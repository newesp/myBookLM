# Ingest — Plan (Pass 1)

You are maintaining an LLM Wiki. New information has arrived. Decide which
wiki pages to create or update.

## Wiki conventions (from the wiki's SKILL.md)

{{wiki_skill_md}}

## Current index

{{index_md}}

## New information

Type: {{ingest_type}}    <!-- "qa" or "source" -->

{{new_content}}

## Your task

Decide what page-level operations are needed to assimilate this information.

Rules:
- Prefer **updating** existing pages over creating new ones when the topic
  already has a page
- Create a new page only when the topic is genuinely new to the wiki, or
  when an existing page would become unfocused if extended
- For each affected page, give a **brief** rationale and a **content brief**
  (1–3 sentences describing what the page should say or how it should change)
- Identify pages that should be updated to add cross-references to the new
  or changed content (the "ripple")
- Keep total operations small — usually 1 create + 1–3 updates is enough

## Output

Respond with a single JSON object, no prose, no code fences:

```json
{
  "operations": [
    {
      "action": "create",
      "type": "concept" | "entity" | "summary" | "compare" | "synthesis",
      "slug": "kebab-case-name",
      "title": "Display Title",
      "reason": "why this page is needed",
      "content_brief": "what the page should say"
    },
    {
      "action": "update",
      "path": "concept/attention.md",
      "reason": "why this page needs to change",
      "change_brief": "what to add or modify"
    }
  ],
  "log_entry": "ingest <type>=\"<short tag>\" pages_created=N pages_updated=M"
}
```

If no changes are warranted, return `{"operations": [], "log_entry": "ingest skipped: <reason>"}`.
