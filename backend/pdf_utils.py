from pathlib import Path
from pypdf import PdfReader

MAX_PDF_PAGES = 1000
MAX_EXTRACTED_CHARS = 5_000_000


def extract_pages(pdf_path: Path) -> list[dict]:
    reader = PdfReader(str(pdf_path))
    if reader.is_encrypted:
        raise ValueError("Encrypted PDFs are not supported")
    if len(reader.pages) > MAX_PDF_PAGES:
        raise ValueError(f"PDF exceeds the {MAX_PDF_PAGES}-page limit")
    out = []
    total_chars = 0
    for i, page in enumerate(reader.pages):
        try:
            text = page.extract_text() or ""
        except Exception:
            text = ""
        total_chars += len(text)
        if total_chars > MAX_EXTRACTED_CHARS:
            raise ValueError("PDF text exceeds the extraction size limit")
        out.append({"page": i + 1, "text": text})
    return out


def pages_to_text(pages: list[dict]) -> str:
    return "\n\n".join(f"=== Page {p['page']} ===\n{p['text']}" for p in pages)
