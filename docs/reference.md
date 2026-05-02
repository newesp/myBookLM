# myBookLM — Reference

Detailed tables and notes consulted only when working on specific subsystems.
See `CLAUDE.md` for the core architecture and gotchas.

---

## Database schema

```sql
jobs: id, pdf_path, book_title, skill_slug, skill_dir,
      status, job_type('skill'|'embedding'),
      current_step, total_chapters, completed_chapters, chapters_json,
      tokens_in, tokens_out, cost, error, provider, model,
      topic_id  -- which topic the produced source should be assigned to

conversations: id, title, created_at, updated_at, topic_id

messages: id, conversation_id, role, content,
          tokens_in, tokens_out, cost, sources_used, created_at

chunks: id, source_slug, chunk_idx, text, embedding BLOB
        INDEX idx_chunks_slug ON chunks(source_slug)

topics: id, name, created_at
        -- A "default" row is seeded by init_db (lowest id, name="預設").

source_topics: source_slug, topic_id   -- many-to-many; PK both columns
        INDEX idx_source_topics_topic, idx_source_topics_slug

source_pdf: slug PK, pdf_filename, created_at
        -- Records 'this slug came from this PDF'. Survives job-log deletion
        -- so the PDF panel can list its derived sources independently.
        -- Note: column is `slug` (not `source_slug`) for backward compat.
        INDEX idx_source_pdf_filename
```

### Migration history

`job_type`, `jobs.topic_id`, `conversations.topic_id`, and `source_pdf` were added after initial release — `init_db()` runs `ALTER TABLE` migrations for existing databases, backfills any null `conversations.topic_id` to the default topic, and backfills `source_pdf` from existing job rows (`os.path.basename(jobs.pdf_path)` keyed by `jobs.skill_slug`).

---

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

---

## Wiki API

All under `/api/wiki/*`. Wiki state is its own layer — not in `list_sources()`, unaffected by topics.

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/wiki/info` | `{exists, page_count, by_type, last_updated, index_summary, schema_version}` |
| GET | `/wiki/pages` | List of `{path, type, slug, title, description}` |
| GET | `/wiki/page?path=<type>/<slug>.md` | Read one page (path validated: `<type>/<slug>.md`, no `..`) |
| GET | `/wiki/index` | Raw `index.md` |
| GET | `/wiki/log` | Raw `log.md` |
| POST | `/wiki/init` | Manually scaffold (otherwise auto on first ingest) |
| POST | `/wiki/ingest/qa` | `{question, answer}` → Plan + Apply + regen index + append log; returns `{ok, operations, tokens_in, tokens_out, log_entry}` |

`config.json` wiki block: `system_prompt_template` (with `{{wiki_content}}` placeholder) and `page_separator`. Deep-merged on load; patchable via `POST /api/config { "wiki": {...} }`.

---

## Sources API (partial delete)

`DELETE /api/sources/{slug}?type=embedding|skill|all`

- omitted / `all` — full delete: files + chunks + topic/pdf links
- `embedding` — drop DB chunks only, keep SKILL.md/chapters/META.json and topic/pdf links
- `skill` — drop on-disk files only, keep DB chunks

Frontend ⋮ menu shows partial options only when the source has both types.

---

## Frontend conventions (detailed)

- `data-p="ollama" data-f="embed_model"` — settings input binding. `data-f` supports dot notation (`pricing.input_per_mtok`).
- `state.wikiInfo` is set by `loadSources()` (parallel `/api/wiki/info` fetch). `renderSources()` always prepends the wiki entry (CSS class `source-wiki`, badge `badge-wiki`) regardless of filter or topic. The "選取所有來源" checkbox includes the wiki sentinel when `wikiInfo.exists`; `syncSelectAll()` counts it in the total.
- Assistant messages render markdown via `renderMarkdown()` (marked.js); `.content.markdown-body` in CSS resets `white-space` and styles headings/lists/code/blockquote/table. User messages stay plain (`escapeHtml`).
- `state.topicId` (number, 0 = "全部") persisted in `localStorage` under `myBookLM.topicId`. Switching topics clears `state.selected` and `state.convId`.
- AI message actions: `📖 存入 Wiki` walks `previousElementSibling` to find the user message, then `POST /api/wiki/ingest/qa`. Settings binds wiki fields with `data-w="..."`.
- PDF button disable pattern: `runConvert()` disables both buttons + spinner; on success `loadJobs()` re-renders (buttons restore naturally); on error, re-enable manually.
- Sidebar width persisted in `localStorage` via the resizer drag handler.
