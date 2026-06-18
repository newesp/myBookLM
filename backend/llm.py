"""Unified async chat() across Claude / Gemini / Grok / OpenAI / Ollama.

Each returns a dict: {content, tokens_in, tokens_out}.
"""
import httpx
from typing import Optional


class LLMError(Exception):
    pass


async def chat(
    provider: str,
    pcfg: dict,
    messages: list,
    system: Optional[str] = None,
    max_tokens: int = 8192,
    json_mode: bool = False,
) -> dict:
    if provider == "claude":
        return await _claude(pcfg, messages, system, max_tokens)
    if provider == "gemini":
        return await _gemini(pcfg, messages, system, max_tokens, json_mode)
    if provider == "grok":
        return await _grok(pcfg, messages, system, max_tokens, json_mode)
    if provider == "openai":
        return await _openai(pcfg, messages, system, max_tokens, json_mode)
    if provider == "ollama":
        return await _ollama(pcfg, messages, system, max_tokens, json_mode)
    raise LLMError(f"Unknown provider: {provider}")


async def _openai(cfg, messages, system, max_tokens, json_mode):
    api_key = cfg.get("api_key") or ""
    if not api_key:
        raise LLMError("OpenAI API key not set")
    full = []
    if system:
        full.append({"role": "system", "content": system})
    full.extend(messages)
    payload = {
        "model": cfg.get("model", "gpt-4o-mini"),
        "messages": full,
        "max_tokens": max_tokens,
    }
    if json_mode:
        payload["response_format"] = {"type": "json_object"}
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    base_url = (cfg.get("base_url") or "https://api.openai.com/v1").rstrip("/")
    async with httpx.AsyncClient(timeout=600) as client:
        r = await client.post(
            f"{base_url}/chat/completions", headers=headers, json=payload
        )
    if r.status_code != 200:
        raise LLMError(f"OpenAI error {r.status_code}: {r.text[:500]}")
    data = r.json()
    content = data["choices"][0]["message"]["content"]
    usage = data.get("usage", {})
    return {
        "content": content,
        "tokens_in": usage.get("prompt_tokens", 0),
        "tokens_out": usage.get("completion_tokens", 0),
    }


async def _claude(cfg, messages, system, max_tokens):
    api_key = cfg.get("api_key") or ""
    if not api_key:
        raise LLMError("Claude API key not set")
    headers = {
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    }
    payload = {
        "model": cfg.get("model", "claude-opus-4-5"),
        "max_tokens": max_tokens,
        "messages": messages,
    }
    if system:
        payload["system"] = system
    async with httpx.AsyncClient(timeout=600) as client:
        r = await client.post(
            "https://api.anthropic.com/v1/messages", headers=headers, json=payload
        )
    if r.status_code != 200:
        raise LLMError(f"Claude error {r.status_code}: {r.text[:500]}")
    data = r.json()
    content = "".join(
        b.get("text", "") for b in data.get("content", []) if b.get("type") == "text"
    )
    usage = data.get("usage", {})
    return {
        "content": content,
        "tokens_in": usage.get("input_tokens", 0),
        "tokens_out": usage.get("output_tokens", 0),
    }


async def _gemini(cfg, messages, system, max_tokens, json_mode):
    api_key = cfg.get("api_key") or ""
    if not api_key:
        raise LLMError("Gemini API key not set")
    model = cfg.get("model", "gemini-2.0-flash-exp")
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
    contents = []
    for m in messages:
        role = "user" if m["role"] == "user" else "model"
        contents.append({"role": role, "parts": [{"text": m["content"]}]})
    payload = {
        "contents": contents,
        "generationConfig": {"maxOutputTokens": max_tokens},
    }
    if system:
        payload["systemInstruction"] = {"parts": [{"text": system}]}
    if json_mode:
        payload["generationConfig"]["responseMimeType"] = "application/json"
    async with httpx.AsyncClient(timeout=600) as client:
        r = await client.post(url, json=payload)
    if r.status_code != 200:
        raise LLMError(f"Gemini error {r.status_code}: {r.text[:500]}")
    data = r.json()
    try:
        content = data["candidates"][0]["content"]["parts"][0]["text"]
    except (KeyError, IndexError):
        content = ""
    usage = data.get("usageMetadata", {})
    return {
        "content": content,
        "tokens_in": usage.get("promptTokenCount", 0),
        "tokens_out": usage.get("candidatesTokenCount", 0),
    }


async def _grok(cfg, messages, system, max_tokens, json_mode):
    api_key = cfg.get("api_key") or ""
    if not api_key:
        raise LLMError("Grok API key not set")
    full = []
    if system:
        full.append({"role": "system", "content": system})
    full.extend(messages)
    payload = {
        "model": cfg.get("model", "grok-2-latest"),
        "messages": full,
        "max_tokens": max_tokens,
    }
    if json_mode:
        payload["response_format"] = {"type": "json_object"}
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    async with httpx.AsyncClient(timeout=600) as client:
        r = await client.post(
            "https://api.x.ai/v1/chat/completions", headers=headers, json=payload
        )
    if r.status_code != 200:
        raise LLMError(f"Grok error {r.status_code}: {r.text[:500]}")
    data = r.json()
    content = data["choices"][0]["message"]["content"]
    usage = data.get("usage", {})
    return {
        "content": content,
        "tokens_in": usage.get("prompt_tokens", 0),
        "tokens_out": usage.get("completion_tokens", 0),
    }


async def _ollama(cfg, messages, system, max_tokens, json_mode):
    base_url = (cfg.get("base_url") or "http://localhost:11434").rstrip("/")
    model = cfg.get("model", "llama3.1")
    # num_ctx caps the context window; prevents runner from allocating too much RAM/VRAM.
    num_ctx = int(cfg.get("num_ctx") or 4096)
    full = []
    if system:
        full.append({"role": "system", "content": system})
    full.extend(messages)
    payload = {
        "model": model,
        "messages": full,
        "stream": False,
        "options": {"num_predict": max_tokens, "num_ctx": num_ctx},
    }
    if json_mode:
        payload["format"] = "json"
    async with httpx.AsyncClient(timeout=600) as client:
        r = await client.post(f"{base_url}/api/chat", json=payload)
    if r.status_code != 200:
        raise LLMError(f"Ollama error {r.status_code}: {r.text[:500]}")
    data = r.json()
    content = data.get("message", {}).get("content", "")
    return {
        "content": content,
        "tokens_in": data.get("prompt_eval_count", 0),
        "tokens_out": data.get("eval_count", 0),
    }


def calc_cost(pcfg: dict, tokens_in: int, tokens_out: int) -> float:
    pricing = pcfg.get("pricing") or {}
    in_cost = (tokens_in / 1_000_000) * float(pricing.get("input_per_mtok", 0) or 0)
    out_cost = (tokens_out / 1_000_000) * float(pricing.get("output_per_mtok", 0) or 0)
    return round(in_cost + out_cost, 6)
