"""PDF → Skill conversion pipeline with pause/resume support.

Flow per job:
  1. Extract PDF text.
  2. Plan chapters via LLM (returns JSON: book title, slug, chapter list with start_markers).
  3. Split full text into chapter bodies by locating start_markers.
  4. For each chapter: call LLM to produce a detailed skill.md file.
  5. Call LLM once more to produce the main SKILL.md index.

Pause = set jobs.status='paused'; the worker checks the flag between chapters and exits.
Resume = start_job() again with the same job id; it picks up from the first chapter
whose file does not yet exist.
"""
import asyncio
import json
import re
from pathlib import Path

from . import db, llm, topics as topicmod, sources as sourcemod
from .pdf_utils import extract_pages, pages_to_text


_running_tasks: dict[int, asyncio.Task] = {}


def slugify(s: str) -> str:
    s = re.sub(r"[^\w\s\-]", "", (s or "").lower())
    s = re.sub(r"[\s_]+", "-", s).strip("-")
    return s or "untitled"


def is_stopped(job_id: int) -> bool:
    """True if DB says this job should stop (paused or deleting)."""
    with db.conn() as c:
        row = c.execute("SELECT status FROM jobs WHERE id=?", (job_id,)).fetchone()
    return (row is None) or row["status"] in ("paused", "deleting")


def _update(job_id: int, **fields) -> None:
    if not fields:
        return
    fields["updated_at"] = db.now()
    sets = ",".join(f"{k}=?" for k in fields.keys())
    values = list(fields.values()) + [job_id]
    with db.conn() as c:
        c.execute(f"UPDATE jobs SET {sets} WHERE id=?", values)
        c.commit()


def _add_usage(job_id: int, tokens_in: int, tokens_out: int, cost: float) -> None:
    with db.conn() as c:
        c.execute(
            "UPDATE jobs SET tokens_in=tokens_in+?, tokens_out=tokens_out+?, "
            "cost=cost+?, updated_at=? WHERE id=?",
            (tokens_in, tokens_out, cost, db.now(), job_id),
        )
        c.commit()


async def start_job(job_id: int, paths: dict, cfg: dict) -> None:
    # Avoid duplicate tasks for the same job.
    existing = _running_tasks.get(job_id)
    if existing and not existing.done():
        return
    task = asyncio.create_task(_run_job(job_id, paths, cfg))
    _running_tasks[job_id] = task


async def _run_job(job_id: int, paths: dict, cfg: dict) -> None:
    try:
        with db.conn() as c:
            row = c.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        if not row:
            return
        provider = row["provider"]
        pcfg = cfg["providers"][provider]
        skills_dir = Path(paths["skills_dir"])
        pdf_path = Path(row["pdf_path"])

        _update(job_id, status="running", current_step="extracting_pdf", error=None)

        pages = extract_pages(pdf_path)
        full_text = pages_to_text(pages)

        if is_stopped(job_id):
            _update(job_id, status="paused")
            return

        # Plan (cached in jobs.chapters_json if already done).
        chapters_json = row["chapters_json"]
        if not chapters_json:
            _update(job_id, current_step="planning_chapters")
            plan = await _plan_chapters(pdf_path.stem, full_text, provider, pcfg)
            _add_usage(
                job_id, plan["tokens_in"], plan["tokens_out"],
                llm.calc_cost(pcfg, plan["tokens_in"], plan["tokens_out"]),
            )
            book_title = plan["book_title"]
            book_slug = slugify(plan.get("book_slug") or plan["book_title"])
            chapters = plan["chapters"]
            # sanitize slugs
            for i, ch in enumerate(chapters):
                ch["slug"] = slugify(ch.get("slug") or ch.get("title", f"ch-{i+1}"))
            skill_dir = skills_dir / book_slug
            skill_dir.mkdir(parents=True, exist_ok=True)
            (skill_dir / "chapters").mkdir(exist_ok=True)
            chapters_json = json.dumps(
                {"book_title": book_title, "book_slug": book_slug, "chapters": chapters},
                ensure_ascii=False,
            )
            _update(
                job_id,
                chapters_json=chapters_json,
                book_title=book_title,
                skill_slug=book_slug,
                skill_dir=str(skill_dir),
                total_chapters=len(chapters),
            )
            # Assign the new source to the topic recorded on the job.
            try:
                topic_id = row["topic_id"] if "topic_id" in row.keys() else None
            except Exception:
                topic_id = None
            if topic_id:
                topicmod.add_source_to_topic(book_slug, topic_id)
            # Persist 'this slug came from this PDF' for the PDF panel.
            sourcemod.link_source_pdf(book_slug, pdf_path.name)
        else:
            plan_data = json.loads(chapters_json)
            book_title = plan_data["book_title"]
            book_slug = plan_data["book_slug"]
            chapters = plan_data["chapters"]
            skill_dir = Path(row["skill_dir"])

        if is_stopped(job_id):
            _update(job_id, status="paused")
            return

        bodies = _split_chapters(full_text, chapters)

        completed = 0
        for idx, ch in enumerate(chapters):
            if is_stopped(job_id):
                _update(job_id, status="paused",
                        current_step=f"paused_before_ch_{idx+1}")
                return
            ch_filename = f"{idx + 1:02d}-{ch['slug']}.md"
            ch_path = skill_dir / "chapters" / ch_filename
            if ch_path.exists():
                completed = idx + 1
                continue
            _update(job_id, current_step=f"writing_chapter_{idx+1}_{ch['slug']}")
            result = await _write_chapter(
                book_title, book_slug, ch, bodies[idx], provider, pcfg
            )
            _add_usage(
                job_id, result["tokens_in"], result["tokens_out"],
                llm.calc_cost(pcfg, result["tokens_in"], result["tokens_out"]),
            )
            ch_path.write_text(result["content"], encoding="utf-8")
            completed = idx + 1
            with db.conn() as c:
                c.execute(
                    "UPDATE jobs SET completed_chapters=?, updated_at=? WHERE id=?",
                    (completed, db.now(), job_id),
                )
                c.commit()

        if is_stopped(job_id):
            _update(job_id, status="paused")
            return

        _update(job_id, current_step="writing_main_skill")
        main_path = skill_dir / "SKILL.md"
        if not main_path.exists():
            result = await _write_main_skill(
                book_title, book_slug, chapters, pdf_path.name, provider, pcfg
            )
            _add_usage(
                job_id, result["tokens_in"], result["tokens_out"],
                llm.calc_cost(pcfg, result["tokens_in"], result["tokens_out"]),
            )
            main_path.write_text(result["content"], encoding="utf-8")

        _update(job_id, status="done", current_step="completed")

    except asyncio.CancelledError:
        _update(job_id, status="paused", current_step="cancelled")
        raise
    except Exception as e:
        _update(job_id, status="failed", error=f"{type(e).__name__}: {e}")
    finally:
        _running_tasks.pop(job_id, None)


# ---------- LLM calls ----------

async def _plan_chapters(fallback_title: str, full_text: str, provider: str, pcfg: dict):
    # First 30k chars usually contain TOC or first couple chapters.
    sample = full_text[:30000]
    prompt = f"""Analyze this book and identify its chapters.

Return STRICT JSON (no markdown fences, no prose) with this structure:
{{
  "book_title": "Book Title",
  "book_slug": "kebab-case-slug",
  "description": "One-sentence index description.",
  "chapters": [
    {{
      "slug": "kebab-case",
      "title": "Chapter Title",
      "start_marker": "verbatim 80-150 char snippet from the chapter's opening"
    }}
  ]
}}

Rules:
- Identify 5 to 25 chapters. If the book has explicit chapters, use them. If not, divide by major topic shifts.
- start_marker MUST be a VERBATIM substring of the book text below (we search for it to split the file).
  Pick distinctive text near the chapter opening (title line or first sentence). Keep it short enough to not exceed ~150 chars, and long enough to be unique.
- Slugs: lowercase, hyphenated, no punctuation.
- If no book title is findable, use: "{fallback_title}".

BOOK TEXT (excerpt):
{sample}
"""
    result = await llm.chat(
        provider, pcfg,
        [{"role": "user", "content": prompt}],
        system="You output only valid JSON with no markdown fences and no prose.",
        max_tokens=4096, json_mode=True,
    )
    content = result["content"].strip()
    content = re.sub(r"^```(?:json)?\s*\n?", "", content)
    content = re.sub(r"\n?```\s*$", "", content)
    try:
        data = json.loads(content)
    except json.JSONDecodeError as e:
        raise llm.LLMError(f"Plan JSON parse failed: {e}; got: {content[:300]}")
    if "chapters" not in data or not isinstance(data["chapters"], list):
        raise llm.LLMError(
            f"Plan missing chapters[] list. Model returned: {content[:500]}"
        )
    if not data["chapters"]:
        raise llm.LLMError(
            f"Plan returned empty chapters[] list. Model returned: {content[:500]}"
        )
    data["tokens_in"] = result["tokens_in"]
    data["tokens_out"] = result["tokens_out"]
    if not data.get("book_title"):
        data["book_title"] = fallback_title
    return data


def _split_chapters(full_text: str, chapters: list) -> list[str]:
    """Locate each chapter's start_marker in full_text; interpolate gaps."""
    n = len(chapters)
    positions: list[int | None] = [None] * n
    for i, ch in enumerate(chapters):
        marker = (ch.get("start_marker") or "").strip()
        if not marker:
            continue
        search = marker[:60]
        pos = full_text.find(search)
        if pos < 0:
            pos = full_text.lower().find(search.lower())
        if pos >= 0:
            positions[i] = pos

    # Ensure first chapter has a position; if not, start at 0.
    if positions[0] is None:
        positions[0] = 0
    # Sentinel at end
    positions.append(len(full_text))

    for i in range(1, n):
        if positions[i] is None:
            # Find next known position, then linear-interpolate.
            next_idx = None
            for j in range(i + 1, n + 1):
                if positions[j] is not None:
                    next_idx = j
                    break
            prev = positions[i - 1]
            if next_idx is not None:
                gap = positions[next_idx] - prev
                step = gap / (next_idx - (i - 1))
                positions[i] = int(prev + step)
            else:
                positions[i] = len(full_text)

    # Monotonic fix
    for i in range(1, n):
        if positions[i] < positions[i - 1]:
            positions[i] = positions[i - 1] + 1

    bodies = []
    for i in range(n):
        bodies.append(full_text[positions[i]:positions[i + 1]])
    return bodies


async def _write_chapter(book_title, book_slug, ch, body, provider, pcfg):
    if len(body) > 60000:
        body = body[:60000] + "\n\n[...truncated for length]"

    prompt = f"""You are converting a book chapter into a Claude Code "skill" markdown file — a detailed, structured knowledge base.

Follow this EXACT template:

---
name: {ch['slug']}
description: >
  [2-4 sentence description of what the chapter covers. End with: "Use this skill when users ask about: [comma-separated concrete topics, names, phrases that should trigger it]." Be pushy and specific — include multiple real trigger phrases.]
parent_skill: {book_slug}
source: "{book_title}"
---

# {ch['title']}

[1-2 paragraph setup introducing the chapter in context.]

## [Section Heading reflecting a key subtopic]

[Explanation + direct quotes using > blockquote. Preserve the author's voice. Bold key phrases with **...**.]

## [More sections — use the chapter's natural argument structure]

## How to Apply This Teaching

**When users [specific situation]:**
[Direct actionable guidance.]

[6-10 such bullets covering application patterns.]

## Core Phrases From This Chapter

- "Direct quote 1"
- "Direct quote 2"
[Pull 8-15 memorable direct quotes.]

---

WRITING RULES:
- Preserve direct quotes verbatim in > blockquotes.
- Aim for 150-400 lines — thorough, not terse.
- Extract the chapter's key concepts, arguments, examples, names.
- Match the source language (if source is Chinese, write the skill in Chinese; if English, English).
- Do NOT fabricate content not present in the source.

CHAPTER TITLE: {ch['title']}
CHAPTER SLUG: {ch['slug']}
BOOK: {book_title}

CHAPTER TEXT:
{body}

Output ONLY the skill markdown file content, starting with the --- frontmatter. No preamble, no commentary, no code fences around the whole file."""
    result = await llm.chat(
        provider, pcfg, [{"role": "user", "content": prompt}], max_tokens=8192
    )
    content = result["content"].strip()
    if content.startswith("```"):
        content = re.sub(r"^```(?:markdown|md)?\s*\n?", "", content)
        content = re.sub(r"\n?```\s*$", "", content)
    return {
        "content": content,
        "tokens_in": result["tokens_in"],
        "tokens_out": result["tokens_out"],
    }


async def _write_main_skill(book_title, book_slug, chapters, source_file, provider, pcfg):
    listing = []
    for idx, ch in enumerate(chapters):
        filename = f"chapters/{idx + 1:02d}-{ch['slug']}.md"
        listing.append(f"| {idx + 1} | `{filename}` | {ch['title']} |")
    chapters_md = "\n".join(listing)

    prompt = f"""Generate the main SKILL.md for a multi-chapter skill — it serves as an INDEX that points at chapter files.

Book: {book_title}
Slug: {book_slug}
Source PDF: {source_file}

Chapter files already created:
{chapters_md}

Produce a SKILL.md with this structure:

---
name: {book_slug}
description: >
  [3-5 sentence description covering subject matter + "pushy" trigger phrases for when the skill should activate. List specific topics/names/terms users might mention. End with: "This file is the INDEX — for deep per-chapter material, load the matching file under `chapters/`."]
---

# {book_title} — Index

[1-2 paragraph introduction.]

## Chapter Index — Load the Relevant File

| # | File | When to load it |
|---|------|-----------------|
[Row per chapter: use the filenames above. "When to load" = 1-line description of the chapter's topic / matching user questions.]

## How to Use This Skill

[Brief load pattern: main SKILL.md first, then 1-3 specific chapter files based on the user's question; load several when a topic spans chapters.]

## Source

{source_file}

Write in the same language as the chapter titles. Output ONLY the SKILL.md content starting with ---. No preamble or code fences."""
    result = await llm.chat(
        provider, pcfg, [{"role": "user", "content": prompt}], max_tokens=4096
    )
    content = result["content"].strip()
    if content.startswith("```"):
        content = re.sub(r"^```(?:markdown|md)?\s*\n?", "", content)
        content = re.sub(r"\n?```\s*$", "", content)
    return {
        "content": content,
        "tokens_in": result["tokens_in"],
        "tokens_out": result["tokens_out"],
    }
