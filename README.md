# myBookLM

A local alternative to NotebookLM. The purpose is not to replicate NotebookLM’s functionality, but rather to enable choosing different AI providers for information retrieval and answering questions.

## Features

- **PDF → Skill.md**: Use an LLM to rewrite a PDF as structured chapter knowledge files (slow, high quality, great for deep reading)
- **PDF → Embedding**: Vectorize PDF text directly for similarity-based retrieval at query time (fast, 30–90 seconds, preserves original text)
- **Hybrid RAG chat**: Select sources in the left panel; chat uses full-text injection for skill.md sources and top-k retrieval for embedding sources
- **LLM Wiki**: An LLM-managed knowledge layer (concept / entity / summary / compare / synthesis pages) sitting on top of raw resources. Click 📖 存入 Wiki on any AI reply to file the Q&A back as wiki pages; check the pinned wiki entry in the source list to query it. No embeddings — the LLM navigates by reading `index.md` and following links. Powered by the [llm-wiki skill](backend/skills/llm-wiki/) which is portable to other projects.
- **Save as source**: Save any AI reply as a new mini skill.md source
- **Topics**: Group sources by topic — pick a topic in the sidebar to scope the source list and conversation history; sources can belong to multiple topics
- **Multiple AI providers**: Claude / Gemini / Grok / Ollama (local) — switchable at any time
- **Conversation management**: Multiple conversations, clear history, token and cost display per message
- **Job management**: Conversions can be paused, resumed, and deleted (single or bulk-clear all completed log rows); resumes automatically from the last completed chapter after restart

## Installation

**Requirements**: Python 3.10+, [Ollama](https://ollama.com) (for local inference and embedding)

```bash
# 1. Install Python dependencies (choose one)

# Option A: Conda (recommended)
conda create --name myBookLm python=3.11 -y
conda activate myBookLm
pip install -r requirements.txt

# Option B: venv
python -m venv .venv
.venv\Scripts\activate        # Windows
# source .venv/bin/activate   # macOS / Linux
pip install -r requirements.txt

# 2. Pull the embedding model (free, local)
ollama pull nomic-embed-text

# 3. Optional: pull a chat model for fully local use (requires 8 GB+ RAM)
ollama pull qwen2.5:7b
```

## Start

```bash
python app.py
```

Open **http://127.0.0.1:8765** in your browser.

## Project Structure

```
myBookLM/
├── app.py              # Entry point (uvicorn)
├── backend/
│   ├── app.py          # FastAPI app factory
│   ├── routes.py       # REST API endpoints
│   ├── chat.py         # RAG logic (skill.md full-text + embedding top-k + wiki two-pass)
│   ├── conversion.py   # PDF → skill.md pipeline (multi-step LLM)
│   ├── embedding.py    # PDF → embedding (Ollama nomic-embed-text)
│   ├── llm.py          # Unified LLM interface (4 providers)
│   ├── sources.py      # Source listing and deletion (clears DB chunks too)
│   ├── topics.py       # Topic CRUD + many-to-many source membership
│   ├── wiki.py         # LLM Wiki: ingest (Plan+Apply), Pass 1 page picking, info
│   ├── pdf_utils.py    # PDF text extraction (pypdf)
│   ├── config.py       # Config read/write (data/config.json)
│   ├── db.py           # SQLite schema (jobs / conversations / messages / chunks)
│   └── skills/
│       └── llm-wiki/   # Vendored skill: prompts, reference docs, page templates
├── frontend/
│   ├── index.html
│   ├── styles.css
│   └── app.js
├── raw_data/           # Place PDF files here (excluded from git)
├── resources/          # Generated sources from PDFs (excluded from git)
├── wiki/               # LLM-managed wiki (excluded from git, lazy-init on first ingest)
└── data/               # SQLite DB + config.json (excluded from git)
```

## Usage

### Adding sources

**PDF → Embedding (recommended for local use, fast)**
1. In Settings, confirm Ollama `Embedding Model` is set to `nomic-embed-text`
2. Go to the Convert tab → select a PDF → click the purple **Embedding** button
3. A 200-page book finishes in about 30–90 seconds

**PDF → Skill.md (recommended with a cloud LLM)**
1. In Settings, switch to Claude or Gemini and enter your API key
2. Go to the Convert tab → select a PDF → click the blue **skill.md** button
3. A book takes 5–15 minutes; cost is roughly $0.30–$2.00 (Gemini is cheaper)
4. ⚠️ Local 3B models usually cannot produce correct JSON output — use 7B+ or a cloud LLM

**Save an AI reply as a source**
- Click **💾 Save as source** below any AI reply and enter a title

### Topics

Sources can be grouped into topics so you can keep separate domains (e.g. 投資 / 哲學 / 工作) from polluting each other.

- The topic dropdown at the top of the sidebar filters both the source list and the conversation list
- Click ⚙ next to "主題" to add / rename / delete topics
- New conversions, embeddings, and "save as source" actions are auto-assigned to the currently selected topic (or the default topic if "全部" is selected)
- Use a source's ⋮ menu → **🏷 主題分類…** to add or remove a single source from any number of topics
- In the topic manager, click **📋 管理來源** on any topic row to batch-assign existing sources to it — there's a search box for filtering when the source list is long, and saving here only changes membership for the selected topic (each source's other topic memberships are preserved)
- "全部" shows everything regardless of topic; the default "預設" topic is created automatically and cannot be deleted

### Chat

1. Go to the Chat tab and check the sources you want to reference
2. Type your question and press Enter or →

### Settings

Fill in API keys, select models, and adjust context limits in the Settings tab. Changes take effect immediately after saving.

## Provider recommendations

| Use case | Recommendation |
|----------|----------------|
| PDF → skill.md conversion | Claude claude-opus-4-5 / Gemini Flash |
| Everyday chat (cost-conscious) | Gemini Flash / Grok |
| Fully local (privacy) | Ollama qwen2.5:7b (needs ~4 GB free RAM) |
| Embedding (required) | Ollama nomic-embed-text (free, local) |

## RAG strategy

| Source type | How it is used at chat time |
|-------------|----------------------------|
| skill.md | Full text of SKILL.md + all chapter files injected into system prompt (up to the configured char limit) |
| Embedding only | Query is embedded at request time → top-8 most similar chunks injected |
| Both | skill.md full-text injection takes priority |
| LLM Wiki (when checked) | Pass 1: model reads `index.md` and picks relevant pages. Pass 2: those page bodies are injected inside a configurable system-prompt block (Settings → LLM Wiki). Small wikis (under ~2k tokens) skip Pass 1 and dump everything. |

## LLM Wiki

The wiki layer is an LLM-managed, concept-organized rewrite of your raw resources, modeled after [Karpathy's LLM Wiki sketch](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f). It lives in `wiki/` and is created on first `📖 存入 Wiki` click.

**Layout** (auto-created from `backend/skills/llm-wiki/templates/`):

```
wiki/
├── SKILL.md     # the wiki's own maintenance manual (schema + workflows)
├── index.md     # auto-regenerated catalog of all pages
├── log.md       # append-only operation log
├── concept/     # concept pages
├── entity/      # named entities
├── summary/     # one page per ingested raw source (slug = source slug)
├── compare/     # comparison pages
└── synthesis/   # narrative cross-cutting summaries
```

**Wiki API** (all under `/api`):

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/wiki/info` | Page count, by-type breakdown, last-updated, schema_version |
| GET | `/wiki/pages` | List all pages with title and description |
| GET | `/wiki/page?path=...` | Read one page (path must be `<type>/<slug>.md`) |
| GET | `/wiki/index` | Raw `index.md` content |
| GET | `/wiki/log` | Raw `log.md` content |
| POST | `/wiki/init` | Manually scaffold the wiki (otherwise auto-init on first ingest) |
| POST | `/wiki/ingest/qa` | `{question, answer}` → run Plan + Apply, regen index, append log |
| POST | `/wiki/lint` | Cheap structural lint (broken links, orphans, missing sections, empty pages) — no LLM cost |
| POST | `/wiki/lint/llm` | LLM-based semantic lint (duplicates, contradictions, stale claims) — costs tokens |
| POST | `/wiki/fix-broken-link` | `{from_path, to_path}` → unlinks every broken `[text](to)` in the page, keeping the visible text |
| POST | `/wiki/migrate/sources-plaintext` | One-shot: flatten every page's `## Sources` markdown links to plain text (idempotent) |
| POST | `/wiki/repair/orphan` | `{page}` → LLM picks partners and adds bidirectional cross-references — costs tokens |
| POST | `/wiki/repair/discuss` | `{issue}` → create a fresh conversation seeded for human-in-the-loop discussion of a lint issue (typically `contradiction`); returns `{conversation_id, seed_message, ...}`. No LLM call here — the user reviews the seed in the chat input and sends it; the regular `/chat` path delivers wiki context |

**Cost note**: Each `📖 存入 Wiki` typically runs 1 Plan call + 2–4 Apply calls (one per page). Use a cheaper model in Settings if budget-sensitive — the Plan/Apply prompts are language-neutral and work with all four providers.

**Reusing the skill**: `backend/skills/llm-wiki/` is a vendored copy of `~/.claude/skills/llm-wiki/`. It contains `SKILL.md`, reference docs, prompt templates, and starter file templates — language-neutral, so any project can vendor it and write its own runtime against the same prompts.

## Known limitations

- PDF → skill.md requires a 7B+ LLM; 3B models typically fail to produce valid JSON output
- Ollama 7B models need ~3.1 GiB of RAM (system needs 4 GiB+ available)
- Embedding search uses pure-Python cosine similarity; expect 200–500 ms per query with multiple sources (acceptable for a local app)
