# Operations

Three primary operations: **ingest**, **query**, **lint**.

---

## Ingest

New information arrives from one of two sources:

- **Q&A**: a chat exchange (user question + assistant answer) the user wants to file
- **Source**: a raw source the user wants assimilated into the wiki

Both follow the same two-pass shape.

### Pass 1 — Plan (`prompts/ingest-plan.md`)

Inputs:
- The new content (Q&A pair or source summary)
- Current `index.md` (so the LLM knows what pages exist)
- Wiki `SKILL.md` (schema/conventions)

Output (JSON):
```json
{
  "operations": [
    {
      "action": "create",
      "type": "concept",
      "slug": "attention",
      "title": "Attention",
      "reason": "...",
      "content_brief": "..."
    },
    {
      "action": "update",
      "path": "entity/transformer.md",
      "reason": "...",
      "change_brief": "..."
    }
  ],
  "log_entry": "ingest qa=\"...\" pages_created=1 pages_updated=1"
}
```

### Pass 2 — Apply (`prompts/ingest-apply-create.md`, `prompts/ingest-apply-update.md`)

For each operation, one LLM call:
- **create**: produce full page content following the conventions, including
  the required header blockquote and `## Sources` section
- **update**: given the current page content + the new information + reason,
  produce the new full page content

Caller writes files, regenerates `index.md` deterministically (sort pages by
type then slug, pull description from each page's first prose paragraph), then
appends one line to `log.md`.

### Cost note

A typical ingest is 1 plan call + 2–4 apply calls. Use a cheaper model for
plan and the user's preferred model for apply, or use the cheaper one
throughout if budget-sensitive.

---

## Query

Two-pass retrieval against the wiki. The wiki has no embeddings — the LLM
itself navigates by reading `index.md` and following links.

### Pass 1 — Pick pages (`prompts/query-pick-pages.md`)

Inputs:
- User's question
- `index.md` content
- Wiki `SKILL.md` (so the LLM knows the page type semantics)

Output (JSON):
```json
{
  "pages": ["concept/attention.md", "entity/transformer.md"],
  "reasoning": "..."
}
```

### Pass 2 — Answer (`prompts/query-answer.md`)

Inputs:
- User's question
- The full text of every page selected in Pass 1
- Optionally: any other raw sources the user explicitly attached
- Wiki `SKILL.md` (the wrapping system prompt provided by the application)

Output: the natural-language answer, with citations to wiki pages.

The application is responsible for the system-prompt wrapper around the wiki
content (e.g. "this is your maintained wiki, prefer it over raw sources").
This wrapper is intentionally outside the prompt files because applications
will want to customize it — see your application's config for the template.

### Small-wiki shortcut

If the wiki is small (e.g. total content < 2000 tokens), Pass 1 can be
skipped: read all pages and inject them directly. The application implements
the threshold.

---

## Lint

Periodic maintenance pass. Reads a sample (or all) of the wiki and identifies:

- **Contradictions** between pages
- **Stale claims** that newer sources have superseded
- **Orphan pages** with no inbound links
- **Broken links** to nonexistent pages
- **Duplicates** (two pages covering the same concept)
- **Misclassified pages** (e.g. a `concept/` that is actually an `entity/`)

See `prompts/lint.md` for output format. Lint reports issues but does not
auto-apply fixes; the user reviews and approves changes (which then become
ingest-style update operations).

Lint is intentionally Phase 2; the core ingest+query loop works without it.
