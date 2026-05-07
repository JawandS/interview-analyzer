# Corpus Theme Analysis — Implementation Plan

## Goal

Add corpus-level pattern detection: identify recurring themes across all interview documents with approximate cross-document frequency. Keep ChromaDB RAG for specific Q&A retrieval; add a lightweight theme layer on top.

## Approach

**Per-document theme extraction** — a new map-reduce pass (same pattern as the existing extraction/summary pipelines) that produces a structured JSON list of themes per document. Results cached in `data/themes/`. Corpus aggregation is then just SQL over those cached results, stored in a new SQLite table.

---

## What Changes

### 1. New SQLite table — `document_themes`

```sql
CREATE TABLE IF NOT EXISTS document_themes (
    filename     TEXT PRIMARY KEY,
    themes_json  TEXT NOT NULL,   -- JSON array: [{name, mentions, quote}, ...]
    extracted_at TEXT NOT NULL
)
```

Added to `_init_db()` in `app/main.py`. No migration needed for existing rows — the table starts empty and is populated on first extraction.

### 2. New LLM prompts in `app/main.py`

**`_THEMES_MAP_PROMPT`** — per passage, identify any distinct themes as short labels + a supporting quote. Returns structured text (`THEME: label | QUOTE: ...`) or "nothing notable."

**`_THEMES_REDUCE_PROMPT`** — consolidate all map outputs into a JSON array:
```json
[
  {"name": "water access", "mentions": 3, "quote": "we've had real trouble getting irrigation permits"},
  {"name": "generational transition", "mentions": 2, "quote": "my son wants to keep the farm but..."}
]
```
Return only valid JSON, no prose.

### 3. New endpoints in `app/main.py`

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/documents/{filename}/themes` | Run theme extraction (streaming NDJSON, same flow as `/summary` and `/extract`). Saves result to `data/themes/{stem}.json` and upserts into `document_themes` table. Accepts `?regenerate=true`. |
| `GET`  | `/documents/{filename}/themes` | Return cached themes JSON (404 if not yet run). |
| `GET`  | `/corpus/themes` | Aggregate across all documents with cached themes. Returns theme frequency ranked by `doc_count` (how many documents mention it) and `total_mentions`. |

**`/corpus/themes` response shape:**
```json
{
  "themes": [
    {"name": "water access", "doc_count": 5, "total_mentions": 12, "examples": ["file1.pdf", "file2.pdf"]},
    ...
  ],
  "documents_analyzed": 7,
  "documents_with_themes": 5
}
```

### 4. Chat routing for corpus-level queries

In the `/chat` handler, before calling `rag.retrieve()`, run a lightweight heuristic check on the message:

```python
_CORPUS_KEYWORDS = re.compile(
    r'\b(across|all (documents|interviews|files)|corpus|recurring|common theme|how many|pattern|frequency)\b',
    re.I
)
```

If it matches **and** there are themes in `document_themes`, inject the aggregated corpus summary into the system prompt instead of (or prepended to) the RAG chunks. This lets the user ask "what themes come up across all interviews?" and get a corpus-scoped answer rather than a single-document RAG result.

### 5. New directory

`data/themes/` — cached per-document theme JSON files. Parallel to `data/extractions/` and `data/summaries/`.

Add `THEMES_DIR` constant in `app/main.py` alongside `EXTRACTIONS_DIR`.

### 6. Frontend additions

**Document modal** (`app/templates/components/` or the modal in `index.html`):
- Add a "Themes" tab alongside summary/extraction in the document detail modal.
- Shows the theme list for that document. "Extract Themes" button triggers `POST /documents/{filename}/themes` with streaming progress (reuse existing progress bar pattern from summary/extraction).

**Corpus panel** (new section in sidebar or main area):
- "Corpus Analysis" collapsible section.
- On expand, fetches `GET /corpus/themes` and renders a ranked theme frequency table.
- Shows doc_count as a simple bar / count badge next to each theme name.
- Only shown when at least one document has themes extracted.

---

## Build Order

1. `_init_db()` — add `document_themes` table, add `THEMES_DIR` constant.
2. New prompts — `_THEMES_MAP_PROMPT`, `_THEMES_REDUCE_PROMPT`, `_parse_themes_json()`.
3. `POST /documents/{filename}/themes` endpoint (streaming, cache to file + DB).
4. `GET /documents/{filename}/themes` endpoint (read cache).
5. `GET /corpus/themes` endpoint (SQL aggregation over `document_themes`).
6. `/chat` corpus keyword routing.
7. Frontend — Themes tab in document modal.
8. Frontend — Corpus Analysis panel in sidebar.

---

## What Stays the Same

- ChromaDB RAG pipeline (`app/rag.py`) — no changes. Still used for specific Q&A retrieval.
- Existing extraction fields (acreage, grant_status, etc.) — untouched.
- Summary pipeline — untouched.
- No new dependencies. All processing stays local via Ollama.
