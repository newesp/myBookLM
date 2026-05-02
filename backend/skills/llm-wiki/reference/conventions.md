# Conventions

## Page types

| Type | Directory | Purpose | Example filename |
|------|-----------|---------|------------------|
| concept   | `concept/`   | An idea, mechanism, or pattern | `attention.md` |
| entity    | `entity/`    | A named thing (model, person, system, dataset) | `transformer.md` |
| summary   | `summary/`   | One per raw source — what it covers and key takeaways | `<source-slug>.md` |
| compare   | `compare/`   | Side-by-side analysis of two or more concepts/entities | `attention-vs-rnn.md` |
| synthesis | `synthesis/` | Narrative cross-cutting summary spanning many pages | `overview.md` |

A page's type is fixed once chosen; type changes happen only via lint.

## Filename rules

- ASCII, lowercase, kebab-case: `language-model.md`, not `Language Model.md`
- Singular nouns where possible: `transformer.md`, not `transformers.md`
- No prefixes — the directory already encodes the type
- Avoid abbreviations unless they are the canonical form (`gpt`, `rnn` are fine; `lm` is not)
- A page's H1 (top heading) can be in any language and is the human-friendly
  display title; the filename slug stays English

## Page structure

Every page should have:

```markdown
# <Display Title>

> **Type:** concept | entity | summary | compare | synthesis
> **Aliases:** alt-name-1, alt-name-2  (optional)
> **Related:** [Other Page](../entity/other.md), [Yet Another](another.md)

## <First substantive section>

...prose...

## Sources

- [<source-slug>](../summary/<source-slug>.md) — page 42, "section title"
- [<source-slug-2>](../summary/<source-slug-2>.md) — chapter 3
```

The blockquote with Type/Aliases/Related and the closing `## Sources` section
are required. Body sections in between are free-form.

## Cross-references

Use relative markdown links:

- Same directory: `[Attention](attention.md)`
- Other directory: `[Transformer](../entity/transformer.md)`
- From `index.md` (wiki root): `[Attention](concept/attention.md)`
- From `SKILL.md` (wiki root): same as `index.md`

Every cross-reference target must be an existing file. The lint operation
catches broken links.

## index.md

Authoritative catalog. Format:

```markdown
# Index

## Concepts
- [attention](concept/attention.md) — how transformers route information between tokens
- [tokenization](concept/tokenization.md) — splitting text into model inputs

## Entities
- [transformer](entity/transformer.md) — the architecture introduced in 2017

## Summaries
- [karpathy-llm-intro](summary/karpathy-llm-intro.md) — Karpathy's intro to LLMs

## Comparisons
- ...

## Syntheses
- ...
```

One section per type, alphabetical within each section. Each entry is one
line: link plus a one-line description (about 8–15 words). The ingest
operation regenerates this file deterministically from the directory listing
and per-page descriptions, so don't hand-edit the descriptions in two places —
the page itself is the source of truth and gets surfaced via the `description`
in the page's blockquote-style header (or the first prose sentence as a
fallback).

## log.md

Append-only. One line per operation, ISO-8601 timestamp prefix:

```
2026-05-02T14:23:00Z ingest source=karpathy-llm-intro pages_created=2 pages_updated=3
2026-05-02T14:25:11Z ingest qa="What is attention?" pages_created=1 pages_updated=1
2026-05-02T15:01:42Z lint issues=2 fixed=2
```

Prefixes (`ingest`, `lint`, `query`, etc.) keep the log parseable.
