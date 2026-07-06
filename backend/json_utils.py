import json
import re


def strip_code_fence(text: str) -> str:
    """Remove a leading markdown code fence from an LLM response."""
    s = (text or "").strip()
    if s.startswith("```"):
        s = re.sub(r"^```(?:json)?\s*\n?", "", s)
        s = re.sub(r"\n?```\s*$", "", s)
    return s.strip()


def parse_llm_json(text: str) -> dict:
    """Parse JSON from an LLM response with small, safe normalizations."""
    raw = strip_code_fence(text)
    candidates = [raw]
    extracted = _extract_json_object(raw)
    if extracted and extracted != raw:
        candidates.append(extracted)

    last_error: json.JSONDecodeError | None = None
    for candidate in candidates:
        for normalized in (candidate, _remove_trailing_commas(candidate)):
            try:
                return json.loads(normalized)
            except json.JSONDecodeError as e:
                last_error = e
    if last_error:
        raise last_error
    raise json.JSONDecodeError("No JSON object found", raw, 0)


def _extract_json_object(text: str) -> str | None:
    start = text.find("{")
    if start < 0:
        return None
    depth = 0
    in_string = False
    escaped = False
    for index, char in enumerate(text[start:], start=start):
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return text[start:index + 1]
    return None


def _remove_trailing_commas(text: str) -> str:
    return re.sub(r",\s*([}\]])", r"\1", text)
