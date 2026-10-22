"""Writing a goal's plan: what it creates, replaces and leaves alone."""

from __future__ import annotations

from dataclasses import replace
from datetime import date, timedelta
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from arete.dataio.db import connect
from arete.features.hybrid_plan import HYBRID_PLANNED_RPE
from arete.features.plan_generator import monday_of, planned_tss
from arete.garmin.models import PlannedSession, SessionType
from arete.garmin.repository import GarminRepository
from arete.services import goals, plan_builder

TODAY = date.today() + timedelta(days=1200)  # a "today" no other test reaches
SETTINGS = {"rest_day_preference": ["monday"], "weekly_training_goal": 5}


@pytest.fixture
def goal():
    g = goals.create_goal(
        name="test-plan", race_date=TODAY + timedelta(weeks=8), distance_km=10
    )
    con = connect()
    for i in range(1, 28, 2):  # 14 runs of 50 min in the last four weeks
        con.execute(
            "INSERT INTO app.actual_sessions (user_id, date, sport, duration_sec, source)"
            " VALUES (1, ?, 'running', 3000, 'test-plan')",
            [TODAY - timedelta(days=i)],
        )
    con.close()
    with (
        patch("arete.services.plan_builder.get_user_settings", return_value=SETTINGS),
        patch(
            "arete.services.metrics.current_vdot",
            return_value=(50.0, "garmin_prediction"),
        ),
    ):
        yield g
    con = connect()
    con.execute(
        "DELETE FROM app.planned_sessions WHERE date >= ?", [TODAY - timedelta(days=30)]
    )
    con.execute("DELETE FROM app.actual_sessions WHERE source = 'test-plan'")
    con.execute("DELETE FROM app.goals WHERE name LIKE 'test-%'")
    con.close()


def _plan_sessions(goal_id: int) -> list[PlannedSession]:
    return [
        s
        for s in GarminRepository().list_planned_sessions(
            start_date=TODAY,
            end_date=TODAY + timedelta(weeks=11),
            status=None,
            limit=200,
            ascending=True,
        )
        if s.goal_id == goal_id
    ]


def test_inputs_read_the_athletes_recent_running(goal):
    inputs = plan_builder.plan_inputs(goal, TODAY)
    assert inputs.start == TODAY + timedelta(days=1)
    assert round(inputs.weekly_minutes_now) == 175  # 14 x 50 min / 4 weeks
    assert inputs.sessions_per_week == 4  # 3.5 runs a week, rounded
    assert inputs.rest_days == frozenset({0})
    assert inputs.paces is not None and round(inputs.paces.vdot) == 50


def test_preview_writes_nothing(goal):
    body = plan_builder.preview(goal.id, TODAY)
    assert body["weeks"][-1]["phase"] == "race"
    assert _plan_sessions(goal.id) == []


def test_apply_writes_replaces_and_respects_other_sessions(goal):
    repo = GarminRepository()
    busy = TODAY + timedelta(days=2)  # a Wednesday-ish day the plan would use
    manual = repo.create_planned_session(
        PlannedSession(
            date=busy, session_type=SessionType.ENDURANCE, description="perso"
        )
    )
    first = plan_builder.apply(goal.id, TODAY)
    sessions = _plan_sessions(goal.id)
    assert first["created"] == len(sessions) > 0
    assert all(s.source == "plan" for s in sessions)
    assert all(s.plan_kind is None for s in sessions)  # a road plan stores none
    assert all(s.date != busy for s in sessions)
    assert sessions[-1].session_type == SessionType.RACE
    again = plan_builder.apply(goal.id, TODAY)
    assert again["replaced"] == first["created"]
    assert len(_plan_sessions(goal.id)) == again["created"]
    assert repo.get_planned_session(manual) is not None
    assert plan_builder.remove(goal.id, TODAY) == (again["created"], 0)
    assert _plan_sessions(goal.id) == []


def test_routes(goal, router_client):
    from arete.api.goals import router

    client = router_client(router)
    with patch("arete.services.plan_builder.athlete_today", return_value=TODAY):
        assert client.post(f"/goals/{goal.id}/plan/preview").status_code == 200
    assert client.post("/goals/999999/plan").status_code == 404
    far = goals.create_goal(
        name="test-far", race_date=date.today() + timedelta(weeks=40), distance_km=42.2
    )
    resp = client.post(f"/goals/{far.id}/plan/preview")
    assert resp.status_code == 422 and "24 semaines" in resp.json()["detail"]


def test_projection_shows_the_taper_freshening_the_athlete(goal):
    plan_builder.apply(goal.id, TODAY)
    body = plan_builder.projection(goal.id, TODAY)
    series = body["series"]
    assert series[-1]["date"] == goal.race_date.isoformat()
    assert body["planned_sessions"] > 0
    assert series[0]["date"] >= (TODAY - timedelta(days=28)).isoformat()
    # The plan loads, then the taper lets form come back before the race.
    lowest_tsb = min(p["tsb"] for p in series)
    assert body["race_day"]["tsb"] > lowest_tsb
    assert body["peak_ctl"] >= series[0]["ctl"]


def test_planned_tss_uses_the_history_formula():
    from arete.features.plan_generator import planned_tss

    assert round(planned_tss("tempo", 60)) == round(60 * 0.49 / 0.36)
    assert planned_tss("intervals", 50) > planned_tss("endurance", 50)


def test_regenerating_keeps_the_sessions_the_athlete_edited(goal):
    repo = GarminRepository()
    first = plan_builder.apply(goal.id, TODAY)
    generated = _plan_sessions(goal.id)
    edited, untouched = generated[0], generated[1]
    assert edited.revision == untouched.revision == 1
    assert repo.update_planned_session_fields(
        edited.id or 0, expected_revision=1, description="Footing avec un ami"
    )
    again = plan_builder.apply(goal.id, TODAY)
    kept = repo.get_planned_session(edited.id or 0)
    assert kept is not None and kept.description == "Footing avec un ami"
    assert repo.get_planned_session(untouched.id or 0) is None  # replaced
    assert again["replaced"] == first["created"] - 1
    # Its day stays the athlete's: no generated session lands on it again.
    assert edited.date.isoformat() in again["skipped_days"]
    assert [s.date for s in _plan_sessions(goal.id)].count(edited.date) == 1


@pytest.fixture
def hyrox(goal):
    """A Hyrox 10 weeks out, on the same athlete and history as ``goal``."""
    g = goals.create_goal(
        name="test-hyrox",
        race_date=TODAY + timedelta(weeks=10),
        goal_type="hyrox",
        details={"division": "open", "category": "women", "equipment": ["wall_ball"]},
    )
    facts = SimpleNamespace(acwr=1.7, tsb=-5.0)
    with patch("arete.services.coaching_rules.rule_facts", return_value=facts):
        yield g


def test_a_hyrox_plan_is_written_with_its_sports_and_prescriptions(hyrox):
    body = plan_builder.preview(hyrox.id, TODAY)
    assert body["inputs"]["level"] == "intermediate"
    assert body["inputs"]["deload"] is True  # ACWR above the rest threshold
    assert body["weeks"][0]["recovery"] is True
    assert body["weeks"][-1]["phase"] == "race"
    result = plan_builder.apply(hyrox.id, TODAY)
    sessions = _plan_sessions(hyrox.id)
    assert result["created"] == len(sessions) > 0
    assert {s.sport for s in sessions} == {"running", "strength", "other"}
    # Each session keeps the kind it was generated as, for regeneration.
    assert {s.plan_kind for s in sessions} >= {
        "key_run",
        "compromised",
        "heavy_lower",
        "upper",
        "station",
        "race",
    }
    compromised = [s for s in sessions if s.plan_kind == "compromised"]
    assert compromised and all(
        s.sport == "running" and s.prescription for s in compromised
    )
    # Strength sessions and circuits carry their steps too (ARE-138).
    assert all(s.prescription for s in sessions if s.sport == "strength")
    # Its steps own pace and effort; the duration stays for the planned load.
    assert all(
        s.target_hr_zone is None and s.target_intensity is None for s in compromised
    )
    assert all(s.target_duration_min for s in compromised)
    race = sessions[-1]
    assert (race.session_type, race.date) == (SessionType.RACE, hyrox.race_date)
    # Race day weighs a 90-minute Hyrox, not an 8 km run.
    series = plan_builder.projection(hyrox.id, TODAY)["series"]
    race_point = next(p for p in series if p["date"] == hyrox.race_date.isoformat())
    assert race_point["tss"] == round(planned_tss("race", 90), 1)
    # Its strength and circuits weigh by the hybrid table, nobody else's.
    circuit = next(s for s in sessions if s.session_type == SessionType.CROSS_TRAINING)
    point = next(p for p in series if p["date"] == circuit.date.isoformat())
    day_minutes = {
        s.session_type: s.target_duration_min
        for s in sessions
        if s.date == circuit.date
    }
    assert point["tss"] == round(
        sum(
            planned_tss(t.value, float(m or 0), HYBRID_PLANNED_RPE)
            for t, m in day_minutes.items()
        ),
        1,
    )


def test_the_preview_route_sums_up_a_hyrox_week_by_phase(hyrox, goal, router_client):
    from arete.api.goals import router

    client = router_client(router)
    with patch("arete.services.plan_builder.athlete_today", return_value=TODAY):
        body = client.post(f"/goals/{hyrox.id}/plan/preview").json()
        road = client.post(f"/goals/{goal.id}/plan/preview").json()
    summary = body["summary"]
    assert summary[0].startswith("Semaine type (base) : ")
    assert summary[-1].startswith("Semaine de course : ")
    assert "course clé" in summary[0]
    rest = summary[0].split(" · ")[-1]  # Monday is the athlete's rest day
    assert rest.startswith("lun.") and rest.endswith(" repos")
    kinds = {s["kind"] for w in body["weeks"] for s in w["sessions"]}
    assert {"key_run", "compromised", "heavy_lower", "race"} <= kinds
    # A road plan keeps its preview: no summary, no kinds.
    assert road["summary"] == []
    assert {s["kind"] for w in road["weeks"] for s in w["sessions"]} == {None}


def test_a_running_athletes_projection_keeps_the_usual_rpe(goal):
    manual = PlannedSession(
        date=TODAY + timedelta(days=3),
        sport="strength",
        session_type=SessionType.STRENGTH,
        target_duration_min=60,
    )
    assert plan_builder.session_tss(manual, goal, 60) == planned_tss("strength", 60)
    hyrox_goal = replace(goal, goal_type="hyrox")
    own = replace(manual, goal_id=goal.id)
    assert plan_builder.session_tss(own, hyrox_goal, 60) == planned_tss(
        "strength", 60, HYBRID_PLANNED_RPE
    )
    # Another goal's or a manual session stays on the usual table.
    assert plan_builder.session_tss(manual, hyrox_goal, 60) == planned_tss(
        "strength", 60
    )


@pytest.mark.parametrize(
    "window",
    [
        r"SELECT id FROM app.visible_planned_sessions WHERE goal_id",  # the ids read
        r"SELECT revision FROM visible_planned_sessions",  # the delete's own read
    ],
)
def test_regeneration_does_not_delete_an_edit_landing_meanwhile(
    goal, monkeypatch, window
):
    """ARE-150: the athlete's edit commits between the select and the delete."""
    from write_race import race

    repo = GarminRepository()
    plan_builder.apply(goal.id, TODAY)
    first = min(_plan_sessions(goal.id), key=lambda s: s.id or 0)

    def edit() -> None:
        assert repo.update_planned_session_fields(
            first.id or 0, expected_revision=1, description="Déplacée par moi"
        )

    with race(monkeypatch, window, edit):
        plan_builder.apply(goal.id, TODAY)
    kept = repo.get_planned_session(first.id or 0)
    assert kept is not None and kept.description == "Déplacée par moi"


def test_removing_the_plan_keeps_the_sessions_the_athlete_edited(goal, router_client):
    from arete.api.goals import router

    repo = GarminRepository()
    created = plan_builder.apply(goal.id, TODAY)["created"]
    edited = _plan_sessions(goal.id)[0]
    assert repo.update_planned_session_fields(
        edited.id or 0, expected_revision=1, description="Footing avec un ami"
    )
    with patch("arete.services.plan_builder.athlete_today", return_value=TODAY):
        body = router_client(router).delete(f"/goals/{goal.id}/plan").json()
    assert body == {"deleted": created - 1, "kept": 1}
    assert [s.id for s in _plan_sessions(goal.id)] == [edited.id]


@pytest.mark.parametrize(
    "window",
    [
        r"SELECT id FROM app.visible_planned_sessions WHERE goal_id",  # the ids read
        r"SELECT revision FROM visible_planned_sessions",  # the delete's own read
    ],
)
def test_removing_the_plan_keeps_an_edit_landing_meanwhile(goal, monkeypatch, window):
    """The athlete's edit commits between the select and the delete."""
    from write_race import race

    repo = GarminRepository()
    created = plan_builder.apply(goal.id, TODAY)["created"]
    first = min(_plan_sessions(goal.id), key=lambda s: s.id or 0)

    def edit() -> None:
        assert repo.update_planned_session_fields(
            first.id or 0, expected_revision=1, description="Déplacée par moi"
        )

    with race(monkeypatch, window, edit):
        removal = plan_builder.remove(goal.id, TODAY)
    assert removal == (created - 1, 1)
    kept = repo.get_planned_session(first.id or 0)
    assert kept is not None and kept.description == "Déplacée par moi"


def test_a_hyrox_preview_lists_the_kept_sessions_and_apply_skips_them(hyrox):
    repo = GarminRepository()
    plan_builder.apply(hyrox.id, TODAY)
    key = next(
        s for s in _plan_sessions(hyrox.id) if s.session_type == SessionType.TEMPO
    )
    assert repo.update_planned_session_fields(
        key.id or 0, expected_revision=1, date=key.date + timedelta(days=1)
    )
    body = plan_builder.preview(hyrox.id, TODAY)
    assert body["inputs"]["kept"] == [
        {
            "date": (key.date + timedelta(days=1)).isoformat(),
            "description": key.description,
        }
    ]
    assert body["inputs"]["sessions_per_week"] == 6
    kept = [s for w in body["weeks"] for s in w["sessions"] if "kept" in s["tags"]]
    assert [s["date"] for s in kept] == [(key.date + timedelta(days=1)).isoformat()]
    again = plan_builder.apply(hyrox.id, TODAY)
    same_week = [
        s
        for s in _plan_sessions(hyrox.id)
        if monday_of(s.date) == monday_of(key.date)
        and s.session_type == SessionType.TEMPO
    ]
    assert len(same_week) == 1  # the moved key run, not a second one
    assert again["created"] > 0


def test_a_hybrid_block_previews_without_a_race(goal):
    block = goals.create_goal(
        name="test-hybrid",
        race_date=goals.hybrid_end_window(8, TODAY)[0],
        goal_type="hybrid",
        details={"weeks": 8},
        today=TODAY,
    )
    facts = SimpleNamespace(acwr=None, tsb=None)
    with patch("arete.services.coaching_rules.rule_facts", return_value=facts):
        body = plan_builder.preview(block.id, TODAY)
    sessions = [s for w in body["weeks"] for s in w["sessions"]]
    assert sessions and not any(s["session_type"] == "race" for s in sessions)
    last = body["weeks"][-1]
    assert last["recovery"] is True
    assert any("benchmark" in s["tags"] for s in last["sessions"])


@pytest.mark.parametrize("category,wall_ball", [("women", 4), ("men", 6), (None, None)])
def test_a_hybrid_blocks_category_sets_its_station_loads(goal, category, wall_ball):
    details = {"weeks": 8, "equipment": ["wall_ball"], "category": category}
    block = goals.create_goal(
        name="test-hybrid",
        race_date=goals.hybrid_end_window(8, TODAY)[0],
        goal_type="hybrid",
        details=details,
        today=TODAY,
    )
    facts = SimpleNamespace(acwr=None, tsb=None)
    with patch("arete.services.coaching_rules.rule_facts", return_value=facts):
        body = plan_builder.preview(block.id, TODAY)
    circuits = [
        s for w in body["weeks"] for s in w["sessions"] if "station" in s["tags"]
    ]
    assert any("benchmark" in s["tags"] for s in circuits)
    loads = {
        step["weight_kg"]
        for s in circuits
        for block_step in s["prescription"]["steps"]
        for step in block_step["steps"] or [block_step]
        if step["garmin_exercise"] == "Wall Ball"
    }
    assert loads == {wall_ball}
    # The note asking for the category's load only without a category.
    unloaded = [s for s in circuits if "charge de ta catégorie" in s["description"]]
    assert bool(unloaded) == (category is None)


def test_a_hyrox_preview_fills_strength_and_circuit_steps(hyrox):
    body = plan_builder.preview(hyrox.id, TODAY)
    sessions = [s for w in body["weeks"] for s in w["sessions"]]
    # The payload keeps its shape: the circuits' station ids stay internal.
    assert all("stations" not in s for s in sessions)
    strength = [s for s in sessions if s["sport"] == "strength"]
    assert strength and all(s["prescription"] for s in strength)
    # Women Open: the official 4 kg wall ball, 10 kg sandbag, 2 × 16 kg carry.
    official = {"Wall Ball": 4, "Sandbag Lunges": 10, "Farmer Carry": 16}
    seen = {}
    for s in strength:
        if "station" not in s["tags"]:
            continue
        for block in s["prescription"]["steps"]:
            for step in block["steps"] or [block]:
                if step["garmin_exercise"] in official:
                    seen[step["garmin_exercise"]] = step["weight_kg"]
    assert seen and all(official[name] == kg for name, kg in seen.items())
    # Without a sled, a circuit pushes no sled.
    assert not any("traîneau" in s["description"] for s in strength)


def test_strength_history_counts_logged_days(goal):
    con = connect()
    try:
        for i in range(1, 28, 4):  # 7 days over four weeks
            con.execute(
                "INSERT INTO app.strength_sessions (user_id, date, name)"
                " VALUES (1, ?, 'test-plan')",
                [TODAY - timedelta(days=i)],
            )
        assert plan_builder._recent_strength(con, TODAY) == 7 / 4
    finally:
        con.execute("DELETE FROM app.strength_sessions WHERE name = 'test-plan'")
        con.close()
