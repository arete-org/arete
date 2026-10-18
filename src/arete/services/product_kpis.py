"""Weekly product indicators for administrators, aggregated across athletes.

A trusted read like the scheduler's dispatch: each indicator is one SQL over
the base ``app.*`` tables, counted inside the database, and only counts leave
it, never an athlete id or a row. The SQL repeats what the live projections
hide: soft-deleted rows and deactivated athletes do not count.
``tests/test_athlete_sql_contract.py`` allows here only SQL that is part of
``TRUSTED_READS``.

Weeks are ISO weeks (Monday to Sunday). The current week is partial. Stored
times are compared as they are: naive UTC on Vercel, where every writer runs
in UTC; a Docker host writes some columns in its own zone (hours, at most).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta

from arete.dataio.db import db_connection

MAX_WEEKS = 52
#: The owner's athlete predates sign-ups: its creation date is a migration's.
OWNER_ATHLETE_ID = 1

#: Weeks asked for (Monday to the next Monday, as timestamps) and the live
#: athletes. Parameters: the first Monday, the Monday after the last week.
_WEEKS = (
    "weeks AS (SELECT CAST(t.w AS DATE) AS week_start, t.w AS starts, "
    "t.w + INTERVAL 7 DAY AS ends "
    "FROM range(CAST(? AS TIMESTAMP), CAST(? AS TIMESTAMP), INTERVAL 7 DAY) AS t(w)), "
    "live AS (SELECT id, created_at FROM app.athletes WHERE deleted_at IS NULL)"
)
#: What an athlete does, when: a check-in answered, a briefing reacted to, a
#: strength log, a weekly review accepted, an evening question answered, a
#: conversation with the coach, a device subscribed to pushes.
_ACTIONS = (
    "actions AS ("
    "SELECT athlete_id, answered_at AS happened_at FROM app.daily_checkins "
    "WHERE deleted_at IS NULL AND answered_at IS NOT NULL "
    "UNION ALL SELECT user_id, reacted_at FROM app.coach_briefings "
    "WHERE deleted_at IS NULL AND reacted_at IS NOT NULL "
    "UNION ALL SELECT user_id, created_at FROM app.strength_sessions "
    "WHERE deleted_at IS NULL AND created_at IS NOT NULL "
    "UNION ALL SELECT user_id, applied_at FROM app.weekly_reviews "
    "WHERE deleted_at IS NULL AND applied_at IS NOT NULL "
    "UNION ALL SELECT athlete_id, answered_at FROM app.coach_evening_messages "
    "WHERE deleted_at IS NULL AND answered_at IS NOT NULL "
    "UNION ALL SELECT athlete_id, CAST(created_at AS TIMESTAMP) FROM app.coach_conversations "
    "WHERE deleted_at IS NULL "
    "UNION ALL SELECT athlete_id, created_at FROM app.push_subscriptions "
    "WHERE deleted_at IS NULL AND created_at IS NOT NULL)"
)
#: Each login refreshes ``last_seen_at`` (hourly); an athlete may have several.
_SEEN = (
    "seen AS (SELECT athlete_id, max(last_seen_at) AS last_seen FROM app.users "
    "WHERE athlete_id IS NOT NULL GROUP BY athlete_id)"
)
_ACCOUNTS = "(SELECT count(*) FROM live l WHERE l.created_at < w.ends)"

# Every query returns (week_start, numerator, denominator[, value]) per week.

#: An action in the week, or a last visit in it: ``last_seen_at`` keeps only
#: the latest visit, so a past week misses athletes seen then and since.
ACTIVE = (
    f"WITH {_WEEKS}, {_ACTIONS}, {_SEEN}, "
    "activity AS (SELECT athlete_id, happened_at FROM actions "
    "UNION ALL SELECT athlete_id, last_seen FROM seen) "
    "SELECT w.week_start, "
    "(SELECT count(DISTINCT x.athlete_id) FROM activity x JOIN live l ON l.id = x.athlete_id "
    "WHERE x.happened_at >= w.starts AND x.happened_at < w.ends), "
    f"{_ACCOUNTS} FROM weeks w ORDER BY w.week_start"
)
#: Subscriptions are deleted when a device leaves: a past week counts the
#: devices still subscribed today that were subscribed by its end.
PUSH = (
    f"WITH {_WEEKS} SELECT w.week_start, "
    "(SELECT count(DISTINCT p.athlete_id) FROM app.push_subscriptions p "
    "JOIN live l ON l.id = p.athlete_id "
    "WHERE p.deleted_at IS NULL AND p.created_at < w.ends), "
    f"{_ACCOUNTS} FROM weeks w ORDER BY w.week_start"
)
#: Strength activities imported from the watch (Garmin, Strava, a file) in
#: the week, and those whose strength log was completed and linked to them.
STRENGTH = (
    f"WITH {_WEEKS}, imported AS ("
    "SELECT a.date, EXISTS (SELECT 1 FROM app.strength_sessions s "
    "WHERE s.deleted_at IS NULL AND s.user_id = a.user_id "
    "AND s.actual_session_id = a.id) AS logged "
    "FROM app.actual_sessions a JOIN live l ON l.id = a.user_id "
    "WHERE a.deleted_at IS NULL AND a.sport = 'strength' AND a.source <> 'manual') "
    "SELECT w.week_start, count(i.date) FILTER (WHERE i.logged), count(i.date) "
    "FROM weeks w LEFT JOIN imported i "
    "ON i.date >= w.week_start AND i.date < w.week_start + 7 "
    "GROUP BY w.week_start ORDER BY w.week_start"
)
#: Days whose check-in push was sent (``prompted_at``), and those answered.
#: A check-in answered before its push is neither.
CHECKINS = (
    f"WITH {_WEEKS}, sent AS ("
    "SELECT c.date, c.answered_at IS NOT NULL AS answered FROM app.daily_checkins c "
    "JOIN live l ON l.id = c.athlete_id "
    "WHERE c.deleted_at IS NULL AND c.prompted_at IS NOT NULL) "
    "SELECT w.week_start, count(s.date) FILTER (WHERE s.answered), count(s.date) "
    "FROM weeks w LEFT JOIN sent s "
    "ON s.date >= w.week_start AND s.date < w.week_start + 7 "
    "GROUP BY w.week_start ORDER BY w.week_start"
)
#: Days with a written briefing, and those whose briefing got a reaction. No
#: column records a plain read: a reaction is the read the database knows.
BRIEFINGS = (
    f"WITH {_WEEKS}, days AS ("
    "SELECT b.date, bool_or(b.reaction IS NOT NULL) AS reacted "
    "FROM app.coach_briefings b JOIN live l ON l.id = b.user_id "
    "WHERE b.deleted_at IS NULL AND b.status = 'ok' GROUP BY b.user_id, b.date) "
    "SELECT w.week_start, count(d.date) FILTER (WHERE d.reacted), count(d.date) "
    "FROM weeks w LEFT JOIN days d "
    "ON d.date >= w.week_start AND d.date < w.week_start + 7 "
    "GROUP BY w.week_start ORDER BY w.week_start"
)
#: Reviews written for the week (offered on its Sunday), and those accepted:
#: « Accepter » answers the review even when it applies no proposal.
REVIEWS = (
    f"WITH {_WEEKS}, written AS ("
    "SELECT r.week_start, r.applied_at IS NOT NULL AS accepted "
    "FROM app.weekly_reviews r JOIN live l ON l.id = r.user_id "
    "WHERE r.deleted_at IS NULL AND r.source <> 'pending') "
    "SELECT w.week_start, count(r.week_start) FILTER (WHERE r.accepted), "
    "count(r.week_start) FROM weeks w LEFT JOIN written r "
    "ON r.week_start = w.week_start "
    "GROUP BY w.week_start ORDER BY w.week_start"
)
#: Accounts created in the week, those with an action since, and the median
#: hours from creation to the first one (a clock skew counts as 0).
FIRST_ACTION = (
    f"WITH {_WEEKS}, {_ACTIONS}, firsts AS ("
    "SELECT l.id, l.created_at, min(x.happened_at) AS first_at FROM live l "
    "LEFT JOIN actions x ON x.athlete_id = l.id "
    f"WHERE l.id <> {OWNER_ATHLETE_ID} GROUP BY l.id, l.created_at) "
    "SELECT w.week_start, count(f.first_at), count(f.id), "
    "median(CASE WHEN f.first_at IS NOT NULL "
    "THEN greatest(epoch(f.first_at) - epoch(f.created_at), 0) / 3600.0 END) "
    "FROM weeks w LEFT JOIN firsts f "
    "ON f.created_at >= w.starts AND f.created_at < w.ends "
    "GROUP BY w.week_start ORDER BY w.week_start"
)
#: Accounts created in the week at least 30 days ago, and those seen again
#: 30 days or more after their creation. Parameter: now.
RETENTION = (
    f"WITH {_WEEKS}, {_SEEN} "
    "SELECT w.week_start, "
    "count(l.id) FILTER (WHERE s.last_seen >= l.created_at + INTERVAL 30 DAY), count(l.id) "
    f"FROM weeks w LEFT JOIN live l ON l.id <> {OWNER_ATHLETE_ID} "
    "AND l.created_at >= w.starts AND l.created_at < w.ends "
    "AND l.created_at + INTERVAL 30 DAY <= CAST(? AS TIMESTAMP) "
    "LEFT JOIN seen s ON s.athlete_id = l.id "
    "GROUP BY w.week_start ORDER BY w.week_start"
)

#: Indicator → its query, in display order. ``first_action_hours`` is a
#: median in hours; every other value is numerator / denominator.
QUERIES = {
    "active_accounts": ACTIVE,
    "push_subscribers": PUSH,
    "strength_logged": STRENGTH,
    "checkins_answered": CHECKINS,
    "briefings_reacted": BRIEFINGS,
    "weekly_reviews_accepted": REVIEWS,
    "first_action_hours": FIRST_ACTION,
    "retention_30d": RETENTION,
}
TRUSTED_READS = tuple(QUERIES.values())


@dataclass(frozen=True)
class Cell:
    numerator: int
    denominator: int
    value: float | None


@dataclass(frozen=True)
class WeekKpis:
    week_start: date
    current: bool
    indicators: dict[str, Cell]


def weekly(weeks: int, *, now: datetime | None = None) -> list[WeekKpis]:
    """The last ``weeks`` ISO weeks, the current one first."""
    assert 1 <= weeks <= MAX_WEEKS, f"weeks out of range: {weeks}"
    # Naive and local, like the account times the queries compare it with.
    now = now or datetime.now()
    monday = now.date() - timedelta(days=now.weekday())
    bounds = [monday - timedelta(weeks=weeks - 1), monday + timedelta(weeks=1)]
    cells: dict[str, dict[date, Cell]] = {}
    with db_connection() as con:
        for key, sql in QUERIES.items():
            params = [*bounds, now] if sql is RETENTION else bounds
            rows = con.execute(sql, params).fetchall()
            cells[key] = {row[0]: _cell(row) for row in rows}
    return [
        WeekKpis(
            week_start=week,
            current=week == monday,
            indicators={key: by_week[week] for key, by_week in cells.items()},
        )
        for week in (monday - timedelta(weeks=n) for n in range(weeks))
    ]


def _cell(row: tuple) -> Cell:
    """(week, numerator, denominator) and, for a median, its value."""
    numerator, denominator = int(row[1]), int(row[2])
    if len(row) > 3:
        value = None if row[3] is None else round(float(row[3]), 1)
    else:
        value = round(numerator / denominator, 4) if denominator else None
    return Cell(numerator=numerator, denominator=denominator, value=value)
