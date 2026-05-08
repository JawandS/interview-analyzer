from contextlib import asynccontextmanager
from datetime import datetime, timezone
from fastapi import BackgroundTasks, FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse
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
import re
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
SUMMARIES_DIR   = Path(__file__).parent.parent / "data" / "summaries"
EXTRACTIONS_DIR = Path(__file__).parent.parent / "data" / "extractions"
THEMES_DIR       = Path(__file__).parent.parent / "data" / "themes"
CORPUS_THEMES_PATH = Path(__file__).parent.parent / "data" / "corpus_themes.json"
MAPS_DIR        = Path(__file__).parent.parent / "data" / "maps"
SETTINGS_PATH   = Path(__file__).parent.parent / "data" / "settings.json"


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
        await db.execute("""
            CREATE TABLE IF NOT EXISTS document_themes (
                filename     TEXT PRIMARY KEY,
                themes_json  TEXT NOT NULL,
                extracted_at TEXT NOT NULL
            )
        """)
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


@app.post("/documents/upload")
async def upload_document(file: UploadFile = File(...)):
    if not file.filename or not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are accepted")
    dest = rag.DATA_DIR / file.filename
    dest.write_bytes(await file.read())
    return {"name": file.filename}


@app.post("/ingest")
async def trigger_ingest(background_tasks: BackgroundTasks, filename: str = Form(...)):
    if filename in _ingesting_files:
        return {"status": "ingesting"}
    _ingesting_files.add(filename)
    background_tasks.add_task(_do_ingest, filename)
    return {"status": "started"}


@app.get("/pdf/{filename}/page")
async def pdf_page_for_chunk(filename: str, chunk: int = Query(...)):
    if not filename.lower().endswith(".pdf"):
        return JSONResponse({"error": "not found"}, status_code=404)
    path = rag.DATA_DIR / filename
    if not path.exists():
        return JSONResponse({"error": "not found"}, status_code=404)
    try:
        offset = chunk * rag.CHUNK_STEP
        doc = fitz.open(str(path))
        running = 0
        page_num = doc.page_count
        for i, page in enumerate(doc):
            running += len(page.get_text())
            if running > offset:
                page_num = i + 1
                break

        def _get_text():
            import chromadb
            client = chromadb.PersistentClient(path=str(rag.CHROMA_DIR))
            col = client.get_or_create_collection("interviews")
            results = col.get(ids=[f"{filename}::{chunk}"], include=["documents"])
            return results["documents"][0] if results["documents"] else None

        text = await asyncio.to_thread(_get_text)
        return JSONResponse({"page": page_num, "text": text})
    except Exception:
        return JSONResponse({"page": 1, "text": None})


# ── Document summaries ───────────────────────────────────────

@app.get("/documents/{filename}/summary")
async def get_summary(filename: str):
    stem = Path(filename).stem
    summary_path = SUMMARIES_DIR / f"{stem}.md"
    if summary_path.exists():
        return {"summary": summary_path.read_text(encoding="utf-8"), "cached": True}
    raise HTTPException(status_code=404, detail="No summary cached")


def _load_map_cache(filename: str, kind: str) -> list[str] | None:
    path = MAPS_DIR / kind / f"{Path(filename).stem}.json"
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return None
    return None


def _save_map_cache(filename: str, kind: str, results: list[str]) -> None:
    (MAPS_DIR / kind).mkdir(parents=True, exist_ok=True)
    (MAPS_DIR / kind / f"{Path(filename).stem}.json").write_text(
        json.dumps(results, ensure_ascii=False), encoding="utf-8"
    )


_MAP_BATCH_SIZE = 20

_MAP_PROMPT = """\
You are analyzing an excerpt from an ethnographic interview transcript.
Extract from this passage only:
- Key factual data (names, places, dates, roles, institutions, quantities)
- Direct quotes worth preserving (copy verbatim, keep short)
- The interviewee's stated positions or attitudes
- Any tension between what they say they believe and what they describe doing

Be terse. Bullet points only. If nothing notable is in this passage, return "nothing notable."

Passage {i}/{n} from {filename}:
{text}"""

_REDUCE_PROMPT = """\
You are synthesizing notes from an ethnographic interview transcript.
Below are extracted notes from every section. Produce a structured summary \
using the headings below. Be specific — use the interviewee's own words where possible.

## Interviewee Profile
(background, role, location, context — only what is stated)

## Key Stances and Attitudes
(their positions on the main topics discussed)

## Internal Tensions
(places where stated beliefs conflict with described practices, or where they hedge)

## Notable Quotes
(3–6 direct quotes that best capture their voice)

## Recurring Themes
(2–4 themes that run through the whole interview)

---
Extracted notes:
{notes}"""


_EXTRACT_MAP_PROMPT = """\
You are extracting structured field data from an ethnographic interview transcript.
From this passage, note any EXPLICIT mentions of:
- ACREAGE: farm size in acres or related land area
- GRANTS: any USDA programs, government grants, or external funding received or applied for
- GENERATION: which generation of the family owns or operates this farm
- FARM_TYPE: the type of agricultural operation (crops, livestock, specialty, organic, mixed, etc.)

Be brief. Use format "FIELD: value" for each mention. If nothing relevant appears, return "nothing notable."

Passage {i}/{n}:
{text}"""

_EXTRACT_REDUCE_PROMPT = """\
You are synthesizing field extraction notes from an ethnographic farm interview transcript.
Consolidate the notes below into this JSON schema. Use null for fields with no evidence.
Keep values concise (under 20 words). Return ONLY valid JSON, no explanation or prose.

Schema:
{{
  "acreage": <string or null>,
  "grant_status": <string or null>,
  "generational_status": <string or null>,
  "farm_type": <string or null>,
  "notes": <string>
}}

Extraction notes:
{notes}"""


_THEMES_MAP_PROMPT = """\
You are analyzing an excerpt from an ethnographic interview transcript.
Identify any distinct thematic concepts present in this passage. A theme is a recurring \
idea, concern, tension, or value — not a topic heading. Examples: "land access anxiety", \
"distrust of government programs", "pride in generational continuity".

For each theme you find, output one line in this exact format:
THEME: <short label (2-5 words)> | QUOTE: <short supporting quote, verbatim, under 20 words>

If nothing thematic is present, return "nothing notable."

Passage {i}/{n}:
{text}"""

_THEMES_REDUCE_PROMPT = """\
You are consolidating thematic analysis notes from an ethnographic interview transcript.
Below are theme observations from every section of the document.
Merge duplicates (same concept, different wording), count how many section batches mention each theme, \
and select the best supporting quote for each.

Return ONLY a valid JSON array in this exact schema — no prose, no explanation:
[
  {{"name": "<theme label>", "mentions": <integer count>, "quote": "<best supporting quote>"}},
  ...
]

Observations:
{notes}"""


def _parse_themes_json(text: str) -> list:
    try:
        data = json.loads(text.strip())
        if isinstance(data, list):
            return data
    except json.JSONDecodeError:
        pass
    match = re.search(r'\[[\s\S]*\]', text)
    if match:
        try:
            data = json.loads(match.group())
            if isinstance(data, list):
                return data
        except json.JSONDecodeError:
            pass
    return []


_CORPUS_KEYWORDS = re.compile(
    r'\b(across|all (documents|interviews|files)|corpus|recurring|common theme|how many|pattern|frequency)\b',
    re.I
)

_CORPUS_DOC_BATCH = 5  # documents per corpus map batch

_CORPUS_MAP_PROMPT = """\
You are analyzing themes extracted from a batch of ethnographic interview documents.
Your job is to normalize theme labels to a shared vocabulary — merge near-synonyms \
(e.g. "irrigation challenges" and "water access difficulty" → "water access") and \
identify which canonical themes appear across this batch.

For each canonical theme, output one line:
THEME: <canonical label (2-5 words)> | DOCS: <comma-separated filenames> | MENTIONS: <total count> | QUOTE: <best quote, under 20 words>

Input — per-document theme lists:
{doc_themes}"""

_CORPUS_REDUCE_PROMPT = """\
You are synthesizing cross-document theme analysis for an ethnographic interview corpus.
Below are normalized theme observations from batches of documents. \
Merge overlapping themes, sum document counts and mention counts, and select the best quote for each.

Return ONLY a valid JSON array, no prose:
[
  {{
    "name": "<canonical theme label>",
    "doc_count": <integer — number of distinct documents>,
    "total_mentions": <integer>,
    "examples": [<list of filenames>],
    "quote": "<best supporting quote>"
  }},
  ...
]

Sort by doc_count descending. Include all themes that appear in at least one document.

Batch observations:
{notes}"""


def _parse_extraction_json(text: str) -> dict:
    blank = {"acreage": None, "grant_status": None, "generational_status": None, "farm_type": None, "notes": ""}
    try:
        data = json.loads(text.strip())
        blank.update(data)
        return blank
    except json.JSONDecodeError:
        pass
    match = re.search(r'\{[\s\S]*\}', text)
    if match:
        try:
            data = json.loads(match.group())
            blank.update(data)
            return blank
        except json.JSONDecodeError:
            pass
    blank["notes"] = text.strip()
    return blank


@app.get("/documents/{filename}/extraction")
async def get_extraction(filename: str):
    stem = Path(filename).stem
    extract_path = EXTRACTIONS_DIR / f"{stem}.json"
    if extract_path.exists():
        return {"data": json.loads(extract_path.read_text(encoding="utf-8")), "cached": True}
    raise HTTPException(status_code=404, detail="No extraction cached")


@app.post("/documents/{filename}/extract")
async def create_extraction(
    filename: str,
    model: str = Form(default=DEFAULT_MODEL),
    regenerate: bool = Query(default=False),
):
    pdf_path = rag.DATA_DIR / filename
    if not pdf_path.exists() or pdf_path.suffix.lower() != ".pdf":
        raise HTTPException(status_code=404, detail="Document not found")

    stem = Path(filename).stem
    extract_path = EXTRACTIONS_DIR / f"{stem}.json"

    async def generate():
        if extract_path.exists() and not regenerate:
            yield json.dumps({"stage": "cached", "data": json.loads(extract_path.read_text(encoding="utf-8"))}) + "\n"
            return

        chunks = await rag.get_chunks_for_document(filename)
        if not chunks:
            def _read_pdf():
                doc = fitz.open(str(pdf_path))
                return "".join(page.get_text() for page in doc)
            text = await asyncio.to_thread(_read_pdf)
            chunks = [c.strip() for c in rag._chunk(text) if c.strip()]

        batches = [chunks[i:i + _MAP_BATCH_SIZE] for i in range(0, len(chunks), _MAP_BATCH_SIZE)]
        n = len(batches)

        queue: asyncio.Queue = asyncio.Queue()

        async def _run_map(client: httpx.AsyncClient, idx: int, batch: list[str]) -> None:
            prompt = _EXTRACT_MAP_PROMPT.format(i=idx + 1, n=n, text="\n".join(batch))
            try:
                resp = await client.post(
                    f"{OLLAMA_BASE}/api/generate",
                    json={"model": model, "prompt": prompt, "stream": False, "keep_alive": KEEP_ALIVE},
                )
                resp.raise_for_status()
                out = resp.json().get("response", "").strip()
            except Exception as e:
                logger.warning("Extract map %d/%d failed for %s: %r", idx + 1, n, filename, e)
                out = "nothing notable."
            await queue.put((idx, out))

        cached_map = None if regenerate else _load_map_cache(filename, "extract")
        if cached_map is not None:
            map_results = cached_map
            yield json.dumps({"stage": "map_cached", "total": len(map_results)}) + "\n"
        else:
            map_results = ["nothing notable."] * n
            async with httpx.AsyncClient(timeout=180.0) as client:
                tasks = [asyncio.create_task(_run_map(client, i, batch)) for i, batch in enumerate(batches)]
                for done in range(1, n + 1):
                    idx, out = await queue.get()
                    map_results[idx] = out
                    yield json.dumps({"stage": "map", "batch": done, "total": n}) + "\n"
                await asyncio.gather(*tasks)
            _save_map_cache(filename, "extract", map_results)

        map_outputs = [
            f"[Batch {i + 1}/{n}]\n{out}"
            for i, out in enumerate(map_results)
            if out and out.lower() != "nothing notable."
        ]
        notes = "\n\n".join(map_outputs) if map_outputs else "No relevant field data found."

        yield json.dumps({"stage": "reduce"}) + "\n"

        try:
            async with httpx.AsyncClient(timeout=180.0) as client:
                resp = await client.post(
                    f"{OLLAMA_BASE}/api/generate",
                    json={"model": model, "prompt": _EXTRACT_REDUCE_PROMPT.format(notes=notes), "stream": False, "keep_alive": KEEP_ALIVE},
                )
                resp.raise_for_status()
                raw = resp.json().get("response", "").strip()
        except Exception as e:
            logger.error("Extract reduce failed for %s: %r", filename, e)
            yield json.dumps({"error": repr(e)}) + "\n"
            return

        data = _parse_extraction_json(raw)
        EXTRACTIONS_DIR.mkdir(parents=True, exist_ok=True)
        extract_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        yield json.dumps({"stage": "done", "data": data}) + "\n"

    return StreamingResponse(generate(), media_type="application/x-ndjson")


@app.post("/documents/{filename}/summary")
async def create_summary(
    filename: str,
    model: str = Form(default=DEFAULT_MODEL),
    regenerate: bool = Query(default=False),
):
    pdf_path = rag.DATA_DIR / filename
    if not pdf_path.exists() or pdf_path.suffix.lower() != ".pdf":
        raise HTTPException(status_code=404, detail="Document not found")

    stem = Path(filename).stem
    summary_path = SUMMARIES_DIR / f"{stem}.md"

    async def generate():
        if summary_path.exists() and not regenerate:
            yield json.dumps({"stage": "cached", "summary": summary_path.read_text(encoding="utf-8")}) + "\n"
            return

        chunks = await rag.get_chunks_for_document(filename)
        if not chunks:
            def _read_pdf():
                doc = fitz.open(str(pdf_path))
                return "".join(page.get_text() for page in doc)
            text = await asyncio.to_thread(_read_pdf)
            chunks = [c.strip() for c in rag._chunk(text) if c.strip()]

        batches = [chunks[i:i + _MAP_BATCH_SIZE] for i in range(0, len(chunks), _MAP_BATCH_SIZE)]
        n = len(batches)

        queue: asyncio.Queue = asyncio.Queue()

        async def _run_map(client: httpx.AsyncClient, idx: int, batch: list[str]) -> None:
            prompt = _MAP_PROMPT.format(i=idx + 1, n=n, filename=filename, text="\n".join(batch))
            try:
                resp = await client.post(
                    f"{OLLAMA_BASE}/api/generate",
                    json={"model": model, "prompt": prompt, "stream": False, "keep_alive": KEEP_ALIVE},
                )
                resp.raise_for_status()
                out = resp.json().get("response", "").strip()
            except Exception as e:
                logger.warning("Summary map step %d/%d failed for %s: %r", idx + 1, n, filename, e)
                out = "nothing notable."
            await queue.put((idx, out))

        cached_map = None if regenerate else _load_map_cache(filename, "summary")
        if cached_map is not None:
            map_results = cached_map
            yield json.dumps({"stage": "map_cached", "total": len(map_results)}) + "\n"
        else:
            map_results = ["nothing notable."] * n
            async with httpx.AsyncClient(timeout=180.0) as client:
                tasks = [asyncio.create_task(_run_map(client, i, batch)) for i, batch in enumerate(batches)]
                for done in range(1, n + 1):
                    idx, out = await queue.get()
                    map_results[idx] = out
                    yield json.dumps({"stage": "map", "batch": done, "total": n}) + "\n"
                await asyncio.gather(*tasks)
            _save_map_cache(filename, "summary", map_results)

        map_outputs: list[str] = [
            f"[Batch {i + 1}/{n}]\n{out}"
            for i, out in enumerate(map_results)
            if out and out.lower() != "nothing notable."
        ]

        notes = "\n\n".join(map_outputs) if map_outputs else "No notable content extracted."
        yield json.dumps({"stage": "reduce"}) + "\n"

        accumulated = ""
        try:
            async with httpx.AsyncClient(timeout=300.0) as client:
                async with client.stream(
                    "POST",
                    f"{OLLAMA_BASE}/api/generate",
                    json={"model": model, "prompt": _REDUCE_PROMPT.format(notes=notes), "stream": True, "keep_alive": KEEP_ALIVE},
                ) as resp:
                    resp.raise_for_status()
                    async for line in resp.aiter_lines():
                        if not line:
                            continue
                        try:
                            token = json.loads(line).get("response", "")
                            if token:
                                accumulated += token
                                yield json.dumps({"stage": "streaming", "token": token}) + "\n"
                        except json.JSONDecodeError:
                            continue
        except Exception as e:
            logger.error("Summary reduce step failed for %s: %r", filename, e)
            yield json.dumps({"error": repr(e)}) + "\n"
            return

        SUMMARIES_DIR.mkdir(parents=True, exist_ok=True)
        summary_path.write_text(accumulated, encoding="utf-8")
        yield json.dumps({"stage": "done", "summary": accumulated}) + "\n"

    return StreamingResponse(generate(), media_type="application/x-ndjson")


# ── Document themes ─────────────────────────────────────────

@app.get("/documents/{filename}/themes")
async def get_themes(filename: str):
    stem = Path(filename).stem
    theme_path = THEMES_DIR / f"{stem}.json"
    if theme_path.exists():
        return {"themes": json.loads(theme_path.read_text(encoding="utf-8")), "cached": True}
    raise HTTPException(status_code=404, detail="No themes cached")


@app.post("/documents/{filename}/themes")
async def create_themes(
    filename: str,
    model: str = Form(default=DEFAULT_MODEL),
    regenerate: bool = Query(default=False),
):
    pdf_path = rag.DATA_DIR / filename
    if not pdf_path.exists() or pdf_path.suffix.lower() != ".pdf":
        raise HTTPException(status_code=404, detail="Document not found")

    stem = Path(filename).stem
    theme_path = THEMES_DIR / f"{stem}.json"

    async def generate():
        if theme_path.exists() and not regenerate:
            yield json.dumps({"stage": "cached", "themes": json.loads(theme_path.read_text(encoding="utf-8"))}) + "\n"
            return

        chunks = await rag.get_chunks_for_document(filename)
        if not chunks:
            def _read_pdf():
                doc = fitz.open(str(pdf_path))
                return "".join(page.get_text() for page in doc)
            text = await asyncio.to_thread(_read_pdf)
            chunks = [c.strip() for c in rag._chunk(text) if c.strip()]

        batches = [chunks[i:i + _MAP_BATCH_SIZE] for i in range(0, len(chunks), _MAP_BATCH_SIZE)]
        n = len(batches)

        queue: asyncio.Queue = asyncio.Queue()

        async def _run_map(client: httpx.AsyncClient, idx: int, batch: list[str]) -> None:
            prompt = _THEMES_MAP_PROMPT.format(i=idx + 1, n=n, text="\n".join(batch))
            try:
                resp = await client.post(
                    f"{OLLAMA_BASE}/api/generate",
                    json={"model": model, "prompt": prompt, "stream": False, "keep_alive": KEEP_ALIVE},
                )
                resp.raise_for_status()
                out = resp.json().get("response", "").strip()
            except Exception as e:
                logger.warning("Themes map %d/%d failed for %s: %r", idx + 1, n, filename, e)
                out = "nothing notable."
            await queue.put((idx, out))

        cached_map = None if regenerate else _load_map_cache(filename, "themes")
        if cached_map is not None:
            map_results = cached_map
            yield json.dumps({"stage": "map_cached", "total": len(map_results)}) + "\n"
        else:
            map_results = ["nothing notable."] * n
            async with httpx.AsyncClient(timeout=180.0) as client:
                tasks = [asyncio.create_task(_run_map(client, i, batch)) for i, batch in enumerate(batches)]
                for done in range(1, n + 1):
                    idx, out = await queue.get()
                    map_results[idx] = out
                    yield json.dumps({"stage": "map", "batch": done, "total": n}) + "\n"
                await asyncio.gather(*tasks)
            _save_map_cache(filename, "themes", map_results)

        map_outputs = [
            f"[Batch {i + 1}/{n}]\n{out}"
            for i, out in enumerate(map_results)
            if out and out.lower() != "nothing notable."
        ]
        notes = "\n\n".join(map_outputs) if map_outputs else "No themes identified."

        yield json.dumps({"stage": "reduce"}) + "\n"

        try:
            async with httpx.AsyncClient(timeout=180.0) as client:
                resp = await client.post(
                    f"{OLLAMA_BASE}/api/generate",
                    json={"model": model, "prompt": _THEMES_REDUCE_PROMPT.format(notes=notes), "stream": False, "keep_alive": KEEP_ALIVE},
                )
                resp.raise_for_status()
                raw = resp.json().get("response", "").strip()
        except Exception as e:
            logger.error("Themes reduce failed for %s: %r", filename, e)
            yield json.dumps({"error": repr(e)}) + "\n"
            return

        themes = _parse_themes_json(raw)
        THEMES_DIR.mkdir(parents=True, exist_ok=True)
        theme_path.write_text(json.dumps(themes, ensure_ascii=False, indent=2), encoding="utf-8")

        now = datetime.now(timezone.utc).isoformat()
        async with aiosqlite.connect(DB_PATH) as db:
            await db.execute(
                "INSERT OR REPLACE INTO document_themes (filename, themes_json, extracted_at) VALUES (?, ?, ?)",
                (filename, json.dumps(themes, ensure_ascii=False), now),
            )
            await db.commit()

        yield json.dumps({"stage": "done", "themes": themes}) + "\n"

    return StreamingResponse(generate(), media_type="application/x-ndjson")


def _sql_aggregate_themes(rows) -> dict:
    """Fallback: naive string-match aggregation when LLM corpus pass hasn't run."""
    aggregated: dict[str, dict] = {}
    docs_with_themes = 0
    for row in rows:
        try:
            themes = json.loads(row["themes_json"])
        except Exception:
            continue
        if not themes:
            continue
        docs_with_themes += 1
        for t in themes:
            name = (t.get("name") or "").strip().lower()
            if not name:
                continue
            if name not in aggregated:
                aggregated[name] = {
                    "name": t.get("name", name),
                    "doc_count": 0,
                    "total_mentions": 0,
                    "examples": [],
                    "quote": t.get("quote", ""),
                }
            entry = aggregated[name]
            entry["doc_count"] += 1
            entry["total_mentions"] += int(t.get("mentions", 1))
            entry["examples"].append(row["filename"])
            if not entry["quote"] and t.get("quote"):
                entry["quote"] = t["quote"]
    ranked = sorted(aggregated.values(), key=lambda x: (-x["doc_count"], -x["total_mentions"]))
    return {"themes": ranked, "documents_analyzed": len(rows), "documents_with_themes": docs_with_themes}


@app.get("/corpus/themes")
async def corpus_themes():
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute("SELECT filename, themes_json FROM document_themes")
        rows = await cur.fetchall()

    if not rows:
        return {"themes": [], "documents_analyzed": 0, "documents_with_themes": 0, "llm_extracted": False}

    if CORPUS_THEMES_PATH.exists():
        try:
            cached = json.loads(CORPUS_THEMES_PATH.read_text(encoding="utf-8"))
            cached["llm_extracted"] = True
            cached["documents_analyzed"] = len(rows)
            return cached
        except Exception:
            pass

    result = _sql_aggregate_themes(rows)
    result["llm_extracted"] = False
    return result


@app.post("/corpus/themes/extract")
async def extract_corpus_themes(
    model: str = Form(default=DEFAULT_MODEL),
    regenerate: bool = Query(default=False),
):
    if CORPUS_THEMES_PATH.exists() and not regenerate:
        try:
            cached = json.loads(CORPUS_THEMES_PATH.read_text(encoding="utf-8"))

            async def _cached():
                yield json.dumps({"stage": "cached", **cached}) + "\n"

            return StreamingResponse(_cached(), media_type="application/x-ndjson")
        except Exception:
            pass

    async def generate():
        async with aiosqlite.connect(DB_PATH) as db:
            db.row_factory = aiosqlite.Row
            cur = await db.execute("SELECT filename, themes_json FROM document_themes")
            rows = await cur.fetchall()

        docs = []
        for row in rows:
            try:
                themes = json.loads(row["themes_json"])
                if themes:
                    docs.append({"filename": row["filename"], "themes": themes})
            except Exception:
                continue

        if not docs:
            yield json.dumps({"error": "No per-document themes extracted yet. Run Themes on individual documents first."}) + "\n"
            return

        def _fmt_doc(doc: dict) -> str:
            lines = [f"Document: {doc['filename']}"]
            for t in doc["themes"]:
                line = f"  - {t.get('name', '?')} ({t.get('mentions', 1)} mentions)"
                if t.get("quote"):
                    line += f': "{t["quote"]}"'
                lines.append(line)
            return "\n".join(lines)

        batches = [docs[i:i + _CORPUS_DOC_BATCH] for i in range(0, len(docs), _CORPUS_DOC_BATCH)]
        n = len(batches)
        queue: asyncio.Queue = asyncio.Queue()

        async def _run_map(client: httpx.AsyncClient, idx: int, batch: list[dict]) -> None:
            doc_themes_text = "\n\n".join(_fmt_doc(d) for d in batch)
            prompt = _CORPUS_MAP_PROMPT.format(doc_themes=doc_themes_text)
            try:
                resp = await client.post(
                    f"{OLLAMA_BASE}/api/generate",
                    json={"model": model, "prompt": prompt, "stream": False, "keep_alive": KEEP_ALIVE},
                )
                resp.raise_for_status()
                out = resp.json().get("response", "").strip()
            except Exception as e:
                logger.warning("Corpus map batch %d/%d failed: %r", idx + 1, n, e)
                out = ""
            await queue.put((idx, out))

        map_results = [""] * n
        async with httpx.AsyncClient(timeout=180.0) as client:
            tasks = [asyncio.create_task(_run_map(client, i, batch)) for i, batch in enumerate(batches)]
            for done in range(1, n + 1):
                idx, out = await queue.get()
                map_results[idx] = out
                yield json.dumps({"stage": "map", "batch": done, "total": n}) + "\n"
            await asyncio.gather(*tasks)

        notes = "\n\n".join(
            f"[Batch {i + 1}/{n}]\n{out}" for i, out in enumerate(map_results) if out
        ) or "No cross-document patterns found."

        yield json.dumps({"stage": "reduce"}) + "\n"

        try:
            async with httpx.AsyncClient(timeout=240.0) as client:
                resp = await client.post(
                    f"{OLLAMA_BASE}/api/generate",
                    json={"model": model, "prompt": _CORPUS_REDUCE_PROMPT.format(notes=notes), "stream": False, "keep_alive": KEEP_ALIVE},
                )
                resp.raise_for_status()
                raw = resp.json().get("response", "").strip()
        except Exception as e:
            logger.error("Corpus reduce failed: %r", e)
            yield json.dumps({"error": repr(e)}) + "\n"
            return

        themes = _parse_themes_json(raw)
        if not themes:
            yield json.dumps({"error": "Model returned no valid JSON. Try again or check the model output."}) + "\n"
            return

        result = {
            "themes": themes,
            "documents_with_themes": len(docs),
        }
        CORPUS_THEMES_PATH.parent.mkdir(parents=True, exist_ok=True)
        CORPUS_THEMES_PATH.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        yield json.dumps({"stage": "done", **result}) + "\n"

    return StreamingResponse(generate(), media_type="application/x-ndjson")


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

    corpus_context = None
    if _CORPUS_KEYWORDS.search(message):
        try:
            corpus_data = await corpus_themes()
            if corpus_data["documents_with_themes"] > 0:
                theme_lines = []
                for t in corpus_data["themes"][:20]:
                    ex = ", ".join(Path(f).stem for f in t["examples"][:3])
                    theme_lines.append(
                        f"- **{t['name']}** — {t['doc_count']} doc(s), {t['total_mentions']} mention(s) "
                        f"(e.g. {ex}): \"{t['quote']}\""
                    )
                corpus_context = (
                    f"Corpus theme analysis ({corpus_data['documents_analyzed']} documents, "
                    f"{corpus_data['documents_with_themes']} with extracted themes):\n\n"
                    + "\n".join(theme_lines)
                )
        except Exception:
            pass

    chunks = await rag.retrieve(message, OLLAMA_BASE)
    if corpus_context:
        excerpt_lines = [
            f"[Source: {c['source']}, excerpt {c['chunk_index']}]\n{c['text']}"
            for c in chunks
        ] if chunks else []
        rag_block = ("\n\n---\n\nSupporting excerpts:\n\n" + "\n\n---\n\n".join(excerpt_lines)) if excerpt_lines else ""
        system_prompt = (
            "You are analyzing an ethnographic interview corpus. "
            "The following corpus-level theme analysis has been pre-computed across all documents. "
            "Use it to answer questions about patterns and frequency across the corpus.\n\n"
            + corpus_context + rag_block
        )
    elif chunks:
        excerpt_lines = [
            f"[Source: {c['source']}, excerpt {c['chunk_index']}]\n{c['text']}"
            for c in chunks
        ]
        system_prompt = (
            "You are analyzing an ethnographic interview corpus. "
            "Use the following excerpts to inform your response. "
            "Whenever you draw on an excerpt, cite it using the format (Source: filename, excerpt chunk_index).\n\n"
            + "\n\n---\n\n".join(excerpt_lines)
        )
    else:
        system_prompt = None

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
