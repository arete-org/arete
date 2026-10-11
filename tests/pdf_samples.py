"""Real PDF bytes for extraction tests, built with PDFium and encrypted by pypdf."""

import ctypes
import io

import pypdfium2 as pdfium
import pypdfium2.raw as pdfium_c
from PIL import Image
from pypdf import PdfReader, PdfWriter

WIDTH, HEIGHT = 595, 842


def add_text(document, page, text, top=70, size=12.0):
    """One text object per line, ``top`` points below the page's top edge."""
    font = pdfium_c.FPDFText_LoadStandardFont(document.raw, b"Helvetica")
    for offset, line in enumerate(text.split("\n")):
        obj = pdfium_c.FPDFPageObj_CreateTextObj(document.raw, font, size)
        buffer = ctypes.create_string_buffer((line + "\0").encode("utf-16-le"))
        pdfium_c.FPDFText_SetText(
            obj, ctypes.cast(buffer, ctypes.POINTER(pdfium_c.FPDF_WCHAR))
        )
        baseline = page.get_height() - top - offset * size * 1.5
        pdfium_c.FPDFPageObj_Transform(obj, 1, 0, 0, 1, 30, baseline)
        pdfium_c.FPDFPage_InsertObject(page.raw, obj)
    page.gen_content()


def add_image(document, page, image: Image.Image, left, top, right, bottom):
    """Places ``image`` in a box given in points from the page's top left."""
    obj = pdfium.PdfImage.new(document)
    obj.set_bitmap(pdfium.PdfBitmap.from_pil(image.convert("RGB")))
    width, height = right - left, bottom - top
    obj.set_matrix(
        pdfium.PdfMatrix()
        .scale(width, height)
        .translate(left, page.get_height() - bottom)
    )
    page.insert_obj(obj)
    page.gen_content()


def to_bytes(document) -> bytes:
    out = io.BytesIO()
    document.save(out)
    return out.getvalue()


def text_pdf(*texts) -> bytes:
    document = pdfium.PdfDocument.new()
    for text in texts:
        page = document.new_page(WIDTH, HEIGHT)
        if text:
            add_text(document, page, text)
    return to_bytes(document)


def rendered_text(text, size=24.0) -> Image.Image:
    """A 200 dpi scan of ``text``, for pages that only OCR can read."""
    document = pdfium.PdfDocument.new()
    page = document.new_page(600, 180)
    add_text(document, page, text, size=size)
    return pdfium.PdfDocument(to_bytes(document))[0].render(scale=200 / 72).to_pil()


def encrypted(raw: bytes, password: str) -> bytes:
    writer = PdfWriter(clone_from=PdfReader(io.BytesIO(raw)))
    writer.encrypt(user_password=password, owner_password="owner", algorithm="AES-256")
    out = io.BytesIO()
    writer.write(out)
    return out.getvalue()
