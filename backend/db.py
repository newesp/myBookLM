import sqlite3
from pathlib import Path
from datetime import datetime

SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pdf_path TEXT NOT NULL,
    book_title TEXT,
    skill_slug TEXT NOT NULL DEFAULT '',
    skill_dir TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    job_type TEXT NOT NULL DEFAULT 'skill',
    current_step TEXT,
    total_chapters INTEGER DEFAULT 0,
    completed_chapters INTEGER DEFAULT 0,
    chapters_json TEXT,
    tokens_in INTEGER DEFAULT 0,
    tokens_out INTEGER DEFAULT 0,
    cost REAL DEFAULT 0,
    error TEXT,
    provider TEXT,
    model TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    sources_used TEXT,
    tokens_in INTEGER DEFAULT 0,
    tokens_out INTEGER DEFAULT 0,
    cost REAL DEFAULT 0,
    created_at TEXT NOT NULL,
    FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_slug TEXT NOT NULL,
    chunk_idx INTEGER NOT NULL,
    text TEXT NOT NULL,
    embedding BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunks_slug ON chunks(source_slug);

CREATE TABLE IF NOT EXISTS topics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS source_topics (
    source_slug TEXT NOT NULL,
    topic_id INTEGER NOT NULL,
    PRIMARY KEY (source_slug, topic_id),
    FOREIGN KEY (topic_id) REFERENCES topics(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_source_topics_topic ON source_topics(topic_id);
CREATE INDEX IF NOT EXISTS idx_source_topics_slug ON source_topics(source_slug);
"""

_db_path: Path | None = None


def init_db(path: Path) -> None:
    global _db_path
    _db_path = path
    path.parent.mkdir(parents=True, exist_ok=True)
    with conn() as c:
        c.executescript(SCHEMA)
        # Migration: add job_type column for databases created before this feature
        existing_cols = {row[1] for row in c.execute("PRAGMA table_info(jobs)")}
        if "job_type" not in existing_cols:
            c.execute("ALTER TABLE jobs ADD COLUMN job_type TEXT NOT NULL DEFAULT 'skill'")
        # Migration: topic_id columns on jobs and conversations
        if "topic_id" not in existing_cols:
            c.execute("ALTER TABLE jobs ADD COLUMN topic_id INTEGER")
        conv_cols = {row[1] for row in c.execute("PRAGMA table_info(conversations)")}
        if "topic_id" not in conv_cols:
            c.execute("ALTER TABLE conversations ADD COLUMN topic_id INTEGER")

        # Seed: ensure a default topic exists. Backfill any sources/conversations
        # without an assignment so the existing setup keeps working.
        existing_topic = c.execute("SELECT id FROM topics ORDER BY id ASC LIMIT 1").fetchone()
        if existing_topic is None:
            cur = c.execute(
                "INSERT INTO topics (name, created_at) VALUES (?, ?)",
                ("預設", now()),
            )
            default_id = cur.lastrowid
        else:
            default_id = existing_topic["id"]
        # Backfill conversations without a topic
        c.execute(
            "UPDATE conversations SET topic_id=? WHERE topic_id IS NULL",
            (default_id,),
        )
        c.commit()


def conn() -> sqlite3.Connection:
    assert _db_path is not None, "DB not initialized"
    c = sqlite3.connect(_db_path, timeout=10)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA foreign_keys=ON")
    return c


def now() -> str:
    return datetime.utcnow().isoformat()
