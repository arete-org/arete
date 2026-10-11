"""End-to-end domain boundaries of propose / respond / remember, with no LLM."""

import json
from datetime import date, timedelta
from unittest.mock import patch

import pytest

from arete.dataio.db import db_connection
from arete.garmin.models import ActualSession, PlannedSession, SessionType
from arete.garmin.repository import GarminRepository
from arete.services import coach_followup, coach_today, memory, plan_adaptation
from arete.services.athlete_scope import athlete_scope
from arete.services.coaching_rules import RuleFacts, _generate_cardio_feedback


@pytest.fixture
def athlete(monkeypatch, tmp_path):
    monkeypatch.setenv("ARETE_DATA_DIR", str(tmp_path))
    with db_connection() as con:
        con.execute("INSERT INTO app.athletes(id) VALUES (8123) ON CONFLICT DO NOTHING")
    with athlete_scope(8123):
        with db_connection() as con:
            con.execute(
                "INSERT INTO app.game_profile(id,athlete_id) VALUES(1,8123) ON CONFLICT DO NOTHING"
            )
        yield
        with db_connection() as con:
            for table in ("plan_decisions", "actual_sessions", "planned_sessions"):
                con.execute(f"DELETE FROM app.{table} WHERE user_id=8123")
    with db_connection() as con:
        for table in (
            "game_events",
            "game_profile",
            "coach_followups",
            "coach_memory_files",
            "coach_memory_imports",
        ):
            con.execute(f"DELETE FROM app.{table} WHERE athlete_id=8123")
        con.execute("DELETE FROM app.athletes WHERE id=8123")


def proposal():
    repo = GarminRepository()
    sid = repo.create_planned_session(
        PlannedSession(
            date=date.today(),
            sport="running",
            session_type=SessionType.TEMPO,
            target_duration_min=50,
        )
    )
    facts = RuleFacts(
        acwr=1,
        tsb=-5,
        readiness_score=65,
        fatigue_threshold=85,
        fitness_goal="build",
        readiness_source="garmin_training",
        readiness_measured_on=date.today() - timedelta(days=1),
    )
    with patch("arete.services.coaching_rules.rule_facts", return_value=facts):
        decision = plan_adaptation.adapt_today()[0]
    return sid, decision


def test_proposal_requires_validation_and_replay_cannot_apply_twice(athlete):
    sid, decision = proposal()
    repo = GarminRepository()
    assert repo.get_planned_session(sid).revision == 1
    assert decision.state == "pending" and decision.applied_at is None
    assert coach_today.today()["items"][0]["record"]["readiness_measured_on"] == str(
        date.today() - timedelta(days=1)
    )
    result = plan_adaptation.respond(decision.id, 1, "apply")
    assert result.state == "applied" and repo.get_planned_session(sid).revision == 2
    assert plan_adaptation.respond(decision.id, 1, "apply").state == "applied"
    assert repo.get_planned_session(sid).revision == 2


def test_stale_or_reserved_plan_never_commits_a_proposal(athlete):
    sid, decision = proposal()
    GarminRepository().update_planned_session_fields(sid, description="changed")
    with pytest.raises(plan_adaptation.ProposalConflict):
        plan_adaptation.respond(decision.id, 1, "apply")
    assert coach_today.today()["items"][0]["record"]["state"] == "stale"
    with db_connection() as con:
        assert (
            con.execute(
                "SELECT applied_at FROM app.visible_plan_decisions WHERE id=?",
                [decision.id],
            ).fetchone()[0]
            is None
        )


def test_dismissed_proposal_does_not_return_and_get_is_read_only(athlete):
    _, decision = proposal()
    plan_adaptation.respond(decision.id, 1, "keep")
    with patch(
        "arete.services.coaching_rules.rule_facts",
        side_effect=AssertionError("No recomputation on GET"),
    ):
        assert coach_today.today()["items"] == []
    assert plan_adaptation.adapt_today()[0].state == "dismissed"


def test_followup_prioritizes_accepted_adaptation_and_saves_actual_rpe(athlete):
    sid, decision = proposal()
    plan_adaptation.respond(decision.id, 1, "apply")
    repo = GarminRepository()
    actual = repo.create_actual_session(
        ActualSession(
            date=date.today(),
            sport="running",
            duration_sec=1800,
            planned_session_id=sid,
        )
    )
    repo.create_actual_session(
        ActualSession(date=date.today(), sport="running", duration_sec=7200)
    )
    coach_followup.prepare()
    coach_followup.prepare()
    items = coach_followup.pending()
    assert len(items) == 1 and items[0]["session_id"] == actual
    result = coach_followup.respond(
        items[0]["id"], 1, "answer", rpe=4, notes="Jambes mieux"
    )
    assert result["state"] == "answered"
    assert repo.get_actual_session(actual).rpe == 4
    assert "Jambes mieux" in coach_followup.context_block()
    assert (
        coach_followup.respond(items[0]["id"], 1, "answer", rpe=4, notes="Jambes mieux")
        == result
    )
    with pytest.raises(coach_followup.FollowupConflict):
        coach_followup.respond(items[0]["id"], 1, "answer", rpe=8)
    coach_followup.prepare()
    assert coach_followup.pending() == []


def test_snooze_does_not_renew_expiry_and_skip_closes_it(athlete):
    GarminRepository().create_actual_session(
        ActualSession(date=date.today(), sport="running", duration_sec=6000)
    )
    coach_followup.prepare()
    item = coach_followup.pending()[0]
    snoozed = coach_followup.respond(item["id"], 1, "snooze")
    assert snoozed["expires_at"] == item["expires_at"]
    assert coach_followup.pending() == []
    closed = coach_followup.respond(item["id"], 2, "skip")
    assert closed["state"] == "skipped"


def test_expired_or_foreign_followup_cannot_write(athlete):
    GarminRepository().create_actual_session(
        ActualSession(date=date.today(), sport="running", duration_sec=6000)
    )
    coach_followup.prepare()
    item = coach_followup.pending()[0]
    with athlete_scope(1):
        assert coach_followup.get(item["id"]) is None
        with pytest.raises(LookupError):
            coach_followup.respond(item["id"], 1, "answer", rpe=5)
    with db_connection() as con:
        con.execute(
            "UPDATE app.coach_followups SET expires_at=now()-INTERVAL '1 hour' WHERE id=?",
            [item["id"]],
        )
    with pytest.raises(coach_followup.FollowupConflict):
        coach_followup.respond(item["id"], 1, "answer", rpe=5)


def test_strength_hr_is_not_interpreted_as_cardio_quality(athlete):
    sid = GarminRepository().create_actual_session(
        ActualSession(
            date=date.today(),
            sport="strength",
            duration_sec=1020,
            avg_hr=79,
            max_hr=115,
        )
    )
    feedback, evidence = _generate_cardio_feedback(sid)
    assert evidence.sport == "strength"
    assert "renforcement" in feedback.feedback
    assert "travail de fond" not in feedback.feedback
    assert all("zone" not in h.lower() for h in feedback.highlights)


def test_memory_import_is_once_and_scope_isolated(athlete):
    root = memory.memory_root()
    root.mkdir(parents=True)
    (root / "notes.md").write_text("old")
    old = memory.read_file("notes.md")
    memory.delete_file("notes.md")
    (root / "notes.md").write_text("resurrected")
    assert memory.read_file("notes.md").forgotten
    with pytest.raises(memory.MemoryConflict):
        memory.replace_file("notes.md", old.content, old.revision)
    with athlete_scope(1):
        assert memory.read_file("notes.md").content == ""
    assert memory.append_entry("notes.md", "new", "new evidence")
    assert "resurrected" not in memory.read_file("notes.md").content


def test_forget_fact_cannot_delete_a_newer_revision(athlete):
    from arete.agent.tools.journal import forget_fact
    from arete.services import athlete_facts

    fact = athlete_facts.add_fact("preference", "Le matin")
    fact = athlete_facts.update_fact(fact.id, text="Le soir", expected_revision=1)
    assert "error" in json.loads(
        forget_fact.invoke({"fact_id": fact.id, "expected_revision": 1})
    )
    assert json.loads(forget_fact.invoke({"fact_id": fact.id, "expected_revision": 2}))[
        "forgotten"
    ]
    assert athlete_facts.fact_history(fact.id) == []


def test_cards_only_reference_confirmed_writes():
    from langchain_core.messages import ToolMessage

    from arete.agent.runtime.events import coach_card

    def message(content, status="success"):
        return ToolMessage(
            name="remember_fact",
            tool_call_id="call",
            content=json.dumps(content),
            status=status,
        )

    assert coach_card(message({"saved": True, "fact": {"id": 12}})) == {
        "type": "coach_card",
        "id": "fact:12",
        "ref_kind": "fact",
        "ref_id": 12,
    }
    assert coach_card(message({"error": "conflict"})) is None
    assert coach_card(message({"saved": True, "fact": {"id": 12}}, "error")) is None
