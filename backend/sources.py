import json
import re
from pathlib import Path

from . import db


def list_sources(skills_dir: Path, topic_id: int | None = None) -> list[dict]:
    """List sources, optionally filtered to those belonging to a topic.

    topic_id=None or 0 means no filter (all sources).
    """
    allowed: set[str] | None = None
    if topic_id:
        with db.conn() as c:
            rows = c.execute(
                "SELECT source_slug FROM source_topics WHERE topic_id=?",
                (topic_id,),
            ).fetchall()
        allowed = {r["source_slug"] for r in rows}

    out: dict[str, dict] = {}

    if skills_dir.exists():
        for sub in sorted(skills_dir.iterdir()):
            if not sub.is_dir():
                continue
            slug = sub.name
            has_skill = (sub / "SKILL.md").exists()
            entry: dict = {
                "slug": slug,
                "name": slug,
                "description": "",
                "chapter_count": 0,
                "types": [],
            }
            if has_skill:
                info = _parse_frontmatter(sub / "SKILL.md")
                chapters_dir = sub / "chapters"
                entry["name"] = info.get("name", slug)
                entry["description"] = info.get("description", "")
                entry["chapter_count"] = (
                    len(list(chapters_dir.glob("*.md"))) if chapters_dir.exists() else 0
                )
                entry["types"].append("skill")
            # Read META.json for name if no SKILL.md
            meta_path = sub / "META.json"
            if meta_path.exists() and not has_skill:
                try:
                    meta = json.loads(meta_path.read_text(encoding="utf-8"))
                    entry["name"] = meta.get("name", slug)
                except Exception:
                    pass
            out[slug] = entry

    # Overlay embedding info from DB
    with db.conn() as c:
        rows = c.execute(
            "SELECT source_slug, COUNT(*) as cnt FROM chunks GROUP BY source_slug"
        ).fetchall()
    for row in rows:
        slug = row["source_slug"]
        if slug not in out:
            out[slug] = {
                "slug": slug, "name": slug, "description": "",
                "chapter_count": 0, "types": [],
            }
        out[slug]["types"].append("embedding")
        out[slug]["chunk_count"] = row["cnt"]

    # Filter out empty entries (dirs with no content at all)
    result = [v for v in out.values() if v["types"]]
    if allowed is not None:
        result = [v for v in result if v["slug"] in allowed]
    result.sort(key=lambda x: x["slug"])
    return result


def _parse_frontmatter(path: Path) -> dict:
    try:
        text = path.read_text(encoding="utf-8")
    except Exception:
        return {}
    m = re.match(r"^---\s*\n(.*?)\n---\s*\n", text, re.DOTALL)
    if not m:
        return {}
    info: dict = {}
    current_key = None
    for line in m.group(1).split("\n"):
        if re.match(r"^\w[\w\-]*:", line):
            k, _, v = line.partition(":")
            info[k.strip()] = v.strip()
            current_key = k.strip()
        elif line.startswith("  ") and current_key:
            info[current_key] = (info[current_key] + " " + line.strip()).strip()
    return info


def get_source_content(skills_dir: Path, slug: str) -> dict:
    """Return full content for viewer.
    - skill: main SKILL.md + list of chapters {filename, title, content}
    - embedding: all chunks with idx + text
    Either/both can be present depending on source types.
    """
    result: dict = {"slug": slug, "name": slug, "types": [], "skill": None, "embedding": None}
    sub = skills_dir / slug
    if sub.exists() and sub.is_dir():
        skill_md = sub / "SKILL.md"
        if skill_md.exists():
            info = _parse_frontmatter(skill_md)
            result["name"] = info.get("name", slug)
            chapters: list[dict] = []
            chapters_dir = sub / "chapters"
            if chapters_dir.exists():
                for ch in sorted(chapters_dir.glob("*.md")):
                    content = ch.read_text(encoding="utf-8")
                    ch_info = _parse_frontmatter(ch)
                    title = ch_info.get("name") or ch_info.get("title") or ch.stem
                    chapters.append({
                        "filename": ch.name,
                        "title": title,
                        "content": content,
                    })
            result["skill"] = {
                "main_md": skill_md.read_text(encoding="utf-8"),
                "description": info.get("description", ""),
                "chapters": chapters,
            }
            result["types"].append("skill")
        meta_path = sub / "META.json"
        if meta_path.exists() and not skill_md.exists():
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
                result["name"] = meta.get("name", slug)
            except Exception:
                pass

    with db.conn() as c:
        rows = c.execute(
            "SELECT chunk_idx, text FROM chunks WHERE source_slug=? ORDER BY chunk_idx ASC",
            (slug,),
        ).fetchall()
    if rows:
        result["embedding"] = {
            "chunks": [{"idx": r["chunk_idx"], "text": r["text"]} for r in rows],
            "count": len(rows),
        }
        result["types"].append("embedding")
    return result


def rename_source(skills_dir: Path, slug: str, new_name: str) -> bool:
    """Update the display name. Slug/directory is NOT changed (it's the primary key)."""
    sub = skills_dir / slug
    if not sub.exists() or not sub.is_dir():
        # Embedding-only with no directory: store name in META.json in the skills dir
        sub.mkdir(parents=True, exist_ok=True)
    skill_md = sub / "SKILL.md"
    if skill_md.exists():
        text = skill_md.read_text(encoding="utf-8")
        m = re.match(r"^(---\s*\n)(.*?)(\n---\s*\n)", text, re.DOTALL)
        if m:
            fm = m.group(2)
            if re.search(r"^name:\s*.*$", fm, re.MULTILINE):
                fm = re.sub(r"^name:\s*.*$", f"name: {new_name}", fm, count=1, flags=re.MULTILINE)
            else:
                fm = f"name: {new_name}\n" + fm
            text = m.group(1) + fm + m.group(3) + text[m.end():]
        else:
            text = f"---\nname: {new_name}\n---\n\n" + text
        skill_md.write_text(text, encoding="utf-8")
        return True
    # No SKILL.md: write/update META.json
    meta_path = sub / "META.json"
    meta: dict = {}
    if meta_path.exists():
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except Exception:
            meta = {}
    meta["name"] = new_name
    meta["slug"] = slug
    meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    return True


def delete_source(skills_dir: Path, slug: str) -> bool:
    import shutil
    target = skills_dir / slug
    deleted_files = False
    if target.exists() and target.is_dir():
        shutil.rmtree(target, ignore_errors=True)
        deleted_files = True
    # Delete embedding chunks from DB
    with db.conn() as c:
        c.execute("DELETE FROM chunks WHERE source_slug=?", (slug,))
        c.commit()
    return deleted_files


def list_pdfs(books_dir: Path) -> list[dict]:
    out = []
    if not books_dir.exists():
        return out
    for pdf in sorted(books_dir.glob("*.pdf")):
        out.append({
            "name": pdf.name,
            "path": str(pdf),
            "size_mb": round(pdf.stat().st_size / 1_048_576, 2),
        })
    return out
