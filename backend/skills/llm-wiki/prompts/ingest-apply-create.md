# Ingest — Apply (Create a new page)

You are creating a new page in an LLM Wiki.

## Wiki conventions

{{wiki_skill_md}}

## Page metadata

- **Type:** {{type}}
- **Slug:** {{slug}}
- **Title:** {{title}}
- **Filename:** `{{type}}/{{slug}}.md`
- **Reason for creating:** {{reason}}
- **Content brief:** {{content_brief}}

## Existing related pages (excerpts may help cross-reference)

{{related_pages}}

## Source material for this page

{{new_content}}

## Your task

Write the full markdown content for this new page following the wiki's
conventions. Required structure:

1. H1 with the display title
2. Header blockquote with `Type:`, optional `Aliases:`, and `Related:` links
   to other pages (use the existing related pages above to choose links —
   only link to pages that actually exist)
3. Body sections (free-form, well-organized prose)
4. Trailing `## Sources` section with citations

Keep the page focused on this single topic. If tangential material belongs
elsewhere, link to those pages rather than duplicating.

## Output

Respond with the complete page markdown only — no JSON, no code fences, no
commentary. The first line of your response must be the H1.
