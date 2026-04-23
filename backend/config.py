import json
from pathlib import Path
from copy import deepcopy

DEFAULT_CONFIG = {
    "active_provider": "ollama",
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
