"""Administrators' weekly indicators: each ratio over three athletes.

The multi-athlete migrations ran on Wednesday 26 August: they created the
owner's athlete and OLD's, which held data before. ANA and BEN sign up in the
week of 31 August, CYD in the week of 5 October, NEW this week. A deactivated
athlete also holds data, which no indicator counts.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import asdict
from datetime import date, datetime

import pytest

from arete.dataio.db import connect
from arete.dataio.init_duckdb import main as init_schema
from arete.services import notifications, product_kpis
from arete.services.athlete_scope import athlete_scope

NOW = datetime(2026, 10, 14, 12, 0)  # a Wednesday, naive UTC
THIS_WEEK, LAST_WEEK = date(2026, 10, 12), date(2026, 10, 5)
COHORT_WEEK, MIGRATION_WEEK = date(2026, 8, 31), date(2026, 8, 24)
OWNER, ANA, BEN, CYD, GONE, OLD, NEW = 1, 2, 3, 4, 5, 6, 7


def ts(day: str, hour: int = 12, minute: int = 0) -> datetime:
    return datetime.fromisoformat(day).replace(hour=hour, minute=minute)


MIGRATED = ts("2026-08-26", 8)
ATHLETES = [
    (OWNER, MIGRATED, None),
    (OLD, MIGRATED, None),
    (ANA, ts("2026-09-01", 10), None),
    (BEN, ts("2026-09-02", 8), None),
    (CYD, ts("2026-10-06", 9), None),
    (NEW, ts("2026-10-13", 9), None),
    (GONE, ts("2026-09-01", 9), ts("2026-10-10")),
]
LOGINS = [  # athlete, last seen, deleted
    (OWNER, ts("2026-10-13", 9), None),
    (OLD, ts("2026-10-01", 10), None),  # 36 days after the migration
    (ANA, ts("2026-10-07", 10), None),  # 36 days after signing up: retained
    (ANA, ts("2026-09-02", 10), None),  # an older second login: the latest counts
    (BEN, ts("2026-09-20", 10), None),  # gone before day 30...
    (BEN, ts("2026-10-08", 10), ts("2026-10-08", 11)),  # ...but by a closed login
    (CYD, ts("2026-10-06", 11), None),
    (NEW, ts("2026-10-13", 10), None),
    (GONE, ts("2026-10-13", 9), None),
]
PUSH = [  # athlete, created, deleted
    (BEN, ts("2026-09-03", 8), None),  # BEN's first action: 24 h after signing up
    (BEN, ts("2026-10-01", 8), None),  # a second device: one subscriber
    (ANA, ts("2026-10-07", 9), None),
    (CYD, ts("2026-10-07", 9), ts("2026-10-08")),
    (NEW, ts("2026-08-25", 8), None),  # stamped before NEW existed
    (GONE, ts("2026-09-02", 9), None),
]
CHECKINS = [  # athlete, day, prompted, answered
    (OWNER, "2026-08-24", None, ts("2026-08-24", 10)),
    (NEW, "2026-08-25", None, ts("2026-08-25", 7)),  # stamped before NEW existed
    (OLD, "2026-08-27", None, ts("2026-08-27", 7)),
    (ANA, "2026-09-01", None, ts("2026-09-01", 16)),  # ANA's first action: 6 h
    (ANA, "2026-10-06", ts("2026-10-06", 5), ts("2026-10-06", 7)),
    (ANA, "2026-10-07", ts("2026-10-07", 5), None),
    (ANA, "2026-10-08", ts("2026-10-08", 5), ts("2026-10-08", 6)),
    (BEN, "2026-10-08", None, ts("2026-10-08", 6)),  # answered before any push
    (CYD, "2026-10-09", ts("2026-10-09", 5), None),
    (GONE, "2026-10-06", ts("2026-10-06", 5), ts("2026-10-06", 6)),
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
RATIOS = {key for key, _, _ in product_kpis.QUERIES} - {"first_action_hours"}


@pytest.fixture
def populated(tmp_path, monkeypatch) -> None:
    """A database of its own holding the athletes above."""
    monkeypatch.setenv("ARETE_DB", str(tmp_path / "kpis.duckdb"))
    monkeypatch.setenv("ARETE_DATA_DIR", str(tmp_path / "files"))
    init_schema()
    con = connect()
    try:
        # Recorded right after creating the athletes that already had an owner.
        con.execute(
            "UPDATE app.schema_version SET applied_at = ? WHERE version IN (35, 36)",
            [ts("2026-08-26", 8, 1)],
        )
        for athlete, created, deleted in ATHLETES:
            con.execute(
                "INSERT INTO app.athletes (id, created_at, deleted_at) VALUES (?, ?, ?) "
                "ON CONFLICT (id) DO UPDATE SET created_at = EXCLUDED.created_at",
                [athlete, created, deleted],
            )
        for n, (athlete, seen, deleted) in enumerate(LOGINS):
            con.execute(
                "INSERT INTO app.users "
                "(clerk_user_id, email, athlete_id, last_seen_at, deleted_at) "
                "VALUES (?, ?, ?, ?, ?)",
                [f"user_{n}", f"{n}@example.com", athlete, seen, deleted],
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
        for athlete, day, status, answered, deleted in (
            (ANA, "2026-10-06", "ok", True, False),
            (BEN, "2026-10-07", "ok", False, False),
            (CYD, "2026-10-08", "failed", False, False),
            (GONE, "2026-10-06", "ok", True, False),
            (ANA, "2026-10-08", "ok", True, True),
        ):
            con.execute(
                "INSERT INTO app.coach_evening_messages "
                "(athlete_id,date,status,text,question,answer,answered_at,deleted_at,created_at) "
                "VALUES (?,?,?,'Demain ?','Disponible ?',?,?,?,?)",
                [
                    athlete,
                    day,
                    status,
                    "25 minutes" if answered else None,
                    ts(day, 20) if answered else None,
                    ts(day, 21) if deleted else None,
                    ts(day, 18),
                ],
            )
        # OLD's thread, started the day after the migration, last continued
        # on 8 September.
        con.execute(
            "INSERT INTO app.coach_conversations (id, athlete_id, title, created_at, updated_at) "
            "VALUES ('t1', ?, 'Fil', ?, ?)",
            [OLD, ts("2026-08-27", 8), ts("2026-09-08", 10)],
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


def _read() -> dict[date, dict[str, tuple]]:
    """The last eight weeks, as (numerator, denominator, value)."""
    weeks = product_kpis.weekly(8, now=NOW)
    assert [w.week_start for w in weeks][:2] == [THIS_WEEK, LAST_WEEK]
    assert weeks[-1].week_start == MIGRATION_WEEK
    assert [w.current for w in weeks] == [True] + [False] * 7
    return {
        w.week_start: {k: tuple(asdict(c).values()) for k, c in w.indicators.items()}
        for w in weeks
    }


@pytest.fixture
def kpis(populated) -> dict[date, dict[str, tuple]]:
    return _read()


def test_engagement_ratios_count_live_athletes_only(kpis):
    week = kpis[LAST_WEEK]
    # ANA and CYD seen, BEN reacted; BEN's closed login is no visit.
    assert week["active_accounts"] == (3, 5, 0.6)
    # The owner and NEW were seen this week.
    assert kpis[THIS_WEEK]["active_accounts"] == (2, 6, 0.3333)
    # BEN (two devices) and ANA; CYD's device left.
    assert week["push_subscribers"] == (2, 5, 0.4)
    assert kpis[COHORT_WEEK]["push_subscribers"] == (1, 4, 0.25)
    # ANA's activity of the 6th has its log; the 8th none, CYD's was deleted,
    # BEN's manual entry was never imported.
    assert week["strength_logged"] == (1, 3, 0.3333)
    # Four pushes, two answered; BEN answered without one.
    assert week["checkins_answered"] == (2, 4, 0.5)
    # Days with a briefing: ANA's (twice written, reacted), BEN's, CYD's.
    assert week["briefings_reacted"] == (2, 3, 0.6667)
    # ANA accepted, BEN did not; CYD's was never written.
    assert week["weekly_reviews_accepted"] == (1, 2, 0.5)
    # Written evenings only: exclude failure, erased message and closed athlete.
    assert week["evening_replies"] == (1, 2, 0.5)


def test_an_athlete_counts_only_once_it_exists(kpis):
    # NEW's check-in and device are stamped the week of the migration, before
    # NEW existed: the week counts the owner's and OLD's check-ins, not NEW's.
    assert kpis[MIGRATION_WEEK]["active_accounts"] == (2, 2, 1.0)
    assert kpis[MIGRATION_WEEK]["push_subscribers"] == (0, 2, 0.0)
    for week in kpis.values():
        for key in RATIOS:
            numerator, denominator, _ = week[key]
            assert numerator <= denominator, (week, key)


def test_cohort_indicators_count_sign_ups_only(kpis):
    # ANA after 6 h, BEN after 24 h.
    assert kpis[COHORT_WEEK]["first_action_hours"] == (2, 2, 15.0)
    # The migration created the owner's and OLD's athletes: no sign-up, though
    # OLD acted the next day and came back after 30 days.
    assert kpis[MIGRATION_WEEK]["first_action_hours"] == (0, 0, None)
    assert kpis[MIGRATION_WEEK]["retention_30d"] == (0, 0, None)
    # CYD has done nothing yet; NEW's action stamped before it existed is 0 h.
    assert kpis[LAST_WEEK]["first_action_hours"] == (0, 1, None)
    assert kpis[THIS_WEEK]["first_action_hours"] == (1, 1, 0.0)
    # ANA was seen after day 30; BEN only by a login since closed.
    assert kpis[COHORT_WEEK]["retention_30d"] == (1, 2, 0.5)
    # CYD's day 30 is still to come.
    assert kpis[LAST_WEEK]["retention_30d"] == (0, 0, None)


def test_a_quiet_week_still_counts_its_accounts_and_subscribers(kpis):
    week = kpis[date(2026, 9, 21)]
    assert week.pop("active_accounts") == (0, 4, 0.0)
    assert week.pop("push_subscribers") == (1, 4, 0.25)
    assert set(week.values()) == {(0, 0, None)}


def test_a_conversation_counts_at_its_latest_exchange(kpis):
    # OLD only continued its thread that week.
    assert kpis[date(2026, 9, 7)]["active_accounts"] == (1, 4, 0.25)


def test_the_owner_is_no_sign_up_whatever_its_creation_time(populated):
    """A restored or hand-made athlete 1 may be dated after the migrations."""
    con = connect()
    con.execute(
        "UPDATE app.athletes SET created_at = ? WHERE id = ?",
        [ts("2026-09-01", 12), OWNER],
    )
    con.close()
    # Counted, its check-in of 24 August would be a first action after 0 h.
    assert _read()[COHORT_WEEK]["first_action_hours"] == (2, 2, 15.0)


def test_subscribing_a_device_again_keeps_past_weeks(populated):
    with athlete_scope(BEN):
        notifications.subscribe("https://push/0", "k2", "a2")
    con = connect()
    stored = con.execute(
        "SELECT p256dh, created_at FROM app.push_subscriptions WHERE endpoint = ?",
        ["https://push/0"],
    ).fetchone()
    con.close()
    assert stored == ("k2", ts("2026-09-03", 8))
    week = _read()[COHORT_WEEK]
    assert week["push_subscribers"] == (1, 4, 0.25)
    assert week["first_action_hours"] == (2, 2, 15.0)


def test_the_indicators_read_one_snapshot(populated, monkeypatch):
    """A sign-up committed while the indicators are read waits for the next read."""
    opened = product_kpis.transaction

    @contextmanager
    def racing() -> Iterator[object]:
        with opened() as con:

            class Racing:
                def execute(self, sql: str, params: list) -> object:
                    result = con.execute(sql, params)
                    if sql is product_kpis.ACTIVE:
                        other = connect()
                        other.execute(
                            "INSERT INTO app.athletes (id, created_at) VALUES (8, ?)",
                            [ts("2026-10-13", 11)],
                        )
                        other.close()
                    return result

            yield Racing()

    monkeypatch.setattr(product_kpis, "transaction", racing)
    week = _read()[THIS_WEEK]
    assert week["active_accounts"] == (2, 6, 0.3333)
    assert week["first_action_hours"] == (1, 1, 0.0)
    # The next read sees the new sign-up.
    monkeypatch.setattr(product_kpis, "transaction", opened)
    assert _read()[THIS_WEEK]["first_action_hours"] == (1, 2, 0.0)


def test_the_current_week_is_read_in_utc(monkeypatch, tmp_path):
    """Sunday 23:30 UTC is already Monday in Paris: still Sunday's week."""
    monkeypatch.setenv("ARETE_DB", str(tmp_path / "utc.duckdb"))
    init_schema()
    sunday = datetime.fromisoformat("2026-10-18T23:30:00+00:00")
    monkeypatch.setattr(product_kpis, "utc_now", lambda: sunday)
    weeks = product_kpis.weekly(1)
    assert [(w.week_start, w.current) for w in weeks] == [(date(2026, 10, 12), True)]
