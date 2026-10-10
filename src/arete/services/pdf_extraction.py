"""PDF text/OCR in a disposable process: MuPDF is not safe across API threads."""

from __future__ import annotations

import math
import os
import subprocess
import sys
from pathlib import Path
from threading import BoundedSemaphore

from arete.services.documents import (
    MAX_EXTRACT_BYTES,
    MAX_FILE_BYTES,
    MAX_PAGES,
    DocumentError,
    Extraction,
    SourceBlock,
)

PDF_TIMEOUT_SECONDS = 240
MAX_PDF_WORKERS = 1
MAX_PAGE_LINES = 5000
MAX_PAGE_PIXELS = 25_000_000
OCR_DPI = 200
OCR_THREADS = 1
OCR_LANGUAGES = "fra+eng"
TESSDATA = Path(__file__).resolve().parents[1] / "tessdata"
_WORKERS = BoundedSemaphore(MAX_PDF_WORKERS)
OCR_WARNING = "Texte reconnu automatiquement : vérifie les dates, chiffres et unités dans l’original."


def extract_pdf(raw: bytes) -> Extraction:
    if not 0 < len(raw) <= MAX_FILE_BYTES:
        raise DocumentError("Le PDF doit contenir entre 1 octet et 20 Mio.")
    if not _WORKERS.acquire(blocking=False):
        raise DocumentError(
            "Une extraction PDF est déjà en cours. Réessaie après sa fin."
        )
    try:
        # A thread timeout cannot stop native OCR. run() kills and reaps the child
        # on timeout, and the child never opens the athlete database.
        result = subprocess.run(
            [sys.executable, "-m", "arete.services.pdf_extraction"],
            input=raw,
            capture_output=True,
            timeout=PDF_TIMEOUT_SECONDS,
            check=False,
            env={
                **os.environ,
                "PYTHONPATH": os.pathsep.join(sys.path),
                "OMP_THREAD_LIMIT": str(OCR_THREADS),
            },
        )
        if result.returncode != 0:
            detail = result.stderr.decode(errors="replace").strip()
            raise DocumentError(
                f"Extraction PDF impossible : {detail or 'processus interrompu.'}"
            )
        return Extraction.model_validate_json(result.stdout)
    except subprocess.TimeoutExpired as exc:
        raise DocumentError(
            "Extraction PDF trop longue (240 s). Sépare le document."
        ) from exc
    except OSError as exc:
        raise DocumentError("Impossible de démarrer l’extraction PDF.") from exc
    finally:
        _WORKERS.release()


def _extract_pdf(raw: bytes) -> Extraction:
    import pymupdf

    blocks: list[SourceBlock] = []
    encoded_bytes = 0
    with pymupdf.open(stream=raw, filetype="pdf") as document:
        # Encryption with an empty password is still encryption.
        if document.needs_pass or document.metadata.get("encryption"):
            raise DocumentError("Les PDF chiffrés ne sont pas acceptés.")
        if document.page_count > MAX_PAGES:
            raise DocumentError("Maximum 100 pages par PDF.")
        for index in range(document.page_count):
            page = document[index]
            textpage = page.get_textpage(flags=0)
            text = textpage.extractText()
            # A native header must not hide a scan. Vector-only pages also need
            # OCR; ordinary text pages avoid its cost entirely.
            needs_ocr = (
                not text.strip() or bool(page.get_image_info()) or "\ufffd" in text
            )
            if needs_ocr:
                width = math.ceil(page.rect.width * OCR_DPI / 72)
                height = math.ceil(page.rect.height * OCR_DPI / 72)
                if width * height > MAX_PAGE_PIXELS:
                    raise DocumentError(
                        "Page trop grande pour la reconnaissance (25 mégapixels)."
                    )
                if not all(
                    (TESSDATA / f"{lang}.traineddata").is_file()
                    for lang in OCR_LANGUAGES.split("+")
                ):
                    raise DocumentError(
                        "Ressources OCR français/anglais manquantes sur le serveur."
                    )
                textpage = page.get_textpage_ocr(
                    flags=0,
                    language=OCR_LANGUAGES,
                    dpi=OCR_DPI,
                    full=not text.strip(),
                    tessdata=str(TESSDATA),
                )
            line_number = 0
            for block in textpage.extractDICT(sort=True)["blocks"]:
                for line in block.get("lines", []):
                    line_text = "".join(span["text"] for span in line["spans"])
                    if not line_text.strip():
                        continue
                    line_number += 1
                    if line_number > MAX_PAGE_LINES:
                        raise DocumentError("Plus de 5 000 lignes sur une page PDF.")
                    source = SourceBlock(
                        locator=f"page {index + 1}, ligne {line_number}",
                        text=line_text,
                        method="ocr"
                        if any(
                            span["font"] == "GlyphLessFont" for span in line["spans"]
                        )
                        else "text",
                        box=list(line["bbox"]),
                    )
                    encoded_bytes += len(source.model_dump_json().encode()) + 1
                    if encoded_bytes > MAX_EXTRACT_BYTES - 4096:
                        raise DocumentError(
                            "Extraction trop volumineuse (2 Mio). Sépare le document."
                        )
                    blocks.append(source)
    if not blocks:
        raise DocumentError("Aucun texte lisible dans ce PDF.")
    return Extraction(
        blocks=blocks,
        warnings=[OCR_WARNING] if any(b.method == "ocr" for b in blocks) else [],
    )


def main() -> None:
    import pymupdf

    # Native diagnostics otherwise pollute the JSON protocol; exceptions remain
    # explicit on stderr and fail finalization without persisting partial text.
    pymupdf.TOOLS.mupdf_display_errors(False)
    pymupdf.TOOLS.mupdf_display_warnings(False)
    try:
        raw = sys.stdin.buffer.read(MAX_FILE_BYTES + 1)
        if not 0 < len(raw) <= MAX_FILE_BYTES:
            raise DocumentError("PDF vide ou trop volumineux.")
        extraction = _extract_pdf(raw)
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1) from exc
    sys.stdout.write(extraction.model_dump_json())


if __name__ == "__main__":
    main()
