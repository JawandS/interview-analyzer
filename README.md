# Interview Analyzer

A local-only tool for qualitative analysis of ethnographic interview PDFs using local LLMs via Ollama and retrieval-augmented generation (RAG). No data leaves the machine.

---

## Fresh Windows Setup

### 1. Install Python via uv

Install [uv](https://docs.astral.sh/uv/getting-started/installation/) — the project's package manager:

```powershell
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
```

Restart your terminal after installation. Python 3.11 will be managed automatically by uv — no separate Python install required.

### 2. Install Ollama

Download and install [Ollama for Windows](https://ollama.com/download/windows). It runs as a background service on port `11434`.

### 3. Pull required models

```powershell
ollama pull gemma4:e4b
ollama pull mxbai-embed-large
```

`gemma4:e4b` is the default chat model. `mxbai-embed-large` powers RAG document retrieval. Any other Ollama model can be selected from the UI at runtime.

### 4. Clone the repo and install dependencies

```powershell
git clone <repo-url>
cd interview-analyzer
uv sync
```

### 5. Run the app

```powershell
uv run python main.py
```

The app starts at `http://localhost:8000`. The SQLite database (`data/interview-analyzer.db`) is created automatically on first run and is gitignored.

---

## Features

**Chat with session management**
- Create, rename, and delete named conversations.
- Each session stores full message history (including chain-of-thought) in SQLite.
- Model selection is persisted across restarts in `data/settings.json`.

**RAG over interview PDFs**
- Drop PDFs into `app/static/data/`. They appear in the sidebar for ingestion.
- Ingestion: extracts text via PyMuPDF, chunks at 500 characters with 50-character overlap, embeds each chunk via `mxbai-embed-large`, and upserts into ChromaDB (`data/chroma/`).
- At query time, the user message is embedded and the top-5 most similar chunks are retrieved and injected into the system prompt.

**Document summaries**
- Each PDF in the sidebar has a "Summary" action (`POST /documents/{filename}/summary`).
- Uses a map-reduce pipeline over RAG chunks: batches of 20 chunks (~10k chars each) are sent to the model to extract notes, then all notes are synthesized in a single reduce call into a structured markdown summary (Interviewee Profile, Key Stances, Internal Tensions, Notable Quotes, Recurring Themes).
- Falls back to reading the PDF directly if the document hasn't been ingested yet.
- Results are cached in `data/summaries/`. Add `?regenerate=true` to bypass the cache and rerun.
- Long documents may take 2–5 minutes to summarize (map calls are sequential).

**Streaming responses with chain-of-thought**
- Ollama responses stream as NDJSON. The browser's `ThinkParser` splits `<think>...</think>` tokens from response tokens in real time.
- Chain-of-thought is shown as a collapsible "Reasoning" panel above the final answer.
- After streaming completes, the response is re-rendered with markdown and KaTeX.

**Model switching**
- The header lists all locally installed Ollama models (polled via HTMX).
- Switching models unloads the previous model from VRAM and warm-starts the new one.

**Offline-capable**
- All vendor libraries (htmx, marked, KaTeX) are bundled in `app/static/vendor/`. No CDN calls at runtime.
- Theme and sidebar state are persisted in `localStorage`.

---

## Architecture

| Layer | Details |
|---|---|
| Backend | FastAPI, Python, `aiosqlite` |
| Frontend | Vanilla JS ES modules, HTMX, Jinja2 templates — no build step |
| Database | SQLite at `data/interview-analyzer.db` (sessions + messages) |
| Vector store | ChromaDB at `data/chroma/` |
| LLM inference | Ollama (local), default model `gemma4:e4b` |
| Embeddings | Ollama, `mxbai-embed-large` |

---

## Limitations

- **Ollama must be running locally.** There is no support for remote inference endpoints. If Ollama is unreachable on port 11434, all chat and ingestion will fail.
- **PDFs must be placed manually.** There is no file upload UI. Files must be copied into `app/static/data/` on the filesystem.
- **Ingestion is sequential.** Each chunk is embedded one at a time. Ingesting a large PDF can take several minutes.
- **Summary generation is slow for long documents.** Map calls are sequential (Ollama is local). A 30-page transcript may take 2–5 minutes. Use `?regenerate=true` to bypass the cache if you change the model or want to rerun.
- **No authentication or multi-user support.** Anyone with network access to port 8000 can read all sessions and documents.
- **Windows vs. Linux/WSL2.** On Windows, Ollama is reached at `localhost:11434`. On Linux, the app auto-detects the default gateway IP to support WSL2 setups where Ollama runs on the Windows host.
- **Single ChromaDB collection.** All ingested PDFs share one collection (`"interviews"`). There is no per-document namespace, so RAG retrieval draws from the entire corpus regardless of which document is selected in the UI.
