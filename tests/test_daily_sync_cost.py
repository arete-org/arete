"""What one athlete's daily run costs in database statements, step by step.

The real services run against the test database on a realistic morning: a
history (``dashboard_fixture``), yesterday's two runs to import, the week's
three already imported, four health days. Garmin's client answers canned
data and the coach's requests answer without a model.
"""

from __future__ import annotations

import json
import logging
import re
from contextlib import nullcontext
from datetime import timedelta
from time import monotonic

import pytest
from activity_samples import fit_activity
from dashboard_fixture import seed_history

from arete import scheduler
from arete.dataio.db import connect, db_connection
from arete.garmin.client import GarminClient
from arete.garmin.sync import GarminSyncClient
from arete.services.athlete_scope import athlete_scope, current_athlete_id
from arete.services.settings import athlete_today, utc_now

FIRST_ID = 9_105_000
STEP = re.compile(r"(\w+)=(\d+)ms/(\d+)st/(\d+)dbms")
STEPS = (
    "hydrate",
    "garmin_activities",
    "garmin_health",
    "conditions",
    "plan",
    "garmin_push",
    "gamification",
    "google_calendar",
    "followup",
    "feedback",
    "notification",
    "briefing",
    "review",
    "flush",
    "stamp",
    "checkin",
)
#: The run's statements on this fixture before ARE-105: 685, then 269 for a
#: rerun the same day (286 and 81 after it).
FIRST_RUN_BOUND = 300
RERUN_BOUND = 90


def _activity(activity_id, day, name, hour=7):
    return {
        "activityId": activity_id,
        "activityName": name,
        "activityType": {"typeKey": "running"},
        "startTimeLocal": f"{day}T{hour:02d}:30:00",
        "startTimeGMT": f"{day} {hour - 2:02d}:30:00",
        "duration": 2400.0,
        "distance": 7000.0,
        "averageSpeed": 2.9,
        "averageHR": 148,
        "maxHR": 171,
    }


def _health(day):
    seed = day.toordinal() % 7
    return {
        "hrv": {
            "hrvSummary": {
                "lastNightAvg": 50 + seed,
                "weeklyAvg": 54,
                "status": "BALANCED",
            }
        },
        "sleep": {
            "dailySleepDTO": {
                "id": 1,
                "sleepTimeSeconds": 26000 + seed * 100,
                "deepSleepSeconds": 5000,
                "lightSleepSeconds": 14000,
                "remSleepSeconds": 6000,
                "awakeSleepSeconds": 1000,
                "sleepScores": {"overall": {"value": 80 + seed}},
            }
        },
        "stress": {"avgStressLevel": 25 + seed, "maxStressLevel": 90},
        "body_battery": [
            {
                "charged": 60,
                "drained": 55,
                "bodyBatteryValuesArray": [[0, 30], [1, 85 + seed]],
            }
        ],
        "steps": [{"totalSteps": 9000 + seed}],
        "resting_hr": {
            "allMetrics": {
                "metricsMap": {"WELLNESS_RESTING_HEART_RATE": [{"value": 48 + seed}]}
            }
        },
        "training_readiness": {"score": 70 + seed, "level": "HIGH"},
    }


def _new_athlete(give_consent) -> int:
    """An athlete on the morning before the run: nothing decided or written yet."""
    with db_connection() as con:
        athlete_id = con.execute(
            "INSERT INTO app.athletes (id) VALUES (nextval('app.athletes_seq')) RETURNING id"
        ).fetchone()[0]
    give_consent(athlete_id)
    with athlete_scope(athlete_id), db_connection() as con:
        today = athlete_today()
        seed_history(con, today)
        for table, owner in (
            ("coach_followups", "athlete_id"),
            ("plan_decisions", "user_id"),
            ("coach_briefings", "user_id"),
        ):
            con.execute(
                f"DELETE FROM app.{table} WHERE {owner} = getvariable('arete_athlete_id')"
            )
        con.execute(
            "INSERT INTO app.game_profile(id,athlete_id,enabled) VALUES(1,?,true) "
            "ON CONFLICT DO UPDATE SET enabled=true RETURNING id",
            [athlete_id],
        )
        for i in range(3):
            day = today - timedelta(days=i + 2)
            con.execute(
                "INSERT INTO app.actual_sessions (date, sport, duration_sec, source,"
                " garmin_activity_id, start_time) VALUES (?, 'running', 2400,"
                " 'garmin_connect', ?, ?)",
                [day, str(_base(athlete_id) + 10 + i), f"{day} 07:30:00"],
            )
        # Imported long ago, or already given the coach's word.
        con.execute(
            "UPDATE app.actual_sessions SET created_at = CAST(date AS TIMESTAMP) "
            "WHERE user_id = getvariable('arete_athlete_id') RETURNING id"
        )
        con.execute(
            "INSERT INTO app.session_feedback (actual_session_id, text, source, trigger) "
            "SELECT id, 'Bonne séance.', 'rules', 'sync' FROM app.visible_actual_sessions"
        )
        checked = (utc_now() - timedelta(days=1)).replace(tzinfo=None).isoformat()
        con.execute(
            "INSERT INTO app.garmin_sync_state (athlete_id, payload) VALUES (?, ?)",
            [
                athlete_id,
                json.dumps(
                    {
                        "state": "complete",
                        "complete": True,
                        "activities_checked_at": checked,
                        "health_checked_at": checked,
                    }
                ),
            ],
        )
    from arete.services import weekly_review

    with athlete_scope(athlete_id):
        # Written on Sunday evening: the weekday run's fallback finds it.
        weekly_review.write_review(lambda _facts: "Une semaine régulière.")
    return athlete_id


def _base(athlete_id: int) -> int:
    return FIRST_ID + athlete_id * 100


@pytest.fixture
def athlete(give_consent):
    return _new_athlete(give_consent)


@pytest.fixture
def garmin(monkeypatch):
    """Garmin answers: yesterday's two runs, the week's three, older ones, health."""
    monkeypatch.setattr("arete.garmin.token_store.session_status", lambda: (True, None))
    monkeypatch.setattr(GarminClient, "has_tokens", lambda self: True)
    monkeypatch.setattr(GarminClient, "connect", lambda self: object())
    monkeypatch.setattr("arete.garmin.sync_budget.sleep", lambda _seconds: None)

    def page(self, offset, limit):
        base, today = _base(current_athlete_id()), athlete_today()
        yesterday = today - timedelta(days=1)
        rows = [
            _activity(base + 1, yesterday, "Fractionné", hour=18),
            _activity(base + 2, yesterday, "Footing du matin"),
        ]
        rows += [
            _activity(base + 10 + i, today - timedelta(days=i + 2), f"Sortie {i}")
            for i in range(3)
        ]
        rows += [
            _activity(base + 20 + i, today - timedelta(days=10 + i), f"Ancienne {i}")
            for i in range(15)
        ]
        return rows[offset : offset + limit]

    monkeypatch.setattr(GarminClient, "activity_page", page)
    monkeypatch.setattr(GarminClient, "download_fit", lambda self, _id: fit_activity())
    monkeypatch.setattr(GarminClient, "lactate_threshold", lambda self: None)
    for name in (
        "hrv",
        "sleep",
        "stress",
        "body_battery",
        "steps",
        "resting_hr",
        "training_readiness",
    ):
        monkeypatch.setattr(
            GarminClient, name, lambda self, day, _name=name: _health(day)[_name]
        )
    for name in ("training_status", "max_metrics", "endurance_score", "hill_score"):
        monkeypatch.setattr(GarminClient, name, lambda self, day: {})
    monkeypatch.setattr(GarminClient, "race_predictions", lambda self: {})


@pytest.fixture
def coach(monkeypatch):
    """The coach answers without a model; the feedback falls back to its rules."""
    import arete.coaching as coaching

    def unavailable(*_args, **_kwargs):
        raise RuntimeError("no model in tests")

    monkeypatch.setattr(coaching, "run_feedback_batch", unavailable)
    monkeypatch.setattr(
        coaching, "run_briefing", lambda *_a, **_k: "Garde l’allure facile ce matin."
    )
    monkeypatch.setattr(
        coaching, "run_review", lambda *_a, **_k: "Une semaine régulière."
    )


def _run(athlete_id, caplog) -> tuple[dict, dict[str, int], str]:
    """The run's status, each step's statements, and its timing line."""
    caplog.clear()
    with caplog.at_level(logging.INFO, logger="arete.scheduler"):
        status = scheduler._run_athlete(
            athlete_id, monotonic(), utc_now(), "Europe/Paris"
        )
    [line] = [
        r.getMessage()
        for r in caplog.records
        if r.getMessage().startswith("Daily sync timings:")
    ]
    return status, {m[0]: int(m[2]) for m in STEP.findall(line)}, line


def test_one_timing_line_per_athlete_with_each_step(athlete, garmin, coach, caplog):
    status, steps, line = _run(athlete, caplog)
    assert status["garmin_activities"].startswith("2 synced")
    assert line.startswith(f"Daily sync timings: athlete={athlete} total=")
    assert [name for name in steps if name != "total"] == list(STEPS)
    assert steps["total"] == sum(n for name, n in steps.items() if name != "total")
    # Durations and counts only: no activity name, metric or coach text.
    assert not re.sub(STEP, "", line.split(f"athlete={athlete} ", 1)[1]).split()


def test_a_failed_run_still_logs_its_timings(athlete, monkeypatch, caplog):
    def broken():
        from arete.observability.steps import step_done

        step_done("garmin_activities")
        raise RuntimeError("database down")

    monkeypatch.setattr(scheduler, "daily_sync", broken)
    status, steps, _ = _run(athlete, caplog)
    assert status == {"status": "failed; next attempt tomorrow"}
    assert list(steps) == ["total", "hydrate", "garmin_activities"]


def test_daily_run_statements_are_bounded(athlete, garmin, coach, caplog):
    """ARE-105: a third of the statements, mostly by reusing connections."""
    _, first, _ = _run(athlete, caplog)
    assert first["total"] <= FIRST_RUN_BOUND, first
    _, again, _ = _run(athlete, caplog)
    assert again["total"] <= RERUN_BOUND, again


def _readiness_one_day_at_a_time(start, end):
    """``update_readiness_range`` before ARE-105: two reads and a write a day."""
    from arete.garmin.readiness import compute_readiness

    day = start
    while day <= end:
        score = compute_readiness(day)
        if score is not None:
            con = connect()
            try:
                con.execute(
                    "UPDATE app.daily_metrics SET readiness_score = ? "
                    "WHERE user_id = getvariable('arete_athlete_id') AND deleted_at IS NULL "
                    "AND date = ? RETURNING date",
                    [score, day],
                )
            finally:
                con.close()
        day += timedelta(days=1)


def _before_are_105(monkeypatch):
    """New connections for every call, per-day readiness, per-activity presence."""
    monkeypatch.setattr(scheduler, "reuse_connections", nullcontext)
    monkeypatch.setattr(
        "arete.garmin.readiness.update_readiness_range", _readiness_one_day_at_a_time
    )
    monkeypatch.setattr(
        GarminSyncClient,
        "already_synced",
        lambda self, ids: {
            str(i) for i in ids if self.repository.has_garmin_activity(i)
        },
    )


#: Differ between two athletes or two runs by construction, not by content.
_VOLATILE = {"id", "revision", "payload", "event_key", "source_key", "canonical_key"}


def _unkeyed(row: tuple) -> tuple:
    """Without the keys quoted in text: a session's in a link, a Garmin ID in a
    file name, a briefing's in a notification's reference."""
    return tuple(re.sub(r"\d+", "#", v) if isinstance(v, str) else v for v in row)


def _written(athlete_id) -> dict[str, list[tuple]]:
    """Every row the athlete can see, keys, clocks and run state left out."""
    snapshot = {}
    with athlete_scope(athlete_id), db_connection() as con:
        views = [
            row[0]
            for row in con.execute(
                "SELECT view_name FROM duckdb_views() WHERE schema_name = 'app' "
                "AND view_name LIKE 'visible_%' ORDER BY view_name"
            ).fetchall()
        ]
        for view in views:
            columns = con.execute(
                "SELECT column_name, data_type FROM duckdb_columns() "
                "WHERE schema_name = 'app' AND table_name = ? ORDER BY column_index",
                [view],
            ).fetchall()
            kept = [
                f'"{name}" IS NOT NULL' if name.endswith("_id") else f'"{name}"'
                for name, kind in columns
                if name not in _VOLATILE
                and not name.endswith("_at")
                and "TIMESTAMP" not in kind
            ]
            if not kept:
                continue
            rows = con.execute(f"SELECT {', '.join(kept)} FROM app.{view}").fetchall()
            snapshot[view] = sorted((_unkeyed(row) for row in rows), key=repr)
    return snapshot


def test_the_run_writes_what_it_wrote_before_and_nothing_more_again(
    give_consent, garmin, coach, monkeypatch, caplog
):
    before = _new_athlete(give_consent)
    with monkeypatch.context() as old:
        _before_are_105(old)
        _, old_steps, _ = _run(before, caplog)
    after = _new_athlete(give_consent)
    _, new_steps, _ = _run(after, caplog)
    assert new_steps["total"] * 2 < old_steps["total"], (old_steps, new_steps)
    written = _written(after)
    assert written["visible_daily_metrics"] and written["visible_activity_streams"]
    assert written == _written(before)
    # The same day again: the run finds everything done.
    _run(after, caplog)
    assert _written(after) == written
