"""Bounded static chart documents; no database, transport or agent dependencies."""

import json
import math
import re
from html import escape
from html.parser import HTMLParser
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

# The browser consumes the same contract so restored documents have the same limits.
CONTRACT = json.loads(Path(__file__).with_name("chart_contract.json").read_text())
MAX_CHART_TITLE_CHARS = CONTRACT["max_title_chars"]
MAX_CHART_SUMMARY_CHARS = CONTRACT["max_summary_chars"]
MAX_CHART_HTML_BYTES = CONTRACT["max_html_bytes"]
MAX_CHART_ELEMENTS = CONTRACT["max_elements"]
MAX_CHART_DEPTH = CONTRACT["max_depth"]
MAX_CHARTS_PER_RUN = CONTRACT["max_cards"]
MIN_CHART_HEIGHT = CONTRACT["height_min"]
MAX_CHART_HEIGHT = CONTRACT["height_max"]
DEFAULT_CHART_HEIGHT = CONTRACT["height_default"]
MAX_COORDINATE = 1_000_000
HTML_TAGS = frozenset(CONTRACT["html_tags"])
SVG_TAGS = frozenset(CONTRACT["svg_tags"])
CLASSES = frozenset(CONTRACT["classes"])
ATTRIBUTES = {name.lower(): name for name in CONTRACT["attributes"]}
NUMBER = r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?"
NUMBERS = re.compile(rf"{NUMBER}(?:[\s,]+{NUMBER})*")
ENUMS = {
    "role": {"img", "presentation"},
    "fill": {"none", "currentColor"},
    "stroke": {"none", "currentColor"},
    "text-anchor": {"start", "middle", "end"},
    "dominant-baseline": {"auto", "middle", "central", "hanging", "alphabetic"},
    "preserveaspectratio": {"xMidYMid meet", "xMinYMin meet"},
}
TEXT_ATTRIBUTES = frozenset({"class", "role", "aria-label"})


def _numbers(value: str) -> list[float]:
    if not NUMBERS.fullmatch(value):
        raise ValueError("Coordonnées du graphique invalides.")
    numbers = [float(n) for n in re.findall(NUMBER, value)]
    if any(not math.isfinite(n) or abs(n) > MAX_COORDINATE for n in numbers):
        raise ValueError("Coordonnées du graphique hors limites.")
    return numbers


def _attribute(name: str, value: str) -> None:
    if name == "class":
        if not value or not set(value.split()) <= CLASSES:
            raise ValueError(
                "Classe inconnue ; utilise les classes de chart-rendering."
            )
    elif name == "aria-label":
        if not value.strip() or len(value) > MAX_CHART_SUMMARY_CHARS:
            raise ValueError("Libellé du graphique invalide.")
    elif name in ENUMS:
        if value not in ENUMS[name]:
            raise ValueError(f"Valeur interdite pour {name}.")
    elif name == "d":
        if not re.fullmatch(r"[MmLlHhVvCcSsQqTtAaZz\d\s.,eE+\-]+", value):
            raise ValueError("Chemin SVG invalide.")
        _numbers(" ".join(re.findall(NUMBER, value)))
    elif name == "transform":
        if not re.fullmatch(
            r"(?:(?:translate|scale|rotate|matrix|skewX|skewY)\([\d\s.,eE+\-]+\)\s*)+",
            value,
        ):
            raise ValueError("Transformation SVG invalide.")
        _numbers(" ".join(re.findall(NUMBER, value)))
    else:
        numbers = _numbers(value)
        if name == "viewbox":
            if len(numbers) != 4 or numbers[2] <= 0 or numbers[3] <= 0:
                raise ValueError(
                    "Le viewBox doit avoir une largeur et une hauteur positives."
                )
        elif name == "points":
            if len(numbers) < 4 or len(numbers) % 2:
                raise ValueError("Les points SVG doivent former des paires.")
        elif name != "stroke-dasharray" and len(numbers) != 1:
            raise ValueError(f"Une seule valeur est attendue pour {name}.")
        if (
            name in {"opacity", "fill-opacity", "stroke-opacity"}
            and not 0 <= numbers[0] <= 1
        ):
            raise ValueError("L’opacité doit être comprise entre 0 et 1.")
        if name in {
            "width",
            "height",
            "r",
            "rx",
            "ry",
            "stroke-width",
            "stroke-dasharray",
        } and any(n < 0 for n in numbers):
            raise ValueError("Une dimension ne peut pas être négative.")


class _ChartParser(HTMLParser):
    """Reject unsupported input and serialize escaped, canonical markup.

    This enforces the authoring contract. The browser still sanitizes the parsed
    DOM and uses an opaque sandbox; HTMLParser is not the isolation boundary.
    """

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.stack: list[str] = []
        self.fragments: list[str] = []
        self.elements = 0
        self.has_svg = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.elements += 1
        if self.elements > MAX_CHART_ELEMENTS or len(self.stack) >= MAX_CHART_DEPTH:
            raise ValueError(
                "Graphique trop complexe : limite d’éléments ou de profondeur."
            )
        in_svg = "svg" in self.stack
        if tag not in HTML_TAGS | SVG_TAGS or (in_svg and tag in HTML_TAGS):
            raise ValueError(f"Élément interdit dans un graphique : {tag}.")
        if tag in SVG_TAGS - {"svg"} and not in_svg:
            raise ValueError("Les primitives SVG doivent être dans un élément svg.")
        if tag == "svg":
            if in_svg or not any(name == "viewbox" for name, _ in attrs):
                raise ValueError("Un SVG non imbriqué avec viewBox est requis.")
            self.has_svg = True
        seen: set[str] = set()
        attributes = []
        for name, value in attrs:
            if name not in ATTRIBUTES or name in seen or value is None:
                raise ValueError(f"Attribut interdit ou dupliqué : {name}.")
            if tag in HTML_TAGS and name not in TEXT_ATTRIBUTES:
                raise ValueError(f"Attribut SVG interdit sur {tag} : {name}.")
            seen.add(name)
            _attribute(name, value)
            attributes.append(f' {ATTRIBUTES[name]}="{escape(value, quote=True)}"')
        self.fragments.append(f"<{tag}{''.join(attributes)}>")
        if tag != "br":
            self.stack.append(tag)

    def handle_endtag(self, tag: str) -> None:
        if not self.stack or self.stack[-1] != tag:
            raise ValueError(f"Fermeture HTML/SVG incorrecte : {tag}.")
        self.stack.pop()
        self.fragments.append(f"</{tag}>")

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)
        if tag != "br":
            self.handle_endtag(tag)

    def handle_data(self, data: str) -> None:
        self.fragments.append(escape(data, quote=False))

    def handle_comment(self, data: str) -> None:
        raise ValueError("Les commentaires HTML ne sont pas autorisés.")

    def handle_decl(self, decl: str) -> None:
        raise ValueError("Fournis un fragment, pas un document HTML complet.")

    def handle_pi(self, data: str) -> None:
        raise ValueError("Les instructions XML ne sont pas autorisées.")

    def unknown_decl(self, data: str) -> None:
        raise ValueError("Déclaration HTML/SVG interdite.")


def validate_chart_html(html: str) -> str:
    if len(html.encode("utf-8")) > MAX_CHART_HTML_BYTES:
        raise ValueError("Le graphique dépasse 16 Kio de HTML/SVG.")
    if any(ord(char) < 32 and char not in "\t\r\n" for char in html):
        raise ValueError("Caractère de contrôle interdit dans le graphique.")
    parser = _ChartParser()
    parser.feed(html)
    parser.close()
    if parser.stack or not parser.has_svg:
        raise ValueError("Un graphique SVG complet est requis.")
    result = "".join(parser.fragments)
    if len(result.encode("utf-8")) > MAX_CHART_HTML_BYTES:
        raise ValueError("Le graphique normalisé dépasse 16 Kio.")
    return result


class ChartSpec(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)

    title: str = Field(min_length=1, max_length=MAX_CHART_TITLE_CHARS)
    summary: str = Field(min_length=1, max_length=MAX_CHART_SUMMARY_CHARS)
    html: str = Field(min_length=1, max_length=MAX_CHART_HTML_BYTES)
    height_px: int = Field(
        default=DEFAULT_CHART_HEIGHT, ge=MIN_CHART_HEIGHT, le=MAX_CHART_HEIGHT
    )

    @field_validator("title", "summary")
    @classmethod
    def nonblank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Le titre et le résumé doivent contenir du texte.")
        return value

    @field_validator("html")
    @classmethod
    def static_markup(cls, value: str) -> str:
        return validate_chart_html(value)


class ChartCard(ChartSpec):
    version: Literal[1] = 1
    id: str = Field(pattern=r"^[a-f0-9]{64}$")
