import json
import re
from pathlib import Path

from . import db


def list_sources(skills_dir: Path) -> list[dict]:
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
