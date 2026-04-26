import json
import re
import shutil
import time
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Request, HTTPException, UploadFile, File
from pydantic import BaseModel

from . import db, config as cfgmod, sources, conversion, chat as chatmod, embedding as embmod, topics as topicmod

router = APIRouter()


# ---------- Config ----------

class ConfigUpdate(BaseModel):
    active_provider: Optional[str] = None
    providers: Optional[dict] = None


@router.get("/config")
def get_config(request: Request):
    return cfgmod.load_config(request.app.state.config_path)


@router.post("/config")
def update_config(body: ConfigUpdate, request: Request):
    cfg = cfgmod.load_config(request.app.state.config_path)
    if body.active_provider:
        cfg["active_provider"] = body.active_provider
    if body.providers:
        for name, updates in body.providers.items():
            if name not in cfg["providers"]:
                continue
            for k, v in updates.items():
                if k == "pricing" and isinstance(v, dict):
                    cfg["providers"][name].setdefault("pricing", {})
                    cfg["providers"][name]["pricing"].update(v)
                else:
                    cfg["providers"][name][k] = v
    cfgmod.save_config(request.app.state.config_path, cfg)
    return cfg


# ---------- Sources ----------

@router.get("/sources")
def get_sources(request: Request, topic_id: int = 0):
    tid = topic_id if topic_id and topic_id > 0 else None
    return sources.list_sources(request.app.state.skills_dir, topic_id=tid)


@router.delete("/sources/{slug}")
def delete_source(slug: str, request: Request):
    ok = sources.delete_source(request.app.state.skills_dir, slug)
    if not ok:
        # May have been embedding-only (no files) — still OK if chunks were deleted
        pass
    return {"ok": True}


@router.get("/sources/{slug}/content")
def get_source_content(slug: str, request: Request):
    return sources.get_source_content(request.app.state.skills_dir, slug)


class RenameSource(BaseModel):
    name: str


@router.patch("/sources/{slug}")
def rename_source(slug: str, body: RenameSource, request: Request):
    new_name = body.name.strip()
    if not new_name:
        raise HTTPException(400, "Name cannot be empty")
    sources.rename_source(request.app.state.skills_dir, slug, new_name)
    return {"ok": True, "slug": slug, "name": new_name}


class SaveAsSourceBody(BaseModel):
    content: str
    title: str
    topic_id: Optional[int] = None


@router.post("/sources/from-response")
def save_from_response(body: SaveAsSourceBody, request: Request):
    raw = re.sub(r"[^\w\s\-]", "", body.title.lower())
    raw = re.sub(r"[\s_]+", "-", raw).strip("-")
    raw = re.sub(r"-+", "-", raw)[:40] or "note"
    slug = f"note-{raw}-{int(time.time()) % 1_000_000}"

    skill_dir = request.app.state.skills_dir / slug
    skill_dir.mkdir(parents=True, exist_ok=True)

    skill_md = f"""---
name: {body.title}
description: 由 AI 回答儲存的筆記。Use this skill when users ask about topics covered in this note.
type: note
---

# {body.title}

{body.content}
"""
    (skill_dir / "SKILL.md").write_text(skill_md, encoding="utf-8")
    tid = body.topic_id or topicmod.default_topic_id()
    topicmod.add_source_to_topic(slug, tid)
    return {"ok": True, "slug": slug, "name": body.title}


# ---------- Topics ----------

@router.get("/topics")
def get_topics():
    return topicmod.list_topics()


class TopicCreate(BaseModel):
    name: str


@router.post("/topics")
def create_topic(body: TopicCreate):
    try:
        return topicmod.create_topic(body.name)
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.patch("/topics/{topic_id}")
def patch_topic(topic_id: int, body: TopicCreate):
    try:
        topicmod.rename_topic(topic_id, body.name)
        return {"ok": True}
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.delete("/topics/{topic_id}")
def remove_topic(topic_id: int):
    try:
        topicmod.delete_topic(topic_id)
        return {"ok": True}
    except ValueError as e:
        raise HTTPException(400, str(e))


# Per-source topic membership
@router.get("/sources/{slug}/topics")
def get_source_topics(slug: str):
    return {"slug": slug, "topic_ids": topicmod.get_source_topics(slug)}


class SetSourceTopics(BaseModel):
    topic_ids: list[int]


@router.put("/sources/{slug}/topics")
def put_source_topics(slug: str, body: SetSourceTopics):
    topicmod.set_source_topics(slug, body.topic_ids)
    return {"ok": True}


# Per-topic source membership (batch assign sources to a topic)
class SetTopicSources(BaseModel):
    slugs: list[str]


@router.put("/topics/{topic_id}/sources")
def put_topic_sources(topic_id: int, body: SetTopicSources):
    topicmod.set_topic_sources(topic_id, body.slugs)
    return {"ok": True}


# ---------- PDFs ----------

@router.get("/pdfs")
def get_pdfs(request: Request):
    return sources.list_pdfs(request.app.state.books_dir)


@router.post("/pdfs/upload")
async def upload_pdf(request: Request, file: UploadFile = File(...)):
    if not file.filename.lower().endswith(".pdf"):
        raise HTTPException(400, "Only PDF files are accepted")
    dest = request.app.state.books_dir / file.filename
    with open(dest, "wb") as out:
        while True:
            chunk = await file.read(8192)
            if not chunk:
                break
            out.write(chunk)
    return {"ok": True, "name": file.filename}


# ---------- Jobs ----------

class StartJob(BaseModel):
    pdf_filename: str
    topic_id: Optional[int] = None


@router.get("/jobs")
def list_jobs():
    with db.conn() as c:
        rows = c.execute("SELECT * FROM jobs ORDER BY id DESC").fetchall()
    return [dict(r) for r in rows]


@router.post("/jobs")
async def create_job(body: StartJob, request: Request):
    pdf_path = request.app.state.books_dir / body.pdf_filename
    if not pdf_path.exists():
        raise HTTPException(404, "PDF not found in books/")
    cfg = cfgmod.load_config(request.app.state.config_path)
    provider = cfg["active_provider"]
    pcfg = cfg["providers"][provider]
    model = pcfg.get("model", "")
    tid = body.topic_id or topicmod.default_topic_id()
    with db.conn() as c:
        cur = c.execute(
            "INSERT INTO jobs (pdf_path, status, job_type, provider, model, topic_id, created_at, updated_at) "
            "VALUES (?, 'pending', 'skill', ?, ?, ?, ?, ?)",
            (str(pdf_path), provider, model, tid, db.now(), db.now()),
        )
        job_id = cur.lastrowid
        c.commit()
    paths = {
        "skills_dir": str(request.app.state.skills_dir),
        "books_dir": str(request.app.state.books_dir),
    }
    await conversion.start_job(job_id, paths, cfg)
    return {"job_id": job_id}


@router.post("/pdfs/embed")
async def create_embed_job(body: StartJob, request: Request):
    pdf_path = request.app.state.books_dir / body.pdf_filename
    if not pdf_path.exists():
        raise HTTPException(404, "PDF not found in books/")
    cfg = cfgmod.load_config(request.app.state.config_path)
    ollama_cfg = cfg["providers"]["ollama"]

    slug = embmod.slugify_pdf(pdf_path.stem)
    skill_dir = request.app.state.skills_dir / slug
    skill_dir.mkdir(parents=True, exist_ok=True)

    # Write META.json so the source appears in the list even without SKILL.md
    if not (skill_dir / "SKILL.md").exists():
        meta = {"name": pdf_path.stem.replace("_", " ").replace("-", " "), "slug": slug}
        (skill_dir / "META.json").write_text(
            json.dumps(meta, ensure_ascii=False), encoding="utf-8"
        )

    model = ollama_cfg.get("embed_model", "nomic-embed-text")
    tid = body.topic_id or topicmod.default_topic_id()
    with db.conn() as c:
        cur = c.execute(
            "INSERT INTO jobs (pdf_path, book_title, skill_slug, skill_dir, status, "
            "job_type, provider, model, topic_id, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, 'pending', 'embedding', 'ollama', ?, ?, ?, ?)",
            (str(pdf_path), pdf_path.stem, slug, str(skill_dir), model, tid, db.now(), db.now()),
        )
        job_id = cur.lastrowid
        c.commit()
    # Slug is known up-front for embedding jobs — assign immediately.
    topicmod.add_source_to_topic(slug, tid)

    await embmod.start_embed_job(job_id, str(pdf_path), slug, ollama_cfg)
    return {"job_id": job_id}


@router.post("/jobs/{job_id}/pause")
def pause_job(job_id: int):
    with db.conn() as c:
        c.execute(
            "UPDATE jobs SET status='paused', updated_at=? "
            "WHERE id=? AND status='running'",
            (db.now(), job_id),
        )
        c.commit()
    return {"ok": True}


@router.post("/jobs/{job_id}/resume")
async def resume_job(job_id: int, request: Request):
    cfg = cfgmod.load_config(request.app.state.config_path)
    with db.conn() as c:
        row = c.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
    if not row:
        raise HTTPException(404)
    if row["status"] not in ("paused", "failed", "pending"):
        raise HTTPException(400, f"Cannot resume a job in status '{row['status']}'")

    job_type = row["job_type"] if "job_type" in row.keys() else "skill"

    if job_type == "embedding":
        ollama_cfg = cfg["providers"]["ollama"]
        model = ollama_cfg.get("embed_model", "nomic-embed-text")
        with db.conn() as c:
            c.execute(
                "UPDATE jobs SET model=?, error=NULL, updated_at=? WHERE id=?",
                (model, db.now(), job_id),
            )
            c.commit()
        await embmod.start_embed_job(job_id, row["pdf_path"], row["skill_slug"], ollama_cfg)
    else:
        provider = cfg["active_provider"]
        model = cfg["providers"][provider].get("model", "")
        with db.conn() as c:
            c.execute(
                "UPDATE jobs SET provider=?, model=?, error=NULL, updated_at=? WHERE id=?",
                (provider, model, db.now(), job_id),
            )
            c.commit()
        paths = {
            "skills_dir": str(request.app.state.skills_dir),
            "books_dir": str(request.app.state.books_dir),
        }
        await conversion.start_job(job_id, paths, cfg)

    return {"ok": True}


@router.delete("/jobs/{job_id}")
def delete_job(job_id: int, keep_files: bool = False):
    with db.conn() as c:
        row = c.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        if not row:
            raise HTTPException(404)
        c.execute("UPDATE jobs SET status='deleting' WHERE id=?", (job_id,))
        c.commit()

    job_type = row["job_type"] if "job_type" in row.keys() else "skill"

    # Cancel running task
    if job_type == "embedding":
        task = embmod._running_tasks.get(job_id)
    else:
        task = conversion._running_tasks.get(job_id)
    if task:
        task.cancel()

    with db.conn() as c:
        c.execute("DELETE FROM jobs WHERE id=?", (job_id,))
        c.commit()

    if not keep_files:
        if job_type == "embedding":
            slug = row["skill_slug"]
            if slug:
                with db.conn() as c:
                    c.execute("DELETE FROM chunks WHERE source_slug=?", (slug,))
                    c.commit()
                # Remove directory only if it has no SKILL.md (embedding-only)
                sd = Path(row["skill_dir"]) if row["skill_dir"] else None
                if sd and sd.exists() and not (sd / "SKILL.md").exists():
                    shutil.rmtree(sd, ignore_errors=True)
        else:
            if row["skill_dir"]:
                sd = Path(row["skill_dir"])
                if sd.exists():
                    shutil.rmtree(sd, ignore_errors=True)

    return {"ok": True}


# ---------- Conversations ----------

@router.get("/conversations")
def list_convs(topic_id: int = 0):
    if topic_id and topic_id > 0:
        with db.conn() as c:
            rows = c.execute(
                "SELECT * FROM conversations WHERE topic_id=? ORDER BY updated_at DESC",
                (topic_id,),
            ).fetchall()
    else:
        with db.conn() as c:
            rows = c.execute(
                "SELECT * FROM conversations ORDER BY updated_at DESC"
            ).fetchall()
    return [dict(r) for r in rows]


class CreateConv(BaseModel):
    topic_id: Optional[int] = None


@router.post("/conversations")
def create_conv(body: CreateConv | None = None):
    tid = (body.topic_id if body else None) or topicmod.default_topic_id()
    with db.conn() as c:
        cur = c.execute(
            "INSERT INTO conversations (title, topic_id, created_at, updated_at) VALUES (?, ?, ?, ?)",
            ("新對話", tid, db.now(), db.now()),
        )
        cid = cur.lastrowid
        c.commit()
    return {"id": cid, "title": "新對話", "topic_id": tid}


@router.get("/conversations/{cid}/messages")
def get_messages(cid: int):
    with db.conn() as c:
        rows = c.execute(
            "SELECT * FROM messages WHERE conversation_id=? ORDER BY id ASC",
            (cid,),
        ).fetchall()
    return [dict(r) for r in rows]


@router.delete("/conversations/{cid}")
def delete_conv(cid: int):
    with db.conn() as c:
        c.execute("DELETE FROM conversations WHERE id=?", (cid,))
        c.commit()
    return {"ok": True}


@router.post("/conversations/{cid}/clear")
def clear_conv(cid: int):
    with db.conn() as c:
        c.execute("DELETE FROM messages WHERE conversation_id=?", (cid,))
        c.commit()
    return {"ok": True}


# ---------- Chat ----------

class ChatRequest(BaseModel):
    conversation_id: int
    message: str
    sources: list[str] = []


@router.post("/chat")
async def send_chat(body: ChatRequest, request: Request):
    cfg = cfgmod.load_config(request.app.state.config_path)
    try:
        return await chatmod.run_chat(
            body.conversation_id, body.message, body.sources,
            request.app.state.skills_dir, cfg,
        )
    except Exception as e:
        raise HTTPException(500, f"{type(e).__name__}: {e}")
