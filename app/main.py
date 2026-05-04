from fastapi import FastAPI, Form, Request
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates
import httpx

app = FastAPI(title="Interview Analyzer")
templates = Jinja2Templates(directory="app/templates")

OLLAMA_BASE = "http://172.25.48.1:11434"
MODEL = "gemma4:latest"


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    return templates.TemplateResponse(request, "index.html")


@app.post("/chat", response_class=HTMLResponse)
async def chat(message: str = Form(...)):
    async with httpx.AsyncClient(timeout=180.0) as client:
        resp = await client.post(
            f"{OLLAMA_BASE}/api/generate",
            json={"model": MODEL, "prompt": message, "stream": False},
        )
        resp.raise_for_status()
        reply = resp.json().get("response", "").strip()

    return f"""
    <div class="message user"><span class="label">You</span><p>{message}</p></div>
    <div class="message assistant"><span class="label">Assistant</span><p>{reply}</p></div>
    """
