# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Install dependencies (uses uv)
uv sync

# Run the development server (auto-reload)
python main.py

# Or directly with uvicorn
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

The app requires **Ollama running locally** on port 11434. On Windows it connects to `localhost`; on Linux it auto-detects the default gateway IP (for WSL2 usage). The default model is `gemma4:e4b`; embedding uses `mxbai-embed-large`.

## Architecture

This is a single-page FastAPI app for analyzing ethnographic interview PDFs using local LLMs via Ollama, with RAG over ingested documents.

**Backend (`app/`)**
- `app/main.py` — All FastAPI routes. Manages SQLite sessions/messages, orchestrates RAG retrieval before chat, handles PDF summary generation, and streams Ollama responses as NDJSON.
- `app/rag.py` — RAG pipeline: reads PDFs from `app/static/data/`, chunks text (500 chars, 450 step), embeds via Ollama (`mxbai-embed-large`), stores/retrieves from ChromaDB at `data/chroma/`.

**Persistence**
- `data/interview-analyzer.db` — SQLite via `aiosqlite`; two tables: `sessions` and `messages` (with a `thinking` column for chain-of-thought).
- `data/chroma/` — ChromaDB vector store, one collection `"interviews"`.
- `data/summaries/` — Cached markdown summaries per PDF (keyed by filename stem).
- `app/static/data/` — Drop PDFs here; they appear in the UI for ingestion.

**Frontend**
- No build step — vanilla JS ES modules, HTMX for model list polling, Jinja2 templates.
- `app/static/app.js` — All client logic: session management, streaming chat handler (reads NDJSON), document ingestion UI, summary modal, theme/sidebar state in `localStorage`.
- `app/static/think-parser.js` — Streaming `<think>...</think>` tag parser that splits Ollama's chain-of-thought tokens from response tokens in real time.
- Templates in `app/templates/components/` are included into `index.html` (sidebar, chat, header, modal).
- Vendor libraries (htmx, marked, KaTeX) are bundled in `app/static/vendor/` — fully offline capable.

**Chat flow**
1. User submits message → JS creates a session if new, POSTs to `/chat`.
2. `/chat` saves user message, calls `rag.retrieve()` to get top-5 similar chunks, builds a system prompt, then streams Ollama's response back as NDJSON.
3. `ThinkParser` in the browser separates `<think>` blocks (shown as collapsible "Reasoning" panels) from the actual response.
4. After streaming completes, the full response is re-rendered with markdown + KaTeX.
