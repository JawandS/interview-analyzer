import asyncio
import logging
from pathlib import Path

import fitz  # PyMuPDF
import httpx
import chromadb

logger = logging.getLogger(__name__)

DATA_DIR    = Path(__file__).parent / "static" / "data"
CHROMA_DIR  = Path(__file__).parent.parent / "data" / "chroma"
EMBED_MODEL = "mxbai-embed-large"
COLLECTION  = "interviews"
CHUNK_SIZE  = 500
CHUNK_STEP  = 450


def _chunk(text: str) -> list[str]:
    chunks = []
    start = 0
    while start < len(text):
        chunks.append(text[start : start + CHUNK_SIZE])
        start += CHUNK_STEP
    return chunks


async def _embed(text: str, ollama_base: str) -> list[float]:
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(
            f"{ollama_base}/api/embed",
            json={"model": EMBED_MODEL, "input": text},
        )
        resp.raise_for_status()
        return resp.json()["embeddings"][0]


async def ingest(ollama_base: str) -> None:
    pdfs = list(DATA_DIR.glob("*.pdf"))
    if not pdfs:
        logger.info("RAG: no PDFs found in %s", DATA_DIR)
        return

    def _get_collection():
        client = chromadb.PersistentClient(path=str(CHROMA_DIR))
        return client.get_or_create_collection(COLLECTION)

    collection = await asyncio.to_thread(_get_collection)

    total = 0
    for pdf_path in pdfs:
        doc = await asyncio.to_thread(fitz.open, str(pdf_path))
        text = "".join(page.get_text() for page in doc)
        chunks = _chunk(text)

        ids, embeddings, documents = [], [], []
        for i, chunk in enumerate(chunks):
            chunk = chunk.strip()
            if not chunk:
                continue
            try:
                vec = await _embed(chunk, ollama_base)
            except Exception as e:
                logger.warning("RAG: embedding failed for %s chunk %d: %s", pdf_path.name, i, e)
                return
            ids.append(f"{pdf_path.name}::{i}")
            embeddings.append(vec)
            documents.append(chunk)

        if ids:
            await asyncio.to_thread(
                collection.upsert, ids=ids, embeddings=embeddings, documents=documents
            )
            total += len(ids)
            logger.info("RAG: upserted %d chunks from %s", len(ids), pdf_path.name)

    logger.info("RAG: ingest complete — %d total chunks in collection", total)


async def retrieve(query: str, ollama_base: str, n: int = 5) -> list[str]:
    try:
        query_vec = await _embed(query, ollama_base)
    except Exception as e:
        logger.warning("RAG: query embedding failed: %s", e)
        return []

    def _query():
        client = chromadb.PersistentClient(path=str(CHROMA_DIR))
        col = client.get_or_create_collection(COLLECTION)
        if col.count() == 0:
            return []
        results = col.query(query_embeddings=[query_vec], n_results=min(n, col.count()))
        return results["documents"][0] if results["documents"] else []

    try:
        return await asyncio.to_thread(_query)
    except Exception as e:
        logger.warning("RAG: retrieval failed: %s", e)
        return []
