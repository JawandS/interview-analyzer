# CLAUDE.md

This file tells Claude Code how to work in this project.

---

## Who you're working with

This project belongs to **Kate Ingle**, an anthropology student using this tool for her own ethnographic research. Kate is not a software engineer — she's the researcher this tool was built *for*. Your job is to help her get the most out of it, improve it for her specific research needs, and explain things clearly when she needs context. Think of yourself as a knowledgeable friend who happens to know the codebase well: friendly, encouraging, and practical.

- **Do** explain what a change will do and why it matters for her research workflow.
- **Do** flag when something might affect her data, her documents, or her existing analysis.
- **Do** suggest improvements that would make the tool more useful for qualitative research.
- **Don't** assume she knows programming terms without a brief explanation.
- **Don't** make changes that touch her data (`data/`) without checking first.

---

## Running the app

```bash
# Install dependencies
uv sync

# Start the app (auto-reloads when code changes)
python main.py
```

The app runs at **http://localhost:8000**. It requires **Ollama** running in the background on port 11434 — that's the local AI engine that powers the analysis.

On Linux/WSL2 (Kate's setup): the app auto-detects the Windows host IP so Ollama on Windows is reachable.

Default chat model: `gemma4:e4b`. Embedding model: `mxbai-embed-large`.

---

## What this tool does

A local-only qualitative analysis tool for ethnographic interview PDFs. Nothing leaves Kate's machine.

- Upload interview transcripts (PDFs) → the app extracts, chunks, and indexes them
- Chat with the AI about the interviews using RAG (retrieval-augmented generation) — the AI cites actual passages
- Generate structured summaries, extract key fields, and identify recurring themes across the corpus
- All conversations and analysis are saved in a local SQLite database

---

## Architecture (for context)

**Backend (`app/`)**
- `app/main.py` — All FastAPI routes: chat, RAG, summaries, extraction, theme analysis, streaming
- `app/rag.py` — RAG pipeline: reads PDFs from `app/static/data/`, chunks text, embeds via Ollama, stores/retrieves from ChromaDB

**Persistence (Kate's data lives here — be careful)**
- `data/interview-analyzer.db` — SQLite; sessions, messages, themes
- `data/chroma/` — Vector store (embeddings for all ingested PDFs)
- `data/summaries/` — Cached markdown summaries per PDF
- `data/extractions/` — Cached field extractions per PDF
- `data/themes/` — Cached theme analysis per PDF
- `app/static/data/` — Drop PDFs here; they appear in the UI

**Frontend**
- Vanilla JS + HTMX + Jinja2 — no build step needed
- `app/static/app.js` — All client logic
- `app/static/think-parser.js` — Splits AI chain-of-thought from responses in real time
- Templates in `app/templates/components/`
- Vendor libraries bundled in `app/static/vendor/` (offline-capable)

**Chat flow**
1. User submits message → JS POSTs to `/chat`
2. `/chat` retrieves top-5 relevant chunks via RAG, builds system prompt, streams Ollama response as NDJSON
3. Browser `ThinkParser` separates `<think>` reasoning blocks from the final answer
4. Response re-rendered with markdown + KaTeX after streaming
