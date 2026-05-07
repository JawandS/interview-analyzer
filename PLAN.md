# Plan: Full-Document Thematic Summaries

## Problem

The current summary (`POST /documents/{filename}/summary`) reads the full PDF text but then truncates to `text[:8000]` before sending it to the model. For a long interview transcript this means only the opening section is ever summarized. The prompt is also generic — suited to a research paper, not an ethnographic interview — and doesn't ask for stances, attitudes, or tensions.

## Approach: Map-Reduce over RAG Chunks

The RAG pipeline already chunks every ingested document into 500-char pieces stored in ChromaDB. The summary pipeline should reuse this work rather than re-reading the PDF.

**Map step** — process the document in batches of chunks (e.g. 20 chunks ≈ ~10,000 chars per batch), asking the model to extract a compact intermediate note from each batch: key claims made, notable quotes, factual data points (acreage, grants, generational status), and any tensions visible within that passage.

**Reduce step** — feed all intermediate notes into a final synthesis call that produces the structured summary. The reduce input is much smaller than the full transcript, so it fits comfortably in one context window.

This keeps individual Ollama calls at a manageable size, avoids the 8,000-char ceiling, and produces a summary grounded in the whole document.

## New Prompt Structure

### Map prompt (per batch)
```
You are analyzing an excerpt from an ethnographic interview about farming and land stewardship.
Extract from this passage only:
- Any factual data mentioned (acreage, farm type, crops, grants received, generation)
- Direct quotes worth preserving (copy verbatim, keep short)
- The interviewee's stated positions or attitudes (toward USDA, markets, soil health, neighbors, etc.)
- Any tension between what they say they believe and what they describe doing

Be terse. Bullet points only. If nothing notable is in this passage, return "nothing notable."

Passage {i}/{n} from {filename}:
{chunk_batch_text}
```

### Reduce prompt (final synthesis)
```
You are synthesizing notes from an ethnographic interview about farming and land stewardship.
Below are extracted notes from every section of the transcript. Produce a structured summary
using the headings below. Be specific — use the interviewee's own words where possible.

## Interviewee Profile
(farm type, size, location, generational status — only what's stated)

## Key Stances and Attitudes
(their positions on: USDA/government programs, markets and buyers, soil health practices,
neighbors and community, land ownership)

## Internal Tensions
(places where stated beliefs conflict with described practices, or where they hedge)

## Notable Quotes
(3–6 direct quotes that best capture their voice and worldview)

## Recurring Themes
(2–4 themes that run through the whole interview)

---
Extracted notes:
{all_map_outputs}
```

## Implementation Steps

### 1. Add a `summarize_chunks` helper in `app/rag.py`
- Takes `filename` and returns all chunk texts for that document from ChromaDB in order.
- Requires the document to already be ingested. If not ingested, fall back to reading the PDF directly and chunking in memory (same logic as `ingest_file`).

### 2. Modify `create_summary` in `app/main.py`
- Replace `text[:8000]` truncation with the map-reduce flow.
- Group chunks into batches of 20.
- Run map calls sequentially (Ollama is local; parallel calls would overload it).
- Collect map outputs, run one reduce call, save result to `SUMMARIES_DIR`.
- Keep the existing cache check — if `{stem}.md` exists, return it immediately.

### 3. Add a `regenerate` flag
- `POST /documents/{filename}/summary?regenerate=true` bypasses the cache and rewrites the file.
- Useful when you change the prompt or want to re-run on a new model.

### 4. Stream progress to the UI (optional but valuable)
- The map step can take a while for a long transcript. Use the existing NDJSON streaming pattern to emit `{"stage": "map", "batch": i, "total": n}` tokens so the UI can show a progress indicator instead of a spinner.

## What Changes

| File | Change |
|------|--------|
| `app/rag.py` | Add `get_chunks_for_document(filename)` — queries ChromaDB for all chunks belonging to a file, sorted by chunk index |
| `app/main.py` | Replace `excerpt = text[:8000]` + single prompt with map-reduce loop; add `regenerate` query param |
| `app/static/app.js` | Show batch progress during summary generation (optional) |

## What Stays the Same

- Cache location (`data/summaries/{stem}.md`) and format (markdown).
- The summary modal UI — it renders whatever markdown is returned.
- The `GET /documents/{filename}/summary` endpoint — unchanged.

## Risks and Constraints

- **Ollama throughput**: map calls are sequential. A 30-page transcript might produce ~60 batches of 20 chunks → ~60 Ollama calls before the reduce step. Budget roughly 2–5 minutes per document on a local GPU.
- **ChromaDB ordering**: chunk IDs are `{filename}::{i}` so sorting by the integer suffix gives document order. Verify this holds after upserts.
- **Unigested documents**: if a user clicks "Summarize" before "Ingest", fall back to reading the PDF and chunking in memory rather than erroring out.
