"""Replanning a missed session the same evening: detected once, proposed, answered."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, date, datetime, timedelta
from unittest.mock import MagicMock, patch

import pytest

from arete.dataio.db import connect
from arete.garmin.models import (
    ActualSession,
    PlannedSession,
    SessionStatus,
    SessionType,
)
from arete.garmin.repository import GarminRepository
from arete.services import garmin_export, missed_sessions, plan_adaptation
from arete.services.adaptation import Decision
from arete.services.plan_repository import (
    MISSED_REPLAN,
    PlanDecision,
    PlanDecisionRepository,
)

#: A Tuesday far ahead: no other test's "today", the week's Monday behind it
#: and its Friday within the three days a move reaches.
_AHEAD = date.today() + timedelta(days=1100)
DAY = _AHEAD - timedelta(days=_AHEAD.weekday()) + timedelta(days=1)


def _day(offset: int) -> date:
    return DAY + timedelta(days=offset)


def _planned(kind=SessionType.TEMPO, offset=0, *, sid=None, minutes=50, **fields):
    return PlannedSession(
        id=sid,
        date=_day(offset),
        sport=fields.pop("sport", "running"),
        session_type=kind,
        target_duration_min=minutes,
        **fields,
    )


def _decision(session_id: int, **fields) -> PlanDecision:
    values = {
        "id": 1,
        "date": DAY,
        "planned_session_id": session_id,
        "decision": "ease",
        "reason": "Préparation basse",
        "readiness_score": 55.0,
        "readiness_source": "garmin_training",
        "acwr": 1.0,
        "original": None,
        "adapted": None,
        "applied_at": None,
        "reverted_at": None,
        "created_at": None,
        "state": "pending",
    }
    values.update(fields)
    return PlanDecision(**values)


# --------------------------------------------------------------------------- #
# Detection, pure
# --------------------------------------------------------------------------- #
def test_only_pending_planned_non_race_sessions_are_missed():
    sessions = [
        _planned(sid=1),
        _planned(SessionType.ENDURANCE, sid=2, status=SessionStatus.SKIPPED),
        _planned(SessionType.ENDURANCE, sid=3, status=SessionStatus.COMPLETED),
        _planned(SessionType.RACE, sid=4),
        _planned(SessionType.ENDURANCE, sid=5, status=SessionStatus.MODIFIED),
    ]
    found = missed_sessions.missed(sessions, [], trained=False)
    assert [s.id for s in found] == [1, 5]


def test_a_day_with_any_activity_is_not_missed():
    # An activity that matched no plan is still training: no false proposal.
    assert missed_sessions.missed([_planned(sid=1)], [], trained=True) is None


def test_an_adapted_or_renegotiated_session_is_not_missed():
    applied_morning = _decision(1, state="applied", applied_at=datetime(2030, 1, 1))
    athletes = _decision(1, state="applied", readiness_source="athlete")
    for decision in (applied_morning, athletes):
        assert (
            missed_sessions.missed([_planned(sid=1)], [decision], trained=False) == []
        )


def test_a_declined_or_reverted_decision_leaves_the_session_missed():
    declined = _decision(1, state="dismissed")
    reverted = _decision(
        1, state="applied", readiness_source="athlete", reverted_at=datetime(2030, 1, 1)
    )
    for decision in (declined, reverted):
        found = missed_sessions.missed([_planned(sid=1)], [decision], trained=False)
        assert [s.id for s in found] == [1]


def test_an_open_morning_proposal_or_the_days_replanning_holds_the_day():
    # Answered together, the day's proposals must not mix.
    open_ = _decision(2, state="pending")
    snoozed = _decision(2, state="pending", snoozed_until=_day(1))
    declined_replan = _decision(1, state="dismissed", readiness_source=MISSED_REPLAN)
    for decision in (open_, snoozed, declined_replan):
        assert (
            missed_sessions.missed([_planned(sid=1)], [decision], trained=False) is None
        )


# --------------------------------------------------------------------------- #
# What is proposed, pure
# --------------------------------------------------------------------------- #
def _propose(sessions, week=None, races=frozenset(), moved=frozenset(), today=DAY):
    return {
        s.id: (kind, reason, adapted)
        for s, kind, reason, adapted in missed_sessions.propose(
            sessions, today, list(week or sessions), set(races), set(moved)
        )
    }


def test_a_missed_hard_session_moves_to_the_next_free_day():
    tempo = _planned(sid=1, target_intensity="hard")
    ((kind, reason, adapted),) = _propose([tempo]).values()
    assert kind == Decision.MOVE and adapted == {"date": _day(1).isoformat()}
    assert reason.startswith("Séance manquée aujourd’hui : la séance tempo 50 min")


def test_a_missed_easy_session_is_dropped():
    easy = _planned(SessionType.ENDURANCE, sid=1)
    ((kind, reason, adapted),) = _propose([easy]).values()
    assert kind == Decision.DROP and adapted is None
    assert "facile" in reason


def test_no_free_day_drops_the_hard_session_too():
    tempo = _planned(sid=1)
    busy = [_planned(SessionType.ENDURANCE, d, sid=10 + d) for d in (1, 2, 3)]
    ((kind, reason, _),) = _propose([tempo], [tempo, *busy]).values()
    assert kind == Decision.DROP and "aucun jour" in reason


def test_a_session_moved_once_or_on_sunday_is_dropped():
    tempo = _planned(sid=1)
    ((kind, reason, _),) = _propose([tempo], moved={1}).values()
    assert kind == Decision.DROP and "déjà été déplacée" in reason
    sunday = _planned(sid=2, offset=5)
    ((kind, reason, _),) = _propose([sunday], today=_day(5)).values()
    assert kind == Decision.DROP and "dernier jour de la semaine" in reason


def test_two_missed_hard_sessions_never_land_on_the_same_day():
    intervals = _planned(SessionType.INTERVALS, sid=1)
    long_run = _planned(SessionType.LONG_RUN, sid=2, minutes=90)
    proposals = _propose([long_run, intervals])
    # The key session (intervals) leads; the long run cannot sit next to it.
    assert proposals[1][2] == {"date": _day(1).isoformat()}
    assert proposals[2][2] == {"date": _day(3).isoformat()}


def test_never_into_the_two_days_before_a_race():
    tempo = _planned(sid=1)
    ((kind, _, _),) = _propose([tempo], races={_day(3)}).values()
    assert kind == Decision.DROP


# --------------------------------------------------------------------------- #
# Writes, answers, Garmin
# --------------------------------------------------------------------------- #
@pytest.fixture
def evening(monkeypatch):
    from arete.features.hr_zones import ZoneModel

    monkeypatch.setattr(
        "arete.dataio.settings.athlete_zone_model",
        lambda: ZoneModel.from_reference(lthr=170),
    )
    monkeypatch.setattr("arete.services.settings.athlete_today", lambda: DAY)
    monkeypatch.setattr(plan_adaptation, "athlete_today", lambda: DAY)
    session_id = GarminRepository().create_planned_session(
        PlannedSession(
            date=DAY,
            sport="running",
            session_type=SessionType.TEMPO,
            target_duration_min=50,
            target_hr_zone="Z4",
            target_intensity="hard",
        )
    )
    yield session_id
    con = connect()
    window = [DAY - timedelta(days=2), DAY + timedelta(days=10)]
    con.execute("DELETE FROM app.plan_decisions WHERE date BETWEEN ? AND ?", window)
    con.execute(
        "DELETE FROM app.garmin_exports WHERE session_id IN "
        "(SELECT id FROM app.planned_sessions WHERE date BETWEEN ? AND ?)",
        window,
    )
    con.execute("DELETE FROM app.actual_sessions WHERE date BETWEEN ? AND ?", window)
    con.execute("DELETE FROM app.planned_sessions WHERE date BETWEEN ? AND ?", window)
    con.close()


def _pushing(enabled: bool = True):
    return patch(
        "arete.services.plan_adaptation.get_user_settings",
        return_value={"push_to_garmin_enabled": enabled},
    )


def _garmin():
    from test_garmin_export import Garmin

    client = Garmin()
    client.has_tokens = MagicMock(return_value=True)
    return client


def _today() -> list[PlanDecision]:
    return PlanDecisionRepository().list_for_day(DAY)


def test_one_proposal_a_day_whatever_the_runs(evening):
    (proposal,) = missed_sessions.replan()
    assert proposal.state == "pending" and proposal.applied_at is None
    assert proposal.readiness_source == MISSED_REPLAN
    assert proposal.decision == "move"
    # Nothing changed yet.
    assert GarminRepository().get_planned_session(evening).date == DAY
    assert missed_sessions.replan() == []
    assert missed_sessions.candidates() is False
    assert len(_today()) == 1


def test_overlapping_runs_write_it_once(evening):
    with ThreadPoolExecutor(max_workers=3) as pool:
        results = list(pool.map(lambda _: missed_sessions.replan(), range(3)))
    assert sorted(len(r) for r in results) == [0, 0, 1]
    assert len(_today()) == 1


def test_a_session_done_is_not_missed(evening):
    GarminRepository().create_actual_session(
        ActualSession(date=DAY, sport="running", duration_sec=50 * 60)
    )
    assert missed_sessions.candidates() is False
    assert missed_sessions.replan() == []


def test_a_renegotiated_session_is_not_missed(evening):
    from arete.services import renegotiation

    with patch.object(renegotiation, "athlete_today", lambda: DAY), _pushing(False):
        menu = renegotiation.options(evening)
        renegotiation.apply(evening, "tired", "lighter", menu["version"])
    assert missed_sessions.replan() == []


def test_a_session_moved_here_is_judged_on_its_new_day_and_moves_no_more(evening):
    from arete.services import renegotiation

    # Today's own tempo is skipped: the day is free for yesterday's session.
    GarminRepository().update_planned_session_status(evening, SessionStatus.SKIPPED)
    yesterday = _day(-1)
    moved_here = GarminRepository().create_planned_session(
        PlannedSession(
            date=yesterday, sport="running", session_type=SessionType.INTERVALS
        )
    )
    with (
        patch.object(renegotiation, "athlete_today", lambda: yesterday),
        _pushing(False),
    ):
        menu = renegotiation.options(moved_here)
        option = next(
            o
            for r in menu["reasons"]
            if r["id"] == "no_time"
            for o in r["options"]
            if o["id"] == "move"
        )
        assert option["label"].startswith("Déplacer à ")
        renegotiation.apply(moved_here, "no_time", "move", menu["version"])
    assert GarminRepository().get_planned_session(moved_here).date == DAY
    written = {d.planned_session_id: d for d in missed_sessions.replan()}
    assert written[moved_here].decision == "drop"
    assert "déjà été déplacée" in written[moved_here].reason


def test_accepting_a_move_is_one_revertable_decision(evening):
    (proposal,) = missed_sessions.replan()
    with _pushing(False):
        applied, garmin = plan_adaptation.respond_reporting(
            proposal.id, proposal.revision, "apply"
        )
    assert applied.state == "applied" and garmin == "unchanged"
    moved = GarminRepository().get_planned_session(evening)
    assert moved.date == _day(1)
    # Still pending: tomorrow's readiness weighs it.
    assert moved.status == SessionStatus.PENDING
    with _pushing(False):
        plan_adaptation.revert(proposal.id)
    assert GarminRepository().get_planned_session(evening).date == DAY


def test_accepting_a_drop_skips_it_and_reverting_brings_it_back(evening):
    con = connect()
    con.execute(
        "UPDATE app.planned_sessions SET session_type='endurance', target_intensity=NULL "
        "WHERE id=?",
        [evening],
    )
    con.close()
    (proposal,) = missed_sessions.replan()
    assert proposal.decision == "drop"
    with _pushing(False):
        plan_adaptation.respond(proposal.id, proposal.revision, "apply")
    assert (
        GarminRepository().get_planned_session(evening).status == SessionStatus.SKIPPED
    )
    with _pushing(False):
        plan_adaptation.revert(proposal.id)
    assert (
        GarminRepository().get_planned_session(evening).status == SessionStatus.PENDING
    )


def test_declining_records_it_and_nothing_is_proposed_again(evening):
    (proposal,) = missed_sessions.replan()
    declined = plan_adaptation.respond(proposal.id, proposal.revision, "keep")
    assert declined.state == "dismissed"
    assert GarminRepository().get_planned_session(evening).date == DAY
    assert missed_sessions.replan() == []


def test_a_declined_morning_proposal_is_replaced_and_kept_readable(evening):
    from arete.services.coaching_rules import RuleFacts

    facts = RuleFacts(
        acwr=1.0,
        tsb=-5.0,
        readiness_score=70.0,
        fatigue_threshold=85,
        fitness_goal="build",
        readiness_source="garmin_training",
        readiness_measured_on=DAY,
    )
    with patch("arete.services.coaching_rules.rule_facts", return_value=facts):
        (morning,) = plan_adaptation.adapt_today(DAY)
    # Open, the morning's proposal holds the day.
    assert missed_sessions.replan() == []
    plan_adaptation.respond(morning.id, morning.revision, "keep")
    (proposal,) = missed_sessions.replan()
    assert proposal.id == morning.id and proposal.state == "pending"
    assert proposal.original["replaced"]["reason"] == morning.reason


def test_a_session_changed_since_makes_the_proposal_stale(evening):
    from arete.services import coach_today

    (proposal,) = missed_sessions.replan()
    GarminRepository().update_planned_session_fields(evening, target_duration_min=40)
    with patch.object(coach_today, "athlete_today", lambda: DAY):
        card = coach_today.today()
    assert card["items"][0]["record"]["state"] == "stale"
    with pytest.raises(plan_adaptation.ProposalConflict):
        plan_adaptation.respond(proposal.id, proposal.revision, "apply")
    assert GarminRepository().get_planned_session(evening).date == DAY


def test_garmin_follows_an_accepted_move_and_a_drop(evening, monkeypatch):
    client = _garmin()
    monkeypatch.setattr("arete.garmin.client.GarminClient", lambda: client)
    garmin_export.export(evening, client=client)
    (proposal,) = missed_sessions.replan()
    with _pushing():
        _, garmin = plan_adaptation.respond_reporting(
            proposal.id, proposal.revision, "apply"
        )
    assert garmin == "sent"
    assert [s["date"] for s in client.schedules.values()] == [_day(1).isoformat()]


def test_the_http_answer_reports_garmin(evening, router_client):
    from arete.api.coach import router

    (proposal,) = missed_sessions.replan()
    with _pushing(False):
        answer = router_client(router).post(
            f"/coach/proposals/{proposal.id}/response",
            json={"revision": proposal.revision, "action": "apply"},
        )
    assert answer.status_code == 200
    assert answer.json()["garmin"] == "unchanged"
    assert answer.json()["decision"] == "move"


# --------------------------------------------------------------------------- #
# The evening's dispatch and push
# --------------------------------------------------------------------------- #
def test_the_evening_starts_at_six_outside_quiet_hours():
    from arete.scheduler import evening_owed
    from arete.services.settings import QuietHours

    def at(hour: int, minute: int = 0) -> float:
        return datetime(2026, 10, 14, hour, minute, tzinfo=UTC).timestamp()

    quiet = QuietHours()
    assert not evening_owed(at(15, 59), "Europe/Paris", quiet)  # 17:59 in Paris
    assert evening_owed(at(18), "Europe/Paris", quiet)  # 20:00 in Paris
    assert evening_owed(at(18), "Europe/London", quiet)  # 19:00
    assert not evening_owed(at(18), "America/New_York", quiet)  # 14:00
    assert not evening_owed(at(20), "Europe/Paris", quiet)  # 22:00: quiet hours


def test_the_push_goes_once_and_only_when_a_proposal_is_written(evening, monkeypatch):
    from arete import scheduler
    from arete.services.notifications import NotifyResult

    refresh = MagicMock(return_value={})
    sent = MagicMock(return_value=NotifyResult(1, 0))
    monkeypatch.setattr("arete.services.garmin_sync.ensure_fresh", refresh)
    monkeypatch.setattr("arete.services.notifications.notify", sent)
    from time import monotonic

    first = scheduler.replan_missed_evening(monotonic())
    assert first.startswith("1 proposed")
    second = scheduler.replan_missed_evening(monotonic())
    assert second == "nothing missed"
    assert sent.call_count == 1
    title, body, url = sent.call_args.args
    assert sent.call_args.kwargs == {"kind": "adapted_session"}
    assert title == "Séance manquée ?" and "déplacer à" in body and url == "/"
    # The second run found the day handled with one read: no Garmin request.
    assert refresh.call_count == 1


def test_a_day_with_nothing_missed_asks_garmin_nothing(evening, monkeypatch):
    from time import monotonic

    from arete import scheduler

    GarminRepository().update_planned_session_status(evening, SessionStatus.SKIPPED)
    refresh = MagicMock()
    monkeypatch.setattr("arete.services.garmin_sync.ensure_fresh", refresh)
    assert scheduler.replan_missed_evening(monotonic()) == "nothing missed"
    refresh.assert_not_called()


def test_the_athletes_choice_of_kind_holds_the_push():
    from arete.services.notifications import withheld

    settings = {
        "timezone": "Europe/Paris",
        "notification_preferences": {
            "kinds": {"adapted_session": False},
            "quiet_hours": None,
        },
    }
    assert withheld(settings, "adapted_session") == "type de notification désactivé"


# --------------------------------------------------------------------------- #
# Review fixes
# --------------------------------------------------------------------------- #
def test_a_declined_replanning_holds_the_day_even_written_over(evening, monkeypatch):
    from arete.services import renegotiation

    monkeypatch.setattr(renegotiation, "athlete_today", lambda: DAY)
    (proposal,) = missed_sessions.replan()
    plan_adaptation.respond(proposal.id, proposal.revision, "keep")  # « Non merci »
    with _pushing(False):
        menu = renegotiation.options(evening)
        renegotiation.apply(evening, "tired", "lighter", menu["version"])
        (choice,) = _today()
        plan_adaptation.revert(choice.id)
    # « Modifier » wrote over the row, « Rétablir » reverted it: still held.
    assert missed_sessions.replan() == []
    assert missed_sessions.candidates() is False


def test_a_replaced_evening_replanning_is_named_the_evenings(evening, monkeypatch):
    from arete.services import renegotiation
    from arete.services.briefing import briefing_facts
    from arete.services.coaching_rules import RuleFacts

    monkeypatch.setattr(renegotiation, "athlete_today", lambda: DAY)
    (proposal,) = missed_sessions.replan()
    plan_adaptation.respond(proposal.id, proposal.revision, "keep")  # « Non merci »
    with _pushing(False):
        menu = renegotiation.options(evening)
        renegotiation.apply(evening, "pain", "rest", menu["version"])
    facts = RuleFacts(
        acwr=1.0,
        tsb=0.0,
        readiness_score=None,
        fatigue_threshold=85,
        fitness_goal="build",
    )
    text = briefing_facts(DAY, "rules", facts)
    (line,) = [line for line in text.splitlines() if "remplacée :" in line]
    assert "proposition du soir remplacée" in line and proposal.reason in line


@pytest.mark.parametrize(
    ("sport", "minutes", "trained"),
    [
        ("running", 15, False),
        ("walking", 60, False),
        ("hiking", 90, False),
        ("running", 25, True),
        ("cycling", 20, True),
    ],
)
def test_a_short_or_incidental_activity_does_not_train_the_day(
    evening, sport, minutes, trained
):
    GarminRepository().create_actual_session(
        ActualSession(date=DAY, sport=sport, duration_sec=minutes * 60)
    )
    assert missed_sessions.candidates() is not trained


def test_an_activity_synced_after_the_proposal_makes_it_stale(evening):
    from arete.services import coach_today

    (proposal,) = missed_sessions.replan()
    GarminRepository().create_actual_session(
        ActualSession(date=DAY, sport="running", duration_sec=45 * 60)
    )
    with patch.object(coach_today, "athlete_today", lambda: DAY):
        assert coach_today.today()["items"][0]["record"]["state"] == "stale"
    with _pushing(False), pytest.raises(plan_adaptation.ProposalConflict):
        plan_adaptation.respond(proposal.id, proposal.revision, "apply")
    assert GarminRepository().get_planned_session(evening).date == DAY
    # Declining still works.
    assert (
        plan_adaptation.respond(proposal.id, proposal.revision, "keep").state
        == "dismissed"
    )


def test_a_dropped_session_counts_as_missed_in_the_week(evening):
    from arete.services.coaching_rules import RuleFacts
    from arete.services.weekly_review import week_facts

    con = connect()
    con.execute(
        "UPDATE app.planned_sessions SET session_type='endurance', target_intensity=NULL "
        "WHERE id=?",
        [evening],
    )
    con.close()
    (proposal,) = missed_sessions.replan()
    with _pushing(False):
        plan_adaptation.respond(proposal.id, proposal.revision, "apply")
    facts = RuleFacts(
        acwr=1.0,
        tsb=0.0,
        readiness_score=None,
        fatigue_threshold=85,
        fitness_goal="build",
        readiness_source="model",
        readiness_measured_on=None,
    )
    monday = DAY - timedelta(days=DAY.weekday())
    with patch("arete.services.coaching_rules.rule_facts", return_value=facts):
        week = week_facts(monday, DAY)
    assert (week.planned_due, week.completed, week.missed) == (1, 0, 1)
    assert week.minutes_planned == 50


def test_the_evening_order_rotates_every_day():
    from arete.scheduler import evening_rank

    def order(day):
        return sorted(range(1, 9), key=lambda athlete: evening_rank(athlete, day))

    orders = [order(DAY + timedelta(days=d)) for d in range(4)]
    # A different last athlete across the days, the same order within a day.
    assert len({o[-1] for o in orders}) > 1
    assert order(DAY) == orders[0]


def test_dockers_evening_starts_after_the_after_work_runs():
    from arete.scheduler import DOCKER_EVENING_FROM_HOUR, evening_owed
    from arete.services.settings import QuietHours

    paris_1930 = datetime(2026, 10, 14, 17, 30, tzinfo=UTC).timestamp()
    paris_2010 = datetime(2026, 10, 14, 18, 10, tzinfo=UTC).timestamp()
    assert evening_owed(paris_1930, "Europe/Paris", QuietHours())
    assert not evening_owed(
        paris_1930, "Europe/Paris", QuietHours(), DOCKER_EVENING_FROM_HOUR
    )
    assert evening_owed(
        paris_2010, "Europe/Paris", QuietHours(), DOCKER_EVENING_FROM_HOUR
    )
