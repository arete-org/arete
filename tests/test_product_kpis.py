"""Administrators' weekly indicators: each ratio over three athletes.

Athletes 2 and 3 sign up in the week of 31 August, athlete 4 in the week of
5 October; the owner's athlete and a deactivated one also hold data, which the
cohort indicators (owner) and every indicator (deactivated) leave out.
"""

from __future__ import annotations

from dataclasses import asdict
from datetime import date, datetime

import pytest

from arete.dataio.db import connect
from arete.dataio.init_duckdb import main as init_schema
from arete.services import product_kpis

NOW = datetime(2026, 10, 14, 12, 0)  # a Wednesday
THIS_WEEK, LAST_WEEK, COHORT_WEEK = (
    date(2026, 10, 12),
    date(2026, 10, 5),
    date(2026, 8, 31),
)
OWNER, ANA, BEN, CYD, GONE = 1, 2, 3, 4, 5


def ts(day: str, hour: int = 12) -> datetime:
    return datetime.fromisoformat(day).replace(hour=hour)


ATHLETES = [
    (OWNER, ts("2026-09-01", 12), None),  # inside the cohort week: still left out
    (ANA, ts("2026-09-01", 10), None),
    (BEN, ts("2026-09-02", 8), None),
    (CYD, ts("2026-10-06", 9), None),
    (GONE, ts("2026-09-01", 9), ts("2026-10-10")),
]
LOGINS = [  # athlete, last seen
    (OWNER, ts("2026-10-13", 9)),
    (ANA, ts("2026-10-07", 10)),  # 36 days after signing up: retained
    (ANA, ts("2026-09-02", 10)),  # an older second login: the latest counts
    (BEN, ts("2026-09-20", 10)),  # gone before day 30
    (CYD, ts("2026-10-06", 11)),
    (GONE, ts("2026-10-13", 9)),
]
PUSH = [  # athlete, created, deleted
    (BEN, ts("2026-09-03", 8), None),  # BEN's first action: 24 h after signing up
    (BEN, ts("2026-10-01", 8), None),  # a second device: one subscriber
    (ANA, ts("2026-10-07", 9), None),
    (CYD, ts("2026-10-07", 9), ts("2026-10-08")),
    (GONE, ts("2026-09-02", 9), None),
]
CHECKINS = [  # athlete, day, prompted, answered
    (ANA, "2026-09-01", None, ts("2026-09-01", 16)),  # ANA's first action: 6 h
    (ANA, "2026-10-06", ts("2026-10-06", 5), ts("2026-10-06", 7)),
    (ANA, "2026-10-07", ts("2026-10-07", 5), None),
    (ANA, "2026-10-08", ts("2026-10-08", 5), ts("2026-10-08", 6)),
    (BEN, "2026-10-08", None, ts("2026-10-08", 6)),  # answered before any push
    (CYD, "2026-10-09", ts("2026-10-09", 5), None),
    (GONE, "2026-10-06", ts("2026-10-06", 5), ts("2026-10-06", 6)),
    (OWNER, "2026-09-01", None, ts("2026-09-01", 13)),
]
BRIEFINGS = [  # athlete, day, status, reaction, reacted
    (ANA, "2026-10-06", "ok", None, None),  # rewritten the same day
    (ANA, "2026-10-06", "ok", "up", ts("2026-10-06", 8)),
    (BEN, "2026-10-08", "ok", "down", ts("2026-10-08", 7)),
    (CYD, "2026-10-07", "failed", None, None),
    (CYD, "2026-10-09", "ok", None, None),
    (GONE, "2026-10-06", "ok", "up", ts("2026-10-06", 8)),
]
REVIEWS = [  # athlete, week, source, accepted
    (ANA, "2026-10-05", "agent", ts("2026-10-11", 20)),
    (BEN, "2026-10-05", "rules", None),
    (CYD, "2026-10-05", "pending", None),  # claimed, never written
    (GONE, "2026-10-05", "agent", ts("2026-10-11", 20)),
]
ACTIVITIES = [  # id, athlete, day, source, logged (None: no log, False: deleted)
    (101, ANA, "2026-10-06", "garmin_connect", True),
    (102, ANA, "2026-10-08", "garmin_connect", None),
    (103, BEN, "2026-10-07", "manual", True),  # not imported
    (104, CYD, "2026-10-09", "strava", False),
    (105, GONE, "2026-10-06", "garmin_connect", True),
]


@pytest.fixture
def kpis(tmp_path, monkeypatch) -> dict[date, dict[str, tuple]]:
    """The fixture's last eight weeks, as (numerator, denominator, value)."""
    monkeypatch.setenv("ARETE_DB", str(tmp_path / "kpis.duckdb"))
    monkeypatch.setenv("ARETE_DATA_DIR", str(tmp_path / "files"))
    init_schema()
    con = connect()
    try:
        for athlete, created, deleted in ATHLETES:
            con.execute(
                "INSERT INTO app.athletes (id, created_at, deleted_at) VALUES (?, ?, ?) "
                "ON CONFLICT (id) DO UPDATE SET created_at = EXCLUDED.created_at",
                [athlete, created, deleted],
            )
        for n, (athlete, seen) in enumerate(LOGINS):
            con.execute(
                "INSERT INTO app.users (clerk_user_id, email, athlete_id, last_seen_at) "
                "VALUES (?, ?, ?, ?)",
                [f"user_{n}", f"{n}@example.com", athlete, seen],
            )
        for n, (athlete, created, deleted) in enumerate(PUSH):
            con.execute(
                "INSERT INTO app.push_subscriptions "
                "(endpoint, p256dh, auth, created_at, athlete_id, deleted_at) "
                "VALUES (?, 'k', 'a', ?, ?, ?)",
                [f"https://push/{n}", created, athlete, deleted],
            )
        con.executemany(
            "INSERT INTO app.daily_checkins (athlete_id, date, prompted_at, answered_at) "
            "VALUES (?, ?, ?, ?)",
            CHECKINS,
        )
        con.executemany(
            "INSERT INTO app.coach_briefings (user_id, date, text, status, reaction, reacted_at) "
            "VALUES (?, ?, 'Briefing.', ?, ?, ?)",
            BRIEFINGS,
        )
        con.executemany(
            "INSERT INTO app.weekly_reviews "
            "(user_id, week_start, text, source, proposals_json, applied_at) "
            "VALUES (?, ?, 'Bilan.', ?, '[]', ?)",
            REVIEWS,
        )
        for activity, athlete, day, source, logged in ACTIVITIES:
            con.execute(
                "INSERT INTO app.actual_sessions (id, user_id, date, sport, duration_sec, source) "
                "VALUES (?, ?, ?, 'strength', 3600, ?)",
                [activity, athlete, day, source],
            )
            if logged is not None:
                con.execute(
                    "INSERT INTO app.strength_sessions "
                    "(user_id, date, actual_session_id, created_at, deleted_at) "
                    "VALUES (?, ?, ?, ?, ?)",
                    [
                        athlete,
                        day,
                        activity,
                        ts(day, 18),
                        None if logged else ts(day, 19),
                    ],
                )
    finally:
        con.close()
    weeks = product_kpis.weekly(8, now=NOW)
    assert [w.week_start for w in weeks][:2] == [THIS_WEEK, LAST_WEEK]
    assert [w.current for w in weeks] == [True] + [False] * 7
    return {
        w.week_start: {k: tuple(asdict(c).values()) for k, c in w.indicators.items()}
        for w in weeks
    }


def test_engagement_ratios_count_live_athletes_only(kpis):
    week = kpis[LAST_WEEK]
    # ANA and CYD seen, BEN reacted; the owner was seen this week only.
    assert week["active_accounts"] == (3, 4, 0.75)
    assert kpis[THIS_WEEK]["active_accounts"] == (1, 4, 0.25)
    # BEN (two devices) and ANA; CYD's device left.
    assert week["push_subscribers"] == (2, 4, 0.5)
    assert kpis[COHORT_WEEK]["push_subscribers"] == (1, 3, 0.3333)
    # ANA's activity of the 6th has its log; the 8th none, CYD's was deleted,
    # BEN's manual entry was never imported.
    assert week["strength_logged"] == (1, 3, 0.3333)
    # Four pushes, two answered; BEN answered without one.
    assert week["checkins_answered"] == (2, 4, 0.5)
    # Days with a briefing: ANA's (twice written, reacted), BEN's, CYD's.
    assert week["briefings_reacted"] == (2, 3, 0.6667)
    # ANA accepted, BEN did not; CYD's was never written.
    assert week["weekly_reviews_accepted"] == (1, 2, 0.5)


def test_cohort_indicators_leave_the_owner_out(kpis):
    # ANA after 6 h, BEN after 24 h; the owner's athlete is no sign-up.
    assert kpis[COHORT_WEEK]["first_action_hours"] == (2, 2, 15.0)
    # CYD has done nothing yet.
    assert kpis[LAST_WEEK]["first_action_hours"] == (0, 1, None)
    # ANA was seen after day 30, BEN not.
    assert kpis[COHORT_WEEK]["retention_30d"] == (1, 2, 0.5)
    # CYD's day 30 is still to come.
    assert kpis[LAST_WEEK]["retention_30d"] == (0, 0, None)


def test_a_quiet_week_still_counts_its_accounts_and_subscribers(kpis):
    week = kpis[date(2026, 9, 21)]
    assert week.pop("active_accounts") == (0, 3, 0.0)
    assert week.pop("push_subscribers") == (1, 3, 0.3333)
    assert set(week.values()) == {(0, 0, None)}
