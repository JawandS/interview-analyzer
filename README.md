# Interview Analyzer

Privacy-first local LLM system for qualitative analysis of ethnographic interview corpora.

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

Open a terminal and pull both the chat model and the embedding model:

```powershell
ollama pull qwen2.5:32b
ollama pull mxbai-embed-large
```

`qwen2.5:32b` is the primary analysis model (~20GB at Q4). `mxbai-embed-large` powers RAG document retrieval.

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
