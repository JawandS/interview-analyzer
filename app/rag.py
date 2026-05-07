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
    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(
            f"{ollama_base}/api/embed",
            json={"model": EMBED_MODEL, "input": text},
        )
        resp.raise_for_status()
        return resp.json()["embeddings"][0]


async def list_documents() -> list[dict]:
    pdfs = sorted(DATA_DIR.glob("*.pdf"), key=lambda p: p.name.lower())
    if not pdfs:
        return []

    names = [p.name for p in pdfs]

    def _check():
        CHROMA_DIR.mkdir(parents=True, exist_ok=True)
        client = chromadb.PersistentClient(path=str(CHROMA_DIR))
        col = client.get_or_create_collection(COLLECTION)
        result = {}
        for name in names:
            hits = col.get(ids=[f"{name}::0"])
            result[name] = len(hits["ids"]) > 0
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
        return client.get_or_create_collection(COLLECTION)

    collection = await asyncio.to_thread(_get_collection)

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
            logger.warning("RAG: embed failed for %s chunk %d: %s", filename, i, e)
            return {"ok": False, "error": str(e)}
        ids.append(f"{filename}::{i}")
        embeddings.append(vec)
        documents.append(chunk)

    if ids:
        await asyncio.to_thread(
            collection.upsert, ids=ids, embeddings=embeddings, documents=documents
        )
        logger.info("RAG: upserted %d chunks from %s", len(ids), filename)

    return {"ok": True, "chunks": len(ids)}


async def get_chunks_for_document(filename: str) -> list[str]:
    def _fetch():
        CHROMA_DIR.mkdir(parents=True, exist_ok=True)
        client = chromadb.PersistentClient(path=str(CHROMA_DIR))
        col = client.get_or_create_collection(COLLECTION)
        if col.count() == 0:
            return []
        results = col.get(include=["documents"])
        prefix = f"{filename}::"
        pairs = [
            (id_, doc)
            for id_, doc in zip(results["ids"], results["documents"])
            if id_.startswith(prefix)
        ]
        pairs.sort(key=lambda p: int(p[0].split("::")[-1]))
        return [doc for _, doc in pairs]

    try:
        return await asyncio.to_thread(_fetch)
    except Exception as e:
        logger.warning("RAG: get_chunks_for_document failed for %s: %s", filename, e)
        return []


async def retrieve(query: str, ollama_base: str, n: int = 5) -> list[str]:
    try:
        query_vec = await _embed(query, ollama_base)
    except Exception as e:
        logger.warning("RAG: query embedding failed: %s", e)
        return []

    def _query():
        CHROMA_DIR.mkdir(parents=True, exist_ok=True)
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
