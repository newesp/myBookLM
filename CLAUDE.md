# myBookLM — Claude Code Development Guide

## Architecture

**Backend**: FastAPI + uvicorn. Single `app.py` entry point; all logic lives in `backend/` modules.  
**Frontend**: Vanilla HTML/CSS/JS, no build tool. Static files served from `/static`.  
**Database**: SQLite (`data/app.db`). Schema defined in `backend/db.py`.  
**Config**: `data/config.json`. Read/write logic in `backend/config.py` (deep-merge on load).

## Running

```bash
python app.py   # http://127.0.0.1:8765
```

On startup, any job with `status='running'` is reset to `'paused'` (lifespan handler in `backend/app.py`).

## Source types

| Type | Storage | Detected by |
|------|---------|-------------|
| skill.md | `skills/{slug}/SKILL.md` + `skills/{slug}/chapters/*.md` | File exists |
| embedding | `data/app.db` chunks table + `skills/{slug}/META.json` | DB chunks exist |
| Both | Both of the above | skill.md full-text injection takes priority in RAG |

## Key modules

**`backend/llm.py`** — `chat()` unified interface; four private functions `_claude / _gemini / _grok / _ollama`. Always use `or` for config fallbacks (`cfg.get("key") or "default"`), not `.get("key", "default")` — an empty string won't trigger the `.get()` default but will break the URL.

**`backend/embedding.py`** — `chunk_text()` (CHUNK_SIZE=800, OVERLAP=100) → Ollama `/api/embeddings` → pure-Python cosine similarity. `has_embedding(slug)` queries the DB. `_running_tasks` dict tracks asyncio Tasks (same pattern as `conversion.py`).

**`backend/chat.py`** — `build_source_context` is `async` (must `await` embed_text). skill.md sources get full-text injection; embedding-only sources get top-k retrieval. Ollama config is always read for embedding even when a different chat provider is active.

**`backend/conversion.py`** — `slugify()` defined here (reuse it). `_running_tasks` dict. Chapter files are the checkpoint: if the file exists, the chapter is skipped on resume.

**`backend/sources.py`** — `delete_source()` removes both the filesystem directory and DB chunks. `list_sources()` merges filesystem scan with a `GROUP BY source_slug` query on the chunks table.

## Database schema highlights

```sql
jobs: id, pdf_path, book_title, skill_slug, skill_dir,
      status, job_type('skill'|'embedding'),
      current_step, total_chapters, completed_chapters, chapters_json,
      tokens_in, tokens_out, cost, error, provider, model

chunks: id, source_slug, chunk_idx, text, embedding BLOB
        INDEX idx_chunks_slug ON chunks(source_slug)
```

`job_type` was added after initial release — `init_db()` runs an `ALTER TABLE` migration for existing databases.

## Frontend conventions

- `data-p="ollama" data-f="embed_model"` — settings input binding. `data-f` supports dot notation (`pricing.input_per_mtok`).
- `state.selected` is a `Set<string>` of slugs.
- PDF button disable pattern: `runConvert()` disables both buttons and shows a spinner; on success `loadJobs()` re-renders the list (buttons restore naturally); on error, buttons are re-enabled manually.
- Sidebar width is persisted in `localStorage` via the resizer drag handler.

## Important notes

- `.gitignore` excludes `data/`, `books/*.pdf`, `skills/`, `.venv/`
- `books/` keeps a `.gitkeep`
- Deleting an embedding job with `keep_files=False` removes DB chunks but only removes the directory if it has no `SKILL.md` (i.e. it is embedding-only)
- skill.md conversion requires a 7B+ LLM — 3B models reliably fail JSON planning
