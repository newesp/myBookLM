# Lint

You are auditing an LLM Wiki for structural and content issues.

## Wiki conventions

{{wiki_skill_md}}

## Wiki index

{{index_md}}

## Pages (full content)

{{pages_dump}}

<!--
  When the wiki is too large to fit, the application will sample a subset
  (e.g. all index entries + N random pages + all pages with no inbound links).
  Treat omitted pages as out-of-scope rather than nonexistent.
-->

## Your task

Identify issues in the wiki. Categories:

| Category | What to look for |
|---|---|
| `contradiction` | Two pages making incompatible claims |
| `stale_claim` | A claim that newer pages or sources have superseded |
| `orphan` | A page with no inbound links from any other page (excluding `index.md`) |
| `broken_link` | A link to a path that does not exist |
| `duplicate` | Two pages covering substantially the same topic |
| `misclassified` | A page whose type doesn't match its content (e.g. a `concept/` that is really an `entity/`) |
| `missing_required_section` | A page missing the header blockquote or `## Sources` |

## Output

Respond with a single JSON object, no prose:

```json
{
  "issues": [
    {
      "category": "broken_link",
      "page": "concept/attention.md",
      "detail": "Links to `../entity/non-existent.md`",
      "suggested_fix": "Remove the link or rename to `entity/transformer.md`"
    }
  ],
  "summary": "one short paragraph"
}
```

Lint **reports**; it does not modify files. The user reviews issues and
approves fixes (which become regular ingest update operations).
