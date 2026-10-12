"""PDF text/OCR in a disposable process: PDFium is not safe across API threads."""

from __future__ import annotations

import math
import os
import subprocess
import sys
from pathlib import Path
from threading import BoundedSemaphore
from typing import Literal

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
    import pypdfium2 as pdfium
    import pypdfium2.raw as pdfium_c

    try:
        document = pdfium.PdfDocument(raw)
    except pdfium.PdfiumError as exc:
        if exc.err_code == pdfium_c.FPDF_ERR_PASSWORD:
            raise DocumentError("Les PDF chiffrés ne sont pas acceptés.") from exc
        raise
    blocks: list[SourceBlock] = []
    encoded_bytes = 0
    try:
        # Encryption with an empty password is still encryption.
        if pdfium_c.FPDF_GetSecurityHandlerRevision(document.raw) != -1:
            raise DocumentError("Les PDF chiffrés ne sont pas acceptés.")
        if len(document) > MAX_PAGES:
            raise DocumentError("Maximum 100 pages par PDF.")
        for index in range(len(document)):
            page = document[index]
            native = _native_lines(page)
            text = "".join(line_text for line_text, _ in native)
            # A native header must not hide a scan. Vector-only pages also need
            # OCR; ordinary text pages avoid its cost entirely.
            has_image = (
                next(page.get_objects(filter=[pdfium_c.FPDF_PAGEOBJ_IMAGE]), None)
                is not None
            )
            lines: list[tuple[str, list[float], Literal["text", "ocr"]]] = [
                (t, box, "text") for t, box in native if "\ufffd" not in t
            ]
            if not text.strip() or has_image or "\ufffd" in text:
                # Partial OCR keeps readable native lines and adds only what the
                # recognizer finds elsewhere on the page.
                kept = [box for _, box, _ in lines]
                lines += [
                    (t, box, "ocr")
                    for t, box in _ocr_lines(page)
                    if not any(_overlaps(box, other) for other in kept)
                ]
            lines.sort(key=lambda line: (round(line[1][1]), line[1][0]))
            line_number = 0
            for line_text, box, method in lines:
                if not line_text.strip():
                    continue
                line_number += 1
                if line_number > MAX_PAGE_LINES:
                    raise DocumentError("Plus de 5 000 lignes sur une page PDF.")
                source = SourceBlock(
                    locator=f"page {index + 1}, ligne {line_number}",
                    text=line_text,
                    method=method,
                    box=box,
                )
                encoded_bytes += len(source.model_dump_json().encode()) + 1
                if encoded_bytes > MAX_EXTRACT_BYTES - 4096:
                    raise DocumentError(
                        "Extraction trop volumineuse (2 Mio). Sépare le document."
                    )
                blocks.append(source)
    finally:
        document.close()
    if not blocks:
        raise DocumentError("Aucun texte lisible dans ce PDF.")
    return Extraction(
        blocks=blocks,
        warnings=[OCR_WARNING] if any(b.method == "ocr" for b in blocks) else [],
    )


def _native_lines(page) -> list[tuple[str, list[float]]]:
    """PDFium's text rectangles, one per line segment, boxed from the top left."""
    height = page.get_height()
    textpage = page.get_textpage()
    lines = []
    for i in range(textpage.count_rects()):
        left, bottom, right, top = textpage.get_rect(i)
        lines.append(
            (
                textpage.get_text_bounded(left, bottom, right, top),
                [left, height - top, right, height - bottom],
            )
        )
    return lines


def _ocr_lines(page) -> list[tuple[str, list[float]]]:
    import tesserocr

    width, height = page.get_size()
    if (
        math.ceil(width * OCR_DPI / 72) * math.ceil(height * OCR_DPI / 72)
        > MAX_PAGE_PIXELS
    ):
        raise DocumentError("Page trop grande pour la reconnaissance (25 mégapixels).")
    if not all(
        (TESSDATA / f"{lang}.traineddata").is_file()
        for lang in OCR_LANGUAGES.split("+")
    ):
        raise DocumentError(
            "Ressources OCR français/anglais manquantes sur le serveur."
        )
    image = page.render(scale=OCR_DPI / 72, grayscale=True).to_pil()
    points = 72 / OCR_DPI
    level = tesserocr.RIL.TEXTLINE
    lines: list[tuple[str, list[float]]] = []
    with tesserocr.PyTessBaseAPI(path=str(TESSDATA), lang=OCR_LANGUAGES) as api:
        # Tesseract's diagnostics would otherwise reach the user-facing error.
        api.SetVariable("debug_file", os.devnull)
        api.SetImage(image)
        api.SetSourceResolution(OCR_DPI)
        api.Recognize()
        iterator = api.GetIterator()
        if iterator is None:
            return lines
        for item in tesserocr.iterate_level(iterator, level):
            try:
                text = item.GetUTF8Text(level).strip()
            except RuntimeError:  # tesserocr's "No text returned": a blank page
                continue
            bbox = item.BoundingBox(level)
            if text and bbox:
                lines.append((text, [value * points for value in bbox]))
    return lines


def _overlaps(box: list[float], other: list[float]) -> bool:
    """Whether most of an OCR line lies on a native line already extracted."""
    width = min(box[2], other[2]) - max(box[0], other[0])
    height = min(box[3], other[3]) - max(box[1], other[1])
    area = (box[2] - box[0]) * (box[3] - box[1])
    return width > 0 and height > 0 and width * height > area / 2


def main() -> None:
    # Exceptions remain explicit on stderr and fail finalization without
    # persisting partial text; stdout carries only the JSON result.
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
