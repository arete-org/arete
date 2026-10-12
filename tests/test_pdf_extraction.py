"""Real PDF/OCR bytes, provenance, and bounded worker failures (no network)."""

import subprocess
import sys
from threading import Event, Thread

import pypdfium2 as pdfium
import pytest
from pdf_samples import (
    add_image,
    add_text,
    encrypted,
    rendered_text,
    text_pdf,
    to_bytes,
)

from arete.services import pdf_extraction as pdf
from arete.services.documents import DocumentError


def mixed_pdf():
    scan = rendered_text("Natation 8 x 100 m repos 30 secondes")
    document = pdfium.PdfDocument.new()
    add_text(
        document, document.new_page(595, 842), "Course 12 janvier 2027 : 45 minutes"
    )
    for header in ("", "Velo 13 janvier 2027 : 60 minutes"):
        page = document.new_page(595, 842)
        if header:
            add_text(document, page, header)
        add_image(document, page, scan, 30, 100, 570, 262)
    return to_bytes(document)


def test_text_does_not_require_ocr_data(monkeypatch, tmp_path):
    monkeypatch.setattr(pdf, "TESSDATA", tmp_path)
    result = pdf._extract_pdf(text_pdf("Course 45 minutes"))
    assert [(b.locator, b.text, b.method) for b in result.blocks] == [
        ("page 1, ligne 1", "Course 45 minutes", "text")
    ]
    assert len(result.blocks[0].box) == 4
    assert result.warnings == []


def test_real_worker_preserves_text_scan_and_mixed_pages():
    result = pdf.extract_pdf(mixed_pdf())
    pages = [
        [b for b in result.blocks if b.locator.startswith(f"page {n},")]
        for n in (1, 2, 3)
    ]
    assert any("45 minutes" in b.text and b.method == "text" for b in pages[0])
    for page in pages[1:]:
        assert any(
            "8 x 100 m repos 30 secondes" in b.text and b.method == "ocr" for b in page
        )
    # Partial OCR keeps the native header and does not read it a second time.
    assert [b.method for b in pages[2] if "60 minutes" in b.text] == ["text"]
    assert all(b.confidence is None for b in result.blocks)
    assert result.warnings == [pdf.OCR_WARNING]


def test_missing_languages_fail_even_with_native_header(monkeypatch, tmp_path):
    monkeypatch.setattr(pdf, "TESSDATA", tmp_path)
    with pytest.raises(DocumentError, match="Ressources OCR"):
        pdf._extract_pdf(mixed_pdf())


@pytest.mark.parametrize("password", ["secret", ""])
def test_encrypted_pdf_is_rejected(password):
    raw = encrypted(text_pdf("Private"), password)
    with pytest.raises(DocumentError, match="chiffrés"):
        pdf.extract_pdf(raw)


def test_invalid_and_empty_pdf_fail():
    with pytest.raises(DocumentError, match="Extraction PDF impossible"):
        pdf.extract_pdf(b"not a PDF")
    with pytest.raises(DocumentError, match="Aucun texte"):
        pdf.extract_pdf(text_pdf(""))


@pytest.mark.parametrize(
    "limit,value,texts,match",
    [
        ("MAX_PAGES", 1, ("first", "second"), "pages"),
        ("MAX_PAGE_LINES", 1, ("first\nsecond",), "lignes"),
        ("MAX_EXTRACT_BYTES", 4100, ("Course",), "volumineuse"),
        ("MAX_PAGE_PIXELS", 1, ("",), "mégapixels"),
    ],
)
def test_limits_fail_without_truncation(monkeypatch, limit, value, texts, match):
    monkeypatch.setattr(pdf, limit, value)
    with pytest.raises(DocumentError, match=match):
        pdf._extract_pdf(text_pdf(*texts))


def test_timeout_kills_worker_and_releases_slot(monkeypatch):
    run = subprocess.run
    calls = []

    def slow_worker(command, **kwargs):
        # Exercise the actual subprocess timeout/reaping path, not a fake error.
        calls.append(command)
        return run([sys.executable, "-c", "import time; time.sleep(10)"], **kwargs)

    with monkeypatch.context() as patch:
        patch.setattr(pdf, "PDF_TIMEOUT_SECONDS", 0.05)
        patch.setattr(pdf.subprocess, "run", slow_worker)
        with pytest.raises(DocumentError, match="trop longue"):
            pdf.extract_pdf(text_pdf("Course"))
    assert len(calls) == 1
    assert pdf.extract_pdf(text_pdf("Course")).blocks[0].text == "Course"


def test_concurrent_request_fails_fast_and_failure_releases_slot(monkeypatch):
    started, release = Event(), Event()
    errors = []
    raw = text_pdf("Course")

    def worker(*args, **kwargs):
        started.set()
        assert release.wait(timeout=5)
        raise OSError("Cannot spawn")

    def first_request():
        try:
            pdf.extract_pdf(raw)
        except DocumentError as exc:
            errors.append(str(exc))

    with monkeypatch.context() as patch:
        patch.setattr(pdf.subprocess, "run", worker)
        thread = Thread(target=first_request)
        thread.start()
        try:
            assert started.wait(timeout=5)
            with pytest.raises(DocumentError, match="déjà en cours"):
                pdf.extract_pdf(raw)
        finally:
            release.set()
            thread.join(timeout=5)
        assert not thread.is_alive()
    assert len(errors) == 1 and "démarrer" in errors[0]
    assert pdf.extract_pdf(raw).blocks[0].text == "Course"
