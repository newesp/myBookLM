# Repair — Merge two duplicate wiki pages

You are repairing an LLM Wiki where two pages cover substantially the same topic.

## Wiki conventions

{{wiki_skill_md}}

## Page A

Path: `{{path_a}}`

```markdown
{{content_a}}
```

## Page B

Path: `{{path_b}}`

```markdown
{{content_b}}
```

## Lint context

{{lint_context}}

## Your task

Decide which page should be kept as the **primary** (canonical) page and which
becomes a **secondary** redirect stub. Then produce the new content for both.

### Picking primary vs secondary

Selection criteria, in order:
1. Prefer the page with richer / more accurate content
2. Prefer the page whose `<type>/` subdir matches the merged content's nature
   (e.g. an `entity/` is correct for a person; a `concept/` for an abstraction)
3. Prefer the page with more inbound links (cited more often)
4. Tie-breaker: shorter path / earlier alphabetical order

### Producing `merged_content` (for primary)

- Combine unique information from both pages; deduplicate redundant statements
- Preserve every distinct citation and Sources entry from both pages
- Maintain the wiki page format exactly:
  - `# Title` (h1)
  - one-line `> blockquote header` summary
  - body content with cross-references
  - `## Sources` section (plain-text references — never markdown links)
- Keep the title appropriate for the primary path's subdir convention
- Length: comparable to the longer of the two original pages, not a sum

### Producing `secondary_content` (for secondary)

A short redirect stub:
- `# <secondary's original title>` (h1)
- one-line `> blockquote header` noting it's been merged
- body containing exactly: `→ 已併入 [<primary title>]({{relative link to primary}})`
- keep the original `## Sources` section as-is (sources still reference raw resources)

The relative link is computed as `../<primary path>` (every wiki page lives one level under the wiki root in its type subdir).

## Output

Respond with a single JSON object, no prose:

```json
{
  "primary": "<one of the two paths above>",
  "secondary": "<the other path>",
  "reasoning": "<one short sentence on why this is primary>",
  "merged_content": "<full markdown body for primary — multi-line, plain string>",
  "secondary_content": "<full markdown body for secondary stub — multi-line, plain string>"
}
```

**Critical rules**:
- `primary` and `secondary` MUST each be exactly one of `{{path_a}}` or `{{path_b}}`
  — no other paths, no markdown wrapping, no autolinks
- All string values are plain strings; do NOT nest JSON or arrays
- Page paths in any field must NEVER be wrapped as `[name](http://name.md)` —
  reference paths bare (e.g. `concept/foo.md`)
- `merged_content` and `secondary_content` are full page bodies, including
  the `# Title`, blockquote header, body, and `## Sources` sections
