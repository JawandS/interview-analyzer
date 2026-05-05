from contextlib import asynccontextmanager
from fastapi import FastAPI, Form, Request
from fastapi.responses import HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
import asyncio
import html
import httpx
import json
import subprocess


def _wsl_gateway() -> str:
    try:
        out = subprocess.check_output(["ip", "route", "show", "default"], text=True)
        return out.split()[2]
    except Exception:
        return "localhost"


OLLAMA_BASE = f"http://{_wsl_gateway()}:11434"
DEFAULT_MODEL = "gemma4:latest"
KEEP_ALIVE   = "30m"


async def _warmup():
    """Load the default model into memory so the first request is fast."""
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            await client.post(
                f"{OLLAMA_BASE}/api/generate",
                json={"model": DEFAULT_MODEL, "prompt": "", "stream": False, "keep_alive": KEEP_ALIVE},
            )
    except Exception:
        pass  # Ollama not running yet — fine, user will see the error on first chat


@asynccontextmanager
async def lifespan(_: FastAPI):
    asyncio.create_task(_warmup())
    yield


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
            f'<option value="{html.escape(n)}"{"selected" if n == DEFAULT_MODEL else ""}>'
            f'{html.escape(n)}</option>'
            for n in names
        )
        return (
            f'<select id="model-select" name="model" class="model-select" aria-label="Model">'
            f'{options}</select>'
        )
    except Exception:
        return '<span class="model-error">Ollama unreachable</span>'


@app.post("/chat")
async def chat(message: str = Form(...), model: str = Form(default=DEFAULT_MODEL)):
    async def generate():
        try:
            async with httpx.AsyncClient(timeout=180.0) as client:
                async with client.stream(
                    "POST",
                    f"{OLLAMA_BASE}/api/generate",
                    json={"model": model, "prompt": message, "stream": True, "keep_alive": KEEP_ALIVE},
                ) as resp:
                    resp.raise_for_status()
                    async for line in resp.aiter_lines():
                        if line:
                            yield line + "\n"
        except httpx.ConnectError:
            err = {"error": f"Could not reach Ollama at {OLLAMA_BASE}. Is the service running on Windows?"}
            yield json.dumps(err) + "\n"
        except Exception as e:
            yield json.dumps({"error": str(e)}) + "\n"

    return StreamingResponse(generate(), media_type="application/x-ndjson")
