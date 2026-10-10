"""Bundle pinned French/English Tesseract data; never download during an upload."""

import hashlib
import urllib.request
from pathlib import Path

TARGET = Path(__file__).resolve().parents[1] / "src" / "arete" / "tessdata"
BASE_URL = "https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/4.1.0"
LANGUAGES = {
    "eng": "7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2",
    "fra": "ced037562e8c80c13122dece28dd477d399af80911a28791a66a63ac1e3445ca",
}
MAX_LANGUAGE_BYTES = 16 * 1024 * 1024
DOWNLOAD_TIMEOUT_SECONDS = 30


def main() -> None:
    TARGET.mkdir(parents=True, exist_ok=True)
    for language, expected in LANGUAGES.items():
        path = TARGET / f"{language}.traineddata"
        if path.is_file() and hashlib.sha256(path.read_bytes()).hexdigest() == expected:
            continue
        with urllib.request.urlopen(
            f"{BASE_URL}/{path.name}", timeout=DOWNLOAD_TIMEOUT_SECONDS
        ) as response:
            raw = response.read(MAX_LANGUAGE_BYTES + 1)
        if len(raw) > MAX_LANGUAGE_BYTES or hashlib.sha256(raw).hexdigest() != expected:
            raise ValueError(f"Invalid OCR language data: {language}")
        path.write_bytes(raw)
        print(f"Bundled OCR language: {language} ({len(raw)} bytes)")


if __name__ == "__main__":
    main()
