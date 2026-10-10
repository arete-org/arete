"""Real PDF/OCR bytes, provenance, and bounded worker failures (no network)."""

import subprocess
import sys
from threading import Event, Thread

import pymupdf
import pytest

from arete.services import pdf_extraction as pdf
from arete.services.documents import DocumentError


def text_pdf(*texts):
    with pymupdf.open() as doc:
        for text in texts:
            doc.new_page().insert_text((30, 70), text)
        return doc.tobytes()


def mixed_pdf():
    with pymupdf.open() as scan:
        page = scan.new_page(width=600, height=180)
        page.insert_text((30, 70), "Natation 8 x 100 m repos 30 secondes", fontsize=24)
        image = page.get_pixmap(dpi=200).tobytes("png")
    with pymupdf.open() as doc:
        doc.new_page().insert_text((30, 70), "Course 12 janvier 2027 : 45 minutes")
        for header in ("", "Velo 13 janvier 2027 : 60 minutes"):
            page = doc.new_page()
            if header:
                page.insert_text((30, 70), header)
            page.insert_image(pymupdf.Rect(30, 100, 570, 262), stream=image)
        return doc.tobytes()


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
    assert any("60 minutes" in b.text and b.method == "text" for b in pages[2])
    assert all(b.confidence is None for b in result.blocks)
    assert result.warnings == [pdf.OCR_WARNING]


def test_missing_languages_fail_even_with_native_header(monkeypatch, tmp_path):
    monkeypatch.setattr(pdf, "TESSDATA", tmp_path)
    with pytest.raises(DocumentError, match="Ressources OCR"):
        pdf._extract_pdf(mixed_pdf())


@pytest.mark.parametrize("password", ["secret", ""])
def test_encrypted_pdf_is_rejected(password):
    with pymupdf.open(stream=text_pdf("Private"), filetype="pdf") as doc:
        raw = doc.tobytes(
            encryption=pymupdf.PDF_ENCRYPT_AES_256, user_pw=password, owner_pw="owner"
        )
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
