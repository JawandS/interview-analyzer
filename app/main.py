from fastapi import FastAPI, Form, Request
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates
import html
import httpx
import subprocess

app = FastAPI(title="Interview Analyzer")
templates = Jinja2Templates(directory="app/templates")

def _wsl_gateway() -> str:
    """Return the Windows host IP from WSL2's default route."""
    out = subprocess.check_output(["ip", "route", "show", "default"], text=True)
    return out.split()[2]

OLLAMA_BASE = f"http://{_wsl_gateway()}:11434"
MODEL = "gemma4:latest"


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    return templates.TemplateResponse(request, "index.html")


@app.post("/chat", response_class=HTMLResponse)
async def chat(message: str = Form(...)):
    try:
        async with httpx.AsyncClient(timeout=180.0) as client:
            resp = await client.post(
                f"{OLLAMA_BASE}/api/generate",
                json={"model": MODEL, "prompt": message, "stream": False},
            )
            resp.raise_for_status()
            reply = resp.json().get("response", "").strip()
    except httpx.ConnectError:
        reply = f"Could not reach Ollama at {OLLAMA_BASE}. Is the service running on Windows?"
    except Exception as e:
        reply = f"Error: {e}"

    return f"""
    <div class="message assistant">
      <span class="label">Analyst</span>
      <div class="bubble">{html.escape(reply)}</div>
    </div>
    """
