"""PDF → chunk → embed via Ollama. Cosine similarity search at query time."""
import asyncio
import math
import re
import struct
from pathlib import Path

import httpx

from . import db
from .pdf_utils import extract_pages, pages_to_text

CHUNK_SIZE = 800
CHUNK_OVERLAP = 100
TOP_K = 8

_running_tasks: dict[int, asyncio.Task] = {}


def slugify_pdf(stem: str) -> str:
    s = re.sub(r"[^\w\s\-]", "", stem.lower())
    s = re.sub(r"[\s_]+", "-", s).strip("-")
    return (re.sub(r"-+", "-", s) or "source")[:60]


def chunk_text(text: str) -> list[str]:
    chunks = []
    start = 0
    while start < len(text):
        end = min(start + CHUNK_SIZE, len(text))
        chunks.append(text[start:end])
        if end == len(text):
            break
        start += CHUNK_SIZE - CHUNK_OVERLAP
    return chunks


async def embed_text(base_url: str, model: str, text: str) -> list[float]:
    url = base_url.rstrip("/") + "/api/embeddings"
    async with httpx.AsyncClient(timeout=120) as client:
        r = await client.post(url, json={"model": model, "prompt": text})
    if r.status_code != 200:
        raise RuntimeError(f"Ollama embedding error {r.status_code}: {r.text[:300]}")
    return r.json()["embedding"]


def _pack(vec: list[float]) -> bytes:
    return struct.pack(f"{len(vec)}f", *vec)


def _unpack(data: bytes) -> list[float]:
    n = len(data) // 4
    return list(struct.unpack(f"{n}f", data))


def _cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(x * x for x in b))
    return dot / (na * nb) if na and nb else 0.0


def has_embedding(slug: str) -> bool:
    with db.conn() as c:
        row = c.execute(
            "SELECT COUNT(*) as cnt FROM chunks WHERE source_slug=?", (slug,)
        ).fetchone()
    return bool(row and row["cnt"] > 0)


async def search_chunks(slug: str, query_vec: list[float], top_k: int = TOP_K) -> list[dict]:
    with db.conn() as c:
        rows = c.execute(
            "SELECT chunk_idx, text, embedding FROM chunks WHERE source_slug=? ORDER BY chunk_idx",
            (slug,),
        ).fetchall()
    results = []
    for row in rows:
        sim = _cosine(query_vec, _unpack(row["embedding"]))
        results.append({"chunk_idx": row["chunk_idx"], "text": row["text"], "score": sim})
    results.sort(key=lambda x: x["score"], reverse=True)
    return results[:top_k]


async def _run_embed_job(job_id: int, pdf_path: str, slug: str, ollama_cfg: dict) -> None:
    try:
        base_url = ollama_cfg.get("base_url") or "http://localhost:11434"
        model = ollama_cfg.get("embed_model") or "nomic-embed-text"

        _update_job(job_id, status="running", current_step="extracting_pdf", error=None)

        pages = extract_pages(Path(pdf_path))
        full_text = pages_to_text(pages)
        chunks = chunk_text(full_text)
        total = len(chunks)

        # Resume: skip chunks already in DB
        with db.conn() as c:
            row = c.execute(
                "SELECT COUNT(*) as cnt FROM chunks WHERE source_slug=?", (slug,)
            ).fetchone()
            start_idx = row["cnt"] if row else 0

        _update_job(job_id, total_chapters=total, completed_chapters=start_idx,
                    current_step=f"embedding_chunks")

        for i, chunk in enumerate(chunks):
            if i < start_idx:
                continue

            with db.conn() as c:
                row = c.execute("SELECT status FROM jobs WHERE id=?", (job_id,)).fetchone()
            if row and row["status"] in ("paused", "deleting"):
                return

            vec = await embed_text(base_url, model, chunk)
            with db.conn() as c:
                c.execute(
                    "INSERT INTO chunks (source_slug, chunk_idx, text, embedding) "
                    "VALUES (?, ?, ?, ?)",
                    (slug, i, chunk, _pack(vec)),
                )
                c.execute(
                    "UPDATE jobs SET completed_chapters=?, updated_at=? WHERE id=?",
                    (i + 1, db.now(), job_id),
                )
                c.commit()

        with db.conn() as c:
            row = c.execute("SELECT status FROM jobs WHERE id=?", (job_id,)).fetchone()
            if row and row["status"] not in ("paused", "deleting"):
                c.execute(
                    "UPDATE jobs SET status='done', current_step='completed', updated_at=? WHERE id=?",
                    (db.now(), job_id),
                )
                c.commit()

    except asyncio.CancelledError:
        _update_job(job_id, status="paused", current_step="cancelled")
        raise
    except Exception as e:
        _update_job(job_id, status="failed", error=f"{type(e).__name__}: {e}")
    finally:
        _running_tasks.pop(job_id, None)


def _update_job(job_id: int, **fields) -> None:
    if not fields:
        return
    fields["updated_at"] = db.now()
    sets = ",".join(f"{k}=?" for k in fields)
    with db.conn() as c:
        c.execute(f"UPDATE jobs SET {sets} WHERE id=?", [*fields.values(), job_id])
        c.commit()


async def start_embed_job(job_id: int, pdf_path: str, slug: str, ollama_cfg: dict) -> None:
    existing = _running_tasks.get(job_id)
    if existing and not existing.done():
        return
    task = asyncio.create_task(_run_embed_job(job_id, pdf_path, slug, ollama_cfg))
    _running_tasks[job_id] = task
