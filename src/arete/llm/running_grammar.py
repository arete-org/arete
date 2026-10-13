"""Grammar for a running session's written description (Lark, LALR).

The coach, the plan generator and the athlete describe structured runs in
the same compact French notation:

    VMA — 12×400 @3'33 r1'. Échauffement 20-25' + 4-6 strides, retour 15'
    Seuil : 3×10' au seuil (3:56/km), récup 2'
    Activation : 20' facile + 4×2' allure course (4:10/km)

Blocks are separated by ``.``, ``+``, ``·``, ``,``, ``;``, a dash, a new line
or "puis". An optional title ("VMA —", "Seuil :", "Fractionné") opens the
text. Each block is a repeat ``N×D``, a single effort ``D``, a recovery
(``r1'``, ``r90"``, ``récup 2'``), a warm-up (``Échauffement``, ``échauff``,
``EC``), a cool-down (``retour``, ``RAC``, ``retour au calme``) or strides
(``4 strides``, ``6 lignes droites``). D is a distance (``400 m``, ``1 km``, a
bare number of at least 100 meters) or a duration (``10'``, ``1'30``,
``90"``, ``45 min``, ``1h30``). An effort may carry a pace (``@3'33``,
``@3'30-3'36``, ``(3:56/km)``), a heart-rate zone (``Z2``) and intensity
words from a closed list ("au seuil", "allure course", "facile"...).

Output: Step-shaped dictionaries (see ``services.prescriptions.Step``); the
caller validates them. Anything the grammar cannot place makes the whole
text unparsed: a partial workout is never returned.
"""

from __future__ import annotations

import re
from typing import Any

from lark import Lark, Token, Transformer
from lark.exceptions import LarkError

#: A single written pace becomes a target this many seconds per km either side.
PACE_TOLERANCE_SEC = 3
#: A bare number reads as meters only from here ("12×400"); "r90" is ambiguous.
MIN_BARE_METERS = 100
MAX_TEXT = 1_000

_P = r"\d{1,2}\s*['’′:]\s*\d{2}[\"”″]?"
_PR = rf"{_P}(?:\s*(?:-|–|à)\s*{_P})?"

GRAMMAR = rf"""
start: title? block (_SEP block)* _SEP?

title: TITLE | LABEL _SEP?

?block: warmup | cooldown | strides | repeat | effort | recovery

warmup: WARMUP ":"? amount? mods | amount WARMUP mods
cooldown: COOLDOWN ":"? amount? mods | amount COOLDOWN mods
strides: COUNT STRIDES
repeat: REPEAT amount mods recovery?
effort: amount mods
recovery: RECOVERY ":"? amount mods

mods: (PACE | ZONE | INTENSITY)*
?amount: DURATION | DISTANCE | COUNT

TITLE.7: /(?!(?i:[ée]chauf|retour|r[aà]c\b|ec\b))[^\W\d_][^\W\d_'’]*(?:[ '’]+[^\W\d_]+)*\s*(?::|—|–|\s-(?=\s))/
REPEAT.6: /\d+\s*[x×]\s*(?=\d)/i
PACE.5: /@\s*{_PR}(?:\s*(?:min)?\/\s*km)?|\(\s*{_PR}\s*(?:(?:min)?\/\s*km)?\s*\)|(?:à\s+)?{_PR}\s*(?:min)?\/\s*km/i
ZONE.5: /z[1-5]\b/i
WARMUP.5: /(?i:[ée]chauf+(?:ement|e)?\b)|EC\b/
COOLDOWN.5: /(?i:retour(?:\s+au\s+calme)?\b|r[aà]c\b)/
STRIDES.5: /(?:strides?|lignes?\s+droites?)\b/i
RECOVERY.5: /(?:r(?=\s?\d)|r[ée]cup(?:[ée]ration)?\b|repos\b)/i
DURATION.4: /\d+\s*h(?:\s*\d{{2}})?\b|\d+(?:\s*[-–]\s*\d+)?\s*(?:['’′]{{2}}|[\"”″]|['’′](?:\s*\d{{2}}[\"”″]?)?|(?:min(?:utes?)?|mn|sec(?:ondes?)?|s)\b)/i
DISTANCE.4: /\d+(?:[.,]\d+)?(?:\s*[-–]\s*\d+(?:[.,]\d+)?)?\s*(?:km|m)\b/i
INTENSITY.3: /(?:au\s+seuil|(?:[àa]\s+)?(?:l['’]\s*)?allure\s+(?:vma|course|seuil|marathon|semi(?:-marathon)?|sp[ée]cifique|10\s?km|5\s?km)|vma|seuil|tempo|facile|souple|footing|trot|march[ée]e?|endurance(?:\s+fondamentale)?|ef)\b/i
LABEL.3: /(?:fractionn[ée]|vma|seuil|tempo|sp[ée]cifique|rappel|activation|s[ée]ance)\b/i
COUNT.1: /\d+(?:\s*[-–]\s*\d+)?/
_SEP: /(?:[.+·,;—–\n]|puis\b)(?:\s*(?:[.+·,;—–\n]|puis\b))*/i

%import common.WS_INLINE
%ignore WS_INLINE
"""

_PARSER = Lark(GRAMMAR, parser="lalr", lexer="contextual")


class RunningParseError(ValueError):
    """The text holds something the grammar recognises but cannot represent."""


# --------------------------------------------------------------------------- #
# Token helpers
# --------------------------------------------------------------------------- #
def _numbers(text: str) -> list[float]:
    return [float(n.replace(",", ".")) for n in re.findall(r"\d+(?:[.,]\d+)?", text)]


def _is_range(text: str) -> bool:
    return bool(re.search(r"\d\s*[-–]\s*\d", text))


def _seconds(tok: str) -> float:
    """Lower bound of a duration in seconds: 20-25' -> 1200, 1'30 -> 90."""
    t = tok.lower()
    numbers = [int(n) for n in re.findall(r"\d+", t)]
    if "h" in t:
        return numbers[0] * 3600 + (numbers[1] * 60 if len(numbers) > 1 else 0)
    if re.search(r"['’′]{2}", t):
        return numbers[0]
    if re.search(r"['’′]\s*\d", t):  # minutes then seconds
        return numbers[-2] * 60 + numbers[-1]
    if re.search(r"min|mn|['’′]", t):
        return numbers[0] * 60
    return numbers[0]  # ", s, sec, secondes


def _amount(tok: Token) -> tuple[str, float]:
    text = str(tok)
    if tok.type == "DURATION":
        return "seconds", _seconds(text)
    low = _numbers(text)[0]
    if tok.type == "DISTANCE":
        return "meters", low * 1000 if text.lower().rstrip().endswith("km") else low
    if low < MIN_BARE_METERS:
        raise RunningParseError(f"distance sans unité ambiguë : {text}")
    return "meters", low


def _pace(tok: Token) -> tuple[float, float]:
    paces = [
        int(m) * 60 + int(s)
        for m, s in re.findall(r"(\d{1,2})\s*['’′:]\s*(\d{2})", str(tok))
    ]
    if len(paces) == 1:
        return paces[0] - PACE_TOLERANCE_SEC, paces[0] + PACE_TOLERANCE_SEC
    return min(paces), max(paces)


# --------------------------------------------------------------------------- #
# Transformer: parse tree -> blocks
# --------------------------------------------------------------------------- #
def _step(kind: str, children: list[Any]) -> dict[str, Any]:
    """One step from its amount token (optional) and its modifiers."""
    amount = next(
        (c for c in children if isinstance(c, Token) and c.type in _AMOUNTS), None
    )
    mods = next((c for c in children if isinstance(c, dict)), {})
    step: dict[str, Any] = {"kind": kind}
    notes = list(mods.get("notes", []))
    if amount is not None:
        step["duration_kind"], step["value"] = _amount(amount)
        if _is_range(str(amount)):
            notes.insert(0, str(amount).strip())
    targets = mods.get("targets", [])
    if targets:
        step["target"] = targets[0]
    if len(targets) > 1:
        step["secondary_target"] = targets[1]
    if notes:
        step["notes"] = " ".join(notes)
    return step


_AMOUNTS = frozenset({"DURATION", "DISTANCE", "COUNT"})


class _ToBlocks(Transformer):
    def mods(self, toks: list[Token]) -> dict[str, Any]:
        paces = [t for t in toks if t.type == "PACE"]
        zones = [t for t in toks if t.type == "ZONE"]
        if len(paces) > 1 or len(zones) > 1:
            raise RunningParseError("plusieurs cibles du même type")
        targets = [
            {"kind": "pace_sec_km", "low": low, "high": high}
            for low, high in map(_pace, paces)
        ] + [
            {"kind": "hr_zone", "low": z, "high": z}
            for z in (int(str(t)[1]) for t in zones)
        ]
        notes = [" ".join(str(t).split()) for t in toks if t.type == "INTENSITY"]
        return {"targets": targets, "notes": notes}

    def title(self, _: list[Token]) -> None:
        return None

    def warmup(self, children: list[Any]) -> dict[str, Any]:
        return _step("warmup", children)

    def cooldown(self, children: list[Any]) -> dict[str, Any]:
        return _step("cooldown", children)

    def effort(self, children: list[Any]) -> dict[str, Any]:
        return _step("effort", children)

    def recovery(self, children: list[Any]) -> dict[str, Any]:
        return _step("recovery", children)

    def strides(self, children: list[Token]) -> dict[str, Any]:
        count = str(children[0])
        n = int(_numbers(count)[0])
        stride = {"kind": "effort", "duration_kind": "lap", "notes": "strides"}
        if n == 1:
            return {**stride, "_strides": True}
        block: dict[str, Any] = {"kind": "repeat", "repeat": n, "steps": [stride]}
        if _is_range(count):
            block["notes"] = f"{count.strip()} strides"
        return {**block, "_strides": True}

    def repeat(self, children: list[Any]) -> dict[str, Any]:
        n = int(_numbers(str(children[0]))[0])
        work = _step("effort", children[1:3])
        steps = [work] + ([children[3]] if len(children) > 3 else [])
        return {"kind": "repeat", "repeat": n, "steps": steps}

    def start(self, children: list[Any]) -> list[dict[str, Any]]:
        return [c for c in children if c is not None]


_TRANSFORM = _ToBlocks()


def _assemble(blocks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Warm-up (with the strides that follow it) first, cool-down last.

    A recovery standing alone after a repeat without one ("6×3', récup 2'")
    is that repeat's recovery.
    """
    middle: list[dict[str, Any]] = []
    warmup: list[dict[str, Any]] = []
    cooldown: list[dict[str, Any]] = []
    after_warmup = False
    for block in blocks:
        strides = block.pop("_strides", False)
        if block["kind"] == "warmup":
            if warmup:
                raise RunningParseError("deux échauffements")
            warmup.append(block)
        elif block["kind"] == "cooldown":
            if cooldown:
                raise RunningParseError("deux retours au calme")
            cooldown.append(block)
        elif strides and after_warmup:
            warmup.append(block)
        elif (
            block["kind"] == "recovery"
            and middle
            and middle[-1]["kind"] == "repeat"
            and len(middle[-1]["steps"]) == 1
        ):
            middle[-1]["steps"].append(block)
        else:
            middle.append(block)
        after_warmup = block["kind"] == "warmup" or (strides and after_warmup)
    if not any(b["kind"] in {"effort", "repeat"} for b in middle):
        raise RunningParseError("aucun effort")
    return warmup + middle + cooldown


# --------------------------------------------------------------------------- #
# Public API
# --------------------------------------------------------------------------- #
def parse_running(text: str) -> list[dict[str, Any]] | None:
    """Step dictionaries for the whole description, or None if any part is unread."""
    text = text.strip()
    if not text or len(text) > MAX_TEXT:
        return None
    try:
        tree = _PARSER.parse(text)
        return _assemble(_TRANSFORM.transform(tree))
    except (LarkError, RunningParseError):
        # Transformer errors arrive wrapped in VisitError, a LarkError.
        return None
