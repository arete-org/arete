"""Grammar for a running session's written description (Lark, LALR).

The coach, the plan generator and the athlete describe structured runs in
the same compact French notation:

    Échauffement 20-25' + 4-6 strides, 12×400 @3'33 r1', retour 15'
    Seuil : 3×10' au seuil (3:56/km), récup 2'
    Activation : 20' facile + 4×2' allure course (4:10/km)

Blocks are separated by ``.``, ``+``, ``·``, ``,``, ``;``, a dash, a new line
or "puis", and stay in written order: a warm-up (``Échauffement``,
``échauff``, ``EC``) only first, a cool-down (``retour``, ``RAC``, ``retour
au calme``) only last. One exception, the coach's habit: a last sentence
(after ``.``, ``;`` or a new line) holding only a warm-up, optional strides
and a final cool-down frames the main set written before it:

    VMA — 12×400 @3'33 r1'. Échauffement 20-25' + 4-6 strides, retour 15'
 An optional title ("Fractionné :", "Rappel :") opens
the text; a leading intensity ("Seuil :", "VMA —") becomes the first
effort's notes. Other blocks are a repeat ``N×D``, a single effort ``D``, a
recovery (``r1'``, ``r90"``, ``r200 m``, ``récup 2'``) or strides (``4
strides``, ``6 lignes droites``: lap button to end each, lap button after
walking back). D is a distance (``400 m``, ``1 km``, an effort's bare number
of at least 100 meters) or a duration (``10'``, ``1'30``, ``90"``, ``45
min``, ``1h30``). An effort may carry a pace (``@3'33``, ``@3'30-3'36``,
``(3:56/km)``), a heart-rate zone (``Z2``) and intensity words from a closed
list ("au seuil", "allure course", "facile"...); a recovery only how to
recover ("trot", "marche").

When in doubt the text is unread: "1.000 m", a unitless recovery, a target
after a recovery, seconds of 60 or more, any other warm-up after the main set.

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
# Intensity and strides words carry meaning: never swallowed by a title.
_INTENSITY = (
    r"(?:au\s+seuil|seuil\s+continu|(?:[àa]\s+)?(?:l['’]\s*)?allure\s+"
    r"(?:vma|course|seuil|marathon|semi(?:-marathon)?|sp[ée]cifique|10\s?km|5\s?km)"
    r"|vma|seuil|tempo|facile|souple|footing|trot|march[ée]e?"
    r"|endurance(?:\s+fondamentale)?|ef)\b"
)
_STRIDES = r"(?:strides?|lignes?\s+droites?)\b"
_KEYWORD = rf"(?i:{_INTENSITY}|{_STRIDES}|[ée]chauf|retour\b|r[aà]c\b|ec\b)"
_TITLE_WORD = rf"(?!{_KEYWORD})[^\W\d_][^\W\d_'’]*"
#: Recovery notes that describe how to recover, not an effort's intensity.
RECOVERY_NOTES = frozenset(
    {"trot", "footing", "facile", "souple", "marche", "marché", "marchée"}
)

GRAMMAR = rf"""
start: head? block (SEP block)* SEP?

head: TITLE | LABEL lead? SEP? | lead
lead: INTENSITY+ (":" | SEP)?

?block: warmup | cooldown | strides | repeat | effort | recovery

warmup: WARMUP ":"? amount? mods | amount WARMUP mods
cooldown: COOLDOWN ":"? amount? mods | amount COOLDOWN mods
strides: COUNT STRIDES
repeat: REPEAT amount mods recovery?
effort: amount mods
recovery: RECOVERY ":"? amount mods

mods: (PACE | ZONE | INTENSITY)*
?amount: DURATION | DISTANCE | COUNT

TITLE.7: /{_TITLE_WORD}(?:[ '’]+{_TITLE_WORD})*\s*(?::|—|–|\s-(?=\s))/
REPEAT.6: /\d+\s*[x×]\s*(?=\d)/i
PACE.5: /@\s*{_PR}(?:\s*(?:min)?\/\s*km)?|\(\s*{_PR}\s*(?:(?:min)?\/\s*km)?\s*\)|(?:à\s+)?{_PR}\s*(?:min)?\/\s*km/i
ZONE.5: /z[1-5]\b/i
WARMUP.5: /(?i:[ée]chauf+(?:ement|e)?\b)|EC\b/
COOLDOWN.5: /(?i:retour(?:\s+au\s+calme)?\b|r[aà]c\b)/
STRIDES.5: /{_STRIDES}/i
RECOVERY.5: /(?:r(?=\s?\d)|r[ée]cup(?:[ée]ration)?\b|repos\b)/i
DURATION.4: /\d+\s*h(?:\s*\d{{2}})?\b|\d+(?:\s*[-–]\s*\d+)?\s*(?:['’′]{{2}}|[\"”″]|['’′](?:\s*\d{{2}}[\"”″]?)?|(?:min(?:utes?)?|mn|sec(?:ondes?)?|s)\b)/i
DISTANCE.4: /\d+(?:[.,]\d+)?(?:\s*[-–]\s*\d+(?:[.,]\d+)?)?\s*(?:km|m)\b/i
INTENSITY.3: /{_INTENSITY}/i
LABEL.3: /(?:fractionn[ée]|sp[ée]cifique|rappel|activation|s[ée]ance)\b/i
COUNT.1: /\d+(?:\s*[-–]\s*\d+)?/
SEP: /(?:[.+·,;—–\n]|puis\b)(?:\s*(?:[.+·,;—–\n]|puis\b))*/i

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
        minutes = numbers[1] if len(numbers) > 1 else 0
        if minutes >= 60:
            raise RunningParseError(f"minutes invalides : {tok}")
        return numbers[0] * 3600 + minutes * 60
    if re.search(r"['’′]{2}", t):
        return numbers[0]
    if re.search(r"['’′]\s*\d", t):  # minutes then seconds
        if numbers[-1] >= 60:
            raise RunningParseError(f"secondes invalides : {tok}")
        return numbers[-2] * 60 + numbers[-1]
    if re.search(r"min|mn|['’′]", t):
        return numbers[0] * 60
    return numbers[0]  # ", s, sec, secondes


def _amount(tok: Token) -> tuple[str, float]:
    text = str(tok)
    if tok.type == "DURATION":
        return "seconds", _seconds(text)
    if re.search(r"\d[.,]\d{3}", text):  # 1.000 m: thousands or decimals?
        raise RunningParseError(f"distance ambiguë : {text}")
    low = _numbers(text)[0]
    if tok.type == "DISTANCE":
        return "meters", low * 1000 if text.lower().rstrip().endswith("km") else low
    if low < MIN_BARE_METERS:
        raise RunningParseError(f"distance sans unité ambiguë : {text}")
    return "meters", low


def _pace(tok: Token) -> tuple[float, float]:
    found = re.findall(r"(\d{1,2})\s*['’′:]\s*(\d{2})", str(tok))
    if any(int(s) >= 60 for _, s in found):
        raise RunningParseError(f"allure invalide : {tok}")
    paces = [int(m) * 60 + int(s) for m, s in found]
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

    def lead(self, toks: list[Token]) -> dict[str, Any]:
        return {
            "_lead": [" ".join(str(t).split()) for t in toks if t.type == "INTENSITY"]
        }

    def head(self, children: list[Any]) -> dict[str, Any] | None:
        return next((c for c in children if isinstance(c, dict)), None)

    def warmup(self, children: list[Any]) -> dict[str, Any]:
        return _step("warmup", children)

    def cooldown(self, children: list[Any]) -> dict[str, Any]:
        return _step("cooldown", children)

    def effort(self, children: list[Any]) -> dict[str, Any]:
        return _step("effort", children)

    def recovery(self, children: list[Any]) -> dict[str, Any]:
        # "10×400 r1' @3'33": the pace was meant for the effort; never guess.
        amount = next(
            c for c in children if isinstance(c, Token) and c.type in _AMOUNTS
        )
        if amount.type == "COUNT":
            raise RunningParseError(f"récupération sans unité : {amount}")
        mods = next((c for c in children if isinstance(c, dict)), {})
        if mods.get("targets") or set(mods.get("notes", [])) - RECOVERY_NOTES:
            raise RunningParseError("cible ou intensité après la récupération")
        return _step("recovery", children)

    def strides(self, children: list[Token]) -> dict[str, Any]:
        count = str(children[0])
        n = int(_numbers(count)[0])
        if n < 2:
            raise RunningParseError("une seule ligne droite")
        # Lap button to end the stride, lap button again after walking back.
        steps = [
            {"kind": "effort", "duration_kind": "lap", "notes": "strides"},
            {"kind": "recovery", "duration_kind": "lap"},
        ]
        block: dict[str, Any] = {"kind": "repeat", "repeat": n, "steps": steps}
        if _is_range(count):
            block["notes"] = f"{count.strip()} strides"
        return {**block, "_strides": True}

    def repeat(self, children: list[Any]) -> dict[str, Any]:
        n = int(_numbers(str(children[0]))[0])
        work = _step("effort", children[1:3])
        steps = [work] + ([children[3]] if len(children) > 3 else [])
        return {"kind": "repeat", "repeat": n, "steps": steps}

    def start(self, children: list[Any]) -> list[dict[str, Any]]:
        blocks: list[dict[str, Any]] = []
        sentence = False
        for child in children:
            if isinstance(child, Token):  # SEP: does a new sentence start?
                sentence = bool(re.search(r"[.;\n]", str(child)))
            elif child is not None:
                if sentence:
                    child["_sentence"] = True
                blocks.append(child)
        if blocks and "_lead" in blocks[0]:
            # "Seuil : 3×10'": the leading intensity belongs to the first effort.
            notes, first = blocks.pop(0)["_lead"], blocks[0]
            work = first["steps"][0] if first["kind"] == "repeat" else first
            if first.get("_strides") or work["kind"] != "effort":
                raise RunningParseError("intensité sans effort")
            work["notes"] = " ".join([*notes, work.get("notes", "")]).strip()
        return blocks


_TRANSFORM = _ToBlocks()


def _trailing_warmup(blocks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Move one written-after sentence: "…. Échauffement 20' + 4 strides, retour 15'".

    Only a last sentence made of a warm-up, optional strides and a final
    cool-down; any other order stays as written (and is refused below).
    """
    starts = [i for i, b in enumerate(blocks) if b.get("_sentence")]
    if not starts or starts[-1] == 0:
        return blocks
    tail = blocks[starts[-1] :]
    shape = ["strides" if b.get("_strides") else b["kind"] for b in tail]
    if shape not in (["warmup", "cooldown"], ["warmup", "strides", "cooldown"]):
        return blocks
    return tail[:-1] + blocks[: starts[-1]] + tail[-1:]


def _assemble(blocks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Steps in written order: a warm-up only first, a cool-down only last.

    A recovery standing alone after a repeat without one ("6×3', récup 2'")
    is that repeat's recovery. Apart from the trailing warm-up sentence, a
    warm-up after the main set or a "retour" in the middle (a jog back?) is
    not guessed: the text is unread.
    """
    blocks = _trailing_warmup(blocks)
    steps: list[dict[str, Any]] = []
    for index, block in enumerate(blocks):
        block.pop("_strides", None)
        block.pop("_sentence", None)
        if block["kind"] == "warmup" and index != 0:
            raise RunningParseError("échauffement après le début")
        if block["kind"] == "cooldown" and index != len(blocks) - 1:
            raise RunningParseError("retour au calme avant la fin")
        if (
            block["kind"] == "recovery"
            and steps
            and steps[-1]["kind"] == "repeat"
            and len(steps[-1]["steps"]) == 1
        ):
            steps[-1]["steps"].append(block)
        else:
            steps.append(block)
    if not any(b["kind"] in {"effort", "repeat"} for b in steps):
        raise RunningParseError("aucun effort")
    return steps


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
