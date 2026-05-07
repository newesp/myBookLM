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
import secrets
import time
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


# ---------- Broken-link scan ----------

# Matches [text](href). The href can contain anything except ) and whitespace,
# which is enough for the kind of links the LLM emits in wiki pages.
_MD_LINK_RE = re.compile(r"\[([^\]]+)\]\(([^)\s]+)\)")


def _resolve_relative_md(base_dir: str, href: str) -> str | None:
    """Resolve a relative .md href against base_dir.

    Returns posix-style wiki-relative path, or None if the link should be
    ignored (external, anchor-only, non-.md, or escapes the wiki root).
    """
    h = (href or "").strip()
    if not h or h.startswith(("http://", "https://", "mailto:", "#")):
        return None
    # Drop fragment
    if "#" in h:
        h = h.split("#", 1)[0]
    if not h.endswith(".md"):
        return None
    parts = (base_dir + "/" + h).split("/") if base_dir else h.split("/")
    stack: list[str] = []
    for part in parts:
        if not part or part == ".":
            continue
        if part == "..":
            if not stack:
                return None  # escaped wiki root
            stack.pop()
        else:
            stack.append(part)
    return "/".join(stack)


def unlink_broken(wiki_dir: Path, from_path: str, to_path: str) -> dict:
    """Strip broken markdown links from a single page, keeping the link text.

    For every `[text](href)` in `from_path` whose href resolves to `to_path`,
    replace it with the bare link text. Other links are untouched. The page
    is rewritten in place and a log line appended. Returns the number of
    replacements made; 0 means nothing matched (e.g. already fixed).
    """
    p = _safe_rel_path(from_path)
    full = wiki_dir / p
    if not full.exists():
        raise FileNotFoundError(from_path)
    text = full.read_text(encoding="utf-8")
    base_dir = from_path.rsplit("/", 1)[0] if "/" in from_path else ""

    removed = 0

    def _sub(m: re.Match) -> str:
        nonlocal removed
        link_text, href = m.group(1), m.group(2)
        resolved = _resolve_relative_md(base_dir, href)
        if resolved == to_path:
            removed += 1
            return link_text
        return m.group(0)

    new_text = _MD_LINK_RE.sub(_sub, text)
    if removed:
        full.write_text(new_text, encoding="utf-8")
        append_log(
            wiki_dir,
            f"unlink broken: {from_path} → {to_path} (×{removed})",
        )
    return {"ok": True, "removed": removed, "from": from_path, "to": to_path}


# Matches a `## Sources` section heading and captures the body until the next
# H2 (or end of file). Used by the migration that converts markdown-link
# Sources entries into plain text.
_SOURCES_SECTION_RE = re.compile(
    r"(^##\s+Sources\b[^\n]*\n)(.*?)(?=^##\s|\Z)",
    flags=re.MULTILINE | re.DOTALL,
)


def _flatten_sources_links(body: str) -> tuple[str, int]:
    """Inside a Sources-section body, replace every `[text](href)` with bare
    `text`. Returns (new_body, num_replacements).
    """
    count = 0

    def _sub(m: re.Match) -> str:
        nonlocal count
        count += 1
        return m.group(1)

    new = _MD_LINK_RE.sub(_sub, body)
    return new, count


def migrate_sources_to_plaintext(wiki_dir: Path) -> dict:
    """One-shot migration: strip markdown links inside every page's
    `## Sources` section, leaving the visible labels.

    Returns a summary `{pages_scanned, pages_changed, links_removed, changes:
    [{path, links_removed}]}`. Idempotent — re-running on already-migrated
    content does nothing.
    """
    if not is_initialized(wiki_dir):
        return {"pages_scanned": 0, "pages_changed": 0,
                "links_removed": 0, "changes": []}
    pages = list_pages(wiki_dir)
    changes: list[dict] = []
    total_removed = 0
    for pg in pages:
        full = wiki_dir / pg["path"]
        try:
            text = full.read_text(encoding="utf-8")
        except Exception:
            continue
        page_removed = 0
        new_text = text

        def _section_sub(m: re.Match) -> str:
            nonlocal page_removed
            heading, body = m.group(1), m.group(2)
            new_body, n = _flatten_sources_links(body)
            page_removed += n
            return heading + new_body

        new_text = _SOURCES_SECTION_RE.sub(_section_sub, new_text)
        if page_removed > 0 and new_text != text:
            full.write_text(new_text, encoding="utf-8")
            total_removed += page_removed
            changes.append({"path": pg["path"], "links_removed": page_removed})
    if total_removed > 0:
        append_log(
            wiki_dir,
            f"migrate sources→plaintext: pages={len(changes)} "
            f"links_removed={total_removed}",
        )
    return {
        "pages_scanned": len(pages),
        "pages_changed": len(changes),
        "links_removed": total_removed,
        "changes": changes,
    }


def find_broken_links(wiki_dir: Path) -> list[dict]:
    """Scan every wiki page body for relative .md links to non-existent files.

    Returns [{from, to, text}, ...] sorted by `from`. Top-level files
    (index.md, log.md, SKILL.md) are accepted as link targets even though
    they aren't returned by `list_pages()`.
    """
    if not is_initialized(wiki_dir):
        return []
    pages = list_pages(wiki_dir)
    known = {p["path"] for p in pages}
    for special in ("index.md", "log.md", "SKILL.md"):
        if (wiki_dir / special).exists():
            known.add(special)
    broken: list[dict] = []
    for pg in pages:
        page_path = pg["path"]
        base_dir = page_path.rsplit("/", 1)[0] if "/" in page_path else ""
        try:
            text = (wiki_dir / page_path).read_text(encoding="utf-8")
        except Exception:
            continue
        for m in _MD_LINK_RE.finditer(text):
            link_text, href = m.group(1), m.group(2)
            resolved = _resolve_relative_md(base_dir, href)
            if resolved is None or resolved in known:
                continue
            broken.append({"from": page_path, "to": resolved, "text": link_text})
    broken.sort(key=lambda b: (b["from"], b["to"]))
    return broken


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
            "broken_link_count": 0,
            "broken_links": [],
            "schema_version": _skill_schema_version(),
        }
    pages = list_pages(wiki_dir)
    by_type = {t: 0 for t in PAGE_TYPES}
    for pg in pages:
        by_type[pg["type"]] += 1
    index_md = (wiki_dir / "index.md").read_text(encoding="utf-8") if (wiki_dir / "index.md").exists() else ""
    broken = find_broken_links(wiki_dir)
    return {
        "exists": True,
        "page_count": len(pages),
        "by_type": by_type,
        "last_updated": _read_last_log_timestamp(wiki_dir),
        "index_summary": index_md[:500],
        "broken_link_count": len(broken),
        "broken_links": broken[:50],  # cap payload — viewer shows count regardless
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


async def _llm_json(
    provider: str, pcfg: dict, system: str, user: str, max_tokens: int = 2048,
) -> dict:
    """One-shot LLM call expecting JSON. Falls back to fence-stripping.

    `max_tokens` defaults to 2048 (suitable for short Plan/pick-pages outputs).
    Callers producing longer JSON (e.g. lint with N issues) should pass a
    bigger budget; otherwise the response gets truncated mid-string and the
    `json.loads` below raises with "Unterminated string".
    """
    result = await llm.chat(
        provider, pcfg,
        messages=[{"role": "user", "content": user}],
        system=system,
        max_tokens=max_tokens,
        json_mode=True,
    )
    raw = _strip_code_fence(result.get("content", ""))
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as e:
        # Truncation gives "Unterminated string" — point the user at max_tokens.
        hint = ""
        if "Unterminated" in str(e):
            hint = (" — likely truncated; the caller may need a larger "
                    "max_tokens budget")
        err = RuntimeError(
            f"LLM returned invalid JSON: {e}{hint}; "
            f"raw_len={len(raw)}; head={raw[:200]}; tail={raw[-200:]}"
        )
        # Attach raw + token usage so callers (e.g. lint) can attempt recovery.
        err.raw = raw  # type: ignore[attr-defined]
        err.tokens_in = result.get("tokens_in", 0)  # type: ignore[attr-defined]
        err.tokens_out = result.get("tokens_out", 0)  # type: ignore[attr-defined]
        raise err
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
        # Auto broken-link scan after ingest. We don't fail the operation —
        # an LLM frequently writes citations to pages it expects later Apply
        # calls (or future ingests) to create. Just record the count so the
        # frontend can surface it and so the log has an audit trail.
        broken_after = find_broken_links(wiki_dir)
        if broken_after:
            sample = broken_after[0]
            append_log(
                wiki_dir,
                f"⚠ broken links: {len(broken_after)} "
                f"(e.g. {sample['from']} → {sample['to']})",
            )

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
        "broken_link_count": len(broken_after),
        "broken_links": broken_after[:20],
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


# ---------- Repair: orphan ----------

def _page_title_for(pages: list[dict], path: str) -> str:
    for p in pages:
        if p["path"] == path:
            return p["title"] or path
    return path


def _relative_link_from(from_path: str, to_path: str) -> str:
    """Produce a relative wiki link from `from_path` (e.g. concept/a.md) to
    `to_path` (e.g. entity/b.md). All wiki pages live one level under the
    wiki root in their type subdir, so the answer is always `../<to>`.
    """
    return "../" + to_path


# ---------- Contradiction discussion seed ----------

def _detect_other_page_in_text(
    wiki_dir: Path, exclude: str, text: str
) -> str | None:
    """Scan `text` for a `<type>/<slug>.md` reference that exists on disk and
    differs from `exclude`. Used to enrich the contradiction-discuss seed
    when the LLM lint detail mentions a second page.
    """
    if not text:
        return None
    pattern = re.compile(
        r"\b((?:concept|entity|summary|compare|synthesis)/[a-z0-9_\-]+\.md)\b",
        re.IGNORECASE,
    )
    for m in pattern.findall(text):
        if m == exclude:
            continue
        try:
            p = _safe_rel_path(m)
        except ValueError:
            continue
        if (wiki_dir / p).exists():
            return m
    return None


def build_contradiction_seed(wiki_dir: Path, issue: dict) -> dict:
    """Compose a seed user message for the discuss-contradiction conversation.

    Returns `{title, seed_message, pages}`. The frontend pre-fills
    `seed_message` into the chat input — the user reviews and clicks send,
    so the wiki two-pass retrieval delivers the actual page content during
    the chat turn (we don't paste full pages here).
    """
    issue = issue or {}
    page = (issue.get("page") or "").strip()
    detail = (issue.get("detail") or "").strip()
    suggested_fix = (issue.get("suggested_fix") or "").strip()
    category = (issue.get("category") or "contradiction").strip()

    # Try to spot a second page in the lint text — purely best-effort.
    other = _detect_other_page_in_text(
        wiki_dir, page, f"{detail}\n{suggested_fix}"
    )

    page_basename = Path(page).stem if page else "?"
    if other:
        title = f"釐清矛盾：{page_basename} ↔ {Path(other).stem}"
    else:
        title = f"釐清矛盾：{page_basename}"
    title = title[:80]

    parts: list[str] = [
        "我想透過討論釐清 LLM lint 找到的一個問題。",
        "",
        f"**類別**：`{category}`",
    ]
    if page:
        parts.append(f"**主要頁**：`{page}`")
    if other:
        parts.append(f"**對照頁**：`{other}`")
    if detail:
        parts.extend(["", f"**lint 說明**：{detail}"])
    if suggested_fix:
        parts.append(f"**lint 建議**：{suggested_fix}")
    parts.extend([
        "",
        "請：",
        "1. 讀過上述頁面後，明確指出兩段陳述具體在哪一點相互衝突",
        "2. 提出 3 個可能的化解方案（例：改頁 A、改頁 B、加 disambiguation、"
        "建 compare 頁、判定為「不衝突 / 不需改」）",
        "3. 對每個方案說明利弊與適用情境",
        "",
        "我會接著與你討論細節，最後挑一個方向後再請你產生具體文字，"
        "我會手動 📖 存入 Wiki。",
    ])

    pages = [p for p in [page, other] if p]
    return {"title": title, "seed_message": "\n".join(parts), "pages": pages}


async def repair_orphan(wiki_dir: Path, orphan_path: str, cfg: dict) -> dict:
    """Add bidirectional cross-references between an orphan and 1-2 partner
    pages. LLM picks the partners; existing ingest-apply-update prompt does
    the actual prose edits. Per-wiki lock prevents concurrent edits.

    Returns `{ok, orphan, partners, applied, skipped, [skip_reason],
    tokens_in, tokens_out}`. Idempotent in spirit: if the LLM picks the same
    partners again on a re-run it'll just (over-)write similar prose.
    """
    p = _safe_rel_path(orphan_path)
    full = wiki_dir / p
    if not full.exists():
        raise FileNotFoundError(orphan_path)

    pages = list_pages(wiki_dir)
    orphan_content = full.read_text(encoding="utf-8")
    skill_md = (wiki_dir / "SKILL.md").read_text(encoding="utf-8")

    # Build summary of every other page (path · title · description) for
    # the partner-picker. Capped to keep the prompt tidy.
    summary_lines: list[str] = []
    for pg in pages:
        if pg["path"] == orphan_path:
            continue
        desc = pg.get("description", "") or ""
        summary_lines.append(f"- `{pg['path']}` — **{pg['title']}** — {desc}")
    pages_summary = "\n".join(summary_lines) or "(no other pages exist)"

    pick_prompt = _render(
        _load_prompt("repair-orphan-pick-partners"),
        wiki_skill_md=skill_md,
        orphan_path=orphan_path,
        orphan_content=orphan_content,
        pages_summary=pages_summary,
    )

    provider = cfg["active_provider"]
    pcfg = cfg["providers"][provider]
    totals = {"in": 0, "out": 0}

    async with _lock_for(wiki_dir):
        pick_res = await _llm_json(
            provider, pcfg, system="", user=pick_prompt, max_tokens=1024
        )
        totals["in"] += pick_res["tokens_in"]
        totals["out"] += pick_res["tokens_out"]
        data = pick_res["data"]

        raw_partners = data.get("partners", []) or []
        skip_reason = data.get("skip_reason")
        valid: list[dict] = []
        for raw in raw_partners:
            if not isinstance(raw, dict):
                continue
            path_s = _strip_autolinks(raw.get("path", "") or "")
            try:
                _safe_rel_path(path_s)
            except ValueError:
                continue
            if path_s == orphan_path or not (wiki_dir / path_s).exists():
                continue
            valid.append({"path": path_s, "reason": raw.get("reason", "")})

        if not valid:
            reason = skip_reason or "no related pages found"
            append_log(
                wiki_dir,
                f"repair orphan {orphan_path}: skipped ({reason})",
            )
            return {
                "ok": True, "orphan": orphan_path,
                "partners": [], "applied": [],
                "skipped": True, "skip_reason": reason,
                "tokens_in": totals["in"], "tokens_out": totals["out"],
            }

        existing_pages = list_pages(wiki_dir)
        applied: list[dict] = []

        async def _update_page(target_path: str, change_brief: str) -> bool:
            tp = _safe_rel_path(target_path)
            tfull = wiki_dir / tp
            if not tfull.exists():
                return False
            cur = tfull.read_text(encoding="utf-8")
            related = _select_related_pages(
                existing_pages, change_brief, exclude=target_path
            )
            update_prompt = _render(
                _load_prompt("ingest-apply-update"),
                wiki_skill_md=skill_md,
                path=target_path,
                reason="repair orphan: add bidirectional cross-reference",
                change_brief=change_brief,
                current_content=cur,
                related_pages=related,
                # No external new_content — the change is purely structural.
                new_content="(no new external content; integrate the cross-reference described in the change brief)",
            )
            res = await _llm_text(provider, pcfg, system="", user=update_prompt)
            totals["in"] += res.get("tokens_in", 0)
            totals["out"] += res.get("tokens_out", 0)
            _write_page(wiki_dir, target_path, res["content"].strip() + "\n")
            return True

        # 1) Update orphan to mention each partner
        orphan_brief_lines = ["Add a sentence (or short paragraph) cross-referencing the following related page(s):"]
        for v in valid:
            link = _relative_link_from(orphan_path, v["path"])
            partner_title = _page_title_for(pages, v["path"])
            orphan_brief_lines.append(
                f"- `{v['path']}` (title: {partner_title}) — link as "
                f"`[{partner_title}]({link})`. Why relevant: {v['reason']}"
            )
        orphan_brief_lines.append(
            "Place the reference where it fits naturally in existing prose. "
            "Do not duplicate content; just add a brief cross-link sentence."
        )
        if await _update_page(orphan_path, "\n".join(orphan_brief_lines)):
            applied.append({"action": "update", "path": orphan_path})

        # 2) Update each partner to mention orphan
        orphan_title = _page_title_for(pages, orphan_path)
        for v in valid:
            partner_path = v["path"]
            link = _relative_link_from(partner_path, orphan_path)
            partner_brief = (
                f"Add a brief cross-reference to the page `{orphan_path}` "
                f"(title: '{orphan_title}'). Use a markdown link "
                f"`[{orphan_title}]({link})` placed naturally in existing "
                f"prose. Why this link belongs here: {v['reason']}. "
                f"Do not duplicate content from that page; just add a brief "
                f"sentence noting the relationship."
            )
            if await _update_page(partner_path, partner_brief):
                applied.append({"action": "update", "path": partner_path})

        regenerate_index(wiki_dir)
        partner_paths = [v["path"] for v in valid]
        append_log(
            wiki_dir,
            f"repair orphan {orphan_path} ↔ {partner_paths}",
        )

    return {
        "ok": True,
        "orphan": orphan_path,
        "partners": valid,
        "applied": applied,
        "skipped": False,
        "tokens_in": totals["in"],
        "tokens_out": totals["out"],
    }


# ---------- Duplicate merge: plan + apply ----------

# Process-local plan cache. Cleared on app restart; that's fine — plans are
# explicitly cheap to regenerate and we don't want stale plans surviving
# across deploys.
_REPAIR_PLAN_CACHE: dict[str, dict] = {}
_REPAIR_PLAN_TTL_SEC = 300  # 5 minutes


def _gc_repair_plans() -> None:
    """Drop expired entries opportunistically."""
    now = time.time()
    for k in [k for k, v in _REPAIR_PLAN_CACHE.items() if v["expires_at"] < now]:
        _REPAIR_PLAN_CACHE.pop(k, None)


async def plan_repair_duplicate(
    wiki_dir: Path, issue: dict, cfg: dict
) -> dict:
    """LLM proposes a merge plan for two duplicate pages. Plan-only — does NOT
    write any files. Returns a `plan_id` (cached for 5 min) plus the actions
    the frontend renders as a diff preview before the user confirms apply.

    Raises ValueError if the issue does not reference a second page or the
    LLM picks invalid primary/secondary paths.
    """
    _gc_repair_plans()
    issue = issue or {}
    page_a = (issue.get("page") or "").strip()
    if not page_a:
        raise ValueError("issue.page required")
    detail = (issue.get("detail") or "").strip()
    suggested_fix = (issue.get("suggested_fix") or "").strip()
    page_b = _detect_other_page_in_text(
        wiki_dir, page_a, f"{detail}\n{suggested_fix}"
    )
    if not page_b:
        raise ValueError(
            "could not locate the second duplicate page; lint detail must "
            "reference its path explicitly"
        )

    pa = _safe_rel_path(page_a)
    pb = _safe_rel_path(page_b)
    fa = wiki_dir / pa
    fb = wiki_dir / pb
    if not fa.exists():
        raise FileNotFoundError(page_a)
    if not fb.exists():
        raise FileNotFoundError(page_b)

    content_a = fa.read_text(encoding="utf-8")
    content_b = fb.read_text(encoding="utf-8")
    skill_md = (wiki_dir / "SKILL.md").read_text(encoding="utf-8")
    ctx_lines = []
    if detail:
        ctx_lines.append(f"detail: {detail}")
    if suggested_fix:
        ctx_lines.append(f"suggested_fix: {suggested_fix}")
    lint_context = "\n".join(ctx_lines) or "(none)"

    prompt = _render(
        _load_prompt("repair-duplicate-merge"),
        wiki_skill_md=skill_md,
        path_a=page_a,
        content_a=content_a,
        path_b=page_b,
        content_b=content_b,
        lint_context=lint_context,
    )

    provider = cfg["active_provider"]
    pcfg = cfg["providers"][provider]
    res = await _llm_json(
        provider, pcfg, system="", user=prompt, max_tokens=8192
    )
    data = res["data"]

    primary = _strip_autolinks((data.get("primary") or "").strip())
    secondary = _strip_autolinks((data.get("secondary") or "").strip())
    if {primary, secondary} != {page_a, page_b}:
        raise ValueError(
            f"LLM picked invalid primary/secondary: "
            f"{primary!r} / {secondary!r} (expected {page_a!r} or {page_b!r})"
        )
    merged_content = (data.get("merged_content") or "").strip()
    secondary_content = (data.get("secondary_content") or "").strip()
    if not merged_content or not secondary_content:
        raise ValueError(
            "LLM did not produce both merged_content and secondary_content"
        )
    # Normalise trailing newline for clean diffs and writes.
    merged_content += "\n"
    secondary_content += "\n"

    primary_full = wiki_dir / _safe_rel_path(primary)
    secondary_full = wiki_dir / _safe_rel_path(secondary)
    actions = [
        {
            "path": primary,
            "role": "primary",
            "before": primary_full.read_text(encoding="utf-8"),
            "after": merged_content,
        },
        {
            "path": secondary,
            "role": "secondary",
            "before": secondary_full.read_text(encoding="utf-8"),
            "after": secondary_content,
        },
    ]

    plan_id = secrets.token_urlsafe(12)
    expires_at = time.time() + _REPAIR_PLAN_TTL_SEC
    _REPAIR_PLAN_CACHE[plan_id] = {
        "kind": "duplicate-merge",
        "wiki_dir": str(wiki_dir),
        "primary": primary,
        "secondary": secondary,
        "actions": actions,
        "expires_at": expires_at,
    }
    return {
        "plan_id": plan_id,
        "kind": "duplicate-merge",
        "primary": primary,
        "secondary": secondary,
        "reasoning": (data.get("reasoning") or "").strip(),
        "actions": actions,
        "expires_at": expires_at,
        "ttl_seconds": _REPAIR_PLAN_TTL_SEC,
        "tokens_in": res["tokens_in"],
        "tokens_out": res["tokens_out"],
    }


async def apply_repair_plan(wiki_dir: Path, plan_id: str) -> dict:
    """Apply a previously generated plan. Snapshots old content into log.md
    before each write so a human can manually restore. Per-wiki lock prevents
    racing with ingest. Plan is consumed (removed from cache) on success.
    """
    _gc_repair_plans()
    plan = _REPAIR_PLAN_CACHE.get(plan_id)
    if not plan:
        raise ValueError("plan not found or expired")
    if plan["wiki_dir"] != str(wiki_dir):
        raise ValueError("plan belongs to a different wiki")

    applied: list[dict] = []
    async with _lock_for(wiki_dir):
        # Snapshot every target BEFORE writing so the log is self-contained.
        snapshot_parts = [
            f"apply repair plan {plan_id} ({plan['kind']}) — snapshot:"
        ]
        for act in plan["actions"]:
            p = _safe_rel_path(act["path"])
            full = wiki_dir / p
            if full.exists():
                snapshot_parts.append(
                    f"--- BEFORE {act['path']} ---\n"
                    f"{full.read_text(encoding='utf-8')}\n"
                    f"--- END BEFORE ---"
                )
        append_log(wiki_dir, "\n".join(snapshot_parts))

        for act in plan["actions"]:
            _write_page(wiki_dir, act["path"], act["after"])
            applied.append({"action": "update", "path": act["path"]})

        regenerate_index(wiki_dir)
        append_log(
            wiki_dir,
            f"apply repair plan {plan_id}: "
            f"primary={plan['primary']} secondary={plan['secondary']}",
        )

    _REPAIR_PLAN_CACHE.pop(plan_id, None)
    return {"ok": True, "plan_id": plan_id, "applied": applied}


# ---------- Lint ----------

def _build_inbound_graph(wiki_dir: Path, pages: list[dict]) -> dict[str, set[str]]:
    """For each page, collect the set of pages that link to it (excluding
    index.md, which always links to everything by construction).
    """
    inbound: dict[str, set[str]] = {p["path"]: set() for p in pages}
    for pg in pages:
        page_path = pg["path"]
        base_dir = page_path.rsplit("/", 1)[0] if "/" in page_path else ""
        try:
            text = (wiki_dir / page_path).read_text(encoding="utf-8")
        except Exception:
            continue
        for m in _MD_LINK_RE.finditer(text):
            resolved = _resolve_relative_md(base_dir, m.group(2))
            if resolved and resolved in inbound and resolved != page_path:
                inbound[resolved].add(page_path)
    return inbound


def _page_structural_issues(rel: str, text: str) -> list[dict]:
    """Cheap per-page checks for required structural elements."""
    issues: list[dict] = []
    lines = text.split("\n")
    head = lines[:20]  # header section is always near top
    has_h1 = any(ln.lstrip().startswith("# ") for ln in head)
    has_blockquote = any(ln.lstrip().startswith(">") for ln in head)
    has_sources = re.search(r"^##\s+Sources\b", text, flags=re.MULTILINE) is not None
    # Body emptiness: skip H1, header blockquote and blank lines; if nothing
    # but headings remains, treat as empty-ish.
    body_real_lines = 0
    seen_title = False
    for ln in lines:
        s = ln.strip()
        if not seen_title:
            if s.startswith("# "):
                seen_title = True
            continue
        if not s or s.startswith(">") or s.startswith("##") or s.startswith("# "):
            continue
        body_real_lines += 1
    if not has_h1:
        issues.append({"category": "missing_h1", "page": rel,
                       "detail": "page lacks an `# H1` near the top"})
    if not has_blockquote:
        issues.append({"category": "missing_header_blockquote", "page": rel,
                       "detail": "no `> Type: ... | Aliases: ... | Related: ...` header"})
    if not has_sources:
        issues.append({"category": "missing_sources_section", "page": rel,
                       "detail": "no `## Sources` section"})
    if body_real_lines < 2:
        issues.append({"category": "empty_page", "page": rel,
                       "detail": f"page has only {body_real_lines} non-heading body line(s)"})
    return issues


def deterministic_lint(wiki_dir: Path) -> dict:
    """Run all cheap structural checks. No LLM cost.

    Returns {exists, page_count, issue_count, by_category, issues}.
    Each issue: {category, page, detail, [extra...]}.
    """
    if not is_initialized(wiki_dir):
        return {"exists": False, "page_count": 0, "issue_count": 0,
                "by_category": {}, "issues": []}

    pages = list_pages(wiki_dir)
    issues: list[dict] = []

    # broken_link
    for b in find_broken_links(wiki_dir):
        issues.append({
            "category": "broken_link",
            "page": b["from"],
            "detail": f"link `[{b['text']}]({b['to']})` → page does not exist",
            "to": b["to"],
        })

    # orphan
    inbound = _build_inbound_graph(wiki_dir, pages)
    for pg in pages:
        if not inbound[pg["path"]]:
            issues.append({
                "category": "orphan",
                "page": pg["path"],
                "detail": "no other wiki page links to this one",
            })

    # per-page structural checks
    for pg in pages:
        try:
            text = (wiki_dir / pg["path"]).read_text(encoding="utf-8")
        except Exception:
            continue
        issues.extend(_page_structural_issues(pg["path"], text))

    issues.sort(key=lambda i: (i["category"], i["page"]))
    by_cat: dict[str, int] = {}
    for iss in issues:
        by_cat[iss["category"]] = by_cat.get(iss["category"], 0) + 1

    return {
        "exists": True,
        "page_count": len(pages),
        "issue_count": len(issues),
        "by_category": by_cat,
        "issues": issues,
    }


# Hard cap on the bytes of page bodies dumped into the lint prompt. Anything
# beyond this gets dropped — the LLM treats omitted pages as out-of-scope (per
# the comment in lint.md). 50k chars ≈ 12k tokens; comfortable for most models.
LINT_PAGES_DUMP_BUDGET = 50_000

# Pattern that catches `[<path>.md](<anything>)` — used to undo overzealous
# markdown auto-linking that some providers emit inside JSON string values.
# Replacement keeps just the visible label (`<path>.md`).
_AUTOLINK_MD_RE = re.compile(r"\[([^\]]+\.md)\]\([^)]*\)")


def _strip_autolinks(s: str) -> str:
    if not isinstance(s, str) or "[" not in s:
        return s
    return _AUTOLINK_MD_RE.sub(r"\1", s)


def _try_recover_truncated_lint(err: Exception) -> dict | None:
    """Best-effort recovery from a truncated lint JSON response.

    Looks for `"issues": [` in the raw text, then walks object-by-object using
    a brace counter, parsing each complete `{...}` and stopping at the first
    malformed one. Returns `{data, tokens_in, tokens_out}` or None if nothing
    salvageable.
    """
    raw = getattr(err, "raw", None)
    if not isinstance(raw, str) or "Unterminated" not in str(err):
        return None

    m = re.search(r'"issues"\s*:\s*\[', raw)
    if not m:
        return None

    issues: list[dict] = []
    i = m.end()
    n = len(raw)
    while i < n:
        # Skip whitespace and commas between objects
        while i < n and raw[i] in " \t\n\r,":
            i += 1
        if i >= n or raw[i] != "{":
            break
        # Find matching closing brace, respecting strings + escapes
        depth = 0
        j = i
        in_string = False
        escape = False
        while j < n:
            c = raw[j]
            if escape:
                escape = False
            elif c == "\\":
                escape = True
            elif in_string:
                if c == '"':
                    in_string = False
            elif c == '"':
                in_string = True
            elif c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    j += 1
                    break
            j += 1
        if depth != 0:
            break  # last object was truncated mid-content
        chunk = raw[i:j]
        try:
            obj = json.loads(chunk)
        except json.JSONDecodeError:
            break
        if isinstance(obj, dict):
            issues.append(obj)
        i = j

    if not issues:
        return None
    return {
        "data": {"issues": issues, "summary": ""},
        "tokens_in": getattr(err, "tokens_in", 0),
        "tokens_out": getattr(err, "tokens_out", 0),
    }


def _normalize_lint_issue(iss: dict) -> dict:
    """Best-effort cleanup of an LLM-emitted lint issue.

    Today this just strips markdown auto-links out of `page` / `detail` /
    `suggested_fix`. Kept narrow on purpose so we don't accidentally rewrite
    the LLM's intent.
    """
    out = dict(iss)
    for k in ("page", "detail", "suggested_fix"):
        if k in out:
            out[k] = _strip_autolinks(out[k])
    return out


async def llm_lint(wiki_dir: Path, cfg: dict) -> dict:
    """Run the LLM-based lint pass. Returns {issues, summary, ...}.

    Issues here are semantic/cross-page findings (duplicate, contradiction,
    stale_claim, misclassified) that the deterministic checks can't see.
    """
    if not is_initialized(wiki_dir):
        return {"exists": False, "issues": [], "summary": "",
                "tokens_in": 0, "tokens_out": 0,
                "pages_scanned": 0, "pages_total": 0, "truncated": False}

    pages = list_pages(wiki_dir)
    skill_md = (wiki_dir / "SKILL.md").read_text(encoding="utf-8")
    index_md = (wiki_dir / "index.md").read_text(encoding="utf-8")

    chunks: list[str] = []
    used = 0
    scanned = 0
    for pg in pages:
        try:
            body = (wiki_dir / pg["path"]).read_text(encoding="utf-8")
        except Exception:
            continue
        block = f"### {pg['path']}\n\n{body}\n\n"
        if used + len(block) > LINT_PAGES_DUMP_BUDGET and scanned > 0:
            break
        chunks.append(block)
        used += len(block)
        scanned += 1
    pages_dump = "".join(chunks).rstrip() or "(no pages)"
    truncated = scanned < len(pages)

    user = _render(
        _load_prompt("lint"),
        wiki_skill_md=skill_md,
        index_md=index_md,
        pages_dump=pages_dump,
    )

    provider = cfg["active_provider"]
    pcfg = cfg["providers"][provider]
    # Lint can list dozens of issues across categories — give it room to
    # finish the JSON. 2048 / 8192 have both been empirically too small for
    # wikis where the LLM bloats output with markdown auto-links. The prompt
    # caps issues at 30 + tells it to use bare paths, but bigger budget +
    # truncation recovery is the safety net.
    truncated_recovery = False
    try:
        res = await _llm_json(
            provider, pcfg, system="", user=user, max_tokens=16384
        )
        data = res["data"]
        tokens_in = res["tokens_in"]
        tokens_out = res["tokens_out"]
    except RuntimeError as e:
        recovered = _try_recover_truncated_lint(e)
        if recovered is None:
            raise
        data = recovered["data"]
        tokens_in = recovered["tokens_in"]
        tokens_out = recovered["tokens_out"]
        truncated_recovery = True
    issues = data.get("issues", []) or []
    summary = (data.get("summary") or "").strip()
    if truncated_recovery:
        summary = (
            "(部分結果 — LLM 回應遭截斷，已從原始輸出中盡量還原 issues。"
            "建議重跑或進一步精簡 wiki。) " + summary
        ).strip()
    # Some providers auto-format `.md` strings as markdown links inside the
    # JSON output, e.g. `concept/[foo.md](http://foo.md)`. Strip that pattern
    # back to a bare path before sending to the frontend.
    issues = [_normalize_lint_issue(iss) for iss in issues]

    append_log(
        wiki_dir,
        f"lint llm pages={scanned}/{len(pages)} issues={len(issues)}"
        + (" (truncated)" if truncated else ""),
    )

    return {
        "exists": True,
        "issues": issues,
        "summary": summary,
        "tokens_in": res["tokens_in"],
        "tokens_out": res["tokens_out"],
        "pages_scanned": scanned,
        "pages_total": len(pages),
        "truncated": truncated,
    }


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
