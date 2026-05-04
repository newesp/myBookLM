# Ingest — Apply (Update an existing page)

You are updating an existing page in an LLM Wiki.

## Wiki conventions

{{wiki_skill_md}}

## Page being updated

- **Path:** {{path}}
- **Reason for update:** {{reason}}
- **Change brief:** {{change_brief}}

### Current content

```markdown
{{current_content}}
```

## Existing related pages (excerpts)

{{related_pages}}

## New information being assimilated

{{new_content}}

## Your task

Produce the full new content of the page. Rules:

- **Preserve** structure: H1, header blockquote, body sections, trailing `## Sources`
- **Integrate** the new information where it logically fits — extend existing
  sections, add a new section, or update claims that the new info refines
- **Update Related links** in the header blockquote if the change introduces
  meaningful new cross-references (only link to pages that actually exist)
- **Update the Sources section** to add citations for the new information.
  **Sources entries MUST be plain text — NO markdown links.** Reference raw
  resources by slug + chapter identifier:
  ```
  ## Sources

  - jed-mckenna-spiritually-incorrect-enlightenment §06 "Blues for Buddha"
  ```
  The slug is the stable id of the source PDF (it does not change when the
  resource is renamed in the UI). Do **not** use `[label](path.md)` inside
  Sources — those resolve to non-existent wiki pages and become broken links.
- Do **not** wholesale rewrite content that the new info doesn't touch
- Do **not** introduce contradictions; if the new info contradicts existing
  claims, prefer the new info but note the prior framing if it's still
  partially valid

## Output

Respond with the complete updated page markdown only — no JSON, no code
fences, no commentary. The first line of your response must be the H1.
