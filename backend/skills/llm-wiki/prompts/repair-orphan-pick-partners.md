# Repair — Pick partners for an orphan page

You are helping repair an LLM Wiki by adding cross-references to a page that
currently has no inbound links from any other page (an "orphan").

## Wiki conventions

{{wiki_skill_md}}

## Orphan page

Path: `{{orphan_path}}`

```markdown
{{orphan_content}}
```

## Existing pages (path · title · description)

{{pages_summary}}

## Your task

Pick **1-2 existing pages** that are most semantically related to the orphan
and that would naturally benefit from a link to it.

Selection criteria:
- The partner's topic must be genuinely related, not just superficially
- The partner's existing prose has a place where mentioning the orphan would
  enrich the explanation (i.e. you can imagine writing one sentence)
- Prefer partners of complementary types (e.g. a `concept/` orphan pairs well
  with an `entity/` that introduced the concept)
- Do NOT pick `index.md`, the orphan itself, or non-existent pages

If no good partners exist (the orphan is genuinely standalone or about a
topic no other page touches), return an empty list with a brief reason.

## Output

Respond with a single JSON object, no prose:

```json
{
  "partners": [
    {
      "path": "concept/foo.md",
      "reason": "the orphan introduces a sub-concept of this page"
    }
  ],
  "skip_reason": null
}
```

Page paths must be plain strings like `concept/foo.md` — do NOT wrap them
as markdown links.
