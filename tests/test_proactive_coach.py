"""End-to-end domain boundaries of propose / respond / remember, with no LLM."""

import json
from datetime import timedelta
from unittest.mock import patch

import pytest

from arete.dataio.db import db_connection
from arete.garmin.models import ActualSession, PlannedSession, SessionType
from arete.garmin.repository import GarminRepository
from arete.services import coach_followup, coach_today, memory, plan_adaptation
from arete.services.athlete_scope import athlete_scope
from arete.services.coaching_rules import RuleFacts, _generate_cardio_feedback
from arete.services.settings import athlete_today


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
            date=athlete_today(),
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
        readiness_measured_on=athlete_today() - timedelta(days=1),
    )
    with patch("arete.services.coaching_rules.rule_facts", return_value=facts):
        decision = plan_adaptation.adapt_today()[0]
    return sid, decision


def low_adapt():
    facts = RuleFacts(
        acwr=1,
        tsb=-5,
        readiness_score=49,
        fatigue_threshold=85,
        fitness_goal="build",
        readiness_source="garmin_training",
        readiness_measured_on=athlete_today(),
    )
    with patch("arete.services.coaching_rules.rule_facts", return_value=facts):
        return plan_adaptation.adapt_today()


def planned(kind, minutes):
    return GarminRepository().create_planned_session(
        PlannedSession(
            date=athlete_today(),
            sport="running",
            session_type=kind,
            target_duration_min=minutes,
        )
    )


def low_day():
    """Readiness 49 with Fractionné 60' and Endurance 45': one card for the day."""
    ids = [
        planned(kind, minutes)
        for kind, minutes in ((SessionType.ENDURANCE, 45), (SessionType.INTERVALS, 60))
    ]
    low_adapt()
    (item,) = coach_today.today()["items"]
    return ids, item


def test_a_low_day_is_one_card_applied_in_one_transaction(athlete):
    (endurance, intervals), item = low_day()
    assert item["kind"] == "proposal" and len(item["group"]) == 2
    assert [(d["planned_session_id"], d["decision"]) for d in item["group"]] == [
        (intervals, "replace_easy"),
        (endurance, "rest"),
    ]
    key = item["record"]
    assert key == item["group"][0]
    others = {
        m["id"]: m["revision"]
        for m in item["members"]
        if m["id"] != item["record"]["id"]
    }
    # A client that saw only part of the day cannot answer for it.
    with pytest.raises(plan_adaptation.ProposalConflict):
        plan_adaptation.respond(key["id"], key["revision"], "apply")
    plan_adaptation.respond(key["id"], key["revision"], "apply", others)
    repo = GarminRepository()
    assert repo.get_planned_session(intervals).target_duration_min == 30
    assert repo.get_planned_session(endurance).status.value == "skipped"
    # A replay of the same answer changes nothing.
    plan_adaptation.respond(key["id"], key["revision"], "apply", others)
    assert repo.get_planned_session(intervals).revision == 2
    assert coach_today.today()["items"] == []


def test_a_changed_session_applies_nothing_of_the_group(athlete):
    (endurance, intervals), item = low_day()
    # The rest is written first, then the changed key session refuses.
    GarminRepository().update_planned_session_fields(intervals, description="moved")
    key = item["record"]
    others = {
        m["id"]: m["revision"]
        for m in item["members"]
        if m["id"] != item["record"]["id"]
    }
    with pytest.raises(plan_adaptation.ProposalConflict):
        plan_adaptation.respond(key["id"], key["revision"], "apply", others)
    assert GarminRepository().get_planned_session(endurance).status.value == "pending"
    assert [d["state"] for d in coach_today.today()["items"][0]["group"]] == [
        "stale",
        "pending",
    ]


def test_keeping_a_low_day_records_the_choice_for_both(athlete):
    (endurance, intervals), item = low_day()
    key = item["record"]
    others = {
        m["id"]: m["revision"]
        for m in item["members"]
        if m["id"] != item["record"]["id"]
    }
    plan_adaptation.respond(key["id"], key["revision"], "keep", others)
    repo = GarminRepository()
    assert [repo.get_planned_session(s).revision for s in (endurance, intervals)] == [
        1,
        1,
    ]
    assert {d.state for d in plan_adaptation.adapt_today()} == {"dismissed"}


def test_a_stale_session_still_lets_the_athlete_keep_the_day(athlete):
    (endurance, intervals), item = low_day()
    GarminRepository().update_planned_session_fields(endurance, description="moved")
    key = item["record"]
    rest = item["group"][1]
    plan_adaptation.respond(key["id"], key["revision"], "keep", {rest["id"]: 1})
    assert {d.state for d in plan_adaptation.adapt_today()} == {"dismissed"}


def test_a_snooze_hides_the_whole_day_and_a_legacy_one_hides_its_member(athlete):
    _, item = low_day()
    key, rest = item["group"]
    with db_connection() as con:  # a row snoozed alone before the grouping
        con.execute(
            "UPDATE app.plan_decisions SET snoozed_until=?,revision=revision+1 WHERE id=?",
            [athlete_today() + timedelta(days=1), rest["id"]],
        )
    (item,) = coach_today.today()["items"]
    assert [d["id"] for d in item["group"]] == [key["id"]]
    assert {m["id"]: m["revision"] for m in item["members"]} == {
        key["id"]: 1,
        rest["id"]: 2,
    }
    plan_adaptation.respond(key["id"], 1, "snooze", {rest["id"]: 2})
    assert coach_today.today()["items"] == []


def test_a_proposal_created_meanwhile_makes_the_answer_conflict(athlete, monkeypatch):
    from arete.dataio import db
    from arete.services.plan_repository import PlanDecisionRepository

    _, item = low_day()
    key, rest = item["group"]
    late = planned(SessionType.ENDURANCE, 30)
    real = db.transaction

    def racing():
        PlanDecisionRepository().create(
            day=athlete_today(),
            planned_session_id=late,
            decision="rest",
            reason="r",
            readiness_score=49,
            readiness_source="garmin_training",
            acwr=1,
            original={},
            adapted=None,
            session_revision=1,
        )
        return real()

    monkeypatch.setattr(db, "transaction", racing)
    with pytest.raises(plan_adaptation.ProposalConflict):
        plan_adaptation.respond(key["id"], 1, "apply", {rest["id"]: 1})
    assert {d.state for d in plan_adaptation.adapt_today()} == {"pending"}


def test_a_session_added_later_rests_beside_the_open_recovery(athlete):
    low_day()
    late = planned(SessionType.TEMPO, 40)
    decisions = {d.planned_session_id: d for d in low_adapt()}
    assert decisions[late].decision == "rest"
    assert "fractionné 60 min" in decisions[late].reason
    assert [d.decision for d in decisions.values()].count("replace_easy") == 1


def test_a_foreign_or_unknown_proposal_is_simply_not_found(athlete):
    _, item = low_day()
    key, rest = item["group"]
    with pytest.raises(LookupError):
        plan_adaptation.respond(key["id"], 1, "apply", {rest["id"]: 1, 999_999_999: 1})
    with athlete_scope(1):
        for decision_id in (key["id"], 999_999_999):
            with pytest.raises(LookupError):
                plan_adaptation.respond(decision_id, 1, "keep")


def test_proposal_requires_validation_and_replay_cannot_apply_twice(athlete):
    sid, decision = proposal()
    repo = GarminRepository()
    assert repo.get_planned_session(sid).revision == 1
    assert decision.state == "pending" and decision.applied_at is None
    assert coach_today.today()["items"][0]["record"]["readiness_measured_on"] == str(
        athlete_today() - timedelta(days=1)
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
            date=athlete_today(),
            sport="running",
            duration_sec=1800,
            planned_session_id=sid,
        )
    )
    repo.create_actual_session(
        ActualSession(date=athlete_today(), sport="running", duration_sec=7200)
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
        ActualSession(date=athlete_today(), sport="running", duration_sec=6000)
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
        ActualSession(date=athlete_today(), sport="running", duration_sec=6000)
    )
    coach_followup.prepare()
    item = coach_followup.pending()[0]
    with athlete_scope(1):
        assert coach_followup.get(item["id"]) is None
        with pytest.raises(LookupError):
            coach_followup.respond(item["id"], 1, "answer", rpe=5)
    with db_connection() as con:
        con.execute(
            "UPDATE app.coach_followups SET expires_at=(now() AT TIME ZONE 'UTC')-INTERVAL '1 hour' WHERE id=?",
            [item["id"]],
        )
    with pytest.raises(coach_followup.FollowupConflict):
        coach_followup.respond(item["id"], 1, "answer", rpe=5)


def test_followup_lifetime_runs_on_one_clock(athlete):
    # conftest puts the server's date a day apart from the athlete's (Paris):
    # an expiry built from the athlete's date and the server's time was 24 h off.
    # Instants are naive UTC, whatever the server's zone.
    GarminRepository().create_actual_session(
        ActualSession(date=athlete_today(), sport="running", duration_sec=6000)
    )
    coach_followup.prepare()
    item = coach_followup.pending()[0]
    with db_connection() as con:
        left = con.execute(
            "SELECT epoch(expires_at - (now() AT TIME ZONE 'UTC')) FROM app.coach_followups WHERE id=?",
            [item["id"]],
        ).fetchone()[0]
    assert abs(left - coach_followup.MAX_FOLLOWUP_HOURS * 3600) < 60
    # The home card and the coach's context agree on the expiry, either side.
    for shift, visible in (
        ("+ INTERVAL '1 hour'", True),
        ("- INTERVAL '1 hour'", False),
    ):
        with db_connection() as con:
            con.execute(
                f"UPDATE app.coach_followups SET expires_at=(now() AT TIME ZONE 'UTC') {shift} WHERE id=?",
                [item["id"]],
            )
        assert bool(coach_followup.pending()) is visible
        assert (item["question"] in coach_followup.context_block()) is visible


def test_strength_hr_is_not_interpreted_as_cardio_quality(athlete):
    sid = GarminRepository().create_actual_session(
        ActualSession(
            date=athlete_today(),
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
    from arete.agent.tools.fact_memory import forget_fact
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


def _apply_low_day(item):
    key = item["record"]
    others = {m["id"]: m["revision"] for m in item["members"] if m["id"] != key["id"]}
    plan_adaptation.respond(key["id"], key["revision"], "apply", others)


def _auto_push(enabled: bool):
    return patch.object(
        plan_adaptation,
        "get_user_settings",
        return_value={"push_to_garmin_enabled": enabled},
    )


@pytest.fixture
def watch(athlete):
    """Garmin as the athlete's account holds it, with the automatic push on;
    cleaned of this test's exports."""
    from unittest.mock import MagicMock

    from test_garmin_export import Garmin

    garmin = Garmin()
    garmin.has_tokens = MagicMock(return_value=True)
    with (
        patch("arete.garmin.client.GarminClient", return_value=garmin),
        _auto_push(True),
    ):
        yield garmin
    with db_connection() as con:
        con.execute("DELETE FROM app.garmin_exports WHERE athlete_id=8123")


def test_an_applied_low_day_replaces_the_recovery_and_withdraws_the_rest(watch):
    from arete.services import garmin_export

    (endurance, intervals), item = low_day()
    for session_id in (endurance, intervals):
        assert garmin_export.export(session_id, client=watch)["state"] == "scheduled"
    workout_id = garmin_export.inspect_session(intervals)["export"]["workout_id"]
    watch.calls.clear()
    _apply_low_day(item)
    # The recovery replaces the intervals in place: same workout, new steps.
    state = garmin_export.inspect_session(intervals)["export"]
    assert state["state"] == "scheduled" and state["workout_id"] == workout_id
    assert ("PUT", f"{garmin_export.WORKOUT}/{workout_id}") in [
        (m, p) for m, p, _ in watch.calls
    ]
    assert list(watch.workouts) == [workout_id]
    session = GarminRepository().get_planned_session(intervals)
    assert session.target_duration_min == 30 and session.garmin_pushed_at is not None
    # The rest is gone from Garmin.
    assert garmin_export.inspect_session(endurance)["export"]["state"] == "removed"
    assert len(watch.schedules) == 1
    # A replay of the same answer touches Garmin no more.
    calls = len(watch.calls)
    _apply_low_day(item)
    assert len(watch.calls) == calls


def test_a_failed_watch_update_keeps_the_answer_and_is_not_replayed(watch):
    from arete.services import garmin_export

    (endurance, intervals), item = low_day()
    for session_id in (endurance, intervals):
        garmin_export.export(session_id, client=watch)
    watch.calls.clear()
    watch.fail = "read"  # Garmin unreachable
    _apply_low_day(item)
    repo = GarminRepository()
    assert repo.get_planned_session(intervals).target_duration_min == 30
    assert repo.get_planned_session(endurance).status.value == "skipped"
    # One request each, refused before any write: the card offers the button.
    assert len(watch.calls) == 2
    states = {
        s: garmin_export.inspect_session(s)["export"]["state"]
        for s in (endurance, intervals)
    }
    assert states == {endurance: "failed", intervals: "failed"}
    assert repo.get_planned_session(intervals).garmin_pushed_at is None
    assert coach_today.today()["items"] == []


def test_an_answer_for_sessions_not_on_garmin_never_reaches_it(athlete):
    _, item = low_day()
    with _auto_push(True), patch("arete.garmin.client.GarminClient") as client:
        _apply_low_day(item)
    client.assert_not_called()


def _sent(watch, *session_ids):
    from arete.services import garmin_export

    for session_id in session_ids:
        assert garmin_export.export(session_id, client=watch)["state"] == "scheduled"
    watch.calls.clear()


def test_with_the_automatic_push_off_an_answer_leaves_garmin_alone(watch):
    from arete.services import garmin_export

    (endurance, intervals), item = low_day()
    _sent(watch, endurance, intervals)
    with _auto_push(False):
        _apply_low_day(item)
    assert watch.calls == []
    # The eased copy is stale (the card offers to send it again); the rest's
    # copy stays on Garmin (the card offers to withdraw it).
    assert garmin_export.export_state(intervals)["state"] == "dirty"
    assert garmin_export.on_garmin(endurance)


def test_an_answer_waits_for_garmin_within_its_own_budget(watch, monkeypatch):
    from arete.services import garmin_export

    (endurance, intervals), item = low_day()
    _sent(watch, endurance, intervals)
    before = {s: garmin_export.export_state(s) for s in (endurance, intervals)}
    clock = [1000.0]
    monkeypatch.setattr(plan_adaptation, "monotonic", lambda: clock[0])
    monkeypatch.setattr(garmin_export, "monotonic", lambda: clock[0])
    answer = watch.workout_request

    def slow(method, path, *, timeout, payload=None):
        clock[0] += 3  # a slow Garmin: 3 s a request
        return answer(method, path, timeout=timeout, payload=payload)

    watch.workout_request = slow
    _apply_low_day(item)
    assert clock[0] - 1000 <= plan_adaptation.ANSWER_SECONDS
    assert len(watch.calls) <= plan_adaptation.ANSWER_REQUESTS
    after = {s: garmin_export.export_state(s) for s in (endurance, intervals)}
    # One session went through; the other was never claimed (no uncertain row)
    # and keeps its card's button.
    claimed = {
        s for s in after if after[s]["operation_id"] != before[s]["operation_id"]
    }
    (done,) = claimed
    (untouched,) = set(after) - claimed
    assert after[done]["state"] in {"scheduled", "removed"}
    assert after[untouched]["state"] in {"scheduled", "dirty"}


def test_a_revert_brings_the_watch_back_to_the_planned_session(watch):
    from arete.services import garmin_export

    (endurance, intervals), item = low_day()
    _sent(watch, endurance, intervals)
    workout_id = garmin_export.export_state(intervals)["workout_id"]
    _apply_low_day(item)
    assert not garmin_export.on_garmin(endurance)
    recovery, rest = item["group"]
    assert (recovery["decision"], rest["decision"]) == ("replace_easy", "rest")
    plan_adaptation.revert(recovery["id"])
    state = garmin_export.export_state(intervals)
    assert state["state"] == "scheduled" and state["workout_id"] == workout_id
    assert garmin_export.sent_as_is(garmin_export.prepare(intervals))
    assert GarminRepository().get_planned_session(intervals).target_duration_min == 60
    # The rest withdrew its session: reverting it sends the session back.
    plan_adaptation.revert(rest["id"])
    assert garmin_export.export_state(endurance)["state"] == "scheduled"
    assert garmin_export.sent_as_is(garmin_export.prepare(endurance))


def test_a_copy_sent_to_the_watch_goes_back_to_it(watch):
    from arete.services import garmin_export

    (_, intervals), item = low_day()
    assert garmin_export.export(intervals, 10, client=watch)["state"] == (
        "transfer_requested"
    )
    watch.calls.clear()
    _apply_low_day(item)
    state = garmin_export.export_state(intervals)
    assert state["state"] == "transfer_requested" and state["device_id"] == 10
    messages = [
        payload
        for _, path, payload in watch.calls
        if path == "/device-service/devicemessage/messages"
    ]
    assert [m[0]["deviceId"] for m in messages] == [10]


def test_an_unpaired_watch_falls_back_to_garmin_connect(watch, caplog):
    from arete.services import garmin_export

    (_, intervals), item = low_day()
    garmin_export.export(intervals, 10, client=watch)
    watch.calls.clear()
    answer = watch.workout_request

    def unpaired(method, path, *, timeout, payload=None):
        if path == "/device-service/deviceregistration/devices":
            watch.calls.append((method, path, payload))
            return []  # the watch was removed from the account
        return answer(method, path, timeout=timeout, payload=payload)

    watch.workout_request = unpaired
    _apply_low_day(item)
    state = garmin_export.export_state(intervals)
    assert state["state"] == "scheduled" and state["device_id"] is None
    assert all("devicemessage" not in path for _, path, _ in watch.calls)
    assert "Watch 10 unpaired: sending to Garmin Connect only" in caplog.text
