"""Topic management — group sources by topic and scope conversations to a topic.

Conventions:
- Default topic is the lowest id (seeded as id=1, name="預設" on first init).
- A source can belong to many topics (many-to-many via source_topics).
- A conversation belongs to exactly one topic (conversations.topic_id).
- The frontend may pass topic_id=0 to mean "all" — server treats that as no filter.
"""
from . import db


def list_topics() -> list[dict]:
    with db.conn() as c:
        rows = c.execute(
            "SELECT t.id, t.name, t.created_at, "
            "  (SELECT COUNT(*) FROM source_topics st WHERE st.topic_id=t.id) AS source_count "
            "FROM topics t ORDER BY t.id ASC"
        ).fetchall()
    return [dict(r) for r in rows]


def default_topic_id() -> int:
    with db.conn() as c:
        row = c.execute("SELECT id FROM topics ORDER BY id ASC LIMIT 1").fetchone()
    if row is None:
        # Defensive: shouldn't happen because init_db seeds one.
        with db.conn() as c:
            cur = c.execute(
                "INSERT INTO topics (name, created_at) VALUES (?, ?)",
                ("預設", db.now()),
            )
            c.commit()
            return cur.lastrowid
    return row["id"]


def create_topic(name: str) -> dict:
    name = (name or "").strip()
    if not name:
        raise ValueError("Topic name cannot be empty")
    with db.conn() as c:
        cur = c.execute(
            "INSERT INTO topics (name, created_at) VALUES (?, ?)",
            (name, db.now()),
        )
        tid = cur.lastrowid
        c.commit()
    return {"id": tid, "name": name}


def rename_topic(topic_id: int, new_name: str) -> None:
    new_name = (new_name or "").strip()
    if not new_name:
        raise ValueError("Topic name cannot be empty")
    with db.conn() as c:
        c.execute("UPDATE topics SET name=? WHERE id=?", (new_name, topic_id))
        c.commit()


def delete_topic(topic_id: int) -> None:
    """Delete a topic. Refuses to delete the default (lowest-id) topic.

    Source-topic associations cascade. Conversations in this topic are
    reassigned to the default topic so the chat history is not lost.
    """
    default_id = default_topic_id()
    if topic_id == default_id:
        raise ValueError("Cannot delete the default topic")
    with db.conn() as c:
        c.execute(
            "UPDATE conversations SET topic_id=? WHERE topic_id=?",
            (default_id, topic_id),
        )
        c.execute("DELETE FROM topics WHERE id=?", (topic_id,))
        c.commit()


def get_source_topics(slug: str) -> list[int]:
    with db.conn() as c:
        rows = c.execute(
            "SELECT topic_id FROM source_topics WHERE source_slug=?", (slug,)
        ).fetchall()
    return [r["topic_id"] for r in rows]


def set_source_topics(slug: str, topic_ids: list[int]) -> None:
    """Replace the set of topics this source belongs to."""
    with db.conn() as c:
        c.execute("DELETE FROM source_topics WHERE source_slug=?", (slug,))
        for tid in set(topic_ids):
            c.execute(
                "INSERT OR IGNORE INTO source_topics (source_slug, topic_id) VALUES (?, ?)",
                (slug, tid),
            )
        c.commit()


def add_source_to_topic(slug: str, topic_id: int) -> None:
    """Idempotent insert. Used when a job creates a new source."""
    if not topic_id:
        return
    with db.conn() as c:
        c.execute(
            "INSERT OR IGNORE INTO source_topics (source_slug, topic_id) VALUES (?, ?)",
            (slug, topic_id),
        )
        c.commit()


def set_topic_sources(topic_id: int, slugs: list[str]) -> None:
    """Replace the full set of sources in this topic.

    Other topic memberships of each slug are preserved — only the rows
    where topic_id == this topic are touched.
    """
    with db.conn() as c:
        c.execute("DELETE FROM source_topics WHERE topic_id=?", (topic_id,))
        for s in set(slugs):
            c.execute(
                "INSERT OR IGNORE INTO source_topics (source_slug, topic_id) VALUES (?, ?)",
                (s, topic_id),
            )
        c.commit()


def slugs_in_topic(topic_id: int) -> set[str]:
    with db.conn() as c:
        rows = c.execute(
            "SELECT source_slug FROM source_topics WHERE topic_id=?", (topic_id,)
        ).fetchall()
    return {r["source_slug"] for r in rows}
