# Interview Analyzer — TODO

## Working (implement or improve)

- [ ] **Deductive coding against a codebook** — feed existing theoretical codes from early interviews and apply them consistently across all 30 transcripts. LLMs are more consistent than human coders here, though not always more accurate.
- [ ] **Structured data extraction** — extract specific fields (acreage, grant status, generational status, farm type) from unstructured transcript text into clean structured output. Highest-confidence use case in the literature.
- [x] **Per-document thematic summary** — generate a structured summary per interview capturing key topics, stances, and notable quotes. Useful for mapping the corpus before deep analysis.
- [ ] **Corpus-level pattern detection** — identify recurring themes across documents and approximate frequency. Good for a first pass; less reliable than human analysis for nuance. Need to implement a more intelligent RAG system.

## Not Yet Tried — Achievable with Current Setup

- [ ] **Longitudinal discourse tracking** — map how specific concepts ("soil health", "USDA", "cover crops") are framed differently by farm size, region, or generation across the corpus. Computational discourse analysis applied to conservation ethnography.
- [ ] **Social network mapping** — extract relational data (who knows whom, who mentored whom, shared farm history) and build a network graph showing how practices and knowledge travel through communities. Substantive finding, not just a visualization.
- [ ] **Contradiction and tension detection** — prompt the model to find where a single interviewee's stated beliefs conflict with their described practices, or where consensus breaks down across the corpus. Analytically interesting; barely explored in the qualitative literature.
- [ ] **Hypothesis stress-testing** — feed a developed theoretical claim back to the model and ask it to find counter-evidence in the corpus before committing to it in writing. Devil's advocate use.
- [ ] **Iterative analytical memoing** — use the conversational interface to write and refine analytical memos in dialogue with the corpus, so the model can pull evidence for or against a claim in real time. Potentially a methodological contribution in itself.

## Known Limitations — Do Not Rely On

- **Inductive coding from scratch** — models produce generic, obvious themes and miss ethnographically specific nuance. Performance falls well below human levels on ambiguous constructs (per 2026 annotation study). Not suitable for grounded theory work.
- **Long document comprehension** — models degrade significantly on full 5-hour transcripts. RAG chunking helps but loses cross-document context. Work around this, don't fight it.
- **Cross-document relational reasoning** — "How does farmer A's view compare to farmer B's?" gets unreliable fast. Models hallucinate connections or miss subtle ones. Partially improvable with prompt engineering but not solved in the literature.
- **Truly interpretive / thick description** — anything requiring cultural knowledge, positionality awareness, or deep ethnographic interpretation. Current consensus (2025 EASA debate): not reliably achievable, not suitable to stake a thesis on.
