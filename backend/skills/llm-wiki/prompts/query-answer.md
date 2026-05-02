# Query — Answer (Pass 2)

This prompt is the **page-injection block** consumed by the application's
chat flow. The application wraps it with its own system-prompt template
(see the application's wiki config) and may prepend or append additional
content (e.g. raw sources the user attached).

## Wiki pages selected for this question

{{selected_pages}}

<!--
  Each entry in {{selected_pages}} is preceded by a "## <path>" heading so
  the model knows which file each block came from. Cross-references inside
  the pages remain as relative links — the model can mention them in the
  answer but cannot follow them in this single-shot path.
-->

## Answering guidelines

- Prefer the wiki content above when answering. The wiki is the user's
  curated, cross-source synthesis — treat it as more authoritative than ad
  hoc retrieval would be.
- Cite specific pages by name (e.g. "see `concept/attention.md`") when a
  claim depends on one
- If the wiki is silent or contradictory on the question, say so explicitly
  rather than fabricating
- If raw sources are also provided by the application alongside this block,
  use them to fill gaps the wiki doesn't cover, and flag the gap so it can
  later be filed back into the wiki

## User question

{{question}}
