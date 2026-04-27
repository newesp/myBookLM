# myBookLM

A local alternative to NotebookLM. Convert PDFs into conversational knowledge sources with support for multiple AI providers.

## Features

- **PDF → Skill.md**: Use an LLM to rewrite a PDF as structured chapter knowledge files (slow, high quality, great for deep reading)
- **PDF → Embedding**: Vectorize PDF text directly for similarity-based retrieval at query time (fast, 30–90 seconds, preserves original text)
- **Hybrid RAG chat**: Select sources in the left panel; chat uses full-text injection for skill.md sources and top-k retrieval for embedding sources
- **Save as source**: Save any AI reply as a new mini skill.md source
- **Topics**: Group sources by topic — pick a topic in the sidebar to scope the source list and conversation history; sources can belong to multiple topics
- **Multiple AI providers**: Claude / Gemini / Grok / Ollama (local) — switchable at any time
- **Conversation management**: Multiple conversations, clear history, token and cost display per message
- **Job management**: Conversions can be paused, resumed, and have their log deleted; resumes automatically from the last completed chapter after restart. The right "轉換任務" panel is purely a log — to remove the actual produced source, expand the corresponding PDF in the left panel and use its delete button

## Installation

**Requirements**: Python 3.10+, [Ollama](https://ollama.com) (for local inference and embedding)

```bash
# 1. Install Python dependencies
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
│   ├── chat.py         # RAG logic (skill.md full-text + embedding top-k)
│   ├── conversion.py   # PDF → skill.md pipeline (multi-step LLM)
│   ├── embedding.py    # PDF → embedding (Ollama nomic-embed-text)
│   ├── llm.py          # Unified LLM interface (4 providers)
│   ├── sources.py      # Source listing and deletion (clears DB chunks too)
│   ├── topics.py       # Topic CRUD + many-to-many source membership
│   ├── pdf_utils.py    # PDF text extraction (pypdf)
│   ├── config.py       # Config read/write (data/config.json)
│   └── db.py           # SQLite schema (jobs / conversations / messages / chunks)
├── frontend/
│   ├── index.html
│   ├── styles.css
│   └── app.js
├── books/              # Place PDF files here (excluded from git)
├── skills/             # Generated sources (excluded from git)
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

## Known limitations

- PDF → skill.md requires a 7B+ LLM; 3B models typically fail to produce valid JSON output
- Ollama 7B models need ~3.1 GiB of RAM (system needs 4 GiB+ available)
- Embedding search uses pure-Python cosine similarity; expect 200–500 ms per query with multiple sources (acceptable for a local app)
