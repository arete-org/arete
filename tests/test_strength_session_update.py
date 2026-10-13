"""Correcting a logged strength session: same session, new sets, no second credit.

Every correction the coach used to make created a second session, which
doubled the volume, the records and the game credit for one workout.
"""

from __future__ import annotations

import json
from datetime import timedelta

import pytest

from arete.agent.tools.strength import (
    list_strength_sessions,
    save_workout,
    update_workout,
)
from arete.dataio.db import db_connection
from arete.dataio.init_duckdb import main
from arete.garmin.models import ActualSession
from arete.garmin.repository import GarminRepository
from arete.services import gamification as game
from arete.services.settings import athlete_today
from arete.strength.logging_service import (
    parse_for_athlete,
    save_parsed_session,
    update_logged_session,
)
from arete.strength.repository import StrengthRepository


@pytest.fixture(autouse=True)
def fresh_db(tmp_path, monkeypatch):
    monkeypatch.setenv("ARETE_DB", str(tmp_path / "strength.duckdb"))
    monkeypatch.setenv("GAMIFICATION_ENABLED", "true")
    main()


def logged(text: str, day=None) -> int:
    outcome = save_parsed_session(
        parse_for_athlete(text, workout_date=day or athlete_today()),
        require_complete=True,
    )
    assert outcome.session_id, outcome.message
    return outcome.session_id


def reps(session_id: int) -> list[int]:
    session = StrengthRepository().get_session(session_id)
    assert session is not None
    return [s.reps for ex in session.exercises for s in ex.sets]


def test_a_correction_updates_the_same_session():
    garmin = GarminRepository().create_actual_session(
        ActualSession(
            date=athlete_today(), sport="strength", duration_sec=3600, source="manual"
        )
    )
    session_id = logged("4x5 tractions")
    StrengthRepository().link_to_actual_session(session_id, garmin)

    outcome = update_logged_session(session_id, "4x6 tractions")

    assert outcome.session_id == session_id
    day = athlete_today()
    sessions = StrengthRepository().list_sessions(start_date=day, end_date=day)
    assert [s.id for s in sessions] == [session_id]
    assert reps(session_id) == [6, 6, 6, 6]
    assert sessions[0].actual_session_id == garmin


def test_records_are_recomputed_against_the_other_sessions():
    earlier = logged("3x5 @100 squat", athlete_today() - timedelta(days=7))
    session_id = logged("3x5 @90 squat")

    beaten = update_logged_session(session_id, "3x5 @110 squat")
    assert beaten.records and beaten.records[0].exercise == "Back Squat"
    assert update_logged_session(session_id, "3x5 @90 squat").records == []
    # The other session's sets are only compared against, never rewritten.
    assert reps(earlier) == [5, 5, 5]


def test_game_credit_is_neither_duplicated_nor_lost():
    preference = game.preference()
    game.set_preference(game.Preference(enabled=True, version=preference["version"]))
    session_id = logged("4x5 tractions")
    assert game.sync()["shards"] == 10

    update_logged_session(session_id, "4x6 tractions")

    assert game.sync()["shards"] == 10
    with db_connection() as con:
        keys = con.execute(
            "SELECT source_key, eligible FROM app.visible_game_events"
        ).fetchall()
    assert keys == [(f"strength:{session_id}", True)]


@pytest.mark.parametrize("deleted", [False, True])
def test_an_unknown_or_deleted_session_is_refused_in_french(deleted):
    session_id = logged("4x5 tractions")
    if deleted:
        StrengthRepository().delete_session(session_id)
    target = session_id if deleted else session_id + 1000

    out = json.loads(
        update_workout.invoke({"session_id": target, "text": "4x6 tractions"})
    )

    assert out["saved"] is False and "introuvable" in out["error"]
    if not deleted:
        assert reps(session_id) == [5, 5, 5, 5]


def test_an_unrecognised_correction_writes_nothing():
    session_id = logged("4x5 tractions")

    out = json.loads(
        update_workout.invoke(
            {
                "session_id": session_id,
                "text": "4x6 tractions\n4x12 @40 zercher goblet thruster machine",
            }
        )
    )

    assert out["saved"] is False and out["not_recognised"]
    assert reps(session_id) == [5, 5, 5, 5]


def test_a_correction_never_moves_the_session():
    session_id = logged("4x5 tractions")
    other = athlete_today() - timedelta(days=1)

    outcome = update_logged_session(
        session_id, f"{other.strftime('%d/%m/%Y')}: 4x6 tractions"
    )

    assert outcome.session_id is None and "déplace" in outcome.message
    assert reps(session_id) == [5, 5, 5, 5]


def test_a_failed_write_keeps_the_previous_sets(monkeypatch):
    session_id = logged("4x5 tractions")

    def fail(*args, **kwargs):
        raise RuntimeError("storage unavailable")

    with monkeypatch.context() as patch:
        patch.setattr(StrengthRepository, "_create_session_exercise", fail)
        out = json.loads(
            update_workout.invoke({"session_id": session_id, "text": "4x6 tractions"})
        )

    assert "storage unavailable" in out["error"]
    assert reps(session_id) == [5, 5, 5, 5]


def test_the_coach_reads_then_corrects_without_a_second_session():
    day = athlete_today()
    saved = json.loads(save_workout.invoke({"text": "4x5 tractions"}))

    listed = json.loads(list_strength_sessions.invoke({"date_str": day.isoformat()}))
    assert [s["session_id"] for s in listed["sessions"]] == [saved["session_id"]]
    assert "5, 5, 5, 5" in listed["sessions"][0]["summary"]

    out = json.loads(
        update_workout.invoke(
            {"session_id": saved["session_id"], "text": "4x6 tractions"}
        )
    )
    assert out["saved"] is True and out["session_id"] == saved["session_id"]
    assert len(StrengthRepository().list_sessions(start_date=day, end_date=day)) == 1
