# Architecture

The LLM Wiki sits between raw sources and the user, as a curated, LLM-owned
knowledge layer.

```
┌──────────────────────────────────────────────────────────┐
│  Raw Sources (immutable)                                 │
│  Books, papers, articles, transcripts                    │
└──────────────────────────────────────────────────────────┘
                          │
                          │ ingest
                          ▼
┌──────────────────────────────────────────────────────────┐
│  The Wiki (LLM-owned, mutable)                           │
│  concept/ entity/ summary/ compare/ synthesis/           │
│  + index.md, log.md, SKILL.md                            │
└──────────────────────────────────────────────────────────┘
                          │
                          │ query
                          ▼
                        User
```

## Why a wiki layer

A single concept (e.g. "attention") often appears in many raw sources, each
with partial or contradictory takes. Direct RAG over raw chunks gives
fragmented, source-shaped answers. The wiki layer **rewrites** that knowledge
into concept-shaped pages: one page per concept, synthesizing across all
sources, with explicit cross-references.

## Properties

- **Source-derived but source-independent in shape.** A wiki page is organized
  by topic, not by which source it came from. The `summary/` directory is
  the only place where pages map 1:1 to raw sources.
- **Mutable and append-friendly.** New sources or new Q&A answers extend
  existing pages or create new ones. Pages are rewritten in place.
- **Self-describing.** The wiki carries its own `SKILL.md` (maintenance
  manual), `index.md` (catalog), and `log.md` (history). A new LLM picking up
  the wiki can read these three to understand its state and conventions.
- **Cross-linked.** Pages reference each other via standard relative markdown
  links. The `index.md` is the authoritative list of what exists.

## What the LLM does

The LLM owns the wiki layer. Specifically:
- Decides whether new information goes into an existing page or a new page
- Names new pages following the schema's conventions
- Updates other pages that should now cross-reference the new content
- Keeps `index.md` in sync
- Appends every operation to `log.md`
- Periodically lints for contradictions, stale claims, and orphan pages

## What the user does

- Curates the raw sources
- Asks questions (which become wiki queries; good answers can be filed back)
- Reviews wiki pages when curious; can edit by hand if desired
- Triggers lint passes
- Can edit the wiki's own SKILL.md to adjust conventions
