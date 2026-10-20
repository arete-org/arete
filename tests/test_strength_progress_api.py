"""Strength v2 end to end: what the parser reads is stored, records come back
on save, and the Log page and the coach read the same progression."""

from __future__ import annotations

import json
from datetime import date, timedelta

import pytest

from arete.agent.tools.strength import get_strength_progress
from arete.services import strength_progress
from arete.services.strength_progress import DayReadiness
from arete.strength.repository import StrengthRepository

# An exercise no other test logs, so its records are this file's alone.
EXERCISE = "hip thrust"


@pytest.fixture
def clean():
    """Delete every hip thrust session this test wrote."""
    yield
    repo = StrengthRepository()
    exercise = repo.get_exercise_by_catalog_id("hip_thrust")
    if exercise is None:
        return
    for session in repo.list_sessions(limit=200, include_details=True):
        if session.id and any(e.exercise_id == exercise.id for e in session.exercises):
            repo.delete_session(session.id)


@pytest.fixture
def readiness(monkeypatch):
    """Set today's readiness; None means unknown (no deload)."""

    def set_score(score: float | None) -> None:
        value = None if score is None else DayReadiness(score, "garmin", "low")
        monkeypatch.setattr(strength_progress, "today_readiness", lambda *_: value)

    set_score(None)
    return set_score


def save(client, text: str, day: date) -> dict:
    response = client.post(
        "/strength/sessions/parse",
        json={"text": text, "date": day.isoformat(), "save": True},
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_rir_tempo_rest_failure_and_warmups_are_stored(client, clean, readiness):
    day = date.today() - timedelta(days=3)
    out = save(
        client, f"{EXERCISE} 2x5@60 echauf, 3x8@100 RIR 2 tempo 3-1-1-0 r2'", day
    )
    stored = StrengthRepository().get_session(out["session_id"])
    assert stored is not None
    sets = stored.exercises[0].sets
    assert [s.is_warmup for s in sets] == [True, True, False, False, False]
    work = sets[2]
    assert (work.rir, work.tempo, work.rest_sec) == (2, "3-1-1-0", 120)
    # Volume and history leave the warm-ups out.
    assert stored.exercises[0].total_volume == 2400
    history = client.get(
        f"/strength/exercises/{stored.exercises[0].exercise_id}/history"
    ).json()
    assert history[0]["volume"] == 2400
    assert history[0]["max_weight"] == 100
    assert history[0]["best_e1rm"] == pytest.approx(126.7, abs=0.1)


def test_a_record_comes_back_on_save_and_warmups_never_set_one(
    client, clean, readiness
):
    first = date.today() - timedelta(days=7)
    assert save(client, f"{EXERCISE} 3x8@100", first)["records"] == []

    # A heavy warm-up is not a record.
    warm = save(client, f"{EXERCISE} 1x3@140 wu, 3x8@100", first + timedelta(days=2))
    assert warm["records"] == []

    out = save(client, f"{EXERCISE} 3x8@110", first + timedelta(days=4))
    kinds = {r["kind"]: r for r in out["records"]}
    assert kinds["weight"]["value"] == 110 and kinds["weight"]["previous"] == 100
    assert kinds["weight"]["exercise"]
    assert "e1rm" in kinds

    exercise_id = kinds["weight"]["exercise_id"]
    prs = client.get(f"/strength/exercises/{exercise_id}/prs").json()
    assert prs["max_weight"] == 110
    assert prs["best_e1rm"]["weight_kg"] == 110
    assert prs["rep_records"][0]["weight_kg"] == 110


def test_the_preview_shows_the_suggestion_and_a_deload_when_recovery_is_low(
    client, clean, readiness
):
    save(client, f"{EXERCISE} 3x10@100", date.today() - timedelta(days=4))
    preview = client.post(
        "/strength/sessions/parse", json={"text": f"{EXERCISE} 3x10@100"}
    ).json()
    assert preview["exercises"][0]["progression"]["weight_kg"] == 105

    readiness(40)
    preview = client.post(
        "/strength/sessions/parse", json={"text": f"{EXERCISE} 3x10@100"}
    ).json()
    progression = preview["exercises"][0]["progression"]
    assert progression["deload"] is True
    assert progression["weight_kg"] == 90
    assert "Préparation basse" in progression["reason"]


def test_the_suggestion_route_and_the_coach_tool_agree(client, clean, readiness):
    out = save(client, f"{EXERCISE} 3x10@100", date.today() - timedelta(days=4))
    exercise_id = (
        StrengthRepository().get_session(out["session_id"]).exercises[0].exercise_id
    )

    route = client.get(f"/strength/exercises/{exercise_id}/suggestion").json()
    tool = json.loads(get_strength_progress.invoke({"exercise": EXERCISE}))
    assert route["suggestion"] == tool["next_session"]
    assert tool["sessions_logged"] == 1
    assert tool["trend"][0]["top_set"] == "100kg x 10"
    assert len(json.dumps(tool)) < 2_000  # compact enough for one tool result


def test_the_coach_tool_says_when_nothing_matches():
    out = json.loads(get_strength_progress.invoke({"exercise": "zzz qqq"}))
    assert "error" in out
    assert "error" in json.loads(get_strength_progress.invoke({"exercise": " "}))


def test_unknown_exercise_routes_are_404(client):
    assert client.get("/strength/exercises/999999/suggestion").status_code == 404
