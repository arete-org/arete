"""Reads a session spoken out loud in French.

``workout_grammar`` reads what the athlete types; this reads what the athlete
says — "développé couché, 4 séries de 8 à 80 kilos" — and produces exactly the
same exercise dictionaries. No rewriting step in between: a new turn of phrase
is one more alternative in a rule, not another regular expression to slot in at
the right place.

Two stages, because exercise names and quantity keywords fight over the same
words ("soulevé DE terre" against "4 séries DE 8"):

1. split each sentence into a free-text name and the quantities that follow;
2. parse the quantities with an Earley grammar — spoken French orders its
   complements however it likes, and Earley costs nothing on five lines.
"""

from __future__ import annotations

import logging
import re
from typing import Any

from lark import Lark, Token, Tree
from lark.exceptions import LarkError
from text_to_num import alpha2digit

from arete.llm.workout_grammar import _exercise, _make_sets

logger = logging.getLogger(__name__)

DEFAULT_SETS = 1

# Marker tokens: multi-word phrases collapsed before parsing so the grammar
# stays readable.
FAILURE_TOKEN = "FAILURETOKEN"
BODYWEIGHT_TOKEN = "BODYWEIGHTTOKEN"
EACH_SIDE_TOKEN = "EACHSIDETOKEN"

_FAILURE_PHRASES = (
    r"jusqu'?\s*[àa]\s*l'?\s*[ée]chec",
    r"\bau\s+max(?:imum)?\b",
    r"\bjusqu'?\s*[àa]\s*l'?\s*[ée]puisement\b",
    r"\ben\s+amrap\b",
    r"\bto\s+failure\b",
    r"\bamrap\b",
    r"\bas\s+many\s+as\s+possible\b",
)
_BODYWEIGHT_PHRASES = (
    r"\b(?:au|en|du)\s+poids\s+d[eu]\s+corps\b",
    r"\bpoids\s+d[eu]\s+corps\b",
    r"\bbody\s?weight\b",
    r"\bat\s+bw\b",
)
_EACH_SIDE_PHRASES = (
    r"\b(?:de\s+)?chaque\s+(?:c[ôo]t[ée]|bras|jambe|main|pied|[ée]paule)\b",
    r"\bpar\s+c[ôo]t[ée]\b",
    r"\beach\s+(?:side|arm|leg|hand)\b",
    r"\bper\s+side\b",
)
# Spoken padding: stripped from exercise names, kept in whatever is handed
# back to the athlete — a sentence we did not understand is returned as said.
_FILLERS = (
    r"\b(?:euh+|heu+|hum+|bah|ben|bon|alors|voil[àa]|donc)\b",
    r"\b(?:aujourd'hui|ce matin|ce soir|cet apr[èe]s-midi|hier|tout [àa] l'heure)\b",
    r"\b(?:j'ai fait|j'ai commenc[ée] par|je commence par|je fais)\b",
    r"\b(?:je finis par|je termine par|pour finir|j'ai termin[ée] par)\b",
    r"\b(?:i did|i started with|then i did|finished with)\b",
)
# Sentence separators, including the spoken ones.
_SEPARATORS = (
    r"[.;\n]+|\bpuis\b|\bensuite\b|\bapr[èe]s\b|\bet\s+apr[èe]s\b|\bet\b|\bthen\b"
)

# Where the name stops and the numbers begin.
_QUANTITY_START = re.compile(
    rf"\d|{FAILURE_TOKEN}|{BODYWEIGHT_TOKEN}|{EACH_SIDE_TOKEN}",
)

GRAMMAR = r"""
start: spec+

spec: sets_spec
    | reps_spec
    | weight_spec
    | rest_spec
    | rpe_spec
    | FAILURE
    | BODYWEIGHT
    | EACH_SIDE

// "4 séries de 8", "3 fois 10", "4 séries", "3 séries jusqu'à l'échec", "4x10".
// Timed sets ("3 fois 60 secondes") are deliberately left unread: the session
// model counts repetitions, and guessing would file a plank as a set to
// failure. They come back verbatim for the athlete to write as they wish.
// A range needs the word "répétitions":
// without it, "3 séries de 5 à 100" reads 100 as the load, which is what an
// athlete means far more often than a 5-to-100 rep range.
sets_spec: NUMBER SERIES (OF)? NUMBER TO NUMBER REPS_WORD
         | NUMBER SERIES (OF)? NUMBER (REPS_WORD)?
         | NUMBER SERIES (OF)? FAILURE
         | NUMBER SERIES (OF)?
         | SETS_X_REPS

// "10 répétitions", "8 à 10 répétitions"
reps_spec: (FOR)? NUMBER (TO NUMBER)? REPS_WORD

// "à 80 kilos", "avec 80", "de 80 kilos"
weight_spec: (TO | WITH | OF) NUMBER WEIGHT_UNIT
           | (TO | WITH) NUMBER

// "2 minutes de repos", "1 minute 30 de récup", "90 secondes", "repos 2 minutes"
rest_spec.2: (WITH | TO)? REST_WORD (OF)? NUMBER MINUTES (NUMBER (SECONDS)?)?
           | (WITH | TO)? REST_WORD (OF)? NUMBER SECONDS
           | (WITH | TO)? NUMBER MINUTES (NUMBER (SECONDS)?)? (OF)? (REST_WORD)?
           | (WITH | TO)? NUMBER SECONDS (OF)? REST_WORD

// "RPE 8", "à 8 sur 10"
rpe_spec: RPE (OF)? NUMBER
        | (TO)? NUMBER OUT_OF NUMBER

SETS_X_REPS.9: /\d+\s*x\s*\d+/i
NUMBER: /\d+(?:[.,]\d+)?/
SERIES.9: /\b(?:s[ée]ries?|fois|sets?|tours?|rounds?)\b/i
REPS_WORD.9: /\b(?:r[ée]p[ée]titions?|r[ée]ps?|reps|rep|mouvements?|times?)\b/i
WEIGHT_UNIT.9: /\b(?:kilos?|kgs?|lbs?|pounds?)\b/i
REST_WORD.9: /\b(?:repos|r[ée]cup(?:[ée]ration)?|pause|rest|reste)\b/i
MINUTES.9: /\b(?:minutes?|min|mn|mins)\b/i
SECONDS.9: /\b(?:secondes?|sec|secs|seconds?)\b/i
RPE.9: /\brpe\b/i
OUT_OF.9: /\b(?:sur|out\s+of)\b/i
FAILURE.9: /\bFAILURETOKEN\b/
BODYWEIGHT.9: /\bBODYWEIGHTTOKEN\b/
EACH_SIDE.9: /\bEACHSIDETOKEN\b/
TO.8: /\b(?:[àa]|at)\b/i
WITH.8: /\b(?:avec|with)\b/i
FOR.8: /\b(?:pour|for)\b/i
OF.8: /\bde\b|\bd'|\bof\b/i

%import common.WS
%ignore WS
%ignore /,/
"""

_PARSER = Lark(GRAMMAR, parser="earley", ambiguity="resolve")


# --------------------------------------------------------------------------- #
# Normalisation
# --------------------------------------------------------------------------- #
def normalize_speech(text: str) -> str:
    """Transcription -> parseable French: digits, no fillers, marker tokens."""
    out = text.lower().replace("’", "'")
    for pattern in _FAILURE_PHRASES:
        out = re.sub(pattern, f" {FAILURE_TOKEN} ", out)
    for pattern in _BODYWEIGHT_PHRASES:
        out = re.sub(pattern, f" {BODYWEIGHT_TOKEN} ", out)
    for pattern in _EACH_SIDE_PHRASES:
        out = re.sub(pattern, f" {EACH_SIDE_TOKEN} ", out)
    # Whisper hears "RPE 8" and writes "RP-E8", "RPE-8" or "rpe8".
    # One optional dash per gap, so the spaces around it split only one way.
    out = re.sub(r"\brp\s*(?:-\s*)?e\s*(?:-\s*)?(\d)", r"rpe \1", out, flags=re.I)
    # threshold=0 so "deux minutes" becomes "2 minutes"; none of this is prose.
    out = alpha2digit(out, "fr", threshold=0.0)
    return re.sub(r"\s+", " ", out).strip()


def split_sentences(text: str) -> list[str]:
    """One chunk per exercise: a chunk with no name joins the previous one."""
    chunks: list[str] = []
    for raw in re.split(_SEPARATORS, text, flags=re.I):
        part = raw.strip().strip(",").strip()
        if not part:
            continue
        if chunks and not _has_name(part):
            chunks[-1] = f"{chunks[-1]}, {part}"
        else:
            chunks.append(part)
    return chunks


def _has_name(chunk: str) -> bool:
    """True when the chunk opens with words, not with a quantity."""
    name, _ = _split_name(chunk)
    return bool(name)


# Words that belong to the quantities rather than to an exercise name.
_QUANTITY_WORD = re.compile(
    r"^(?:\d+(?:[.,]\d+)?|s[ée]ries?|fois|sets?|tours?|rounds?|r[ée]p[ée]titions?"
    r"|r[ée]ps?|reps?|times?|kilos?|kgs?|lbs?|pounds?|de|d'|of|[àa]|at|avec|with"
    r"|sur|out|rpe|x|pour|for|minutes?|min|mn|mins|secondes?|seconds?|secs?|repos|rest"
    r"|r[ée]cup(?:[ée]ration)?|pause|reste"
    r"|FAILURETOKEN|BODYWEIGHTTOKEN|EACHSIDETOKEN)$",
    re.I,
)


def _all_quantity_words(text: str) -> bool:
    """True when nothing in there could name an exercise."""
    tokens = [token.strip(",") for token in text.split() if token.strip(",")]
    return bool(tokens) and all(_QUANTITY_WORD.match(token) for token in tokens)


def _split_name(chunk: str) -> tuple[str, str]:
    """ "développé couché 4 séries de 8" -> ("développé couché", "4 séries de 8").

    Also handles the other order — "3 séries de 10 tractions", "4 sets of 8
    bench press" — by consuming the quantity words first and taking what is
    left as the name.
    """
    match = _QUANTITY_START.search(chunk)
    if match is None:
        return chunk.strip(" ,"), ""

    name = _clean_name(chunk[: match.start()].strip(" ,"))
    rest = chunk[match.start() :].strip(" ,")
    if name and not _all_quantity_words(name):
        return name, rest
    if name:  # "reste 2 minutes": a keyword, not an exercise
        rest = f"{name} {rest}".strip()

    # Quantities came first: read them until a word that names an exercise.
    tokens = rest.split()
    cut = len(tokens)
    for index, token in enumerate(tokens):
        if not _QUANTITY_WORD.match(token.strip(",")):
            cut = index
            break
    # The name may itself be followed by more quantities: "5 séries de 5 squat
    # à 100 kilos". Take the words up to the next quantity as the name.
    after = tokens[cut:]
    name_end = len(after)
    for index, token in enumerate(after):
        if _QUANTITY_WORD.match(token.strip(",")):
            name_end = index
            break
    quantities = " ".join(tokens[:cut] + after[name_end:])
    return _clean_name(" ".join(after[:name_end])), quantities


_NAME_TAIL = re.compile(r"\b(?:sur|pour|en|avec|de|d')\s*$", re.I)
_NAME_HEAD = re.compile(r"^(?:du|de\s+la|des|le|la|les|un|une|au|aux)\s+", re.I)


def _clean_name(name: str) -> str:
    """ "alors j'ai fait du développé couché" -> "développé couché"."""
    cleaned = name
    for pattern in _FILLERS:
        cleaned = re.sub(pattern, " ", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" ,")
    cleaned = _NAME_HEAD.sub("", cleaned)
    cleaned = _NAME_TAIL.sub("", cleaned).strip(" ,-")
    return re.sub(r"\s+", " ", cleaned)


# --------------------------------------------------------------------------- #
# Public API
# --------------------------------------------------------------------------- #
def parse_dictation(text: str) -> list[dict[str, Any]] | None:
    """Spoken French -> the same exercise dicts as ``parse_workout_grammar``."""
    exercises = [
        exercise
        for chunk in split_sentences(normalize_speech(text))
        for exercise in [_parse_chunk(chunk)]
        if exercise is not None
    ]
    return exercises or None


def unparsed_dictation(text: str) -> list[str]:
    """Sentences the grammar could not read, kept verbatim for the athlete."""
    return [
        chunk
        for chunk in split_sentences(normalize_speech(text))
        if _parse_chunk(chunk) is None
    ]


def _parse_chunk(chunk: str) -> dict[str, Any] | None:
    name, quantities = _split_name(chunk)
    if not name or not quantities:
        return None
    try:
        tree = _PARSER.parse(quantities)
    except LarkError:
        return None
    return _build_exercise(name, tree)


# --------------------------------------------------------------------------- #
# Tree -> exercise
# --------------------------------------------------------------------------- #
def _build_exercise(name: str, tree: Tree) -> dict[str, Any] | None:
    sets_count = DEFAULT_SETS
    reps: int | None = None
    target: str | None = None
    weight: float | None = None
    rest: int | None = None
    rpe: float | None = None
    failure = False
    unilateral = False
    has_volume = False

    for node in tree.children:
        spec = node.children[0] if isinstance(node, Tree) else node
        if isinstance(spec, Token):
            if spec.type == "FAILURE":
                failure = has_volume = True
            elif spec.type == "EACH_SIDE":
                unilateral = True
            continue
        kind = spec.data
        if kind == "sets_spec":
            sets_count, reps, target, spec_failure = _read_sets(spec)
            failure = failure or spec_failure
            has_volume = True
        elif kind == "reps_spec":
            reps, target = _read_reps(spec)
            has_volume = True
        elif kind == "weight_spec":
            weight = _first_number(spec)
        elif kind == "rest_spec":
            rest = _read_rest(spec)
        elif kind == "rpe_spec":
            rpe = _read_rpe(spec)

    if not has_volume:
        return None  # a name with a weight but no sets is not a session line

    if unilateral and target:
        target = f"{target}e"
    sets = _make_sets(sets_count, {"reps": reps, "failure": failure}, weight, rest, rpe)
    return _exercise(name, sets, target, "each side" if unilateral else None)


def _numbers(node: Tree) -> list[float]:
    values: list[float] = []
    for child in node.children:
        if isinstance(child, Token) and child.type == "NUMBER":
            values.append(float(str(child).replace(",", ".")))
        elif isinstance(child, Tree):
            values.extend(_numbers(child))
    return values


def _first_number(node: Tree) -> float | None:
    values = _numbers(node)
    return values[0] if values else None


def _has(node: Tree, token_type: str) -> bool:
    return any(
        isinstance(child, Token) and child.type == token_type for child in node.children
    )


def _read_sets(node: Tree) -> tuple[int, int | None, str | None, bool]:
    """'4 séries de 8', '3 séries de 8 à 10', '4x10', '3 séries à l'échec'."""
    if _has(node, "SETS_X_REPS"):
        raw = next(
            str(c)
            for c in node.children
            if isinstance(c, Token) and c.type == "SETS_X_REPS"
        )
        count, reps = (int(part) for part in re.split(r"\s*x\s*", raw, flags=re.I))
        return count, reps, str(reps), False

    values = _numbers(node)
    count = int(values[0]) if values else DEFAULT_SETS
    if _has(node, "FAILURE"):
        return count, None, None, True
    if len(values) >= 3:  # "3 séries de 8 à 10"
        return count, int(values[1]), f"{int(values[1])}-{int(values[2])}", False
    if len(values) == 2:
        return count, int(values[1]), str(int(values[1])), False
    return count, None, None, False


def _read_reps(node: Tree) -> tuple[int | None, str | None]:
    """'10 répétitions', '8 à 10 répétitions'."""
    values = _numbers(node)
    if not values:
        return None, None
    if len(values) >= 2:
        return int(values[0]), f"{int(values[0])}-{int(values[1])}"
    return int(values[0]), str(int(values[0]))


def _read_rest(node: Tree) -> int | None:
    """'2 minutes', '1 minute 30', '90 secondes' -> seconds."""
    values = _numbers(node)
    if not values:
        return None
    if _has(node, "MINUTES"):
        seconds = int(values[0]) * 60
        if len(values) >= 2:
            seconds += int(values[1])
        return seconds
    return int(values[0])


def _read_rpe(node: Tree) -> float | None:
    return _first_number(node)


__all__ = [
    "normalize_speech",
    "parse_dictation",
    "split_sentences",
    "unparsed_dictation",
]
