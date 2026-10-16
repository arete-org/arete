"""Renegotiating today's session: rule options, one write, revertable, Garmin once."""

from __future__ import annotations

from datetime import date, timedelta
from unittest.mock import patch

import pytest

from arete.dataio.db import connect
from arete.garmin.models import PlannedSession, SessionStatus, SessionType
from arete.garmin.repository import GarminRepository
from arete.services import garmin_export, plan_adaptation, renegotiation
from arete.services.adaptation import Decision
from arete.services.renegotiation import Conflict, propose

#: Far enough ahead that no other test's "today" reaches it (the athlete's
#: today is patched to it: the server's date may differ, see conftest). A
#: Monday: a move stays within its week, which then holds the whole window.
_AHEAD = date.today() + timedelta(days=900)
DAY = _AHEAD - timedelta(days=_AHEAD.weekday())


def _day(offset: int) -> date:
    return DAY + timedelta(days=offset)


def _planned(
    kind: SessionType = SessionType.TEMPO,
    offset: int = 0,
    *,
    minutes: int | None = 50,
    sid: int | None = None,
    **fields,
) -> PlannedSession:
    return PlannedSession(
        id=sid,
        date=_day(offset),
        sport=fields.pop("sport", "running"),
        session_type=kind,
        target_duration_min=minutes,
        target_hr_zone=fields.pop("zone", "Z4" if kind == SessionType.TEMPO else None),
        **fields,
    )


def _options(reasons, reason: str) -> dict[str, renegotiation.Option]:
    (found,) = [r for r in reasons if r.id == reason]
    return {o.id: o for o in found.options}


# --------------------------------------------------------------------------- #
# The rules, pure
# --------------------------------------------------------------------------- #
def test_a_tired_tempo_becomes_a_shorter_easy_run_or_moves_to_tomorrow():
    tempo = _planned(sid=1, target_intensity="hard")
    tired = _options(propose(tempo, DAY, [tempo], set()), "tired")
    # Tired is never a reason to have to say it hurts: rest is offered too.
    assert list(tired) == ["lighter", "move", "rest"]
    lighter = tired["lighter"]
    assert lighter.decision == Decision.EASE
    assert lighter.changes["session_type"] == "endurance"
    assert (
        lighter.changes["target_duration_min"],
        lighter.changes["target_hr_zone"],
    ) == (35, "Z2")
    assert lighter.changes["target_intensity"] == "easy"
    assert lighter.changes["status"] == SessionStatus.MODIFIED
    # The watch shows the description: what the session now is, never the tempo.
    assert (
        lighter.changes["description"]
        == "Endurance 35' Z2 (séance d'origine : tempo 50 min Z4)"
    )
    assert (
        lighter.reason
        == "Je suis cuit : la séance tempo 50 min Z4 devient endurance 35 min Z2."
    )
    assert tired["move"].changes == {"date": _day(1)}
    assert tired["move"].decision == Decision.MOVE


def test_no_time_keeps_an_undescribed_session_and_cuts_it():
    tempo = _planned(sid=1)
    shorter = _options(propose(tempo, DAY, [tempo], set()), "no_time")["shorter"]
    assert shorter.changes["session_type"] == "tempo"
    assert shorter.changes["target_duration_min"] == 35
    # The type's template follows the duration; a description would leave it stepless.
    assert shorter.changes["description"] is None
    long_run = _planned(SessionType.LONG_RUN, sid=2, minutes=90, zone="Z2")
    cut = _options(propose(long_run, DAY, [long_run], set()), "no_time")["shorter"]
    assert (cut.changes["session_type"], cut.changes["target_duration_min"]) == (
        "long_run",
        65,
    )


def test_no_time_on_written_intervals_becomes_an_easy_run():
    intervals = _planned(SessionType.INTERVALS, sid=1, description="10×400 r1'")
    shorter = _options(propose(intervals, DAY, [intervals], set()), "no_time")[
        "shorter"
    ]
    assert shorter.changes["session_type"] == "endurance"
    assert shorter.changes["target_intensity"] == "easy"
    assert "10×400 r1'" in shorter.changes["description"]


@pytest.mark.parametrize(
    "session",
    [
        _planned(SessionType.TEMPO, sid=1, target_intensity="hard"),
        _planned(SessionType.INTERVALS, sid=1, minutes=None),
        _planned(SessionType.LONG_RUN, sid=1, minutes=120, zone="Z2"),
        _planned(SessionType.ENDURANCE, sid=1, minutes=15, zone="Z2"),
        _planned(SessionType.RECOVERY, sid=1, minutes=30, zone="Z1"),
        _planned(SessionType.RECOVERY, sid=1, minutes=20, zone="Z1"),
        _planned(SessionType.STRENGTH, sid=1, sport="strength", minutes=60),
    ],
)
def test_pain_never_offers_a_move_nor_anything_harder(session):
    pain = _options(propose(session, DAY, [session], set()), "pain")
    assert "rest" in pain and "move" not in pain
    assert pain["rest"].changes == {"status": SessionStatus.SKIPPED}
    for option in pain.values():
        minutes = option.changes.get("target_duration_min")
        if minutes is not None and session.target_duration_min is not None:
            assert minutes <= session.target_duration_min
        if "target_intensity" in option.changes:
            assert option.changes["target_intensity"] == "easy"
            assert option.changes["session_type"] == "recovery"


def test_durations_round_half_up_to_five_minutes():
    endurance = _planned(SessionType.ENDURANCE, sid=1, minutes=75, zone="Z2")
    # 75 × 0.7 = 52.5: 55, not the half-to-even 50.
    shorter = _options(propose(endurance, DAY, [endurance], set()), "no_time")[
        "shorter"
    ]
    assert shorter.changes["target_duration_min"] == 55


def test_a_short_recovery_in_pain_can_only_rest():
    recovery = _planned(SessionType.RECOVERY, sid=1, minutes=20, zone="Z1")
    assert list(_options(propose(recovery, DAY, [recovery], set()), "pain")) == ["rest"]


def test_no_free_day_offers_lighter_or_rest():
    tempo = _planned(sid=1)
    week = [tempo] + [
        _planned(SessionType.ENDURANCE, offset, sid=10 + offset) for offset in (1, 2, 3)
    ]
    reasons = propose(tempo, DAY, week, set())
    for reason in ("tired", "no_time"):
        assert list(_options(reasons, reason))[1:] == ["rest"]
    (tired,) = [r for r in reasons if r.id == "tired"]
    assert tired.note and "Pas de jour libre" in tired.note


def test_a_skipped_session_leaves_its_day_free():
    tempo = _planned(sid=1)
    skipped = _planned(SessionType.ENDURANCE, 1, sid=2, status=SessionStatus.SKIPPED)
    assert renegotiation.move_day(tempo, DAY, [tempo, skipped], set()) == _day(1)


def test_a_hard_session_never_lands_next_to_another_hard_one():
    tempo = _planned(sid=1)
    intervals = _planned(SessionType.INTERVALS, 2, sid=2)
    # Tomorrow is the eve of the intervals, the day after them follows them.
    assert renegotiation.move_day(tempo, DAY, [tempo, intervals], set()) is None
    # An easy session goes to tomorrow all the same.
    easy = _planned(SessionType.ENDURANCE, sid=1, zone="Z2")
    assert renegotiation.move_day(easy, DAY, [easy, intervals], set()) == _day(1)
    # Hard by intensity counts too; an easy neighbour does not.
    marked = _planned(SessionType.ENDURANCE, 2, sid=3, target_intensity="hard")
    assert renegotiation.move_day(tempo, DAY, [tempo, marked], set()) is None
    calm = _planned(SessionType.ENDURANCE, 2, sid=3)
    assert renegotiation.move_day(tempo, DAY, [tempo, calm], set()) == _day(1)
    # Something hard left today (a second session) keeps tomorrow off too.
    second = _planned(SessionType.INTERVALS, 0, sid=4)
    assert renegotiation.move_day(tempo, DAY, [tempo, second], set()) == _day(2)


def test_nothing_moves_onto_or_past_a_race():
    tempo = _planned(sid=1)
    easy = _planned(SessionType.ENDURANCE, sid=1, zone="Z2")
    # A goal race in two days: never its eve for a hard session, nor after it.
    assert renegotiation.move_day(tempo, DAY, [tempo], {_day(2)}) is None
    assert renegotiation.move_day(easy, DAY, [easy], {_day(2)}) == _day(1)
    assert renegotiation.move_day(easy, DAY, [easy], {_day(1)}) is None
    # A planned race counts as one.
    race = _planned(SessionType.RACE, 2, sid=5)
    assert renegotiation.move_day(tempo, DAY, [tempo, race], set()) is None


def test_a_hard_session_never_moves_into_the_two_days_before_a_race():
    tempo = _planned(sid=1)
    easy = _planned(SessionType.ENDURANCE, sid=1, zone="Z2")
    # Race in four days: tomorrow is three days before, still fine.
    assert renegotiation.move_day(tempo, DAY, [tempo], {_day(4)}) == _day(1)
    # Race in three days: tomorrow and the day after are its last two days.
    assert renegotiation.move_day(tempo, DAY, [tempo], {_day(3)}) is None
    assert renegotiation.move_day(easy, DAY, [easy], {_day(3)}) == _day(1)
    # A planned race beyond the window counts the same.
    race = _planned(SessionType.RACE, 4, sid=5)
    assert renegotiation.move_day(tempo, _day(1), [tempo, race], set()) is None


def test_a_move_never_crosses_into_next_week():
    saturday, sunday = _day(5), _day(6)
    easy = _planned(SessionType.ENDURANCE, 5, sid=1, zone="Z2")
    assert renegotiation.move_day(easy, saturday, [easy], set()) == sunday
    taken = _planned(SessionType.ENDURANCE, 6, sid=2)
    assert renegotiation.move_day(easy, saturday, [easy, taken], set()) is None
    on_sunday = _planned(SessionType.ENDURANCE, 6, sid=1, zone="Z2")
    reasons = propose(on_sunday, sunday, [on_sunday], set())
    assert list(_options(reasons, "no_time")) == ["shorter", "rest"]
    (no_time,) = [r for r in reasons if r.id == "no_time"]
    assert no_time.note and "Dernier jour de la semaine" in no_time.note


def test_a_session_moved_once_moves_no_more():
    tempo = _planned(sid=1)
    reasons = propose(tempo, DAY, [tempo], set(), moved_before=True)
    assert list(_options(reasons, "tired")) == ["lighter", "rest"]
    assert list(_options(reasons, "no_time")) == ["shorter", "rest"]
    (tired,) = [r for r in reasons if r.id == "tired"]
    assert tired.note and "Déjà déplacée une fois" in tired.note


def test_a_session_with_explicit_steps_only_moves_or_rests():
    steps = {"steps": [{"kind": "effort", "duration_kind": "seconds", "value": 600}]}
    structured = _planned(sid=1, prescription=steps)
    reasons = propose(structured, DAY, [structured], set())
    assert list(_options(reasons, "tired")) == ["move", "rest"]
    assert list(_options(reasons, "no_time")) == ["move"]
    assert list(_options(reasons, "pain")) == ["rest"]


# --------------------------------------------------------------------------- #
# Reads and writes
# --------------------------------------------------------------------------- #
@pytest.fixture
def today(monkeypatch):
    from arete.features.hr_zones import ZoneModel

    monkeypatch.setattr(
        "arete.dataio.settings.athlete_zone_model",
        lambda: ZoneModel.from_reference(lthr=170),
    )
    monkeypatch.setattr(renegotiation, "athlete_today", lambda: DAY)
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
    window = [DAY - timedelta(days=1), DAY + timedelta(days=10)]
    con.execute("DELETE FROM app.plan_decisions WHERE date BETWEEN ? AND ?", window)
    con.execute(
        "DELETE FROM app.garmin_exports WHERE session_id IN "
        "(SELECT id FROM app.planned_sessions WHERE date BETWEEN ? AND ?)",
        window,
    )
    con.execute("DELETE FROM app.planned_sessions WHERE date BETWEEN ? AND ?", window)
    con.close()


def _choose(session_id: int, reason: str, option: str, version: str | None = None):
    menu = renegotiation.options(session_id)
    return renegotiation.apply(session_id, reason, option, version or menu["version"])


def _decisions() -> list:
    from arete.services.plan_repository import PlanDecisionRepository

    return PlanDecisionRepository().list_for_day(DAY)


def _garmin():
    from unittest.mock import MagicMock

    from test_garmin_export import Garmin

    client = Garmin()
    client.has_tokens = MagicMock(return_value=True)
    return client


def _pushing(enabled: bool = True):
    return patch(
        "arete.services.plan_adaptation.get_user_settings",
        return_value={"push_to_garmin_enabled": enabled},
    )


def test_the_menu_is_read_on_demand_with_a_version(today):
    menu = renegotiation.options(today)
    assert menu["blocked"] is None and len(menu["version"]) == 16
    assert [r["id"] for r in menu["reasons"]] == ["tired", "no_time", "pain"]
    assert menu["reasons"][0]["options"][1]["label"].startswith("Déplacer à ")
    # Reading it writes nothing.
    assert _decisions() == []


def test_a_lighter_choice_is_one_revertable_decision(today):
    with _pushing(False):
        result = _choose(today, "tired", "lighter")
    assert result["garmin"] == "unchanged"
    (decision,) = _decisions()
    assert decision.state == "applied" and decision.applied_at is not None
    assert decision.decision == "ease"
    assert decision.reason.startswith("Je suis cuit : ")
    session = GarminRepository().get_planned_session(today)
    assert session is not None
    assert (session.session_type, session.target_duration_min) == (
        SessionType.ENDURANCE,
        35,
    )
    assert session.status == SessionStatus.MODIFIED
    # The session is decided for the day: the menu says why it offers nothing.
    assert "déjà ajustée" in renegotiation.options(today)["blocked"]
    with _pushing(False):
        plan_adaptation.revert(decision.id)
    back = GarminRepository().get_planned_session(today)
    assert back is not None
    assert (back.session_type, back.target_duration_min, back.target_hr_zone) == (
        SessionType.TEMPO,
        50,
        "Z4",
    )
    assert back.status == SessionStatus.PENDING


def test_a_move_changes_the_day_and_its_revert_brings_it_back(today):
    with _pushing(False):
        result = _choose(today, "no_time", "move")
    assert result["date"] == _day(1).isoformat()
    (decision,) = _decisions()
    assert decision.decision == "move" and decision.adapted == {
        "date": _day(1).isoformat()
    }
    moved = GarminRepository().get_planned_session(today)
    assert moved is not None and moved.date == _day(1)
    # Still pending: the morning's readiness still weighs it on its new day.
    assert moved.status == SessionStatus.PENDING
    with _pushing(False):
        plan_adaptation.revert(decision.id)
    back = GarminRepository().get_planned_session(today)
    assert back is not None and back.date == DAY


def test_a_moved_session_is_not_offered_another_move_on_its_new_day(today, monkeypatch):
    with _pushing(False):
        _choose(today, "no_time", "move")
    monkeypatch.setattr(renegotiation, "athlete_today", lambda: _day(1))
    menu = renegotiation.options(today)
    for reason in menu["reasons"]:
        assert "move" not in [o["id"] for o in reason["options"]]


def test_a_day_planned_inside_the_window_of_the_write_is_a_conflict(today, monkeypatch):
    stale = renegotiation._read(today)
    # Another tab planned tomorrow after this menu was read, before its write.
    GarminRepository().create_planned_session(
        PlannedSession(
            date=_day(1), sport="running", session_type=SessionType.ENDURANCE
        )
    )
    monkeypatch.setattr(renegotiation, "_read", lambda _id: stale)
    with pytest.raises(Conflict, match="plus libre"):
        renegotiation.apply(today, "tired", "move", stale.version)
    assert _decisions() == []
    assert GarminRepository().get_planned_session(today).date == DAY


def test_reverting_a_move_never_undoes_a_later_edit(today):
    with _pushing(False):
        _choose(today, "no_time", "move")
    moved = GarminRepository().get_planned_session(today)
    # The athlete lengthens the moved session in Planning: 70 min now.
    assert GarminRepository().update_planned_session_fields(
        today, expected_revision=moved.revision, target_duration_min=70
    )
    (decision,) = _decisions()
    with _pushing(False), pytest.raises(plan_adaptation.RevertRefused):
        plan_adaptation.revert(decision.id)
    kept = GarminRepository().get_planned_session(today)
    assert (kept.date, kept.target_duration_min) == (_day(1), 70)
    assert _decisions()[0].reverted_at is None


def test_a_move_reverts_only_on_its_own_day_and_gives_back_the_day_alone(
    today, monkeypatch
):
    with _pushing(False):
        _choose(today, "no_time", "move")
    (decision,) = _decisions()
    monkeypatch.setattr(plan_adaptation, "athlete_today", lambda: _day(1))
    with _pushing(False), pytest.raises(plan_adaptation.RevertRefused):
        plan_adaptation.revert(decision.id)
    monkeypatch.setattr(plan_adaptation, "athlete_today", lambda: DAY)
    with _pushing(False):
        plan_adaptation.revert(decision.id)
    back = GarminRepository().get_planned_session(today)
    assert back.date == DAY and back.target_duration_min == 50


def test_a_morning_ease_on_a_structured_session_still_reverts(today):
    from arete.services.plan_repository import PlanDecisionRepository

    con = connect()
    con.execute(
        "UPDATE app.planned_sessions SET structure_json=? WHERE id=?",
        ['{"blocks": []}', today],
    )
    con.close()
    session = GarminRepository().get_planned_session(today)
    decision = PlanDecisionRepository().create(
        day=DAY,
        planned_session_id=today,
        decision="ease",
        reason="Préparation basse",
        readiness_score=40,
        readiness_source="garmin",
        acwr=1.0,
        original=plan_adaptation.snapshot(session),
        adapted={"target_duration_min": 30},
        state="applied",
        session_revision=session.revision,
    )
    GarminRepository().update_planned_session_fields(
        today, target_duration_min=30, status=SessionStatus.MODIFIED
    )
    with _pushing(False):
        plan_adaptation.revert(decision.id)
    back = GarminRepository().get_planned_session(today)
    assert (back.target_duration_min, back.status) == (50, SessionStatus.PENDING)


def test_a_stale_page_or_a_second_tap_applies_nothing(today):
    menu = renegotiation.options(today)
    # Another tab planned tomorrow meanwhile: the move would land elsewhere.
    other = GarminRepository().create_planned_session(
        PlannedSession(
            date=_day(1), sport="running", session_type=SessionType.ENDURANCE
        )
    )
    with pytest.raises(Conflict):
        renegotiation.apply(today, "tired", "move", menu["version"])
    assert _decisions() == []
    assert GarminRepository().get_planned_session(today).date == DAY
    GarminRepository().delete_planned_session(other)
    menu = renegotiation.options(today)
    with _pushing(False):
        renegotiation.apply(today, "tired", "lighter", menu["version"])
        with pytest.raises(Conflict):
            renegotiation.apply(today, "tired", "lighter", menu["version"])
    assert len(_decisions()) == 1
    assert GarminRepository().get_planned_session(today).target_duration_min == 35


def test_a_concurrent_write_after_the_check_rolls_back(today, monkeypatch):
    menu = renegotiation.options(today)
    real = GarminRepository.update_planned_session_fields

    def edited_meanwhile(self, session_id, **kwargs):
        # Planning saved the session between the menu's read and this write.
        con = connect()
        con.execute(
            "UPDATE app.planned_sessions SET revision=revision+1 WHERE id=?",
            [session_id],
        )
        con.close()
        return real(self, session_id, **kwargs)

    monkeypatch.setattr(
        GarminRepository, "update_planned_session_fields", edited_meanwhile
    )
    with pytest.raises(Conflict):
        renegotiation.apply(today, "pain", "rest", menu["version"])
    assert _decisions() == []
    session = GarminRepository().get_planned_session(today)
    assert session is not None and session.status == SessionStatus.PENDING


def test_another_tab_deciding_first_rolls_the_session_back(today, monkeypatch):
    from arete.services.plan_repository import PlanDecisionRepository

    menu = renegotiation.options(today)
    real = PlanDecisionRepository.create

    def claimed_meanwhile(self, **kwargs):
        # Another tab's choice committed the day's decision for this session.
        real(self, **{**kwargs, "con": None})
        return real(self, **kwargs)

    monkeypatch.setattr(PlanDecisionRepository, "create", claimed_meanwhile)
    with pytest.raises(Conflict):
        renegotiation.apply(today, "pain", "rest", menu["version"])
    assert len(_decisions()) == 1
    session = GarminRepository().get_planned_session(today)
    assert session is not None and session.status == SessionStatus.PENDING


def test_an_open_proposal_must_be_answered_first(today):
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
        (proposal,) = plan_adaptation.adapt_today(DAY)
    menu = renegotiation.options(today)
    assert menu["reasons"] == [] and "réponds-y" in menu["blocked"]
    with pytest.raises(Conflict):
        renegotiation.apply(today, "tired", "lighter", menu["version"])
    # Declined, the day's row is the athlete's to fill.
    plan_adaptation.respond(proposal.id, proposal.revision, "keep")
    with _pushing(False):
        _choose(today, "pain", "rest")
    (decision,) = _decisions()
    assert decision.id == proposal.id and decision.decision == "rest"
    assert decision.state == "applied" and decision.reason.startswith("Douleur / gêne")
    assert decision.readiness_source == "athlete"
    # The morning's suggestion stays readable once replaced.
    replaced = decision.original["replaced"]
    assert replaced["reason"] == proposal.reason and replaced["state"] == "dismissed"
    assert replaced["readiness_score"] == 70.0


def test_a_reverted_choice_can_be_renegotiated(today):
    with _pushing(False):
        _choose(today, "tired", "lighter")
        (first,) = _decisions()
        plan_adaptation.revert(first.id)
        _choose(today, "no_time", "move")
    (decision,) = _decisions()
    assert decision.decision == "move" and decision.reverted_at is None
    assert GarminRepository().get_planned_session(today).date == _day(1)


def test_an_unknown_or_foreign_session_is_not_found(today):
    with pytest.raises(LookupError):
        renegotiation.options(999_999)
    other_day = GarminRepository().create_planned_session(
        PlannedSession(date=_day(2), sport="running", session_type=SessionType.TEMPO)
    )
    with pytest.raises(Conflict):
        renegotiation.options(other_day)


@pytest.mark.parametrize(
    ("column", "value", "says"),
    [("session_type", "race", "course"), ("status", "completed", "déjà faite")],
)
def test_a_race_or_a_done_session_offers_nothing(today, column, value, says):
    con = connect()
    con.execute(
        f"UPDATE app.planned_sessions SET {column}=? WHERE id=?", [value, today]
    )
    con.close()
    menu = renegotiation.options(today)
    assert says in menu["blocked"] and menu["reasons"] == []


def test_garmin_follows_once_and_never_fails_the_choice(today, monkeypatch):
    client = _garmin()
    monkeypatch.setattr("arete.garmin.client.GarminClient", lambda: client)
    garmin_export.export(today, client=client)
    with _pushing():
        result = _choose(today, "tired", "lighter")
    assert result["garmin"] == "sent"
    (workout,) = client.workouts.values()
    assert "Endurance 35'" in workout["workoutName"]
    puts = [c for c in client.calls if c[0] == "PUT"]
    assert len(puts) == 1
    # Revert: the copy goes back in place, once.
    (decision,) = _decisions()
    with _pushing():
        plan_adaptation.revert(decision.id)
    assert len([c for c in client.calls if c[0] == "PUT"]) == 2


def test_a_move_reschedules_the_copy_and_its_revert_brings_it_back(today, monkeypatch):
    client = _garmin()
    monkeypatch.setattr("arete.garmin.client.GarminClient", lambda: client)
    garmin_export.export(today, client=client)
    with _pushing():
        assert _choose(today, "no_time", "move")["garmin"] == "sent"
    assert [s["date"] for s in client.schedules.values()] == [_day(1).isoformat()]
    (decision,) = _decisions()
    with _pushing():
        plan_adaptation.revert(decision.id)
    assert [s["date"] for s in client.schedules.values()] == [DAY.isoformat()]


def test_a_rest_withdraws_the_copy(today, monkeypatch):
    client = _garmin()
    monkeypatch.setattr("arete.garmin.client.GarminClient", lambda: client)
    garmin_export.export(today, client=client)
    with _pushing():
        assert _choose(today, "pain", "rest")["garmin"] == "withdrawn"
    assert not client.workouts and not client.schedules


def test_a_failed_garmin_write_is_reported_and_not_replayed(today, monkeypatch):
    client = _garmin()
    monkeypatch.setattr("arete.garmin.client.GarminClient", lambda: client)
    garmin_export.export(today, client=client)
    client.fail = "read"
    with _pushing():
        result = _choose(today, "tired", "lighter")
    assert result["garmin"] == "failed"
    # The choice stands: written, decided, revertable.
    (decision,) = _decisions()
    assert decision.state == "applied"
    session = GarminRepository().get_planned_session(today)
    assert session is not None and session.session_type == SessionType.ENDURANCE


def test_without_a_copy_on_garmin_nothing_is_sent(today, monkeypatch):
    client = _garmin()
    monkeypatch.setattr("arete.garmin.client.GarminClient", lambda: client)
    with _pushing():
        assert _choose(today, "tired", "lighter")["garmin"] == "unchanged"
    assert client.calls == []


def test_without_a_copy_the_push_setting_is_no_warning(today):
    # Most athletes keep the automatic push off: no copy, nothing to say.
    with _pushing(False):
        assert _choose(today, "pain", "rest")["garmin"] == "unchanged"


def test_a_copy_left_by_the_push_off_is_reported(today, monkeypatch):
    client = _garmin()
    garmin_export.export(today, client=client)
    calls = len(client.calls)
    with _pushing(False):
        assert _choose(today, "pain", "rest")["garmin"] == "disabled"
    assert len(client.calls) == calls


def test_the_http_contract(today, router_client):
    from arete.api.plan import router

    http = router_client(router)
    menu = http.get(f"/plan/today/sessions/{today}/options")
    assert menu.status_code == 200
    version = menu.json()["version"]
    assert http.get("/plan/today/sessions/999999/options").status_code == 404
    body = {"reason": "tired", "option": "lighter", "version": "0" * 16}
    assert (
        http.post(f"/plan/today/sessions/{today}/renegotiate", json=body).status_code
        == 409
    )
    body["version"] = version
    body["option"] = "nope"
    assert (
        http.post(f"/plan/today/sessions/{today}/renegotiate", json=body).status_code
        == 422
    )
    body["option"] = "lighter"
    with _pushing(False):
        done = http.post(f"/plan/today/sessions/{today}/renegotiate", json=body)
        assert done.status_code == 200
        assert done.json()["garmin"] == "unchanged"
        assert done.json()["decision"]["decision"] == "ease"
        again = http.post(f"/plan/today/sessions/{today}/renegotiate", json=body)
        assert again.status_code == 409
        decision_id = done.json()["decision"]["id"]
        reverted = http.post(f"/plan/decisions/{decision_id}/revert")
    assert reverted.status_code == 200 and reverted.json()["garmin"] == "unchanged"
    assert reverted.json()["reverted_at"] is not None


def test_other_opens_the_coach_with_the_session_and_the_rules(today):
    from arete.services.coach_today import reference

    found = reference(f"session:{today}")
    assert found["kind"] == "session"
    record = found["record"]
    assert record["seance"]["id"] == today and record["seance"]["type"] == "tempo"
    assert [o["motif"] for o in record["options_des_regles"]] == [
        "Je suis cuit",
        "Pas le temps",
        "Douleur / gêne",
    ]
    with pytest.raises(LookupError):
        reference("session:999999")
