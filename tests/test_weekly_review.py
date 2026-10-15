"""The weekly review: rules propose, the athlete applies, stale ones are skipped."""

from __future__ import annotations

from datetime import date, timedelta
from unittest.mock import Mock, patch

import pytest

from arete.dataio.db import connect
from arete.garmin.models import PlannedSession, SessionStatus, SessionType
from arete.garmin.repository import GarminRepository
from arete.services import weekly_review as wr

TODAY = date.today() + timedelta(
    days=1500 - (date.today() + timedelta(days=1500)).weekday()
)
# TODAY is a Monday far ahead; last week is the 7 days before it.


def _facts(**kw) -> wr.WeekFacts:
    values = {
        "week_start": wr.last_monday(TODAY),
        "planned_due": 5,
        "completed": 5,
        "missed": 0,
        "minutes_done": 300,
        "minutes_planned": 300,
        "runs_done": 5,
        "acwr": 1.0,
        "tsb": -5.0,
        "readiness_avg": 70.0,
    }
    values.update(kw)
    return wr.WeekFacts(**values)


def _session(i, kind, minutes, day=1) -> PlannedSession:
    return PlannedSession(
        id=i,
        date=TODAY + timedelta(days=day),
        session_type=kind,
        target_duration_min=minutes,
        target_hr_zone="Z2",
        status=SessionStatus.PENDING,
    )


UPCOMING = [
    _session(1, SessionType.ENDURANCE, 40, 1),
    _session(2, SessionType.INTERVALS, 50, 2),
    _session(3, SessionType.TEMPO, 55, 3),
    _session(4, SessionType.LONG_RUN, 90, 6),
]


def test_a_good_week_changes_nothing():
    assert wr.propose(_facts(), UPCOMING) == []


def test_overload_eases_the_hardest_session_and_shortens_the_long_run():
    proposals = wr.propose(_facts(acwr=1.45), UPCOMING)
    assert [p.planned_session_id for p in proposals] == [2, 4]
    assert proposals[0].change["session_type"] == "endurance"
    assert proposals[1].change == {"target_duration_min": 75}
    assert "1.45" in proposals[0].reason


def test_a_missed_week_drops_the_shortest_easy_run():
    proposals = wr.propose(_facts(completed=2), UPCOMING)
    assert [(p.planned_session_id, p.change) for p in proposals] == [
        (1, {"status": "skipped"})
    ]
    assert "2 séances faites sur 5" in proposals[0].reason


def test_facts_text_lists_the_proposals_or_says_none():
    assert "aucune, rien à changer" in wr.facts_text(_facts(), [])
    text = wr.facts_text(_facts(acwr=1.45), wr.propose(_facts(acwr=1.45), UPCOMING))
    assert "endurance Z2" in text


@pytest.fixture
def week():
    repo = GarminRepository()
    ids = [
        repo.create_planned_session(
            PlannedSession(
                date=TODAY + timedelta(days=d), session_type=k, target_duration_min=m
            )
        )
        for d, k, m in ((2, SessionType.INTERVALS, 50), (6, SessionType.LONG_RUN, 90))
    ]
    yield ids
    con = connect()
    con.execute(
        "DELETE FROM app.planned_sessions WHERE date >= ?", [TODAY - timedelta(days=10)]
    )
    con.execute(
        "DELETE FROM app.weekly_reviews WHERE week_start >= ?",
        [TODAY - timedelta(days=10)],
    )
    con.close()


def _generate(produce=None, **facts):
    with patch.object(wr, "week_facts", return_value=_facts(**facts)):
        return wr.generate_review(produce, today=TODAY)


def test_generate_once_with_a_rule_floor_and_apply_with_stale_checks(week):
    review = _generate(lambda _f: (_ for _ in ()).throw(RuntimeError("down")), acwr=1.5)
    assert review.source == "rules" and len(review.proposals) == 2
    assert _generate(lambda _f: "texte").id == review.id  # written once
    repo = GarminRepository()
    # The long run changes after the review: its proposal is now stale.
    repo.update_planned_session_fields(week[1], target_duration_min=100)
    result = wr.apply_review(review.id, [0, 1])
    assert result == {"applied": [0], "stale": [1]}
    eased = repo.get_planned_session(week[0])
    assert eased is not None
    assert (eased.session_type, eased.status) == (
        SessionType.ENDURANCE,
        SessionStatus.MODIFIED,
    )
    assert wr.apply_review(review.id, [0]) == {"applied": [], "stale": []}
    assert wr.get_review_by_id(review.id).applied == [0]


def test_the_agent_text_is_kept(week):
    review = _generate(lambda facts: "Bonne semaine. " + str("Propositions" in facts))
    assert (review.source, review.text) == ("agent", "Bonne semaine. True")


def test_an_empty_week_is_reviewed_by_the_rules_without_a_model_request(week):
    produce = Mock(return_value="Semaine calme.")
    review = _generate(
        produce,
        planned_due=0,
        completed=0,
        missed=0,
        minutes_done=0,
        minutes_planned=0,
        runs_done=0,
    )
    produce.assert_not_called()
    assert review.source == "rules"
    assert review.text.startswith("Semaine passée : 0 séances faites sur 0 prévues")


def test_the_daily_run_falls_back_on_any_day_but_sunday():
    from arete import scheduler

    # Sunday's daily run leaves the ending week to the evening's pass.
    assert scheduler.write_weekly_review(date(2026, 10, 18)) == "sunday evening"
    with (
        patch("arete.coaching.write_scheduled_review") as write,
        patch("arete.scheduler._held", return_value=None),
        patch("arete.services.notifications.notify") as notify,
    ):
        notify.return_value = Mock(skipped_reason=None, sent=1)
        write.return_value = wr.Review(
            1, TODAY, "Semaine tenue. Bravo.", "agent", [], [], None, None
        )
        assert (
            scheduler.write_weekly_review(date(2026, 10, 12))
            == "agent, 0 proposals; 1 sent"
        )
        notify.assert_called_once_with(
            "Ta semaine est prête",
            "Semaine tenue.",
            "/planning/semaine",
            kind="weekly_review",
        )
        assert notify.call_count == 1


def test_reviewed_prescriptions_are_left_alone():
    imported = _session(9, SessionType.INTERVALS, 50, 2)
    imported.prescription = {"version": 1, "steps": []}
    proposals = wr.propose(_facts(acwr=1.45), [imported])
    assert proposals == []
