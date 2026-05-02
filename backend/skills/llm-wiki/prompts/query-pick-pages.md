# Query — Pick pages (Pass 1)

You are answering a user question against an LLM Wiki. First, decide which
wiki pages you need to read.

## Wiki conventions

{{wiki_skill_md}}

## Wiki index

{{index_md}}

## User question

{{question}}

## Your task

Choose the wiki pages most relevant to answering this question. Rules:

- Be **inclusive** — when in doubt, include the page. False negatives are
  worse than reading a few extra pages.
- Prefer pages whose topic is mentioned (directly or by close synonym) in
  the question
- Include comparison and synthesis pages when the question spans multiple
  concepts
- If the question is broad and many pages could apply, cap at ~8 pages and
  pick the most central ones
- If no wiki page is relevant, return an empty list — the application will
  fall back to other sources

## Output

Respond with a single JSON object, no prose:

```json
{
  "pages": ["concept/attention.md", "entity/transformer.md"],
  "reasoning": "one short sentence on why these"
}
```
