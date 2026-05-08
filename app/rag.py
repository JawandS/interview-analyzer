import asyncio
import logging
from pathlib import Path

import fitz  # PyMuPDF
import httpx
import chromadb

logger = logging.getLogger(__name__)

DATA_DIR        = Path(__file__).parent / "static" / "data"
CHROMA_DIR      = Path(__file__).parent.parent / "data" / "chroma"
EMBED_MODEL     = "mxbai-embed-large"
CHUNK_SIZE      = 500
CHUNK_STEP      = 450
EMBED_BATCH_SIZE = 64
PER_DOC_CAP     = 2


def _chunk(text: str) -> list[str]:
    chunks = []
    start = 0
    while start < len(text):
        chunks.append(text[start : start + CHUNK_SIZE])
        start += CHUNK_STEP
    return chunks


async def _embed(text: str, ollama_base: str) -> list[float]:
    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(
            f"{ollama_base}/api/embed",
            json={"model": EMBED_MODEL, "input": text},
        )
        resp.raise_for_status()
        return resp.json()["embeddings"][0]


async def _embed_batch(texts: list[str], ollama_base: str) -> list[list[float]]:
    async with httpx.AsyncClient(timeout=300.0) as client:
        resp = await client.post(
            f"{ollama_base}/api/embed",
            json={"model": EMBED_MODEL, "input": texts},
        )
        resp.raise_for_status()
        return resp.json()["embeddings"]


async def list_documents() -> list[dict]:
    pdfs = sorted(DATA_DIR.glob("*.pdf"), key=lambda p: p.name.lower())
    if not pdfs:
        return []

    names = [p.name for p in pdfs]

    def _check():
        CHROMA_DIR.mkdir(parents=True, exist_ok=True)
        client = chromadb.PersistentClient(path=str(CHROMA_DIR))
        col = client.get_or_create_collection("interviews")
        result = {}
        for name in names:
            r = col.get(where={"source": name}, include=[])
            result[name] = len(r["ids"]) > 0
        return result

    try:
        status = await asyncio.to_thread(_check)
    except Exception:
        status = {n: False for n in names}

    return [{"name": n, "ingested": status.get(n, False)} for n in names]


async def ingest_file(filename: str, ollama_base: str) -> dict:
    pdf_path = DATA_DIR / filename
    if not pdf_path.exists() or pdf_path.suffix.lower() != ".pdf":
        return {"ok": False, "error": "File not found"}

    def _get_collection():
        CHROMA_DIR.mkdir(parents=True, exist_ok=True)
        client = chromadb.PersistentClient(path=str(CHROMA_DIR))
        return client.get_or_create_collection("interviews")

    collection = await asyncio.to_thread(_get_collection)

    doc = await asyncio.to_thread(fitz.open, str(pdf_path))
    text = "".join(page.get_text() for page in doc)
    raw_chunks = _chunk(text)

    indexed_chunks = [(i, chunk.strip()) for i, chunk in enumerate(raw_chunks) if chunk.strip()]

    ids, embeddings, documents, metadatas = [], [], [], []
    for batch_start in range(0, len(indexed_chunks), EMBED_BATCH_SIZE):
        batch = indexed_chunks[batch_start : batch_start + EMBED_BATCH_SIZE]
        batch_texts = [chunk for _, chunk in batch]
        try:
            vecs = await _embed_batch(batch_texts, ollama_base)
        except Exception as e:
            logger.warning("RAG: embed failed for %s batch starting at %d: %s", filename, batch_start, e)
            return {"ok": False, "error": str(e)}
        for (i, chunk), vec in zip(batch, vecs):
            ids.append(f"{filename}::{i}")
            embeddings.append(vec)
            documents.append(chunk)
            metadatas.append({"source": filename, "chunk_index": i})

    if ids:
        await asyncio.to_thread(
            collection.upsert,
            ids=ids,
            embeddings=embeddings,
            documents=documents,
            metadatas=metadatas,
        )
        logger.info("RAG: upserted %d chunks from %s into collection interviews", len(ids), filename)

    return {"ok": True, "chunks": len(ids)}


async def get_chunks_for_document(filename: str) -> list[str]:
    def _fetch():
        CHROMA_DIR.mkdir(parents=True, exist_ok=True)
        client = chromadb.PersistentClient(path=str(CHROMA_DIR))
        col = client.get_or_create_collection("interviews")
        results = col.get(where={"source": filename}, include=["documents", "metadatas"])
        if not results["ids"]:
            return []
        pairs = list(zip(results["metadatas"], results["documents"]))
        pairs.sort(key=lambda p: p[0].get("chunk_index", 0))
        return [doc for _, doc in pairs]

    try:
        return await asyncio.to_thread(_fetch)
    except Exception as e:
        logger.warning("RAG: get_chunks_for_document failed for %s: %s", filename, e)
        return []


async def retrieve(query: str, ollama_base: str, n: int = 5) -> list[dict]:
    try:
        query_vec = await _embed(query, ollama_base)
    except Exception as e:
        logger.warning("RAG: query embedding failed: %s", e)
        return []

    def _query():
        CHROMA_DIR.mkdir(parents=True, exist_ok=True)
        client = chromadb.PersistentClient(path=str(CHROMA_DIR))
        col = client.get_or_create_collection("interviews")
        if col.count() == 0:
            return []

        top_k = min(max(20, n * 4), col.count())
        res = col.query(
            query_embeddings=[query_vec],
            n_results=top_k,
            include=["documents", "metadatas", "distances"],
        )
        candidates = [
            {
                "text": text,
                "source": meta.get("source", ""),
                "chunk_index": meta.get("chunk_index", 0),
                "distance": dist,
            }
            for text, meta, dist in zip(
                res["documents"][0], res["metadatas"][0], res["distances"][0]
            )
        ]
        candidates.sort(key=lambda x: x["distance"])

        selected: list[dict] = []
        overflow: list[dict] = []
        source_counts: dict[str, int] = {}
        for candidate in candidates:
            if len(selected) == n:
                break
            src = candidate["source"]
            if source_counts.get(src, 0) < PER_DOC_CAP:
                selected.append(candidate)
                source_counts[src] = source_counts.get(src, 0) + 1
            else:
                overflow.append(candidate)

        if len(selected) < n:
            selected.extend(overflow[: n - len(selected)])

        return selected

    try:
        return await asyncio.to_thread(_query)
    except Exception as e:
        logger.warning("RAG: retrieval failed: %s", e)
        return []
