"""Weekly product indicators for administrators, aggregated across athletes.

A trusted read like the scheduler's dispatch: each indicator is one SQL over
the base ``app.*`` tables, counted inside the database, and only counts leave
it, never an athlete id or a row. The SQL repeats what the live projections
hide: soft-deleted rows and deactivated athletes do not count. Every read of
a private table is one of the ``TRUSTED_READS`` fragments, which
``tests/test_athlete_sql_contract.py`` allows by exact match.

Weeks are ISO weeks (Monday to Sunday). The current week is partial. A ratio's
numerator only counts athletes of its denominator: those created before the
week's end. The indicator queries read one snapshot.

Known limits. Stored times are compared as they are: naive UTC on Vercel,
where every writer runs in UTC, but a Docker host writes some columns in its
own zone, so instances on different clocks shift week edges and the sign-up
cutoff (``_SIGNUPS``) by the zone offset. The per-day indicators (strength,
check-ins, briefings, reviews) group by the athlete's local ``date``, while
active accounts, push subscribers and the cohorts group UTC timestamps.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta

from arete.dataio.db import transaction
from arete.services.settings import utc_now
from arete.services.users import OWNER_ATHLETE_ID

MAX_WEEKS = 52

#: Weeks asked for (Monday to the next Monday, as timestamps), the live
#: athletes and how many of them existed by each week's end. Parameters: the
#: first Monday, the Monday after the last week.
_WEEKS = (
    "weeks AS (SELECT CAST(t.w AS DATE) AS week_start, t.w AS starts, "
    "t.w + INTERVAL 7 DAY AS ends "
    "FROM range(CAST(? AS TIMESTAMP), CAST(? AS TIMESTAMP), INTERVAL 7 DAY) AS t(w)), "
    "live AS (SELECT id, created_at FROM app.athletes WHERE deleted_at IS NULL), "
    "accounts AS (SELECT w.week_start, count(l.id) AS n FROM weeks w "
    "LEFT JOIN live l ON l.created_at < w.ends GROUP BY w.week_start)"
)
#: Athletes that signed up. Migrations 35 and 36 created an athlete for every
#: owner that already existed (the owner's athlete 1 included) before they
#: were recorded: those creation times are the migration's, not a sign-up's.
_SIGNUPS = (
    "signups AS (SELECT l.id, l.created_at FROM live l "
    f"WHERE l.id <> {OWNER_ATHLETE_ID} AND l.created_at > ("
    "SELECT max(applied_at) FROM app.schema_version WHERE version IN (35, 36)))"
)
#: Each live login refreshes ``last_seen_at`` (hourly); an athlete may have several.
_SEEN = (
    "seen AS (SELECT athlete_id, max(last_seen_at) AS last_seen FROM app.users "
    "WHERE athlete_id IS NOT NULL AND deleted_at IS NULL GROUP BY athlete_id)"
)

# The private reads, each a whole constant (the contract test matches them).

#: What an athlete does, when: a check-in answered, a briefing reacted to, a
#: strength log, a weekly review accepted, an evening question answered, a
#: conversation with the coach started or continued (a thread keeps its
#: start and its latest exchange, not each one), a device subscribed to pushes.
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
    "UNION ALL SELECT athlete_id, CAST(updated_at AS TIMESTAMP) FROM app.coach_conversations "
    "WHERE deleted_at IS NULL "
    "UNION ALL SELECT athlete_id, created_at FROM app.push_subscriptions "
    "WHERE deleted_at IS NULL AND created_at IS NOT NULL)"
)
#: Subscriptions are deleted when a device leaves: a past week counts the
#: devices still subscribed today that were subscribed by its end.
_SUBSCRIPTIONS = (
    "subscriptions AS (SELECT athlete_id, created_at FROM app.push_subscriptions "
    "WHERE deleted_at IS NULL)"
)
#: Strength activities imported from the watch (Garmin, Strava, a file), and
#: whether a live strength log is linked to them.
_IMPORTED = (
    "imported AS (SELECT a.user_id AS athlete_id, a.date, "
    "EXISTS (SELECT 1 FROM app.strength_sessions s "
    "WHERE s.deleted_at IS NULL AND s.user_id = a.user_id "
    "AND s.actual_session_id = a.id) AS done "
    "FROM app.actual_sessions a "
    "WHERE a.deleted_at IS NULL AND a.sport = 'strength' AND a.source <> 'manual')"
)
#: Days whose check-in push was sent (``prompted_at``), and whether answered.
#: A check-in answered before its push is neither.
_PROMPTED = (
    "prompted AS (SELECT athlete_id, date, answered_at IS NOT NULL AS done "
    "FROM app.daily_checkins WHERE deleted_at IS NULL AND prompted_at IS NOT NULL)"
)
#: Days with a written briefing, and whether it got a reaction. No column
#: records a plain read: a reaction is the read the database knows.
_BRIEFED = (
    "briefed AS (SELECT user_id AS athlete_id, date, "
    "bool_or(reaction IS NOT NULL) AS done FROM app.coach_briefings "
    "WHERE deleted_at IS NULL AND status = 'ok' GROUP BY user_id, date)"
)
#: Reviews written for a week (offered on its Sunday), and whether accepted:
#: « Accepter » answers the review even when it applies no proposal.
_REVIEWED = (
    "reviewed AS (SELECT user_id AS athlete_id, week_start AS date, "
    "applied_at IS NOT NULL AS done FROM app.weekly_reviews "
    "WHERE deleted_at IS NULL AND source <> 'pending')"
)
_EVENINGS = (
    "evenings AS (SELECT athlete_id, date, answered_at IS NOT NULL AS done "
    "FROM app.coach_evening_messages WHERE deleted_at IS NULL AND status='ok')"
)
TRUSTED_READS = (
    _ACTIONS,
    _SUBSCRIPTIONS,
    _IMPORTED,
    _PROMPTED,
    _BRIEFED,
    _REVIEWED,
    _EVENINGS,
)

# Every query returns (week_start, numerator, denominator[, value]) per week.

#: An action in the week, or a last visit in it: ``last_seen_at`` keeps only
#: the latest visit, so a past week misses athletes seen then and since.
ACTIVE = (
    f"WITH {_WEEKS}, {_ACTIONS}, {_SEEN}, "
    "activity AS (SELECT athlete_id, happened_at FROM actions "
    "WHERE happened_at >= (SELECT min(starts) FROM weeks) "
    "UNION ALL SELECT athlete_id, last_seen FROM seen "
    "WHERE last_seen >= (SELECT min(starts) FROM weeks)), "
    "counted AS (SELECT w.week_start, count(DISTINCT l.id) AS n FROM weeks w "
    "LEFT JOIN activity x ON x.happened_at >= w.starts AND x.happened_at < w.ends "
    "LEFT JOIN live l ON l.id = x.athlete_id AND l.created_at < w.ends "
    "GROUP BY w.week_start) "
    "SELECT c.week_start, c.n, a.n FROM counted c JOIN accounts a USING (week_start) "
    "ORDER BY c.week_start"
)
PUSH = (
    f"WITH {_WEEKS}, {_SUBSCRIPTIONS}, "
    "counted AS (SELECT w.week_start, count(DISTINCT l.id) AS n FROM weeks w "
    "LEFT JOIN subscriptions p ON p.created_at < w.ends "
    "LEFT JOIN live l ON l.id = p.athlete_id AND l.created_at < w.ends "
    "GROUP BY w.week_start) "
    "SELECT c.week_start, c.n, a.n FROM counted c JOIN accounts a USING (week_start) "
    "ORDER BY c.week_start"
)


def _per_day(rows: str, name: str) -> str:
    """Rows (athlete_id, date, done) of live athletes, done ones over all, per week."""
    return (
        f"WITH {_WEEKS}, {rows}, "
        f"days AS (SELECT r.date, r.done FROM {name} r JOIN live l ON l.id = r.athlete_id) "
        "SELECT w.week_start, count(d.date) FILTER (WHERE d.done), count(d.date) "
        "FROM weeks w LEFT JOIN days d "
        "ON d.date >= w.week_start AND d.date < w.week_start + 7 "
        "GROUP BY w.week_start ORDER BY w.week_start"
    )


STRENGTH = _per_day(_IMPORTED, "imported")
CHECKINS = _per_day(_PROMPTED, "prompted")
BRIEFINGS = _per_day(_BRIEFED, "briefed")
#: A review's date is the Monday of the week it reviews.
REVIEWS = _per_day(_REVIEWED, "reviewed")
#: Sign-ups of the week, those with an action since, and the median hours to
#: the first one (an action stamped before the sign-up, a clock skew, is 0).
FIRST_ACTION = (
    f"WITH {_WEEKS}, {_SIGNUPS}, {_ACTIONS}, firsts AS ("
    "SELECT s.id, s.created_at, min(x.happened_at) AS first_at FROM signups s "
    "LEFT JOIN actions x ON x.athlete_id = s.id "
    "WHERE s.created_at >= (SELECT min(starts) FROM weeks) "
    "GROUP BY s.id, s.created_at) "
    "SELECT w.week_start, count(f.first_at), count(f.id), "
    "median(CASE WHEN f.first_at IS NOT NULL "
    "THEN greatest(epoch(f.first_at) - epoch(f.created_at), 0) / 3600.0 END) "
    "FROM weeks w LEFT JOIN firsts f "
    "ON f.created_at >= w.starts AND f.created_at < w.ends "
    "GROUP BY w.week_start ORDER BY w.week_start"
)
#: Sign-ups of the week at least 30 days ago, and those seen again 30 days or
#: more after signing up. Parameter: now.
RETENTION = (
    f"WITH {_WEEKS}, {_SIGNUPS}, {_SEEN} "
    "SELECT w.week_start, "
    "count(s.id) FILTER (WHERE v.last_seen >= s.created_at + INTERVAL 30 DAY), "
    "count(s.id) "
    "FROM weeks w LEFT JOIN signups s "
    "ON s.created_at >= w.starts AND s.created_at < w.ends "
    "AND s.created_at + INTERVAL 30 DAY <= CAST(? AS TIMESTAMP) "
    "LEFT JOIN seen v ON v.athlete_id = s.id "
    "GROUP BY w.week_start ORDER BY w.week_start"
)

#: (indicator, query, whether it takes ``now`` after the week bounds), in
#: display order. ``first_action_hours`` is a median in hours; every other
#: value is numerator / denominator.
QUERIES = (
    ("active_accounts", ACTIVE, False),
    ("push_subscribers", PUSH, False),
    ("strength_logged", STRENGTH, False),
    ("checkins_answered", CHECKINS, False),
    ("briefings_reacted", BRIEFINGS, False),
    ("weekly_reviews_accepted", REVIEWS, False),
    ("first_action_hours", FIRST_ACTION, False),
    ("retention_30d", RETENTION, True),
    ("evening_replies", _per_day(_EVENINGS, "evenings"), False),
)


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
    """The last ``weeks`` ISO weeks, the current one first; ``now`` is naive UTC."""
    assert 1 <= weeks <= MAX_WEEKS, f"weeks out of range: {weeks}"
    now = now or utc_now().replace(tzinfo=None)
    monday = now.date() - timedelta(days=now.weekday())
    bounds = [monday - timedelta(weeks=weeks - 1), monday + timedelta(weeks=1)]
    cells: dict[str, dict[date, Cell]] = {}
    # One transaction: every indicator reads the same snapshot.
    with transaction() as con:
        for key, sql, needs_now in QUERIES:
            rows = con.execute(sql, [*bounds, now] if needs_now else bounds).fetchall()
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
