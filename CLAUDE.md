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

On startup, any job with `status='running'` is reset to `'paused'` (lifespan handler in `backend/app.py`). Uvicorn runs with `reload=True` so backend edits take effect without a manual restart.

## Directory layers (three-layer model)

- **`books/`** — raw PDFs (immutable input)
- **`resources/`** — LLM-converted-from-PDF sources. **Renamed from `skills/`.** The variable name in code is `resources_dir` everywhere except the vendored skill path. App state: `app.state.resources_dir`.
- **`wiki/`** — LLM-managed knowledge layer. Sits at the project root, **not** inside `resources/`. Lazy-init from templates on first ingest. It is its own layer, not a "source" — it has its own routes (`/api/wiki/*`) and is not in `list_sources()`.

`backend/skills/llm-wiki/` is the vendored skill (specification + prompts + page templates) that powers the wiki layer. It is a separate concept from the `skills/` → `resources/` rename and stays under `backend/skills/`.

## Source types (sources in `resources/`)

| Type | Storage | Detected by |
|------|---------|-------------|
| skill.md | `resources/{slug}/SKILL.md` + `resources/{slug}/chapters/*.md` | File exists |
| embedding | `data/app.db` chunks table + `resources/{slug}/META.json` | DB chunks exist |
| Both | Both of the above | skill.md full-text injection takes priority in RAG |

## Key modules

**`backend/llm.py`** — `chat()` unified interface; four private functions `_claude / _gemini / _grok / _ollama`. Always use `or` for config fallbacks (`cfg.get("key") or "default"`), not `.get("key", "default")` — an empty string won't trigger the `.get()` default but will break the URL.

**`backend/embedding.py`** — `chunk_text()` (CHUNK_SIZE=800, OVERLAP=100) → Ollama `/api/embeddings` → pure-Python cosine similarity. `has_embedding(slug)` queries the DB. `_running_tasks` dict tracks asyncio Tasks (same pattern as `conversion.py`).

**`backend/chat.py`** — `build_source_context` is `async` (must `await` embed_text). skill.md sources get full-text injection; embedding-only sources get top-k retrieval. Ollama config is always read for embedding even when a different chat provider is active. The selected slugs list may also contain the sentinel `__wiki__` (matches `wiki.WIKI_SLUG_SENTINEL`); when present, `run_chat` runs `wiki.pick_pages` (Pass 1) and prepends a configurable system-prompt block built from those pages. The block template comes from `cfg["wiki"]["system_prompt_template"]` and is wrapped around `{{wiki_content}}`.

**`backend/wiki.py`** — LLM Wiki module. Owns `wiki_dir` (the `wiki/` directory at project root). `is_initialized()` checks for the wiki's SKILL.md; `initialize()` scaffolds from `backend/skills/llm-wiki/templates/`. `ingest_qa()` runs Plan (`prompts/ingest-plan.md`) → N × Apply (`ingest-apply-create.md` / `ingest-apply-update.md`) → deterministic `regenerate_index()` → `append_log()`. Per-wiki `asyncio.Lock` (`_lock_for`) serializes ingest. `pick_pages()` is Pass 1 of query (skipped when total wiki content < `SMALL_WIKI_CHAR_THRESHOLD`, currently 8000 chars — at that point all pages are returned). All page paths are validated through `_safe_rel_path()` (must be `<type>/<slug>.md`, no `..`). The vendored skill at `backend/skills/llm-wiki/` is the source of truth for prompts/templates; `_skill_schema_version()` reads its frontmatter so `/api/wiki/info` can surface drift.

**`backend/conversion.py`** — `slugify()` defined here (reuse it). `_running_tasks` dict. Chapter files are the checkpoint: if the file exists, the chapter is skipped on resume.

**`backend/sources.py`** — `delete_source(resources_dir, slug, kind=None)` supports partial deletion: `kind=None`/`"all"` removes the filesystem directory + DB chunks + source_topics + source_pdf rows; `kind="embedding"` drops only the chunks (keeps SKILL.md and topic/pdf links so the skill side survives); `kind="skill"` drops only the on-disk files (keeps chunks). The HTTP route is `DELETE /api/sources/{slug}?type=embedding|skill|all`. Frontend ⋮ menu shows the partial options only when the source has both types; otherwise just one "🗑 刪除" button. `list_sources(resources_dir, topic_id=None)` merges filesystem scan with a `GROUP BY source_slug` query on the chunks table; if `topic_id` is given (truthy), only sources whose `slug` is in `source_topics` for that topic are returned. **The wiki is never returned by `list_sources()`** — it is a separate layer. `link_source_pdf(slug, pdf_filename)` is idempotent (`ON CONFLICT DO UPDATE`); called by `conversion.py` and the embed route once the slug is final. `list_pdfs(books_dir, resources_dir)` annotates each PDF with `derived_sources` (skill/embedding rows pulled from `source_pdf`, with a `missing: true` flag for orphaned links).

**`backend/topics.py`** — Topic CRUD + many-to-many `source_topics` membership. `default_topic_id()` returns the lowest-id topic (seeded as "預設" by `init_db`). `add_source_to_topic(slug, topic_id)` is idempotent (`INSERT OR IGNORE`); jobs call it after the slug is finalized so newly-converted sources land in the topic the user was in. `delete_topic()` refuses to delete the default and reassigns its conversations to the default.

## Database schema highlights

```sql
jobs: id, pdf_path, book_title, skill_slug, skill_dir,
      status, job_type('skill'|'embedding'),
      current_step, total_chapters, completed_chapters, chapters_json,
      tokens_in, tokens_out, cost, error, provider, model,
      topic_id  -- which topic the produced source should be assigned to

conversations: id, title, created_at, updated_at, topic_id

chunks: id, source_slug, chunk_idx, text, embedding BLOB
        INDEX idx_chunks_slug ON chunks(source_slug)

topics: id, name, created_at
        -- A "default" row is seeded by init_db (lowest id, name="預設").

source_topics: source_slug, topic_id   -- many-to-many; PK both columns
        INDEX idx_source_topics_topic, idx_source_topics_slug

source_pdf: slug PK, pdf_filename, created_at
        -- Records 'this slug came from this PDF'. Survives job-log deletion
        -- so the PDF panel can list its derived sources independently.
        -- Note: column is `slug` (not `source_slug`) for backward compat
        -- with an earlier ad-hoc schema in the wild.
        INDEX idx_source_pdf_filename
```

`job_type`, `jobs.topic_id`, `conversations.topic_id`, and `source_pdf` were added after initial release — `init_db()` runs `ALTER TABLE` migrations for existing databases, backfills any null `conversations.topic_id` to the default topic, and backfills `source_pdf` from existing job rows (`os.path.basename(jobs.pdf_path)` keyed by `jobs.skill_slug`).

## Frontend conventions

- `data-p="ollama" data-f="embed_model"` — settings input binding. `data-f` supports dot notation (`pricing.input_per_mtok`).
- `state.selected` is a `Set<string>` of slugs. The sentinel `WIKI_SLUG = "__wiki__"` (mirrors `wiki.py::WIKI_SLUG_SENTINEL`) is added when the user checks the pinned LLM Wiki entry; the chat route peels it out before passing to `build_source_context`.
- `state.wikiInfo` is set by `loadSources()` (parallel `/api/wiki/info` fetch). `renderSources()` always prepends the wiki entry (CSS class `source-wiki`, badge `badge-wiki`) regardless of filter or topic — the wiki is cross-topic. The entry is disabled when `wikiInfo.exists === false`. The "選取所有來源" checkbox includes the wiki sentinel when the wiki exists; `syncSelectAll()` counts it in the total.
- Assistant chat messages render markdown via `renderMarkdown()` (marked.js); the bubble's `.content` div gets an extra `markdown-body` class and `styles.css` resets `white-space` plus styles headings/lists/code/blockquote/table for inline display. User messages stay plain (`escapeHtml`).
- `state.topicId` (number, 0 = "全部" / no filter) drives source + conversation filtering and is persisted in `localStorage` under `myBookLM.topicId`. Switching topics clears `state.selected` and `state.convId` so stale slugs/conversations don't leak across topics.
- AI message actions: `📖 存入 Wiki` walks `previousElementSibling` to find the matching user message, then `POST /api/wiki/ingest/qa`. Settings binds wiki fields with `data-w="..."` (mirrors the `data-p` provider pattern).
- PDF button disable pattern: `runConvert()` disables both buttons and shows a spinner; on success `loadJobs()` re-renders the list (buttons restore naturally); on error, buttons are re-enabled manually.
- Sidebar width is persisted in `localStorage` via the resizer drag handler.

## Topics API

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/topics` | List topics with `source_count` |
| POST | `/api/topics` | `{name}` → create |
| PATCH | `/api/topics/{id}` | `{name}` → rename |
| DELETE | `/api/topics/{id}` | Delete (rejects default; reassigns conversations) |
| GET | `/api/sources/{slug}/topics` | Returns `{slug, topic_ids: [..]}` |
| PUT | `/api/sources/{slug}/topics` | `{topic_ids: [..]}` → replace this source's topic memberships |
| PUT | `/api/topics/{id}/sources` | `{slugs: [..]}` → replace this topic's source list (preserves each slug's other topic memberships) |
| GET | `/api/sources?topic_id=N` | `topic_id=0` (or omitted) returns all |
| GET | `/api/conversations?topic_id=N` | Same convention |
| POST | `/api/conversations` | Body `{topic_id}` (defaults to default topic) |
| POST | `/api/jobs`, `/api/pdfs/embed`, `/api/sources/from-response` | Accept optional `topic_id`; the resulting source is auto-assigned |

## Wiki API

All under `/api/wiki/*`. Wiki state is its own layer — it is **not** in `list_sources()` and is unaffected by topics.

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/wiki/info` | `{exists, page_count, by_type, last_updated, index_summary, schema_version}` |
| GET | `/wiki/pages` | List of `{path, type, slug, title, description}` |
| GET | `/wiki/page?path=<type>/<slug>.md` | Read one page (path is validated against `<type>/<slug>.md`, no `..`) |
| GET | `/wiki/index` | Raw `index.md` |
| GET | `/wiki/log` | Raw `log.md` |
| POST | `/wiki/init` | Manually scaffold (otherwise auto on first ingest) |
| POST | `/wiki/ingest/qa` | `{question, answer}` → Plan + Apply + regen index + append log; returns `{ok, operations, tokens_in, tokens_out, log_entry}` |

`config.json` gains a `wiki` block: `system_prompt_template` (with `{{wiki_content}}` placeholder, default in `wiki.py::DEFAULT_SYSTEM_PROMPT_TEMPLATE`) and `page_separator`. Both are deep-merged on load and patchable via `POST /api/config { "wiki": {...} }`.

## Important notes

- `.gitignore` excludes `data/`, `books/*.pdf`, `resources/`, `wiki/`, `.venv/`
- `books/` keeps a `.gitkeep`
- Deleting an embedding job with `keep_files=False` removes DB chunks but only removes the directory if it has no `SKILL.md` (i.e. it is embedding-only)
- skill.md conversion requires a 7B+ LLM — 3B models reliably fail JSON planning
- Wiki ingest is multi-step (1 Plan + N Apply LLM calls) — each `📖 存入 Wiki` click costs tokens. The active provider's model is used; switch to a cheaper provider in Settings if budget-sensitive.
- The vendored skill at `backend/skills/llm-wiki/` is a copy of `~/.claude/skills/llm-wiki/`. To resync, copy from `~/.claude/skills/llm-wiki/` (or symlink during dev). `schema_version` in the SKILL.md frontmatter signals when downstream changes are needed.
