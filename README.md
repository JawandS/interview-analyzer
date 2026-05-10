# Interview Analyzer

A private, local tool for analyzing ethnographic interview PDFs using AI. Your documents stay on your computer — nothing is sent to the cloud.

You can upload interview transcripts, chat with an AI that has actually read them, generate summaries, pull out structured data, and identify themes across your whole corpus.

---

## First-time setup (Windows)

You only need to do this once.

### 1. Install uv (the Python manager)

Open PowerShell and run:

```powershell
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
```

Restart your terminal after this finishes.

### 2. Install Ollama

[Download Ollama for Windows](https://ollama.com/download/windows) and install it. Once installed, it runs quietly in the background — you don't need to open it.

### 3. Download the AI models

In PowerShell:

```powershell
ollama pull gemma4:e4b
ollama pull mxbai-embed-large
```

`gemma4:e4b` is the model that reads and responds to your questions. `mxbai-embed-large` is what lets the tool search your documents. This download only happens once and may take a few minutes depending on your connection.

### 4. Set up the project

```powershell
git clone <repo-url>
cd interview-analyzer
uv sync
```

### 5. Start the app

```powershell
uv run python main.py
```

Then open your browser to **http://localhost:8000**. That's it — the app creates its database automatically on first run.

---

## Everyday use

**Starting the app:** Run `uv run python main.py` in the project folder, then go to http://localhost:8000. Make sure Ollama is running (it usually starts automatically with Windows).

**Adding interviews:** Click the `+` button in the sidebar, or drop PDF files directly into the `app/static/data/` folder. They'll appear in the sidebar ready to ingest.

**Ingesting a document:** Click "Ingest" next to a PDF. This reads the document, breaks it into searchable chunks, and indexes it so the AI can find relevant passages when you ask questions. A longer transcript takes a few minutes.

**Chatting:** Type a question in the chat box. The AI will search your ingested documents and ground its answer in what's actually in the transcripts. You can ask it to compare across interviews, find patterns, or dig into a specific topic.

**Summaries:** Click "Summary" on any document to get a structured overview: interviewee profile, key stances, internal tensions, notable quotes, and recurring themes.

**Data extraction:** Click "Extract" to pull structured fields out of a transcript (acreage, grant status, generational status, farm type). Useful for building a comparison table across interviews.

**Theme analysis:** Click "Themes" to extract recurring thematic concepts from a document. Once you've run this on multiple documents, the sidebar shows a **Corpus Analysis** panel with a frequency chart of themes across your whole set of interviews.

**Corpus questions:** You can ask the chat questions like "what themes recur across all documents?" or "what patterns do you see across the interviews?" — the app detects these and pulls in the aggregated theme data automatically.

---

## What you can see while the AI thinks

Responses stream in real time. You'll often see a collapsible **Reasoning** panel above the answer — that's the AI's chain-of-thought, which can be useful for checking whether it understood your question correctly.

---

## Features at a glance

| Feature | What it does |
|---|---|
| RAG chat | Asks questions grounded in your actual transcripts |
| Summaries | Structured overviews of each interview |
| Extraction | Pulls specific fields into structured data |
| Theme analysis | Identifies and ranks recurring themes per document |
| Corpus analysis | Aggregates themes across all interviews |
| Session history | Saves all your conversations so you can return to them |
| Model switching | Swap AI models from the header without restarting |

---

## Architecture (for reference)

| Layer | Details |
|---|---|
| Backend | FastAPI, Python, `aiosqlite` |
| Frontend | Vanilla JS, HTMX, Jinja2 — no build step |
| Database | SQLite at `data/interview-analyzer.db` |
| Vector store | ChromaDB at `data/chroma/` |
| LLM inference | Ollama (local), default `gemma4:e4b` |
| Embeddings | Ollama, `mxbai-embed-large` |

---

## Limitations worth knowing

- **Ollama must be running.** If the app can't connect to Ollama on port 11434, chat and ingestion won't work.
- **Ingestion takes time.** Each chunk is embedded one at a time. A long transcript can take several minutes.
- **Summaries and extraction are slow.** The map-reduce pipeline makes many AI calls. A 30-page transcript may take 2–5 minutes. If you change models and want to rerun, add `?regenerate=true` to the URL.
- **Extraction accuracy depends on the model.** The AI reads the transcript and makes its best judgment — always verify extracted fields against the source.
- **No login or multi-user support.** Anyone with access to port 8000 on your machine can see all sessions and documents.
