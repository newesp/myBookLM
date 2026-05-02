---
name: llm-wiki
description: |
  Create or maintain an LLM Wiki — an LLM-managed knowledge layer organized
  by concepts, entities, summaries, comparisons, and synthesis pages (NOT by
  source structure). Trigger when the user wants to build a curated
  cross-source knowledge base, asks about implementing the Karpathy LLM Wiki
  pattern, needs a concept-centric reorganization of multiple raw sources,
  or wants to file good Q&A answers back into a maintained wiki. Provides
  conventions, prompt templates, and starter file templates that any
  application or Claude Code agent can consume.
schema_version: "1.0"
---

# LLM Wiki

A portable specification + prompt library for building an LLM-managed wiki layer
on top of immutable raw sources, following the three-layer architecture
described in Karpathy's LLM Wiki sketch.

This skill is **language-neutral**: it provides reference docs, prompt templates,
and file templates. Each consuming application implements its own runtime in
its own language. A Claude Code agent can also consume the same content
directly to help a user bootstrap or maintain a wiki interactively.

## Three-layer architecture

1. **Raw Sources** — immutable curated documents (PDFs, articles, transcripts).
   The LLM reads these but never modifies them.
2. **The Wiki** — a directory of LLM-generated markdown files: concept pages,
   entity pages, source summaries, comparisons, syntheses. The LLM owns this
   layer entirely. It creates pages, updates them when new sources arrive,
   maintains cross-references, and keeps everything consistent.
3. **The Schema** — the conventions, naming rules, and operational workflows
   that tell the LLM how to maintain the wiki. Lives in this skill (canonical)
   and is mirrored into each wiki's own `SKILL.md` (the maintenance manual that
   travels with the wiki).

## What's in this skill

- `reference/architecture.md` — the three-layer model in detail
- `reference/conventions.md` — file naming, page types, link format
- `reference/operations.md` — ingest, query, lint workflows
- `prompts/ingest-plan.md` — Pass 1 of ingest: plan operations
- `prompts/ingest-apply-create.md` — write a new page
- `prompts/ingest-apply-update.md` — update an existing page
- `prompts/query-pick-pages.md` — Pass 1 of query: choose which pages to read
- `prompts/query-answer.md` — Pass 2 of query: synthesize the answer
- `prompts/lint.md` — find contradictions, stale claims, orphan pages
- `templates/SKILL.md.tmpl` — initial wiki SKILL.md (schema baked in)
- `templates/index.md.tmpl` — empty index
- `templates/log.md.tmpl` — empty log

## How to use this skill

### As a Claude Code agent
When the user asks for an LLM Wiki, read `reference/` first to internalize the
model, then `prompts/` for the operational templates, then use `templates/` to
scaffold the wiki directory inside the user's project.

### As an application runtime
Vendor a copy of this skill into your project (e.g. `backend/skills/llm-wiki/`).
At runtime, read prompt files from disk and feed them to your LLM API. Pin
`schema_version` to detect drift if you later sync upstream.

## Wiki directory layout (canonical)

```
wiki/
├── SKILL.md          # the wiki's own maintenance manual (from templates/)
├── index.md          # auto-maintained catalog of all pages
├── log.md            # append-only operation log
├── concept/          # concept pages (e.g. attention.md)
├── entity/           # named entities (e.g. transformer.md)
├── summary/          # one page per ingested raw source
├── compare/          # comparison pages
└── synthesis/        # narrative cross-cutting summaries (incl. optional overview.md)
```

## Output contracts

The prompts in `prompts/` define structured outputs (JSON schemas) that
consuming code parses. If you change a prompt's output schema, bump
`schema_version` in this file's frontmatter so downstream vendored copies can
detect the mismatch.
