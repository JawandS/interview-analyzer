from contextlib import asynccontextmanager
from datetime import datetime, timezone
from fastapi import BackgroundTasks, FastAPI, Form, HTTPException, Request
from fastapi.responses import HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
import asyncio
import aiosqlite
import fitz  # PyMuPDF
import html
import httpx
import json
import logging
import os
from pathlib import Path
import subprocess
from app import rag


def _ollama_host() -> str:
    if os.name == "nt":
        return "localhost"
    try:
        out = subprocess.check_output(["ip", "route", "show", "default"], text=True)
        return out.split()[2]
    except Exception:
        return "localhost"


OLLAMA_BASE   = f"http://{_ollama_host()}:11434"
DEFAULT_MODEL = "gemma4:e4b"
KEEP_ALIVE    = -1
DB_PATH       = Path(__file__).parent.parent / "data" / "interview-analyzer.db"
SUMMARIES_DIR = Path(__file__).parent.parent / "data" / "summaries"
SETTINGS_PATH = Path(__file__).parent.parent / "data" / "settings.json"


def _load_settings() -> dict:
    if SETTINGS_PATH.exists():
        try:
            return json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {}


def _save_settings(data: dict) -> None:
    SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    SETTINGS_PATH.write_text(json.dumps(data), encoding="utf-8")


_active_model: str = _load_settings().get("model", DEFAULT_MODEL)


async def _init_db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("PRAGMA foreign_keys = ON")
        await db.execute("""
            CREATE TABLE IF NOT EXISTS sessions (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                title      TEXT NOT NULL DEFAULT 'New Conversation',
                model      TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        """)
        await db.execute("""
            CREATE TABLE IF NOT EXISTS messages (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                role       TEXT NOT NULL,
                content    TEXT NOT NULL,
                thinking   TEXT,
                created_at TEXT NOT NULL
            )
        """)
        # migrate existing DBs that predate the thinking column
        try:
            await db.execute("ALTER TABLE messages ADD COLUMN thinking TEXT")
        except Exception:
            pass
        await db.commit()


async def _warmup(model: str) -> None:
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            await client.post(
                f"{OLLAMA_BASE}/api/generate",
                json={"model": model, "prompt": "", "stream": False, "keep_alive": KEEP_ALIVE, "think": True},
            )
    except Exception:
        pass


async def _unload(model: str) -> None:
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            await client.post(
                f"{OLLAMA_BASE}/api/generate",
                json={"model": model, "prompt": "", "stream": False, "keep_alive": 0},
            )
    except Exception:
        pass


@asynccontextmanager
async def lifespan(_: FastAPI):
    logging.basicConfig(level=logging.INFO)
    await _init_db()
    asyncio.create_task(_warmup(_active_model))
    yield


logger = logging.getLogger(__name__)

app = FastAPI(title="Interview Analyzer", lifespan=lifespan)
app.mount("/static", StaticFiles(directory="app/static"), name="static")
templates = Jinja2Templates(directory="app/templates")


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    return templates.TemplateResponse(request, "index.html")


@app.get("/models", response_class=HTMLResponse)
async def list_models():
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"{OLLAMA_BASE}/api/tags")
            resp.raise_for_status()
            names = [m["name"] for m in resp.json().get("models", [])]
        if not names:
            return '<span class="model-error">No models installed</span>'
        options = "\n".join(
            f'<option value="{html.escape(n)}"{"selected" if n == _active_model else ""}>'
            f'{html.escape(n)}</option>'
            for n in names
        )
        return (
            f'<select id="model-select" name="model" class="model-select" aria-label="Model">'
            f'{options}</select>'
        )
    except Exception:
        return '<span class="model-error">Ollama unreachable</span>'


@app.post("/models/switch")
async def switch_model(new_model: str = Form(...), old_model: str = Form(default="")):
    global _active_model
    if old_model and old_model != new_model:
        asyncio.create_task(_unload(old_model))
    _active_model = new_model
    _save_settings({"model": new_model})
    asyncio.create_task(_warmup(new_model))
    return {"ok": True, "model": new_model}


@app.get("/models/active")
async def get_active_model():
    return {"model": _active_model}


# ── Sessions ──────────────────────────────────────────────────

@app.get("/sessions")
async def list_sessions():
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(
            "SELECT id, title, model, created_at, updated_at FROM sessions ORDER BY updated_at DESC"
        )
        rows = await cur.fetchall()
    return [dict(r) for r in rows]


@app.post("/sessions")
async def create_session(model: str = Form(default=DEFAULT_MODEL)):
    now = datetime.now(timezone.utc).isoformat()
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute(
            "INSERT INTO sessions (title, model, created_at, updated_at) VALUES (?, ?, ?, ?)",
            ("New Conversation", model, now, now),
        )
        await db.commit()
        sid = cur.lastrowid
    return {"id": sid, "title": "New Conversation", "model": model, "created_at": now, "updated_at": now}


@app.get("/sessions/{session_id}")
async def get_session(session_id: int):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(
            "SELECT id, title, model, created_at, updated_at FROM sessions WHERE id = ?",
            (session_id,),
        )
        session = await cur.fetchone()
        if not session:
            raise HTTPException(status_code=404, detail="Session not found")
        cur = await db.execute(
            "SELECT role, content, thinking, created_at FROM messages WHERE session_id = ? ORDER BY id",
            (session_id,),
        )
        messages = await cur.fetchall()
    return {"session": dict(session), "messages": [dict(m) for m in messages]}


@app.delete("/sessions/{session_id}")
async def delete_session(session_id: int):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("PRAGMA foreign_keys = ON")
        await db.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
        await db.commit()
    return {"ok": True}


@app.patch("/sessions/{session_id}/title")
async def update_session_title(session_id: int, title: str = Form(...)):
    now = datetime.now(timezone.utc).isoformat()
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?",
            (title, now, session_id),
        )
        await db.commit()
    return {"ok": True}


# ── RAG ───────────────────────────────────────────────────────

_ingesting_files: set[str] = set()


@app.get("/documents")
async def list_documents():
    docs = await rag.list_documents()
    for d in docs:
        d["ingesting"] = d["name"] in _ingesting_files
    return docs


async def _do_ingest(filename: str):
    try:
        result = await rag.ingest_file(filename, OLLAMA_BASE)
        logger.info("Ingest complete for %s: %s", filename, result)
    finally:
        _ingesting_files.discard(filename)


@app.post("/ingest")
async def trigger_ingest(background_tasks: BackgroundTasks, filename: str = Form(...)):
    if filename in _ingesting_files:
        return {"status": "ingesting"}
    _ingesting_files.add(filename)
    background_tasks.add_task(_do_ingest, filename)
    return {"status": "started"}


# ── Document summaries ───────────────────────────────────────

@app.get("/documents/{filename}/summary")
async def get_summary(filename: str):
    stem = Path(filename).stem
    summary_path = SUMMARIES_DIR / f"{stem}.md"
    if summary_path.exists():
        return {"summary": summary_path.read_text(encoding="utf-8"), "cached": True}
    raise HTTPException(status_code=404, detail="No summary cached")


@app.post("/documents/{filename}/summary")
async def create_summary(filename: str, model: str = Form(default=DEFAULT_MODEL)):
    pdf_path = rag.DATA_DIR / filename
    if not pdf_path.exists() or pdf_path.suffix.lower() != ".pdf":
        raise HTTPException(status_code=404, detail="Document not found")

    stem = Path(filename).stem
    summary_path = SUMMARIES_DIR / f"{stem}.md"

    if summary_path.exists():
        return {"summary": summary_path.read_text(encoding="utf-8"), "cached": True}

    def _read_pdf():
        doc = fitz.open(str(pdf_path))
        return "".join(page.get_text() for page in doc)

    text = await asyncio.to_thread(_read_pdf)
    excerpt = text[:8000]

    prompt = (
        "Provide a structured summary of the following interview document. "
        "Include: main topics, key themes, notable quotes, any methodology, "
        "and overall findings. Use markdown headings and bullet points.\n\n"
        f"Document: {filename}\n\n{excerpt}"
    )

    try:
        async with httpx.AsyncClient(timeout=180.0) as client:
            resp = await client.post(
                f"{OLLAMA_BASE}/api/generate",
                json={"model": model, "prompt": prompt, "stream": False, "keep_alive": KEEP_ALIVE},
            )
            resp.raise_for_status()
            summary_text = resp.json().get("response", "")
    except Exception as e:
        logger.error("Summary generation failed for %s: %s", filename, e)
        raise HTTPException(status_code=500, detail=str(e))

    SUMMARIES_DIR.mkdir(parents=True, exist_ok=True)
    summary_path.write_text(summary_text, encoding="utf-8")

    return {"summary": summary_text, "cached": False}


# ── Chat ──────────────────────────────────────────────────────

@app.post("/chat")
async def chat(
    message: str = Form(...),
    model: str = Form(default=DEFAULT_MODEL),
    session_id: int = Form(...),
):
    now = datetime.now(timezone.utc).isoformat()
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)",
            (session_id, "user", message, now),
        )
        await db.execute(
            "UPDATE sessions SET updated_at = ? WHERE id = ?",
            (now, session_id),
        )
        await db.commit()

    chunks = await rag.retrieve(message, OLLAMA_BASE)
    system_prompt = (
        "You are analyzing an ethnographic interview corpus. "
        "Use the following excerpts to inform your response:\n\n"
        + "\n\n---\n\n".join(chunks)
    ) if chunks else None

    async def generate():
        response_parts: list[str] = []
        thinking_parts: list[str] = []
        payload: dict = {"model": model, "prompt": message, "stream": True, "keep_alive": KEEP_ALIVE, "think": True}
        if system_prompt:
            payload["system"] = system_prompt
        try:
            async with httpx.AsyncClient(timeout=180.0) as client:
                async with client.stream(
                    "POST",
                    f"{OLLAMA_BASE}/api/generate",
                    json=payload,
                ) as resp:
                    resp.raise_for_status()
                    async for line in resp.aiter_lines():
                        if line:
                            try:
                                chunk = json.loads(line)
                                if chunk.get("response"):
                                    response_parts.append(chunk["response"])
                                if chunk.get("thinking"):
                                    thinking_parts.append(chunk["thinking"])
                            except Exception:
                                pass
                            yield line + "\n"
        except httpx.ConnectError:
            err = {"error": f"Could not reach Ollama at {OLLAMA_BASE}. Is the service running on Windows?"}
            yield json.dumps(err) + "\n"
            return
        except Exception as e:
            yield json.dumps({"error": str(e)}) + "\n"
            return

        if response_parts:
            content  = "".join(response_parts)
            thinking = "".join(thinking_parts) or None
            ts = datetime.now(timezone.utc).isoformat()
            async with aiosqlite.connect(DB_PATH) as db:
                await db.execute(
                    "INSERT INTO messages (session_id, role, content, thinking, created_at) VALUES (?, ?, ?, ?, ?)",
                    (session_id, "assistant", content, thinking, ts),
                )
                await db.execute(
                    "UPDATE sessions SET updated_at = ? WHERE id = ?",
                    (ts, session_id),
                )
                await db.commit()

    return StreamingResponse(generate(), media_type="application/x-ndjson")
