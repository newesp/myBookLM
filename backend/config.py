import json
from pathlib import Path
from copy import deepcopy

from .wiki import DEFAULT_SYSTEM_PROMPT_TEMPLATE, DEFAULT_PAGE_SEPARATOR

DEFAULT_CONFIG = {
    "active_provider": "ollama",
    "wiki": {
        "system_prompt_template": DEFAULT_SYSTEM_PROMPT_TEMPLATE,
        "page_separator": DEFAULT_PAGE_SEPARATOR,
    },
    "providers": {
        "claude": {
            "api_key": "",
            "model": "claude-opus-4-5",
            "context_chars_limit": 250000,
            "pricing": {"input_per_mtok": 15.0, "output_per_mtok": 75.0},
        },
        "gemini": {
            "api_key": "",
            "model": "gemini-2.0-flash-exp",
            "context_chars_limit": 250000,
            "pricing": {"input_per_mtok": 0.0, "output_per_mtok": 0.0},
        },
        "grok": {
            "api_key": "",
            "model": "grok-2-latest",
            "context_chars_limit": 100000,
            "pricing": {"input_per_mtok": 2.0, "output_per_mtok": 10.0},
        },
        "openai": {
            "api_key": "",
            "base_url": "https://api.openai.com/v1",
            "model": "gpt-4o-mini",
            "context_chars_limit": 250000,
            "pricing": {"input_per_mtok": 0.15, "output_per_mtok": 0.60},
        },
        "ollama": {
            "base_url": "http://localhost:11434",
            "model": "llama3.1",
            "embed_model": "nomic-embed-text",
            "context_chars_limit": 5000,
            "max_output_tokens": 1024,
            "num_ctx": 4096,
            "pricing": {"input_per_mtok": 0.0, "output_per_mtok": 0.0},
        },
    },
}


def load_config(path: Path) -> dict:
    if not path.exists():
        save_config(path, DEFAULT_CONFIG)
        return deepcopy(DEFAULT_CONFIG)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return deepcopy(DEFAULT_CONFIG)
    merged = deepcopy(DEFAULT_CONFIG)
    merged["active_provider"] = data.get("active_provider", merged["active_provider"])
    # wiki block (deep-merge so users can override individual fields)
    user_wiki = data.get("wiki") or {}
    for k, v in user_wiki.items():
        if k in merged["wiki"]:
            merged["wiki"][k] = v
    existing = data.get("providers", {})
    for name, defaults in DEFAULT_CONFIG["providers"].items():
        cur = dict(defaults)
        cur.update(existing.get(name, {}))
        # nested pricing merge
        if "pricing" in existing.get(name, {}):
            cur["pricing"] = {**defaults["pricing"], **existing[name]["pricing"]}
        merged["providers"][name] = cur
    return merged


def save_config(path: Path, cfg: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(cfg, indent=2, ensure_ascii=False), encoding="utf-8")
