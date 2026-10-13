"""Capture activity evidence in the caller's transaction, without awarding XP."""

from datetime import UTC, date, datetime, timedelta
from zoneinfo import ZoneInfo

#: Appended to a strength event's reason when an automatic link found both the
#: log and its activity already counted: the projection keeps both rewards
#: instead of merging them. A manual link removes it.
KEPT_AT_LINK = "+kept_at_link"


def capture(
    con,
    key: str,
    day: date,
    name: str,
    valid: bool,
    *,
    started: datetime | None = None,
    manual: bool = True,
    canonical: str | None = None,
) -> None:
    profile = con.execute(
        "SELECT enabled FROM app.visible_game_profile WHERE id=1"
    ).fetchone()
    assert profile is not None
    settings = con.execute(
        "SELECT timezone, weekly_training_goal FROM app.visible_user_settings WHERE user_id = getvariable('arete_athlete_id')"
    ).fetchone()
    zone, goal = settings or ("Europe/Paris", 6)
    now = datetime.now(UTC)
    local_today = now.astimezone(ZoneInfo(zone)).date()
    week = day - timedelta(days=day.weekday())
    eligible = bool(profile[0] and valid and 0 <= (local_today - day).days <= 14)
    reason = "pending" if eligible else "disabled_or_invalid"
    # Date-only imports on a toggle day are ambiguous; manual logging today is explicit.
    if eligible:
        if started is not None:
            instant = (
                started if started.tzinfo else started.replace(tzinfo=ZoneInfo(zone))
            )
            allowed = con.execute(
                "SELECT count(*) FROM app.visible_game_periods WHERE started_at<=? AND (ended_at IS NULL OR ended_at>?)",
                [instant, instant],
            ).fetchone()[0]
        else:
            start = datetime.combine(day, datetime.min.time(), ZoneInfo(zone))
            end = start + timedelta(days=1)
            allowed = (manual and day == local_today) or con.execute(
                "SELECT count(*) FROM app.visible_game_periods WHERE started_at<=? AND (ended_at IS NULL OR ended_at>=?)",
                [start, end],
            ).fetchone()[0]
        if not allowed:
            eligible, reason = False, "outside_enabled_period"
    con.execute(
        "INSERT INTO app.game_events (source_key,canonical_key,activity_date,week_start,timezone,name,eligible,reason) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING",
        [
            key,
            canonical or key,
            day,
            week,
            zone,
            (name or "Séance")[:200],
            eligible,
            reason,
        ],
    )
    if eligible:
        con.execute(
            "INSERT INTO app.game_weeks (week_start,goal,timezone) VALUES (?,?,?) ON CONFLICT DO NOTHING",
            [week, goal, zone],
        )
