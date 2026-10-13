"""The running grammar against real descriptions (tests/data/running_descriptions.jsonl).

Each entry gives the steps the description must yield, or null when any part
of it is unread: the service then returns no prescription at all.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from arete.llm.running_grammar import PACE_TOLERANCE_SEC
from arete.services.prescriptions import Prescription, prescription_from_description

CORPUS = Path(__file__).parent / "data" / "running_descriptions.jsonl"
ENTRIES = [
    json.loads(line)
    for line in CORPUS.read_text(encoding="utf-8").splitlines()
    if line.strip()
]


def test_corpus_holds_enough_real_descriptions():
    real = [e for e in ENTRIES if e["source"] != "notation"]
    read = [e for e in real if e["steps"] is not None]
    assert len(read) >= 15
    # Left unread on purpose: a warm-up written after the main set, and a
    # unitless recovery ("r100": meters or seconds?).
    assert {e["text"] for e in real} - {e["text"] for e in read} == {
        "VMA — 12×400 @3'33 r1'. Échauffement 20-25' + 4-6 strides, retour 15'",
        "20x300 r100",
    }


@pytest.mark.parametrize("entry", ENTRIES, ids=[e["text"] for e in ENTRIES])
def test_description_yields_its_steps_or_nothing(entry):
    parsed = prescription_from_description(entry["text"], "running")
    if entry["steps"] is None:
        assert parsed is None
    else:
        assert parsed == Prescription.model_validate({"steps": entry["steps"]})


def test_coach_interval_description_reads_as_the_written_workout():
    text = "Échauffement 20-25' + 4-6 strides, 12×400 @3'33 r1', retour 15'"
    parsed = prescription_from_description(text, "running")
    assert parsed is not None
    warmup, strides, block, cooldown = parsed.steps
    # A duration range keeps its lower bound.
    assert (warmup.kind, warmup.value, warmup.notes) == ("warmup", 1200, "20-25'")
    # Lap to end each stride, lap again once walked back.
    assert strides.repeat == 4 and strides.notes == "4-6 strides"
    assert [(s.kind, s.duration_kind, s.notes) for s in strides.steps] == [
        ("effort", "lap", "strides"),
        ("recovery", "lap", ""),
    ]
    effort, recovery = block.steps
    assert block.repeat == 12
    assert (effort.duration_kind, effort.value) == ("meters", 400)
    # 3'33/km written once: 3'30–3'36/km on the watch.
    assert PACE_TOLERANCE_SEC == 3
    assert effort.target is not None
    assert (effort.target.kind, effort.target.low, effort.target.high) == (
        "pace_sec_km",
        210,
        216,
    )
    assert (recovery.kind, recovery.duration_kind, recovery.value) == (
        "recovery",
        "seconds",
        60,
    )
    assert (cooldown.kind, cooldown.value) == ("cooldown", 900)
    # The same workout with its warm-up written last is not reordered.
    reordered = "VMA — 12×400 @3'33 r1'. Échauffement 20-25' + 4-6 strides, retour 15'"
    assert prescription_from_description(reordered, "running") is None


@pytest.mark.parametrize("sport", ["cycling", "swimming", "strength"])
def test_other_sports_are_not_read(sport):
    assert (
        prescription_from_description("Seuil : 3×10' au seuil, récup 2'", sport) is None
    )


@pytest.mark.parametrize(
    "text",
    [
        "",
        "101×400 r1'",  # beyond the repeat bound: no truncated prescription
        "Seuil : 3×10' au seuil, récup 2' et on verra",
        "3×10' @4'00 @4'10",
    ],
)
def test_unread_or_invalid_text_gives_no_prescription(text):
    assert prescription_from_description(text, "running") is None
