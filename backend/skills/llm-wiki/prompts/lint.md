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
| `broken_link` | See strict rules below |
| `duplicate` | Two pages covering substantially the same topic |
| `misclassified` | A page whose type doesn't match its content (e.g. a `concept/` that is really an `entity/`) |
| `missing_required_section` | See strict rules below |

### Strict rules for `broken_link`

**Only flag actual markdown link syntax** `[text](path)` where the resolved
relative `path` does NOT match any existing wiki page in this dump.

**The `## Sources` section is special**: its bullet entries are intentionally
plain-text references to the raw PDF resources (e.g.
`- jed-mckenna-notebook §06 "Blues for Buddha"`). These are NOT links to
wiki pages. They reference resource slugs that live outside the wiki layer,
so they are **never** broken_link issues regardless of whether they look
like paths.

Before flagging a broken_link, verify:
1. The line literally contains `[...](...)` syntax (not just plain text)
2. The text inside `()` does not resolve to a page in the dump
3. The line is NOT inside the `## Sources` section

### Strict rules for `missing_required_section`

**Before flagging this**, search the page text for the literal string
`## Sources` (case-sensitive, exactly two `#`). If you find it anywhere in
the page body, the section EXISTS and you must NOT report it as missing.

The same applies to the header blockquote — look for any line starting with
`> ` near the top of the page.

## Output

Respond with a single JSON object, no prose.

**Output budget**: list the most important issues, capped at **30 total**.
Order by severity: `broken_link` → `contradiction` → `duplicate` →
`stale_claim` → `orphan` → `misclassified` → `missing_required_section`. If
you would exceed 30, drop the least severe.

**Critical formatting rule** — every string value in this JSON must be plain
text, including `page`, `detail`, and `suggested_fix`:

- ✅ `"page": "concept/attention.md"`
- ✅ `"page": "entity/jed-mckenna.md"`
- ❌ `"page": "concept/[attention.md](http://attention.md)"`
- ❌ `"page": "entity/[jed-mckenna.md](http://jed-mckenna.md)"`
- ❌ `"detail": "Links to ../concept/[foo.md](anywhere)"`
- ❌ `"suggested_fix": "Rename to [bar.md](http://bar.md)"`

The literal characters `[` `]` `(` `)` MUST NOT surround any `.md` filename
in any field. Reference paths as bare strings only. This is the most common
failure mode — double-check every string before responding.

Keep `detail` and `suggested_fix` to **one short sentence each** (under
80 characters). Do not paste long lists of alternatives into `suggested_fix`.

Schema (placeholder values shown — DO NOT copy them literally):

```
{
  "issues": [
    { "category": <one of the categories above>,
      "page":     <wiki-relative path of the offending page>,
      "detail":   <one short sentence describing the SPECIFIC problem>,
      "suggested_fix": <one short sentence proposing how to fix it> }
  ],
  "summary": <one short paragraph>
}
```

**CRITICAL — do not parrot placeholder values**. Some LLMs copy example
strings verbatim when uncertain. Every value you emit MUST come from the
actual page dump above. In particular:

- Never report a broken link to `non-existent.md`, `placeholder.md`,
  `example.md`, or anything that does not literally appear inside `[...]()`
  syntax in some specific page in the dump
- If you cannot point to a real line in a real page, do NOT invent one to
  fill an issue slot
- An empty `"issues": []` is a valid (and welcome) response when the wiki
  is healthy

Lint **reports**; it does not modify files. The user reviews issues and
approves fixes (which become regular ingest update operations).
