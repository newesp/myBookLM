from pathlib import Path
from pypdf import PdfReader


def extract_pages(pdf_path: Path) -> list[dict]:
    reader = PdfReader(str(pdf_path))
    out = []
    for i, page in enumerate(reader.pages):
        try:
            text = page.extract_text() or ""
        except Exception:
            text = ""
        out.append({"page": i + 1, "text": text})
    return out


def pages_to_text(pages: list[dict]) -> str:
    return "\n\n".join(f"=== Page {p['page']} ===\n{p['text']}" for p in pages)
