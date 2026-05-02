"""LLM Wiki — an LLM-managed knowledge layer.

Consumes the vendored skill at backend/skills/llm-wiki/. Implements:
- lazy initialization from templates/
- ingest (Plan + Apply) using prompts/ingest-*
- query Pass 1 (page picking) using prompts/query-pick-pages
- deterministic index.md regeneration
- append-only log.md

The two-pass query Pass 2 (the answer) is wrapped by chat.py with the
user-configurable system_prompt_template from config.json.
"""
from __future__ import annotations

import asyncio
import json
import re
from datetime import datetime, timezone
from pathlib import Path

from . import llm

PAGE_TYPES = ("concept", "entity", "summary", "compare", "synthesis")
TYPE_TITLES = {
    "concept": "Concepts",
    "entity": "Entities",
    "summary": "Summaries",
    "compare": "Comparisons",
    "synthesis": "Syntheses",
}
SKILL_VENDOR_DIR = Path(__file__).parent / "skills" / "llm-wiki"
SMALL_WIKI_CHAR_THRESHOLD = 8000  # ~2k tokens; below this, dump all pages

WIKI_SLUG_SENTINEL = "__wiki__"  # frontend sends this in `sources` list

DEFAULT_SYSTEM_PROMPT_TEMPLATE = (
    "以下是你維護的 LLM Wiki，是你針對所有原始來源整理出的概念層知識。"
    "請優先依賴此處資訊；若 wiki 有矛盾或不足，再退回參考其他來源。\n\n"
    "=== WIKI START ===\n{{wiki_content}}\n=== WIKI END ==="
)
DEFAULT_PAGE_SEPARATOR = "\n\n---\n\n"


# ---------- Prompt loading ----------

def _load_prompt(name: str) -> str:
    return (SKILL_VENDOR_DIR / "prompts" / f"{name}.md").read_text(encoding="utf-8")


def _render(template: str, **vars) -> str:
    out = template
    for k, v in vars.items():
        out = out.replace("{{" + k + "}}", str(v))
    return out


# ---------- Initialization ----------

def is_initialized(wiki_dir: Path) -> bool:
    return (wiki_dir / "SKILL.md").exists()


def initialize(wiki_dir: Path) -> None:
    """Scaffold a new wiki from templates. No-op if already initialized."""
    if is_initialized(wiki_dir):
        return
    wiki_dir.mkdir(parents=True, exist_ok=True)
    for sub in PAGE_TYPES:
        (wiki_dir / sub).mkdir(exist_ok=True)
    tpl_dir = SKILL_VENDOR_DIR / "templates"
    (wiki_dir / "SKILL.md").write_text(
        (tpl_dir / "SKILL.md.tmpl").read_text(encoding="utf-8"), encoding="utf-8"
    )
    (wiki_dir / "index.md").write_text(
        (tpl_dir / "index.md.tmpl").read_text(encoding="utf-8"), encoding="utf-8"
    )
    (wiki_dir / "log.md").write_text(
        (tpl_dir / "log.md.tmpl").read_text(encoding="utf-8"), encoding="utf-8"
    )


# ---------- Page IO ----------

def _safe_rel_path(rel: str) -> Path:
    """Validate a path string is a wiki-relative page path (type/slug.md)."""
    p = Path(rel)
    if p.is_absolute() or ".." in p.parts:
        raise ValueError(f"unsafe path: {rel}")
    parts = p.parts
    if len(parts) != 2 or parts[0] not in PAGE_TYPES or not parts[1].endswith(".md"):
        raise ValueError(f"path must be <type>/<slug>.md, got: {rel}")
    return p


def list_pages(wiki_dir: Path) -> list[dict]:
    """Return [{path, type, slug, title, description}] for every page."""
    out: list[dict] = []
    for t in PAGE_TYPES:
        type_dir = wiki_dir / t
        if not type_dir.exists():
            continue
        for f in sorted(type_dir.glob("*.md")):
            content = f.read_text(encoding="utf-8")
            title, desc = _extract_title_and_description(content)
            out.append({
                "path": f"{t}/{f.name}",
                "type": t,
                "slug": f.stem,
                "title": title or f.stem,
                "description": desc,
            })
    return out


def _extract_title_and_description(content: str) -> tuple[str, str]:
    """Extract H1 as title and first prose paragraph as description.

    Skips the header blockquote (lines starting with `>`) and blank lines.
    Description is truncated to 120 chars.
    """
    title = ""
    desc = ""
    lines = content.split("\n")
    state = "title"
    desc_lines: list[str] = []
    for ln in lines:
        s = ln.strip()
        if state == "title":
            if s.startswith("# "):
                title = s[2:].strip()
                state = "post-title"
            continue
        if state == "post-title":
            if not s or s.startswith(">"):
                continue
            if s.startswith("#"):
                # No prose before next heading
                break
            desc_lines.append(s)
            state = "desc"
            continue
        if state == "desc":
            if not s:
                break
            if s.startswith("#") or s.startswith(">"):
                break
            desc_lines.append(s)
    desc = " ".join(desc_lines)
    if len(desc) > 120:
        desc = desc[:117].rstrip() + "..."
    return title, desc


def read_page(wiki_dir: Path, rel: str) -> str:
    p = _safe_rel_path(rel)
    return (wiki_dir / p).read_text(encoding="utf-8")


def _write_page(wiki_dir: Path, rel: str, content: str) -> None:
    p = _safe_rel_path(rel)
    full = wiki_dir / p
    full.parent.mkdir(parents=True, exist_ok=True)
    full.write_text(content, encoding="utf-8")


# ---------- Index regeneration ----------

def regenerate_index(wiki_dir: Path) -> None:
    pages = list_pages(wiki_dir)
    by_type: dict[str, list[dict]] = {t: [] for t in PAGE_TYPES}
    for pg in pages:
        by_type[pg["type"]].append(pg)
    out = ["# Index", ""]
    out.append("_This file is regenerated on every ingest. Do not hand-edit._")
    out.append("")
    for t in PAGE_TYPES:
        out.append(f"## {TYPE_TITLES[t]}")
        out.append("")
        if not by_type[t]:
            out.append("_(none yet)_")
        else:
            for pg in sorted(by_type[t], key=lambda p: p["slug"]):
                desc = pg["description"] or ""
                line = f"- [{pg['slug']}]({pg['path']})"
                if desc:
                    line += f" — {desc}"
                out.append(line)
        out.append("")
    (wiki_dir / "index.md").write_text("\n".join(out).rstrip() + "\n", encoding="utf-8")


# ---------- Log ----------

def append_log(wiki_dir: Path, line: str) -> None:
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    log_path = wiki_dir / "log.md"
    if not log_path.exists():
        log_path.write_text(
            (SKILL_VENDOR_DIR / "templates" / "log.md.tmpl").read_text(encoding="utf-8"),
            encoding="utf-8",
        )
    with log_path.open("a", encoding="utf-8") as f:
        f.write(f"\n{ts} {line}")


def _read_last_log_timestamp(wiki_dir: Path) -> str | None:
    log = wiki_dir / "log.md"
    if not log.exists():
        return None
    text = log.read_text(encoding="utf-8")
    matches = re.findall(r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)", text, flags=re.MULTILINE)
    return matches[-1] if matches else None


# ---------- Info ----------

def get_info(wiki_dir: Path) -> dict:
    if not is_initialized(wiki_dir):
        return {
            "exists": False,
            "page_count": 0,
            "by_type": {t: 0 for t in PAGE_TYPES},
            "last_updated": None,
            "index_summary": "",
            "schema_version": _skill_schema_version(),
        }
    pages = list_pages(wiki_dir)
    by_type = {t: 0 for t in PAGE_TYPES}
    for pg in pages:
        by_type[pg["type"]] += 1
    index_md = (wiki_dir / "index.md").read_text(encoding="utf-8") if (wiki_dir / "index.md").exists() else ""
    return {
        "exists": True,
        "page_count": len(pages),
        "by_type": by_type,
        "last_updated": _read_last_log_timestamp(wiki_dir),
        "index_summary": index_md[:500],
        "schema_version": _skill_schema_version(),
    }


def _skill_schema_version() -> str:
    """Read schema_version from the vendored skill's SKILL.md frontmatter."""
    try:
        text = (SKILL_VENDOR_DIR / "SKILL.md").read_text(encoding="utf-8")
        m = re.search(r'^schema_version:\s*"?([^"\n]+)"?', text, flags=re.MULTILINE)
        return m.group(1).strip() if m else "unknown"
    except Exception:
        return "unknown"


# ---------- LLM helpers ----------

def _strip_code_fence(text: str) -> str:
    """Remove a leading ```json ... ``` fence if present."""
    s = text.strip()
    if s.startswith("```"):
        s = re.sub(r"^```(?:json)?\s*\n", "", s)
        s = re.sub(r"\n```\s*$", "", s)
    return s.strip()


async def _llm_json(provider: str, pcfg: dict, system: str, user: str) -> dict:
    """One-shot LLM call expecting JSON. Falls back to fence-stripping."""
    result = await llm.chat(
        provider, pcfg,
        messages=[{"role": "user", "content": user}],
        system=system,
        max_tokens=2048,
        json_mode=True,
    )
    raw = _strip_code_fence(result.get("content", ""))
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"LLM returned invalid JSON: {e}; raw={raw[:300]}")
    return {
        "data": parsed,
        "tokens_in": result.get("tokens_in", 0),
        "tokens_out": result.get("tokens_out", 0),
    }


async def _llm_text(provider: str, pcfg: dict, system: str, user: str, max_tokens: int = 4096) -> dict:
    result = await llm.chat(
        provider, pcfg,
        messages=[{"role": "user", "content": user}],
        system=system,
        max_tokens=max_tokens,
    )
    return result


# ---------- Ingest ----------

_ingest_locks: dict[str, asyncio.Lock] = {}


def _lock_for(wiki_dir: Path) -> asyncio.Lock:
    key = str(wiki_dir.resolve())
    lock = _ingest_locks.get(key)
    if lock is None:
        lock = asyncio.Lock()
        _ingest_locks[key] = lock
    return lock


def _format_qa(question: str, answer: str) -> str:
    return f"### User question\n\n{question}\n\n### Assistant answer\n\n{answer}"


async def ingest_qa(wiki_dir: Path, question: str, answer: str, cfg: dict) -> dict:
    initialize(wiki_dir)
    new_content = _format_qa(question, answer)
    return await _ingest(wiki_dir, "qa", new_content, cfg, log_tag=question[:60])


async def _ingest(wiki_dir: Path, ingest_type: str, new_content: str, cfg: dict, log_tag: str) -> dict:
    """Run Plan + Apply + index/log update. Returns summary dict."""
    provider = cfg["active_provider"]
    pcfg = cfg["providers"][provider]
    tokens_in = 0
    tokens_out = 0

    skill_md = (wiki_dir / "SKILL.md").read_text(encoding="utf-8")
    index_md = (wiki_dir / "index.md").read_text(encoding="utf-8")

    plan_prompt = _render(
        _load_prompt("ingest-plan"),
        wiki_skill_md=skill_md,
        index_md=index_md,
        ingest_type=ingest_type,
        new_content=new_content,
    )

    async with _lock_for(wiki_dir):
        plan_res = await _llm_json(provider, pcfg, system="", user=plan_prompt)
        tokens_in += plan_res["tokens_in"]
        tokens_out += plan_res["tokens_out"]
        plan = plan_res["data"]

        operations = plan.get("operations", []) or []
        applied: list[dict] = []
        existing_pages = list_pages(wiki_dir)

        for op in operations:
            action = op.get("action")
            if action == "create":
                t = op.get("type")
                slug = op.get("slug")
                if t not in PAGE_TYPES or not slug:
                    continue
                slug = re.sub(r"[^a-z0-9\-]", "-", slug.lower()).strip("-")
                if not slug:
                    continue
                rel = f"{t}/{slug}.md"
                if (wiki_dir / rel).exists():
                    # collision: degrade to update
                    op = {**op, "action": "update", "path": rel,
                          "reason": op.get("reason", ""),
                          "change_brief": op.get("content_brief", "")}
                    action = "update"
                else:
                    related = _select_related_pages(existing_pages, op.get("content_brief", ""))
                    create_prompt = _render(
                        _load_prompt("ingest-apply-create"),
                        wiki_skill_md=skill_md,
                        type=t, slug=slug,
                        title=op.get("title", slug),
                        reason=op.get("reason", ""),
                        content_brief=op.get("content_brief", ""),
                        related_pages=related,
                        new_content=new_content,
                    )
                    res = await _llm_text(provider, pcfg, system="", user=create_prompt)
                    tokens_in += res.get("tokens_in", 0)
                    tokens_out += res.get("tokens_out", 0)
                    _write_page(wiki_dir, rel, res["content"].strip() + "\n")
                    applied.append({"action": "create", "path": rel})
            if action == "update":
                rel = op.get("path", "")
                try:
                    p = _safe_rel_path(rel)
                except ValueError:
                    continue
                full = wiki_dir / p
                if not full.exists():
                    continue
                cur = full.read_text(encoding="utf-8")
                related = _select_related_pages(
                    existing_pages, op.get("change_brief", ""), exclude=rel
                )
                update_prompt = _render(
                    _load_prompt("ingest-apply-update"),
                    wiki_skill_md=skill_md,
                    path=rel,
                    reason=op.get("reason", ""),
                    change_brief=op.get("change_brief", ""),
                    current_content=cur,
                    related_pages=related,
                    new_content=new_content,
                )
                res = await _llm_text(provider, pcfg, system="", user=update_prompt)
                tokens_in += res.get("tokens_in", 0)
                tokens_out += res.get("tokens_out", 0)
                _write_page(wiki_dir, rel, res["content"].strip() + "\n")
                applied.append({"action": "update", "path": rel})

        regenerate_index(wiki_dir)
        log_line = plan.get("log_entry") or (
            f"ingest {ingest_type} tag={log_tag!r} applied={len(applied)}"
        )
        append_log(wiki_dir, log_line)

    return {
        "ok": True,
        "operations": applied,
        "skipped": [op for op in operations if not any(
            (a.get("path") == op.get("path") or
             (a.get("action") == "create" and op.get("action") == "create"))
            for a in applied)],
        "tokens_in": tokens_in,
        "tokens_out": tokens_out,
        "log_entry": log_line,
    }


def _select_related_pages(pages: list[dict], hint: str, exclude: str = "", max_pages: int = 5) -> str:
    """Pick a few related pages to show as cross-reference candidates.

    Naive heuristic: pages whose slug or title appears in hint, plus a few from
    the largest type bucket. Just enough for the LLM to know what links exist.
    """
    hint_lower = (hint or "").lower()
    scored: list[tuple[int, dict]] = []
    for pg in pages:
        if pg["path"] == exclude:
            continue
        score = 0
        if pg["slug"] in hint_lower:
            score += 3
        if pg["title"].lower() in hint_lower:
            score += 2
        scored.append((score, pg))
    scored.sort(key=lambda x: (-x[0], x[1]["path"]))
    selected = [pg for _, pg in scored[:max_pages]]
    if not selected:
        return "(no other pages exist yet)"
    lines = []
    for pg in selected:
        lines.append(f"- `{pg['path']}` — **{pg['title']}** — {pg['description']}")
    return "\n".join(lines)


# ---------- Query (Pass 1) ----------

async def pick_pages(wiki_dir: Path, question: str, cfg: dict) -> dict:
    """Run Pass 1: choose which wiki pages are relevant to the question."""
    if not is_initialized(wiki_dir):
        return {"pages": [], "tokens_in": 0, "tokens_out": 0}

    skill_md = (wiki_dir / "SKILL.md").read_text(encoding="utf-8")
    index_md = (wiki_dir / "index.md").read_text(encoding="utf-8")

    # Small-wiki shortcut
    total_chars = sum(len((wiki_dir / pg["path"]).read_text(encoding="utf-8")) for pg in list_pages(wiki_dir))
    if total_chars < SMALL_WIKI_CHAR_THRESHOLD:
        return {"pages": [pg["path"] for pg in list_pages(wiki_dir)], "tokens_in": 0, "tokens_out": 0, "small_wiki": True}

    provider = cfg["active_provider"]
    pcfg = cfg["providers"][provider]
    user = _render(
        _load_prompt("query-pick-pages"),
        wiki_skill_md=skill_md,
        index_md=index_md,
        question=question,
    )
    res = await _llm_json(provider, pcfg, system="", user=user)
    data = res["data"]
    pages = data.get("pages", []) or []
    valid: list[str] = []
    for rel in pages:
        try:
            p = _safe_rel_path(rel)
        except ValueError:
            continue
        if (wiki_dir / p).exists():
            valid.append(rel)
    append_log(wiki_dir, f"query pages={len(valid)} q={question[:60]!r}")
    return {
        "pages": valid,
        "tokens_in": res["tokens_in"],
        "tokens_out": res["tokens_out"],
    }


# ---------- Build context block for chat ----------

def build_pages_block(wiki_dir: Path, page_paths: list[str], separator: str = DEFAULT_PAGE_SEPARATOR) -> str:
    parts: list[str] = []
    for rel in page_paths:
        try:
            p = _safe_rel_path(rel)
        except ValueError:
            continue
        full = wiki_dir / p
        if not full.exists():
            continue
        body = full.read_text(encoding="utf-8")
        parts.append(f"## {rel}\n\n{body}")
    return separator.join(parts)


def render_system_block(template: str, wiki_content: str) -> str:
    return _render(template, wiki_content=wiki_content)
