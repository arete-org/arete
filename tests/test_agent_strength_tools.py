"""Strength toolkit: the first toolkit that writes, and the write is lossy.

The parser only saves exercises the catalog matched confidently. A human at
the form sees the others greyed out; an athlete dictating reads one sentence.
So what gets dropped has to be reported — before the save, and again after it.
"""

from __future__ import annotations

import json
from datetime import date, timedelta

import pytest

from arete.agent.capabilities.registry import CAPABILITIES, STRENGTH_INSTRUCTIONS
from arete.agent.tools.strength import (
    MAX_WORKOUT_TEXT_CHARS,
    STRENGTH_TOOLS,
    save_workout,
)
from arete.strength.repository import StrengthRepository

# One line the grammar reads and the catalog matches, one it cannot place.
KNOWN = "3x10 @80 bench press"
UNKNOWN = "4x12 @40 zercher goblet thruster machine"


@pytest.fixture
def day():
    """A date of this test's own, cleaned up after."""
    target = date.today() + timedelta(days=500)
    yield target
    repo = StrengthRepository()
    for session in repo.list_sessions(start_date=target, end_date=target):
        if session.id:
            repo.delete_session(session.id)


# ---------------------------------------------------------------------------
# Registration
# ---------------------------------------------------------------------------


def test_registered_with_its_tools():
    toolkit = CAPABILITIES["strength"]
    assert {t.name for t in toolkit.tools} == {
        "save_workout",
        "list_strength_sessions",
        "update_workout",
        "get_strength_progress",
    }
    # Background missions may read sessions, never correct them.
    assert toolkit.read_tools == {"get_strength_progress", "list_strength_sessions"}
    assert toolkit.instructions == STRENGTH_INSTRUCTIONS
    assert {t.name for t in STRENGTH_TOOLS} == {t.name for t in toolkit.tools}


# ---------------------------------------------------------------------------
# read_workout: a dry run that writes nothing
# ---------------------------------------------------------------------------


def test_an_unmatched_exercise_is_named_not_swallowed(day):
    out = json.loads(
        save_workout.invoke(
            {"text": f"{KNOWN}\n{UNKNOWN}", "date_str": day.isoformat()}
        )
    )
    names = [d["name"] for d in out["not_recognised"]]
    assert names, f"the drop went unreported: {out}"
    # The athlete needs something to answer with.
    assert "did_you_mean" in out["not_recognised"][0]


def test_unreadable_text_is_an_error_not_a_silent_empty(day):
    out = json.loads(save_workout.invoke({"text": "il faisait beau ce matin"}))
    assert "error" in out


# ---------------------------------------------------------------------------
# save_workout: writes, and still reports the loss
# ---------------------------------------------------------------------------


def test_saving_persists_the_session(day):
    out = json.loads(save_workout.invoke({"text": KNOWN, "date_str": day.isoformat()}))
    assert out["saved"] is True
    assert out["session_id"]
    assert out["saved_exercises"]
    stored = StrengthRepository().list_sessions(start_date=day, end_date=day)
    assert len(stored) == 1


def test_nothing_matched_means_nothing_saved(day):
    out = json.loads(
        save_workout.invoke({"text": UNKNOWN, "date_str": day.isoformat()})
    )
    assert out["saved"] is False
    assert out.get("session_id") is None
    assert StrengthRepository().list_sessions(start_date=day, end_date=day) == []


# ---------------------------------------------------------------------------
# Arguments
# ---------------------------------------------------------------------------


def test_a_bad_date_says_which_format():
    out = json.loads(save_workout.invoke({"text": KNOWN, "date_str": "25/09/2026"}))
    assert "date" in out["error"]


def test_empty_text_is_refused():
    assert "error" in json.loads(save_workout.invoke({"text": "   "}))
    assert "error" in json.loads(save_workout.invoke({"text": ""}))


def test_an_essay_is_refused_before_parsing():
    out = json.loads(save_workout.invoke({"text": "x" * (MAX_WORKOUT_TEXT_CHARS + 1)}))
    assert "4000" in out["error"]


# ---------------------------------------------------------------------------
# The reason the save path was extracted: one behaviour, two entry points
# ---------------------------------------------------------------------------


class TestRouteAndToolAgree:
    """The Log page and the coach must write the same session.

    The save logic used to live inside the route body. A second copy for the
    agent would have drifted — different abbreviations, different catalog
    matching, a planned session completed on one path and not the other.
    """

    def test_same_text_gives_the_same_exercises(self, day, client):
        from_route = client.post(
            "/strength/sessions/parse",
            json={"text": f"{KNOWN}\n{UNKNOWN}", "date": day.isoformat()},
        ).json()
        from_tool = json.loads(
            save_workout.invoke(
                {"text": f"{KNOWN}\n{UNKNOWN}", "date_str": day.isoformat()}
            )
        )

        assert [e["name"] for e in from_route["exercises"]] == [
            e["name"] for e in from_tool["exercises"]
        ]
        assert [e["exercise_matched"] for e in from_route["exercises"]] == [
            e["matched"] for e in from_tool["exercises"]
        ]

    def test_saving_through_either_path_completes_the_planned_session(
        self, day, monkeypatch
    ):
        from arete.strength import logging_service

        completed: list[date] = []
        monkeypatch.setattr(
            logging_service, "complete_planned_strength", completed.append
        )
        save_workout.invoke({"text": KNOWN, "date_str": day.isoformat()})
        assert completed == [day]


@pytest.mark.parametrize("bad", [UNKNOWN, "et un exercice dont je ne sais plus le nom"])
def test_incomplete_workout_is_rejected_without_a_partial_session(day, bad):
    out = json.loads(
        save_workout.invoke({"text": f"{KNOWN}\n{bad}", "date_str": day.isoformat()})
    )
    assert out["saved"] is False and out["error"]
    assert out["not_recognised"] or out["unparsed_lines"]
    assert StrengthRepository().list_sessions(start_date=day, end_date=day) == []


def test_failed_set_write_rolls_back_the_whole_session(day, monkeypatch):
    def fail(*args, **kwargs):
        raise RuntimeError("storage unavailable")

    monkeypatch.setattr(StrengthRepository, "_create_session_exercise", fail)
    out = json.loads(save_workout.invoke({"text": KNOWN, "date_str": day.isoformat()}))
    assert out["saved"] is False and "storage unavailable" in out["error"]
    assert StrengthRepository().list_sessions(start_date=day, end_date=day) == []
