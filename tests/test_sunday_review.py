"""« Ma semaine » (ARE-60): Sunday evening's review, once a week, and « Accepter »."""

from __future__ import annotations

import json
import threading
from datetime import UTC, datetime, timedelta
from time import monotonic
from unittest.mock import Mock, patch

import pytest

from arete.dataio.db import connect
from arete.dataio.init_duckdb import main as init_schema
from arete.garmin.models import PlannedSession, SessionStatus, SessionType
from arete.garmin.repository import GarminRepository
from arete.services import weekly_review as wr
from arete.services.settings import athlete_today

#: 16:10 UTC on a Sunday, the daily sync's last window: 18:10 in Paris (summer).
SUNDAY = datetime(2026, 10, 18, 16, 10, tzinfo=UTC)
#: The same window in winter: 17:10 in Paris.
WINTER_SUNDAY = datetime(2026, 11, 1, 16, 10, tzinfo=UTC)
#: Monday's first window: 09:10 in Paris.
MONDAY = datetime(2026, 10, 19, 7, 10, tzinfo=UTC)


@pytest.fixture
def clock(tmp_path, monkeypatch):
    """An athlete in Paris with one subscribed browser; ``clock[0]`` is now."""
    from arete import scheduler
    from arete.services import checkins, notifications, settings

    monkeypatch.setenv("ARETE_DB", str(tmp_path / "week.duckdb"))
    monkeypatch.setenv("ARETE_DATA_DIR", str(tmp_path / "files"))
    monkeypatch.delenv("ARETE_AUTH", raising=False)
    monkeypatch.setenv("WEB_PUSH_VAPID_PUBLIC_KEY", "pub")
    monkeypatch.setenv("WEB_PUSH_VAPID_PRIVATE_KEY", "priv")
    monkeypatch.setenv("WEB_PUSH_SUBJECT", "mailto:me@example.com")
    init_schema()
    con = connect()
    con.execute("INSERT INTO app.athletes (id) VALUES (1) ON CONFLICT DO NOTHING")
    con.close()
    now = [SUNDAY]
    for module in (scheduler, notifications, settings, checkins, wr):
        monkeypatch.setattr(module, "utc_now", lambda: now[0])
    _prefs()
    notifications.subscribe("https://push.test/week", "p", "a")
    return now


def _prefs(raw: str | None = None) -> None:
    con = connect()
    con.execute(
        "INSERT INTO app.user_settings (user_id, timezone, notification_preferences) "
        "VALUES (1, 'Europe/Paris', ?) ON CONFLICT (user_id) DO UPDATE SET "
        "notification_preferences = EXCLUDED.notification_preferences",
        [raw],
    )
    con.close()


@pytest.fixture
def coach():
    """The review's one model request on a loaded week, and the pushes;
    nothing leaves."""
    with (
        patch.object(
            wr, "week_facts", side_effect=lambda week, _today: _facts(week_start=week)
        ),
        patch("arete.coaching.run_review", return_value="Semaine tenue. Bravo.") as run,
        patch("arete.services.garmin_sync.ensure_fresh") as refresh,
        patch("pywebpush.webpush") as push,
    ):
        yield run, refresh, push


def _week_with_load() -> list[int]:
    """Next week's tempo and long run, after a week that warrants changes."""
    monday = athlete_today() + timedelta(days=1)
    repo = GarminRepository()
    return [
        repo.create_planned_session(
            PlannedSession(
                date=monday + timedelta(days=offset),
                session_type=kind,
                target_duration_min=minutes,
            )
        )
        for offset, kind, minutes in (
            (1, SessionType.INTERVALS, 50),
            (6, SessionType.LONG_RUN, 90),
        )
    ]


def _facts(**overrides) -> wr.WeekFacts:
    values = dict(
        week_start=wr.review_week(athlete_today()),
        planned_due=5,
        completed=4,
        missed=1,
        minutes_done=240,
        minutes_planned=300,
        runs_done=4,
        acwr=1.5,
        tsb=-8.0,
        readiness_avg=70.0,
    )
    return wr.WeekFacts(**{**values, **overrides})


def _sunday_pass() -> dict:
    from arete import scheduler

    return scheduler.run_sunday_reviews(monotonic())["athletes"]


def _rows() -> list[tuple]:
    con = connect()
    try:
        return con.execute(
            "SELECT week_start, source FROM app.weekly_reviews ORDER BY id"
        ).fetchall()
    finally:
        con.close()


# --------------------------------------------------------------------------- #
# Timing
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    ("moment", "due"),
    [
        (SUNDAY, True),  # 18:10 in Paris, in the last window
        (SUNDAY - timedelta(hours=1), False),  # 17:10, but the 15:00 UTC window
        (WINTER_SUNDAY, True),  # 17:10 in winter
        (WINTER_SUNDAY - timedelta(hours=1), False),  # 16:10, too early
        (SUNDAY - timedelta(days=1), False),  # Saturday
        (SUNDAY + timedelta(hours=7), False),  # Monday 01:10
    ],
)
def test_the_review_evening_is_sunday_from_the_last_window(moment, due):
    from arete.scheduler import review_evening

    assert review_evening(moment.timestamp(), "Europe/Paris", None) is due


def test_quiet_hours_and_far_zones_wait_for_monday():
    from arete.scheduler import review_evening
    from arete.services.settings import QuietHours

    quiet = QuietHours(start="18:00", end="07:00")
    assert not review_evening(SUNDAY.timestamp(), "Europe/Paris", quiet)
    # 00:10 on Monday in Tokyo: no Sunday window reaches it.
    assert not review_evening(SUNDAY.timestamp(), "Asia/Tokyo", None)
    # Docker's later ticks serve the Americas: 17:10 in Bogota.
    later = SUNDAY + timedelta(hours=6)
    assert review_evening(later.timestamp(), "America/Bogota", None)


def test_sunday_reviews_the_week_ending_and_monday_the_same_week():
    sunday = SUNDAY.date()
    assert wr.review_week(sunday) == sunday - timedelta(days=6)
    assert wr.review_week(sunday + timedelta(days=1)) == sunday - timedelta(days=6)
    assert wr.review_week(sunday - timedelta(days=1)) == sunday - timedelta(days=13)


def test_every_cron_window_includes_the_review_s(clock):
    from pathlib import Path

    from arete.services.weekly_review import REVIEW_WINDOW_UTC_HOUR

    crons = json.loads((Path(__file__).parents[1] / "vercel.json").read_text())
    sync = [
        c["schedule"] for c in crons["crons"] if c["path"] == "/api/cron/daily-sync"
    ]
    # The review rides the last daily-sync window: no cron of its own.
    assert max(int(s.split()[1]) for s in sync) == REVIEW_WINDOW_UTC_HOUR


# --------------------------------------------------------------------------- #
# Written once, announced once
# --------------------------------------------------------------------------- #
def test_sunday_evening_writes_and_announces_the_week_once(clock, coach):
    run, refresh, push = coach
    _week_with_load()
    assert _sunday_pass() == {"1": "agent, 2 proposals; 1 sent"}
    refresh.assert_called_once()  # the afternoon's sessions first
    payload = json.loads(push.call_args.kwargs["data"])
    assert payload == {
        "title": "Ta semaine est prête",
        "body": "Semaine tenue.",
        "url": "/planning/semaine",
    }
    # The next Docker tick, a cron delivered twice, and Monday's fallback.
    clock[0] = SUNDAY + timedelta(minutes=5)
    assert _sunday_pass() == {"1": "already written"}
    from arete import scheduler

    clock[0] = MONDAY
    assert scheduler.write_weekly_review() == "already written"
    assert run.call_count == 1 and push.call_count == 1
    assert _rows() == [(SUNDAY.date() - timedelta(days=6), "agent")]


def test_overlapping_dispatches_pay_for_one_review(clock, coach):
    run, _refresh, push = coach
    started = threading.Event()
    release = threading.Event()

    def slow(_facts, deadline=None):
        started.set()
        assert release.wait(10)
        return "Semaine tenue."

    run.side_effect = slow
    results: list[dict] = []
    first = threading.Thread(target=lambda: results.append(_sunday_pass()))
    first.start()
    assert started.wait(10)
    # The second dispatch finds the claim: no Garmin refresh, no model
    # request, no push.
    assert _sunday_pass() == {"1": "in progress"}
    assert _refresh.call_count == 1
    release.set()
    first.join(10)
    assert results == [{"1": "agent, 0 proposals; 1 sent"}]
    assert run.call_count == 1 and push.call_count == 1


def test_a_failed_sunday_is_left_to_monday_never_replayed_the_same_day(clock, coach):
    run, _refresh, push = coach
    # A failure after the claim (the rules, before the model request).
    with patch.object(wr, "propose", side_effect=RuntimeError("db down")):
        assert _sunday_pass() == {"1": "failed: db down"}
    # The claim stays: later Sunday ticks, even past its expiry, wait, and
    # say why, without refreshing Garmin again.
    assert _sunday_pass() == {"1": "in progress"}
    clock[0] = SUNDAY + timedelta(seconds=wr.CLAIM_SECONDS + 60)
    assert _sunday_pass() == {"1": "failed earlier today; next attempt tomorrow"}
    assert run.call_count == 0 and push.call_count == 0
    assert _refresh.call_count == 1
    from arete import scheduler

    clock[0] = MONDAY
    assert scheduler.write_weekly_review() == "agent, 0 proposals; 1 sent"
    assert run.call_count == 1 and push.call_count == 1


def test_the_athlete_may_retry_a_failed_review_by_hand(clock, coach):
    run, _refresh, _push = coach
    with (
        patch.object(wr, "week_facts", side_effect=RuntimeError("db down")),
        pytest.raises(RuntimeError),
    ):
        wr.generate_review(run)
    review = wr.generate_review(run)
    assert review.source == "agent"


def test_a_running_claim_answers_in_progress_to_the_athlete(clock, coach):
    run, _refresh, _push = coach
    assert wr._claim(wr.review_week(athlete_today()), scheduled=True) is not None
    with pytest.raises(wr.ReviewInProgress):
        wr.generate_review(run)
    assert wr.current_review() is None  # a claim is never served
    run.assert_not_called()


def test_the_push_respects_the_athlete_s_choice(clock, coach):
    run, _refresh, push = coach
    _prefs('{"kinds": {"weekly_review": false}}')
    assert _sunday_pass() == {"1": "agent, 0 proposals; type de notification désactivé"}
    assert push.call_count == 0
    assert wr.current_review() is not None  # written all the same


def test_quiet_hours_hold_the_review_for_monday(clock, coach):
    run, _refresh, push = coach
    _prefs('{"quiet_hours": {"start": "18:00", "end": "07:00"}}')
    assert _sunday_pass() == {}
    assert _rows() == [] and run.call_count == 0 and push.call_count == 0


def test_the_daily_dispatch_runs_the_sunday_pass(clock, coach):
    from arete import scheduler

    run, _refresh, push = coach
    # This morning's run is done: only the review is owed.
    con = connect()
    con.execute(
        "UPDATE app.athletes SET last_sync_at = ? WHERE id = 1",
        [(SUNDAY - timedelta(hours=8)).replace(tzinfo=None)],
    )
    con.close()
    result = scheduler.run_scheduled_batch()
    assert result["athletes"] == {}
    assert result["reviews"] == {
        "athletes": {"1": "agent, 0 proposals; 1 sent"},
        "deferred": False,
    }


# --------------------------------------------------------------------------- #
# The screen's reads
# --------------------------------------------------------------------------- #
def test_the_dashboard_entry_until_the_athlete_answers(clock, coach):
    run, _refresh, _push = coach
    _week_with_load()
    with patch.object(wr, "week_facts", return_value=_facts()):
        review = wr.write_review(run)
    assert review is not None and len(review.proposals) == 2

    def entry():
        con = connect()
        try:
            return wr.pending_entry(athlete_today(), con)
        finally:
            con.close()

    assert entry() == {
        "id": review.id,
        "week_start": review.week_start.isoformat(),
        "open": 2,
    }
    with patch("arete.services.plan_adaptation.push_week", return_value={}):
        wr.accept(review.id, [])
    assert entry() is None  # answered, even with nothing applied


def test_a_review_without_proposals_shows_until_monday(clock, coach):
    run, _refresh, _push = coach
    review = wr.write_review(run)
    assert review is not None and review.proposals == []

    def entry():
        con = connect()
        try:
            return wr.pending_entry(athlete_today(), con)
        finally:
            con.close()

    assert entry() is not None
    clock[0] = MONDAY
    assert entry() is not None
    clock[0] = MONDAY + timedelta(days=1)
    assert entry() is None


def test_sunday_shows_last_week_s_review_until_the_evening_s(clock, coach):
    run, _refresh, _push = coach
    clock[0] = SUNDAY - timedelta(days=6, hours=9)  # last Monday morning
    last = wr.write_review(run)
    assert last is not None
    clock[0] = SUNDAY - timedelta(hours=8)  # this Sunday morning
    assert wr.current_review() == last
    clock[0] = SUNDAY
    this = wr.write_review(run)
    assert this is not None and wr.current_review() == this


def test_the_week_screen_reads_the_review_and_its_numbers(clock, coach, client):
    run, _refresh, _push = coach
    assert client.get("/plan/review/week").json() == {
        "today": athlete_today().isoformat(),
        "review": None,
        "recap": None,
    }
    with patch.object(wr, "week_facts", return_value=_facts()):
        wr.write_review(run)
        body = client.get("/plan/review/week").json()
    assert body["review"]["text"] == "Semaine tenue. Bravo."
    assert {k: body["recap"][k] for k in ("planned", "completed", "adherence")} == {
        "planned": 5,
        "completed": 4,
        "adherence": 0.8,
    }


def test_the_coach_reads_the_referenced_review(clock, coach):
    from arete.services.coach_today import reference

    run, _refresh, _push = coach
    review = wr.write_review(run)
    assert review is not None
    record = reference(f"review:{review.id}")
    assert record["kind"] == "review"
    assert record["record"]["text"] == "Semaine tenue. Bravo."
    with pytest.raises(LookupError):
        reference(f"review:{review.id + 1}")


# --------------------------------------------------------------------------- #
# « Accepter »
# --------------------------------------------------------------------------- #
def _accepted_week(run) -> tuple[wr.Review, list[int]]:
    ids = _week_with_load()
    with patch.object(wr, "week_facts", return_value=_facts()):
        review = wr.write_review(run)
    assert review is not None
    return review, ids


def test_accept_applies_the_chosen_proposals_and_reports_each_outcome(clock, coach):
    run, _refresh, _push = coach
    review, (intervals, long_run) = _accepted_week(run)
    # The long run changes after the review: its proposal comes back stale.
    GarminRepository().update_planned_session_fields(long_run, target_duration_min=100)
    garmin = {"state": "done", "sessions": [{"planned_session_id": intervals}]}
    with patch("arete.services.plan_adaptation.push_week", return_value=garmin) as push:
        result = wr.accept(review.id, [0, 1], follow_calendar=lambda: "synced")
    assert result == {
        "applied": [0],
        "stale": [1],
        "garmin": garmin,
        "calendar": "synced",
    }
    eased = GarminRepository().get_planned_session(intervals)
    assert eased is not None and eased.session_type == SessionType.ENDURANCE
    # The changed session first, then the week's key one still pending.
    send, withdraw = push.call_args.args
    assert [s.id for s in send] == [intervals, long_run] and withdraw == []


def test_accept_applies_nothing_unselected(clock, coach):
    run, _refresh, _push = coach
    review, (intervals, _long_run) = _accepted_week(run)
    with patch(
        "arete.services.plan_adaptation.push_week",
        return_value={"state": "disabled", "sessions": []},
    ):
        result = wr.accept(review.id, [1])
    assert result["applied"] == [1] and result["stale"] == []
    untouched = GarminRepository().get_planned_session(intervals)
    assert untouched is not None and untouched.session_type == SessionType.INTERVALS


def test_a_failed_watch_or_calendar_never_fails_the_written_plan(clock, coach):
    run, _refresh, _push = coach
    review, (intervals, _long_run) = _accepted_week(run)

    def calendar_down():
        raise RuntimeError("google down")

    with patch(
        "arete.services.plan_adaptation.push_week", side_effect=RuntimeError("garmin")
    ):
        result = wr.accept(review.id, [0], follow_calendar=calendar_down)
    assert result["applied"] == [0]
    assert result["garmin"] == {"state": "failed", "sessions": []}
    assert result["calendar"] == "failed"
    eased = GarminRepository().get_planned_session(intervals)
    assert eased is not None and eased.status == SessionStatus.MODIFIED


def test_the_accept_endpoint_follows_the_calendar_inline(clock, coach, client):
    run, _refresh, _push = coach
    review, _ids = _accepted_week(run)
    with (
        patch(
            "arete.services.plan_adaptation.push_week",
            return_value={"state": "disconnected", "sessions": []},
        ),
        patch("arete.calendar.sync_training_plan", return_value="disabled") as sync,
    ):
        response = client.post(
            f"/plan/review/{review.id}/accept",
            json={"indices": [0], "created_at": review.created_at.isoformat()},
        )
    assert response.status_code == 200
    assert response.json() == {
        "applied": [0],
        "stale": [],
        "garmin": {"state": "disconnected", "sessions": []},
        "calendar": "disabled",
    }
    sync.assert_called_once()
    missing = client.post(
        "/plan/review/999999/accept",
        json={"indices": [], "created_at": review.created_at.isoformat()},
    )
    assert missing.status_code == 404


# --------------------------------------------------------------------------- #
# The week's key sessions on Garmin
# --------------------------------------------------------------------------- #
def _sessions(n: int, status=SessionStatus.PENDING) -> list[PlannedSession]:
    day = athlete_today()
    return [
        PlannedSession(
            id=100 + i,
            date=day + timedelta(days=i + 1),
            session_type=SessionType.TEMPO,
            status=status,
        )
        for i in range(n)
    ]


@pytest.fixture
def pushing():
    from arete.services import plan_adaptation as pa

    garmin = Mock()
    garmin.has_tokens.return_value = True
    with (
        patch.object(
            pa, "get_user_settings", return_value={"push_to_garmin_enabled": True}
        ),
        patch("arete.services.garmin_export.Exchange") as exchange,
    ):
        exchange.return_value.calls = 0
        exchange.return_value.max_calls = 100
        exchange.return_value.deadline = monotonic() + 600
        yield pa, garmin


def test_the_week_push_needs_the_standing_authorization(pushing):
    pa, garmin = pushing
    with patch.object(pa, "get_user_settings", return_value={}):
        assert pa.push_week(_sessions(1), [], client=garmin) == {
            "state": "disabled",
            "sessions": [],
        }
    garmin.has_tokens.return_value = False
    assert pa.push_week(_sessions(1), [], client=garmin) == {
        "state": "disconnected",
        "sessions": [],
    }


def test_the_week_push_reports_every_session(pushing):
    pa, garmin = pushing
    send = _sessions(pa.MAX_WEEK_PUSHES + 1)
    rest = _sessions(1, SessionStatus.SKIPPED)
    reasons = iter([None, "already on Garmin", "export uncertain", None])
    with (
        patch("arete.services.garmin_export.on_garmin", return_value=True),
        patch("arete.services.garmin_export.prepare", return_value=({}, None)),
        patch.object(pa, "_skip_reason", side_effect=lambda _p: next(reasons)),
        patch.object(pa, "_send", side_effect=[True, False]) as sent,
        patch.object(pa, "_withdraw", return_value=True),
    ):
        result = pa.push_week(send, rest, client=garmin)
    assert result["state"] == "done"
    assert [s["outcome"] for s in result["sessions"]] == [
        "withdrawn",
        "sent",
        "already",
        "skipped",
        "failed",
        "not_started",  # past MAX_WEEK_PUSHES: never started
    ]
    assert sent.call_count == 2


# --------------------------------------------------------------------------- #
# The athlete's own request (review findings)
# --------------------------------------------------------------------------- #
def test_a_sunday_afternoon_rewrite_keeps_the_week_on_screen(clock, coach):
    run, refresh, push = coach
    clock[0] = SUNDAY - timedelta(days=6, hours=9)  # last Monday
    last = wr.write_review(run)
    assert last is not None
    clock[0] = SUNDAY - timedelta(hours=4)  # Sunday 14:10 in Paris
    assert wr.current_review() == last  # Planning shows last week's
    redone = wr.generate_review(run, refresh=True)
    assert redone.week_start == last.week_start
    # The evening still writes the ending week, after the afternoon's
    # sessions, and announces it.
    clock[0] = SUNDAY
    assert _sunday_pass() == {"1": "agent, 0 proposals; 1 sent"}
    refresh.assert_called_once()
    assert push.call_count == 1


def test_a_sunday_afternoon_first_review_is_last_week_s(clock, coach):
    run, _refresh, _push = coach
    clock[0] = SUNDAY - timedelta(hours=4)
    written = wr.generate_review(run)
    assert written.week_start == wr.last_monday(athlete_today())
    clock[0] = SUNDAY  # from the evening on, the ending week
    assert wr.generate_review(run).week_start == wr.review_week(athlete_today())


def test_a_rewrite_waits_for_the_run_holding_the_claim(clock, coach):
    run, _refresh, _push = coach
    week = wr.review_week(athlete_today())
    assert wr._claim(week, scheduled=True) is not None
    with pytest.raises(wr.ReviewInProgress):
        wr.generate_review(run, refresh=True)
    run.assert_not_called()  # no second model request
    assert _rows() == [(week, "pending")]  # the run's claim, and its push, stand
    # A claim abandoned by a stopped run is replaced.
    clock[0] = SUNDAY + timedelta(seconds=wr.CLAIM_SECONDS + 60)
    assert wr.generate_review(run, refresh=True).source == "agent"
    assert _rows() == [(week, "agent")]


def test_the_rewrite_endpoint_answers_409_while_a_run_writes(clock, coach, client):
    assert wr._claim(wr.review_week(athlete_today()), scheduled=True) is not None
    response = client.post("/plan/review?refresh=true")
    assert response.status_code == 409


def test_the_daily_run_writes_a_missed_review_until_sunday(clock, coach):
    from arete import scheduler

    run, refresh, push = coach
    clock[0] = MONDAY + timedelta(days=2)  # Wednesday: Sunday and Monday missed
    assert scheduler.write_weekly_review() == "agent, 0 proposals; 1 sent"
    assert scheduler.write_weekly_review() == "already written"
    assert run.call_count == 1 and push.call_count == 1
    refresh.assert_not_called()  # the daily run already synced
    clock[0] = SUNDAY + timedelta(days=7, hours=-8)  # the next Sunday morning
    assert scheduler.write_weekly_review() == "sunday evening"


# --------------------------------------------------------------------------- #
# « Accepter » twice
# --------------------------------------------------------------------------- #
def test_a_second_accept_applies_and_sends_nothing(clock, coach):
    run, _refresh, _push = coach
    review, _ids = _accepted_week(run)
    pushed = {"state": "done", "sessions": []}
    with patch("arete.services.plan_adaptation.push_week", return_value=pushed) as push:
        first = wr.accept(review.id, [0, 1], follow_calendar=lambda: "synced")
        again = wr.accept(review.id, [0, 1], follow_calendar=lambda: "synced")
    assert first["applied"] == [0, 1]
    assert again == {
        "applied": [],
        "stale": [],
        "garmin": {"state": "unchanged", "sessions": []},
        "calendar": "unchanged",
    }
    assert push.call_count == 1


def test_concurrent_accepts_push_once(clock, coach):
    """Two tabs read the review before either answers: the second is refused."""
    run, _refresh, _push = coach
    review, _ids = _accepted_week(run)
    snapshot = wr._read(review.id)
    with patch("arete.services.plan_adaptation.push_week", return_value={}) as push:
        wr.accept(review.id, [0])
        with (
            patch.object(wr, "_read", return_value=snapshot),
            pytest.raises(wr.AcceptInProgress),
        ):
            wr.accept(review.id, [0, 1])
    assert push.call_count == 1
    assert wr.get_review_by_id(review.id).applied == [0]


def test_a_later_accept_of_the_rest_still_applies_it(clock, coach):
    run, _refresh, _push = coach
    review, _ids = _accepted_week(run)
    with patch("arete.services.plan_adaptation.push_week", return_value={}) as push:
        wr.accept(review.id, [0])
        assert wr.accept(review.id, [1])["applied"] == [1]
    assert push.call_count == 2


def test_a_rewrite_keeps_the_id_and_starts_unanswered(clock, coach, client):
    run, _refresh, _push = coach
    review, _ids = _accepted_week(run)
    with patch("arete.services.plan_adaptation.push_week", return_value={}):
        wr.accept(review.id, [0])
    with patch.object(wr, "week_facts", return_value=_facts()):
        redone = wr.generate_review(run, refresh=True, review_id=review.id)
    assert redone.id == review.id and redone.created_at != review.created_at
    assert (redone.applied, redone.applied_at) == ([], None)  # new proposals
    # A page that read the review before its rewrite cannot answer it.
    with pytest.raises(wr.ReviewChanged):
        wr.accept(review.id, [1], seen=review.created_at)
    response = client.post(
        f"/plan/review/{review.id}/accept",
        json={"indices": [1], "created_at": review.created_at.isoformat()},
    )
    assert response.status_code == 409


def test_a_rewrite_during_accept_still_reports_the_written_plan(clock, coach):
    run, _refresh, _push = coach
    review, (intervals, _long_run) = _accepted_week(run)
    real = wr._apply

    def then_rewritten(*args):
        out = real(*args)
        wr.generate_review(run, refresh=True)  # « Refaire » in another tab
        return out

    with (
        patch.object(wr, "_apply", side_effect=then_rewritten),
        patch(
            "arete.services.plan_adaptation.push_week",
            return_value={"state": "done", "sessions": []},
        ),
    ):
        result = wr.accept(review.id, [0])
    assert result["applied"] == [0]  # written, and said so
    eased = GarminRepository().get_planned_session(intervals)
    assert eased is not None and eased.session_type == SessionType.ENDURANCE


# --------------------------------------------------------------------------- #
# Second review pass
# --------------------------------------------------------------------------- #
def _stored(review_id: int) -> tuple:
    con = connect()
    try:
        return con.execute(
            "SELECT applied_json, applied_at FROM app.weekly_reviews WHERE id = ?",
            [review_id],
        ).fetchone()
    finally:
        con.close()


def test_an_evening_rewrite_before_the_window_rewrites_the_review_shown(clock, coach):
    run, refresh, push = coach
    clock[0] = SUNDAY - timedelta(days=6, hours=9)
    last = wr.write_review(run)
    assert last is not None
    # 16:05 UTC: 18:05 in Paris, the evening, but the window has not fired.
    clock[0] = SUNDAY - timedelta(minutes=5)
    assert wr.current_review() == last
    redone = wr.generate_review(run, refresh=True, review_id=last.id)
    assert redone.week_start == last.week_start
    assert _sunday_pass() == {"1": "agent, 0 proposals; 1 sent"}
    refresh.assert_called_once()
    assert push.call_count == 1


def test_the_rewrite_endpoint_rewrites_the_review_it_names(clock, coach, client):
    run, _refresh, _push = coach
    clock[0] = SUNDAY - timedelta(days=6, hours=9)
    last = wr.write_review(run)
    assert last is not None
    clock[0] = SUNDAY - timedelta(minutes=5)
    response = client.post(f"/plan/review?refresh=true&review_id={last.id}")
    assert response.status_code == 200
    assert response.json()["week_start"] == last.week_start.isoformat()
    assert client.post("/plan/review?refresh=true&review_id=999999").status_code == 404


def test_of_two_concurrent_rewrites_the_second_is_refused(clock, coach, client):
    run, _refresh, _push = coach
    review = wr.write_review(run)
    assert review is not None

    def another_tab_first(_facts):
        # The other tab's rewrite lands while this one waits for the coach.
        wr.generate_review(
            Mock(return_value="Autre bilan."), refresh=True, review_id=review.id
        )
        # The review stays visible throughout: the evening pass finds it written.
        assert _sunday_pass() == {"1": "already written"}
        return "Semaine refaite."

    run.reset_mock()
    run.side_effect = another_tab_first
    with pytest.raises(wr.ReviewChanged):
        wr.generate_review(run, refresh=True, review_id=review.id)
    kept = wr.current_review()
    assert kept is not None and kept.id == review.id and kept.text == "Autre bilan."
    assert run.call_count == 1  # each tab paid its own request (explicit action)


def test_a_killed_rewrite_leaves_the_review_visible_and_announced_once(clock, coach):
    """A « Refaire » stopped mid-request (Vercel's 300 s, a redeploy) on Monday."""
    from arete import scheduler

    run, _refresh, push = coach
    review, _ids = _accepted_week(run)  # Sunday's, announced? not here: no push
    with patch("arete.services.plan_adaptation.push_week", return_value={}):
        wr.accept(review.id, [0])
    clock[0] = MONDAY
    with (
        patch.object(wr, "propose", side_effect=SystemExit("killed")),
        pytest.raises(SystemExit),
    ):
        wr.generate_review(run, refresh=True, review_id=review.id)
    kept = wr.current_review()
    assert kept is not None and kept.id == review.id
    assert kept.text == review.text and kept.applied == [0]
    # The next days' runs find it written: no model request, no second push.
    run.reset_mock()
    clock[0] = MONDAY + timedelta(days=1)
    assert scheduler.write_weekly_review() == "already written"
    assert run.call_count == 0 and push.call_count == 0


def test_a_stopped_claim_holding_a_review_is_shown_again_not_rewritten(clock, coach):
    """An older in-place claim stopped mid-way: the review it hid comes back."""
    from arete import scheduler

    run, refresh, push = coach
    week = wr.review_week(athlete_today())
    con = connect()
    con.execute(
        "INSERT INTO app.weekly_reviews (week_start, text, source, proposals_json, "
        "applied_json, applied_at, created_at) VALUES (?, 'Semaine tenue.', 'pending', "
        "'[]', '[]', ?, ?)",
        [
            week,
            (SUNDAY - timedelta(hours=1)).replace(tzinfo=None),
            (SUNDAY - timedelta(hours=1)).replace(tzinfo=None),
        ],
    )
    con.close()
    clock[0] = MONDAY + timedelta(days=1)  # the next daily run
    assert scheduler.write_weekly_review() == "already written"
    kept = wr.get_review(week)
    assert kept is not None and (kept.source, kept.text) == ("agent", "Semaine tenue.")
    assert kept.applied_at is not None  # answered, as it was
    assert run.call_count == 0 and push.call_count == 0


def test_a_new_athlete_s_empty_week_is_neither_written_nor_announced(clock, coach):
    from arete import scheduler

    run, _refresh, push = coach
    empty = dict(
        planned_due=0,
        completed=0,
        missed=0,
        minutes_done=0,
        minutes_planned=0,
        runs_done=0,
    )
    with patch.object(
        wr, "week_facts", side_effect=lambda week, _t: _facts(week_start=week, **empty)
    ):
        clock[0] = MONDAY + timedelta(days=2)  # the fallback, on a Wednesday
        assert scheduler.write_weekly_review() == "empty week: nothing to review"
        assert _rows() == []
        clock[0] = SUNDAY  # the Sunday pass writes the rules' review, silently
        assert _sunday_pass() == {"1": "rules, 0 proposals; no push: empty week"}
    assert run.call_count == 0 and push.call_count == 0


def test_accept_refuses_unknown_indices_and_reports_past_ones_stale(
    clock, coach, client
):
    run, _refresh, _push = coach
    review, (intervals, long_run) = _accepted_week(run)
    with pytest.raises(ValueError):
        wr.accept(review.id, [99])
    response = client.post(
        f"/plan/review/{review.id}/accept",
        json={"indices": [99], "created_at": review.created_at.isoformat()},
    )
    assert response.status_code == 422
    assert _stored(review.id) == (None, None)  # nothing reserved, not answered
    # Tuesday's proposal went by since the page was read: stale, the rest applied.
    clock[0] = SUNDAY + timedelta(days=3)
    with patch("arete.services.plan_adaptation.push_week", return_value={}):
        result = wr.accept(review.id, [0, 1])
    assert (result["applied"], result["stale"]) == ([1], [0])
    untouched = GarminRepository().get_planned_session(intervals)
    assert untouched is not None and untouched.session_type == SessionType.INTERVALS


def test_giving_back_a_stale_proposal_keeps_a_concurrent_answer(clock, coach):
    run, _refresh, _push = coach
    review, (intervals, long_run) = _accepted_week(run)
    GarminRepository().update_planned_session_fields(long_run, target_duration_min=100)
    real = wr._apply
    other: dict = {}

    def then_another_tab(*args):
        out = real(*args)
        if not other:
            other["answer"] = wr.accept(review.id, [0])
        return out

    with (
        patch("arete.services.plan_adaptation.push_week", return_value={}),
        patch.object(wr, "_apply", side_effect=then_another_tab),
    ):
        first = wr.accept(review.id, [1])
    assert first["stale"] == [1] and other["answer"]["applied"] == [0]
    assert json.loads(_stored(review.id)[0]) == [0]


def test_a_failed_apply_claims_nothing_it_did_not_write(clock, coach):
    run, _refresh, _push = coach
    review, _ids = _accepted_week(run)
    with (
        patch.object(
            GarminRepository, "get_planned_session", side_effect=RuntimeError("db")
        ),
        patch("arete.services.plan_adaptation.push_week") as push,
        pytest.raises(RuntimeError),
    ):
        wr.accept(review.id, [0, 1])
    push.assert_not_called()
    assert _stored(review.id) == ("[]", None)  # not applied, not answered


def test_a_give_back_that_loses_a_conflict_is_retried_once(clock, coach):
    import duckdb

    run, _refresh, _push = coach
    review, (_intervals, long_run) = _accepted_week(run)
    GarminRepository().update_planned_session_fields(long_run, target_duration_min=100)
    real = wr.transaction
    calls: list[int] = []

    def conflicted_once():
        calls.append(1)
        if len(calls) == 1:
            raise duckdb.TransactionException("Conflict on update")
        return real()

    with (
        patch("arete.services.plan_adaptation.push_week", return_value={}),
        patch.object(wr, "transaction", side_effect=conflicted_once),
    ):
        result = wr.accept(review.id, [0, 1])
    assert result["stale"] == [1] and len(calls) == 2
    assert json.loads(_stored(review.id)[0]) == [0]


# --------------------------------------------------------------------------- #
# Fourth review pass: every answer carries the version it read
# --------------------------------------------------------------------------- #
def test_a_stale_page_cannot_apply_after_a_rewrite(clock, coach, client):
    run, _refresh, _push = coach
    review, (intervals, _long_run) = _accepted_week(run)
    seen = review.created_at.isoformat()
    with patch.object(wr, "week_facts", return_value=_facts()):
        wr.generate_review(run, refresh=True, review_id=review.id)  # same id
    with pytest.raises(wr.ReviewChanged):
        wr.apply_review(review.id, [0], seen=review.created_at)
    for path in ("apply", "accept"):
        response = client.post(
            f"/plan/review/{review.id}/{path}",
            json={"indices": [0], "created_at": seen},
        )
        assert response.status_code == 409, path
        assert (
            response.json()["detail"]
            == "Le bilan a été refait depuis : recharge la page."
        )
    untouched = GarminRepository().get_planned_session(intervals)
    assert untouched is not None and untouched.session_type == SessionType.INTERVALS


def test_an_answer_without_the_version_is_refused(clock, coach, client):
    run, _refresh, _push = coach
    review, _ids = _accepted_week(run)
    for path in ("apply", "accept"):
        response = client.post(
            f"/plan/review/{review.id}/{path}", json={"indices": [0]}
        )
        assert response.status_code == 422, path
    assert _stored(review.id) == (None, None)


def test_a_rewrite_between_the_read_and_the_reservation_applies_nothing(clock, coach):
    run, _refresh, _push = coach
    review, (intervals, _long_run) = _accepted_week(run)
    real = wr._reserve

    def rewritten_first(*args):
        with patch.object(wr, "week_facts", return_value=_facts()):
            wr.generate_review(run, refresh=True, review_id=review.id)
        return real(*args)

    with (
        patch.object(wr, "_reserve", side_effect=rewritten_first),
        patch("arete.services.plan_adaptation.push_week") as push,
        pytest.raises(wr.ReviewChanged),
    ):
        wr.accept(review.id, [0], seen=review.created_at)
    push.assert_not_called()
    assert _stored(review.id) == (None, None)
    untouched = GarminRepository().get_planned_session(intervals)
    assert untouched is not None and untouched.session_type == SessionType.INTERVALS


def test_planning_s_apply_reserves_like_accept(clock, coach, client):
    run, _refresh, _push = coach
    review, _ids = _accepted_week(run)
    response = client.post(
        f"/plan/review/{review.id}/apply",
        json={"indices": [0], "created_at": review.created_at.isoformat()},
    )
    assert response.json() == {"applied": [0], "stale": []}
    assert wr.get_review_by_id(review.id).applied == [0]


# --------------------------------------------------------------------------- #
# ARE-150: a write committed inside an answer's snapshot window is detected
# --------------------------------------------------------------------------- #
def test_a_give_back_racing_another_answer_keeps_that_answer(clock, coach, monkeypatch):
    from write_race import race

    run, _refresh, _push = coach
    review, (_intervals, long_run) = _accepted_week(run)
    GarminRepository().update_planned_session_fields(long_run, target_duration_min=100)
    other: dict = {}

    def another_tab():
        other["answer"] = wr.accept(review.id, [0])

    with (
        patch("arete.services.plan_adaptation.push_week", return_value={}),
        race(monkeypatch, r"SET applied_json = \?, applied_at = CASE", another_tab),
    ):
        first = wr.accept(review.id, [1])
    assert first["stale"] == [1] and other["answer"]["applied"] == [0]
    # The give-back's stale write conflicts and is retried on the answer's value.
    assert json.loads(_stored(review.id)[0]) == [0]


def test_a_reservation_racing_a_give_back_takes_nothing(clock, coach, monkeypatch):
    from write_race import race

    run, _refresh, _push = coach
    review, _ids = _accepted_week(run)
    with patch("arete.services.plan_adaptation.push_week", return_value={}):
        assert wr.accept(review.id, [0])["applied"] == [0]
    with (
        patch("arete.services.plan_adaptation.push_week") as push,
        race(
            monkeypatch,
            r"applied_at = coalesce\(applied_at, now\(\)\)",
            lambda: wr._give_back(review.id, [0]),
        ),
        pytest.raises(wr.AcceptInProgress),
    ):
        wr.accept(review.id, [1])
    push.assert_not_called()
    assert json.loads(_stored(review.id)[0]) == []  # the give-back stands


def test_a_rewrite_racing_a_give_back_is_refused(clock, coach, monkeypatch):
    from write_race import race

    run, _refresh, _push = coach
    review, _ids = _accepted_week(run)
    with patch("arete.services.plan_adaptation.push_week", return_value={}):
        wr.accept(review.id, [0])
    with (
        patch.object(wr, "week_facts", return_value=_facts()),
        race(
            monkeypatch, r"created_at = greatest", lambda: wr._give_back(review.id, [0])
        ),
        pytest.raises(wr.ReviewChanged),
    ):
        wr.generate_review(run, refresh=True, review_id=review.id)
    kept = wr.get_review_by_id(review.id)
    assert kept is not None and kept.created_at == review.created_at
