"""RAG-style chat: selected sources are loaded into the system prompt.

Strategy:
- skill.md sources: inject full text (SKILL.md + chapter files) up to char limit.
- embedding-only sources: embed user query via Ollama, retrieve top-k chunks.
"""
from pathlib import Path

from . import db, llm
from . import embedding as emb_mod


async def build_source_context(
    skills_dir: Path,
    selected_slugs: list[str],
    limit: int,
    user_message: str,
    ollama_cfg: dict,
) -> tuple[str, list[str]]:
    parts: list[str] = []
    included: list[str] = []
    total = 0
    query_vec: list[float] | None = None  # lazily computed once

    for slug in selected_slugs:
        source_dir = skills_dir / slug
        has_skill = source_dir.exists() and (source_dir / "SKILL.md").exists()
        has_emb = emb_mod.has_embedding(slug)

        if not has_skill and not has_emb:
            continue

        included.append(slug)

        if has_skill:
            if total <= limit:
                content = (source_dir / "SKILL.md").read_text(encoding="utf-8")
                parts.append(f"=== SOURCE: {slug}/SKILL.md ===\n\n{content}")
                total += len(content)
                chapters_dir = source_dir / "chapters"
                if chapters_dir.exists():
                    for ch_file in sorted(chapters_dir.glob("*.md")):
                        if total > limit:
                            parts.append(
                                "[Note: further source material truncated due to size limit.]"
                            )
                            break
                        content = ch_file.read_text(encoding="utf-8")
                        parts.append(
                            f"=== SOURCE: {slug}/chapters/{ch_file.name} ===\n\n{content}"
                        )
                        total += len(content)

        elif has_emb:
            # Embedding-only: retrieve relevant chunks for this query
            if query_vec is None:
                try:
                    base_url = ollama_cfg.get("base_url") or "http://localhost:11434"
                    embed_model = ollama_cfg.get("embed_model") or "nomic-embed-text"
                    query_vec = await emb_mod.embed_text(base_url, embed_model, user_message)
                except Exception as e:
                    parts.append(
                        f"[Note: 無法取得 embedding 查詢向量（{slug}）: {e}]"
                    )
                    continue

            chunks = await emb_mod.search_chunks(slug, query_vec)
            if chunks:
                chunk_text = "\n\n---\n\n".join(
                    f"[片段 {c['chunk_idx']}]\n{c['text']}" for c in chunks
                )
                parts.append(f"=== SOURCE: {slug} (相關片段，依相似度排列) ===\n\n{chunk_text}")
                total += len(chunk_text)

    return "\n\n".join(parts), included


async def run_chat(
    conv_id: int,
    user_message: str,
    selected_slugs: list[str],
    skills_dir: Path,
    cfg: dict,
) -> dict:
    provider = cfg["active_provider"]
    pcfg = cfg["providers"][provider]
    ollama_cfg = cfg["providers"]["ollama"]

    limit = int(pcfg.get("context_chars_limit") or 300_000)
    max_out = int(pcfg.get("max_output_tokens") or 4096)
    source_context, included = await build_source_context(
        skills_dir, selected_slugs, limit, user_message, ollama_cfg
    )

    if source_context:
        system_prompt = f"""You are an assistant answering questions based on the SOURCE materials provided below (retrieved via the user's selection).

Rules:
- Ground your answer in the provided sources. If the sources do not contain the answer, say so explicitly rather than speculating.
- You may cite sources by their slug (e.g., "according to `{included[0] if included else 'source'}`").
- Answer in the same language as the user's question.
- The prior conversation messages are also provided so you can maintain continuity.

=== PROVIDED SOURCES ===

{source_context}

=== END SOURCES ==="""
    else:
        system_prompt = (
            "You are a helpful assistant. No sources have been selected by the user. "
            "Let the user know they can select sources from the left panel for "
            "grounded answers, then still try to help generally."
        )

    with db.conn() as c:
        rows = c.execute(
            "SELECT role, content FROM messages WHERE conversation_id=? ORDER BY id ASC",
            (conv_id,),
        ).fetchall()
    history = [{"role": r["role"], "content": r["content"]} for r in rows]
    history.append({"role": "user", "content": user_message})

    result = await llm.chat(
        provider, pcfg, history, system=system_prompt, max_tokens=max_out
    )
    cost = llm.calc_cost(pcfg, result["tokens_in"], result["tokens_out"])

    with db.conn() as c:
        c.execute(
            "INSERT INTO messages (conversation_id, role, content, created_at) "
            "VALUES (?, 'user', ?, ?)",
            (conv_id, user_message, db.now()),
        )
        c.execute(
            "INSERT INTO messages (conversation_id, role, content, sources_used, "
            "tokens_in, tokens_out, cost, created_at) "
            "VALUES (?, 'assistant', ?, ?, ?, ?, ?, ?)",
            (
                conv_id, result["content"], ",".join(included),
                result["tokens_in"], result["tokens_out"], cost, db.now(),
            ),
        )
        c.execute(
            "UPDATE conversations SET updated_at=? WHERE id=?",
            (db.now(), conv_id),
        )
        c.commit()

    return {
        "content": result["content"],
        "tokens_in": result["tokens_in"],
        "tokens_out": result["tokens_out"],
        "cost": cost,
        "sources_used": included,
    }
