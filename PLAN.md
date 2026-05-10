# Contradiction and Tension Detection

Detect two distinct kinds of analytical tension:

1. **Intra-document** — within a single interviewee's transcript, find places where stated beliefs conflict with described practices, or where the speaker hedges, reverses, or qualifies their own position.
2. **Corpus-level** — across all transcripts, find topics where interviewees hold incompatible stances (consensus breakdown).

Both follow the established map-reduce + caching pattern used by themes and extraction.

---

## Data layout

```
data/
  contradictions/         # per-document JSON, keyed by stem
    interview_a.json
    interview_b.json
  corpus_contradictions.json   # cross-document consensus breakdown
```

Per-document schema:
```json
[
  {
    "type": "belief_vs_practice | self_contradiction | hedging",
    "description": "one-sentence characterisation",
    "quote_a": "verbatim quote expressing belief/stance",
    "quote_b": "verbatim quote expressing conflicting practice/reversal",
    "severity": "strong | moderate | mild"
  }
]
```

Corpus schema:
```json
[
  {
    "topic": "short label",
    "tension_summary": "one sentence describing the disagreement",
    "positions": [
      { "stance": "...", "documents": ["interview_a.pdf"], "quote": "..." },
      { "stance": "...", "documents": ["interview_b.pdf"], "quote": "..." }
    ]
  }
]
```

---

## Prompts (in `app/main.py`)

### `_CONTRA_MAP_PROMPT`
Instructs the model to scan a passage for:
- A stated value or belief followed by a description of behaviour that violates it
- An explicit reversal ("but actually…", "I know I should but…")
- Hedging that undercuts a strong claim made earlier in the same passage

Output format per finding:
```
TYPE: belief_vs_practice
QUOTE_A: <verbatim>
QUOTE_B: <verbatim>
SEVERITY: strong
---
```
Return "nothing notable." if no tension present.

### `_CONTRA_REDUCE_PROMPT`
Consolidates map outputs into the JSON array schema above.
Deduplicate findings that reference the same tension from overlapping chunks.
Return ONLY valid JSON.

### `_CONSENSUS_MAP_PROMPT`
Given per-document contradiction summaries for a batch of documents, extract topics where different interviewees hold opposing or incompatible stances.
Output one line per topic:
```
TOPIC: <label> | DOCS: <filenames> | STANCE_A: <...> | STANCE_B: <...> | QUOTE_A: <...> | QUOTE_B: <...>
```

### `_CONSENSUS_REDUCE_PROMPT`
Merges batch outputs into the corpus JSON schema. Sort by number of documents involved descending.

---

## Backend changes (`app/main.py`)

### New constant
```python
CONTRADICTIONS_DIR = Path(__file__).parent.parent / "data" / "contradictions"
CORPUS_CONTRADICTIONS_PATH = Path(__file__).parent.parent / "data" / "corpus_contradictions.json"
```

### `GET /documents/{filename}/contradictions`
Returns cached JSON or 404. Mirrors `get_themes`.

### `POST /documents/{filename}/contradictions`
Streaming map-reduce, identical structure to `create_themes`:
- stages: `map_cached | map | reduce | done | cached`
- Uses `_load_map_cache` / `_save_map_cache` with kind `"contradictions"`
- Parses result with `_parse_themes_json` (reuse — same list-of-objects shape)
- Saves to `CONTRADICTIONS_DIR / f"{stem}.json"`

### `GET /corpus/contradictions`
Returns cached corpus file or runs `_sql_aggregate_contradictions` fallback (naive: concatenate per-doc lists, group by topic label).

### `POST /corpus/contradictions/extract`
Streaming map-reduce over all per-document contradiction JSONs:
- Map: `_CONSENSUS_MAP_PROMPT` over batches of `_CORPUS_DOC_BATCH` documents
- Reduce: `_CONSENSUS_REDUCE_PROMPT`
- Cache to `CORPUS_CONTRADICTIONS_PATH`

---

## Frontend changes

### Per-document button
In `app/static/app.js`, alongside the existing "Summary", "Themes", "Extract" buttons in the document list, add a **"Tensions"** button.

Click handler mirrors the themes flow:
1. POST to `/documents/{filename}/contradictions`, stream NDJSON progress
2. On `done`, pass `data.contradictions` to a render function and open the modal

### Modal render (`renderContradictions(findings, filename)`)
Renders findings as a structured list inside `#modalBody`:

```
## Internal Tensions — {filename}

[strong] Belief vs. Practice
"stated belief quote" ↔ "practice quote"
One-line description.

[moderate] Hedging
…
```
Severity shown as a badge. Use existing `marked` library for any markdown.

### Corpus tensions tab / section
In the sidebar or wherever corpus themes are displayed, add a **"Consensus Breakdown"** section. Button triggers `POST /corpus/contradictions/extract`, result rendered as a table or card list:

| Topic | Documents | Summary |
|-------|-----------|---------|
| land ownership | A, B, C | Farmers A and C describe…  |

Positions expandable inline.

---

## Implementation sequence

1. Add `CONTRADICTIONS_DIR`, `CORPUS_CONTRADICTIONS_PATH` constants and the four prompts.
2. Implement `GET/POST /documents/{filename}/contradictions` (copy-modify from themes endpoints).
3. Implement `GET/POST /corpus/contradictions/extract`.
4. Add "Tensions" button and `renderContradictions` in `app.js`.
5. Add corpus contradictions section to sidebar/corpus UI.
6. Wire up `?regenerate=true` support (already handled by query param pattern).

---

## Design notes

- The map prompt must be **explicit about passage scope**: each batch is 20 chunks (~10 000 chars), so the model cannot see contradictions that span distant parts of the document. The reduce step is where cross-chunk tension is synthesised — the map step only flags local signals.
- For corpus consensus breakdown, the input is the *reduced* per-document contradiction JSON (not raw map outputs), so the corpus map step is cheap.
- Severity is model-assigned; treat it as a soft signal for display ordering, not a hard filter.
- The existing `_MAP_PROMPT` already asks for tension signals in the summary map — this feature produces a **dedicated, structured** output rather than embedding tensions inside a prose summary. The two are complementary.
