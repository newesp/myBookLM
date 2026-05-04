# myBookLM — Claude Code Development Guide

> **Maintenance rule**: this file is loaded into context every Claude Code
> session, so keep it lean. Only put information that is needed for **most**
> tasks here (architecture overview, key gotchas that prevent bugs, sentinel
> constants). Subsystem-specific reference material — full API tables, DB
> schema, frontend conventions, planned features — lives in:
> - `docs/reference.md` — DB schema, API tables, detailed frontend notes
> - `docs/future-features.md` — designed-but-not-yet-implemented work
> 
> When adding new docs, ask: "would Claude need this on EVERY task?" If no,
> put it in `docs/`.

## Architecture

**Backend**: FastAPI + uvicorn. Single `app.py` entry point; all logic lives in `backend/` modules.  
**Frontend**: Vanilla HTML/CSS/JS, no build tool. Static files served from `/static`.  
**Database**: SQLite (`data/app.db`). Schema in `backend/db.py`.  
**Config**: `data/config.json`. Read/write in `backend/config.py` (deep-merge on load).

## Running

```bash
python app.py   # http://127.0.0.1:8765
```

Uvicorn runs with `reload=True`. On startup, any `status='running'` job is reset to `'paused'`.

## Directory layers

- **`books/`** — raw PDFs (immutable input)
- **`resources/`** — LLM-converted sources (renamed from `skills/`). Variable is `resources_dir` everywhere; app state: `app.state.resources_dir`.
- **`wiki/`** — LLM-managed knowledge layer at project root. Not in `list_sources()`. Own routes at `/api/wiki/*`. Lazy-init from templates on first ingest.

`backend/skills/llm-wiki/` is the vendored skill powering the wiki layer — separate concept from the `skills/` → `resources/` rename, stays under `backend/skills/`.

## Source types

| Type | Storage | Detected by |
|------|---------|-------------|
| skill.md | `resources/{slug}/SKILL.md` + `resources/{slug}/chapters/*.md` | File exists |
| embedding | `data/app.db` chunks table + `resources/{slug}/META.json` | DB chunks exist |
| Both | Both of the above | skill.md full-text injection takes priority in RAG |

## Key modules

**`backend/llm.py`** — `chat()` unified interface. Always use `or` for config fallbacks (`cfg.get("key") or "default"`), not `.get("key", "default")` — empty string won't trigger the default but will break the URL.

**`backend/embedding.py`** — `chunk_text()` (CHUNK_SIZE=800, OVERLAP=100) → Ollama `/api/embeddings` → cosine similarity. `has_embedding(slug)` checks DB. `_running_tasks` dict (same pattern as `conversion.py`).

**`backend/chat.py`** — `build_source_context` is `async`. skill.md → full-text injection; embedding-only → top-k retrieval. Ollama config always read for embedding even when another chat provider is active. Sentinel `__wiki__` in slugs list triggers wiki two-pass retrieval (Pass 1: `pick_pages`; Pass 2: inject block from `cfg["wiki"]["system_prompt_template"]`).

**`backend/wiki.py`** — `ingest_qa()` runs Plan → N × Apply → `regenerate_index()` → `append_log()`. Per-wiki `asyncio.Lock`. `pick_pages()` skipped when total wiki content < 8000 chars (dumps all pages). Paths validated via `_safe_rel_path()` (`<type>/<slug>.md`, no `..`). `find_broken_links()` scans every page after ingest and on every `/wiki/info` call; surfaces count + sample list to frontend, also writes `⚠ broken links: N` to log.md. `deterministic_lint()` runs cheap structural checks (broken_link / orphan / empty_page / missing_h1 / missing_header_blockquote / missing_sources_section); `llm_lint()` dumps pages (capped at `LINT_PAGES_DUMP_BUDGET=50000` chars) into the `lint.md` prompt and returns semantic findings (duplicate/contradiction/stale_claim/misclassified). `unlink_broken(from, to)` rewrites a single page in place, replacing every `[text](href)` whose href resolves to `to` with bare `text`; idempotent (returns `removed=0` when nothing matches). Used by the per-issue 🔧 button and the bulk-fix flow. `migrate_sources_to_plaintext()` flattens markdown links inside every page's `## Sources` section to plain text — Sources should reference raw resources by stable slug + chapter (e.g. `jed-mckenna-notebook §06 "Blues for Buddha"`), never as `[label](path.md)`. The `ingest-apply-create.md` / `ingest-apply-update.md` prompts also enforce this rule when writing new pages. `repair_orphan(orphan_path, cfg)` runs the `repair-orphan-pick-partners` prompt to pick 1-2 partner pages, then runs `ingest-apply-update` on the orphan + each partner to add bidirectional cross-references; per-wiki lock prevents racing with ingest.

**`backend/conversion.py`** — `slugify()` defined here (reuse it). Chapter files are the resume checkpoint — existing files are skipped.

**`backend/sources.py`** — `delete_source(resources_dir, slug, kind=None)`: `kind=None/"all"` = full delete; `kind="embedding"` = chunks only; `kind="skill"` = files only. Route: `DELETE /api/sources/{slug}?type=embedding|skill|all`. `list_sources()` never returns the wiki. `link_source_pdf()` is idempotent.

**`backend/topics.py`** — `default_topic_id()` returns lowest-id topic. `add_source_to_topic()` is idempotent (`INSERT OR IGNORE`).

## Frontend — key sentinels

- `WIKI_SLUG = "__wiki__"` — mirrors `wiki.WIKI_SLUG_SENTINEL`; peeled out before `build_source_context`.
- `state.selected` (`Set<string>`) — includes `WIKI_SLUG` when wiki checkbox checked. `syncSelectAll()` counts wiki in total when `wikiInfo.exists`.
- `state.topicId` (0 = "全部") — persisted in `localStorage`. Switching topic clears `state.selected` and `state.convId`.
- `data-p` / `data-f` — provider settings binding. `data-w` — wiki settings binding.

## Important notes

- `.gitignore` excludes `data/`, `books/*.pdf`, `resources/`, `wiki/`, `.venv/`
- `books/` keeps a `.gitkeep`
- skill.md conversion requires a 7B+ LLM — 3B models reliably fail JSON planning
- Wiki ingest = 1 Plan + N Apply LLM calls per click. Use a cheaper provider if budget-sensitive.
- Vendored skill `backend/skills/llm-wiki/` is a copy of `~/.claude/skills/llm-wiki/`. `schema_version` in frontmatter signals drift.
- Deleting an embedding job removes DB chunks; only removes the directory if no `SKILL.md` present.
- PDF text extraction (`pdf_utils.py`) returns empty for scanned/image PDFs — no OCR fallback. Embedding those produces garbage chunks.
