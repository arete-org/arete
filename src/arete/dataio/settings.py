"""User settings persistence (app.user_settings)."""

from __future__ import annotations

from datetime import date
from typing import Any

import duckdb

from arete.dataio.db import connect
from arete.features.hr_zones import ZoneModel
from arete.services.athlete_scope import resolve_athlete_id


# ---------- User Settings ----------
def _settings_from_row(row: tuple[Any, ...]) -> dict[str, Any]:
    import json as _json

    abbrev_raw = row[10] if len(row) > 10 else "{}"
    try:
        abbreviations = _json.loads(abbrev_raw) if abbrev_raw else {}
    except (ValueError, TypeError):
        abbreviations = {}

    return {
        "user_id": row[0],
        "display_name": row[1],
        "email": row[2],
        "timezone": row[3],
        "weekly_training_goal": row[4],
        "rest_day_preference": row[5].split(",") if row[5] else [],
        "fatigue_threshold": row[6],
        "fitness_goal": row[7],
        "notifications_enabled": row[8],
        "theme": row[9],
        "exercise_abbreviations": abbreviations,
        "weekly_volume_target_kg": row[11] if len(row) > 11 else 20000,
        "lthr": row[12] if len(row) > 12 else None,
        "max_hr": row[13] if len(row) > 13 else None,
        "threshold_pace_sec_km": row[14] if len(row) > 14 else None,
        "lthr_measured_on": row[15] if len(row) > 15 else None,
        # Appended last: the column arrives with migration 8, so a row read
        # from a database that has not migrated yet is simply shorter.
        "coach_briefing_enabled": row[16] if len(row) > 16 else True,
        # Migration 11: the morning adaptation and its Garmin push.
        "auto_adapt_enabled": row[17] if len(row) > 17 else False,
        "push_to_garmin_enabled": row[18] if len(row) > 18 else False,
        # Migration 45: per-kind choices and quiet hours, JSON; None = defaults.
        "notification_preferences": _json_or_none(row[19] if len(row) > 19 else None),
        # Migration 52: the coach's evening message (ARE-64), off by default.
        "coach_evening_enabled": bool(row[20]) if len(row) > 20 else False,
        "coach_evening_hour": (row[21] if len(row) > 21 else None) or 20,
        # Migration 67: what a triathlon plan targets (ARE-208), unset by default.
        "ftp_w": row[22] if len(row) > 22 else None,
        "css_sec_100m": row[23] if len(row) > 23 else None,
    }


def _json_or_none(raw: Any) -> dict[str, Any] | None:
    import json as _json

    if not raw:
        return None
    try:
        value = _json.loads(raw)
    except (ValueError, TypeError):
        return None
    return value if isinstance(value, dict) else None


def get_user_settings(
    user_id: int | None = None, con: duckdb.DuckDBPyConnection | None = None
) -> dict[str, Any] | None:
    """Get user settings by user_id, on ``con`` when the caller holds one."""
    user_id = resolve_athlete_id(user_id)
    own = con is None
    con = con or connect()
    try:
        row = con.execute(
            """
            SELECT user_id, display_name, email, timezone, weekly_training_goal,
                   rest_day_preference, fatigue_threshold, fitness_goal,
                   notifications_enabled, theme, exercise_abbreviations,
                   weekly_volume_target_kg, lthr, max_hr, threshold_pace_sec_km,
                   lthr_measured_on, coach_briefing_enabled,
                   auto_adapt_enabled, push_to_garmin_enabled,
                   notification_preferences, coach_evening_enabled,
                   coach_evening_hour, ftp_w, css_sec_100m
            FROM app.visible_user_settings
            WHERE user_id = ?
            """,
            [user_id],
        ).fetchone()
        return _settings_from_row(row) if row else None
    finally:
        if own:
            con.close()


def upsert_user_settings(
    user_id: int | None = None,
    *,
    display_name: str,
    email: str | None,
    timezone: str,
    weekly_training_goal: int,
    rest_day_preference: list[str],
    fatigue_threshold: int,
    fitness_goal: str,
    notifications_enabled: bool,
    theme: str,
    exercise_abbreviations: dict[str, str] | None = None,
    weekly_volume_target_kg: int = 20000,
    lthr: int | None = None,
    max_hr: int | None = None,
    threshold_pace_sec_km: int | None = None,
    lthr_measured_on: date | None = None,
    coach_briefing_enabled: bool = True,
    auto_adapt_enabled: bool = False,
    push_to_garmin_enabled: bool = False,
    notification_preferences: str | None = None,
    coach_evening_enabled: bool | None = None,
    coach_evening_hour: int | None = None,
    ftp_w: int | None = None,
    css_sec_100m: int | None = None,
) -> dict[str, Any]:
    """Create or update user settings.

    ``notification_preferences`` is JSON; None keeps the stored choice (an
    older client that does not send it must not reset it), and so does None
    for the evening message's two settings. ``ftp_w`` and ``css_sec_100m``
    are written as given, None clearing them: the caller passes the stored
    value to keep it.
    """
    user_id = resolve_athlete_id(user_id)
    import json as _json

    con = connect(False)
    rest_days_str = ",".join(rest_day_preference) if rest_day_preference else ""
    abbrev_json = _json.dumps(exercise_abbreviations or {}, ensure_ascii=False)
    try:
        # Try update first
        row = con.execute(
            """
            UPDATE app.user_settings
            SET display_name = ?, email = ?, timezone = ?, weekly_training_goal = ?,
                rest_day_preference = ?, fatigue_threshold = ?, fitness_goal = ?,
                notifications_enabled = ?, theme = ?, exercise_abbreviations = ?,
                weekly_volume_target_kg = ?, lthr = ?, max_hr = ?,
                threshold_pace_sec_km = ?, lthr_measured_on = ?,
                coach_briefing_enabled = ?, auto_adapt_enabled = ?,
                push_to_garmin_enabled = ?,
                notification_preferences = COALESCE(?, notification_preferences),
                coach_evening_enabled = COALESCE(?, coach_evening_enabled),
                coach_evening_hour = COALESCE(?, coach_evening_hour),
                ftp_w = ?, css_sec_100m = ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE user_id = getvariable('arete_athlete_id') AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM app.athletes scope_owner WHERE scope_owner.id=user_id AND scope_owner.deleted_at IS NULL) AND (user_id = ?) RETURNING user_id, display_name, email, timezone, weekly_training_goal,
                      rest_day_preference, fatigue_threshold, fitness_goal,
                      notifications_enabled, theme, exercise_abbreviations,
                      weekly_volume_target_kg, lthr, max_hr, threshold_pace_sec_km,
                      lthr_measured_on, coach_briefing_enabled,
                   auto_adapt_enabled, push_to_garmin_enabled,
                   notification_preferences, coach_evening_enabled,
                   coach_evening_hour, ftp_w, css_sec_100m
            """,
            [
                display_name,
                email,
                timezone,
                weekly_training_goal,
                rest_days_str,
                fatigue_threshold,
                fitness_goal,
                notifications_enabled,
                theme,
                abbrev_json,
                weekly_volume_target_kg,
                lthr,
                max_hr,
                threshold_pace_sec_km,
                lthr_measured_on,
                coach_briefing_enabled,
                auto_adapt_enabled,
                push_to_garmin_enabled,
                notification_preferences,
                coach_evening_enabled,
                coach_evening_hour,
                ftp_w,
                css_sec_100m,
                user_id,
            ],
        ).fetchone()

        if row:
            return _settings_from_row(row)

        # Insert if not exists
        row = con.execute(
            """
            INSERT INTO app.user_settings (
                user_id, display_name, email, timezone, weekly_training_goal,
                rest_day_preference, fatigue_threshold, fitness_goal,
                notifications_enabled, theme, exercise_abbreviations,
                weekly_volume_target_kg, lthr, max_hr, threshold_pace_sec_km,
                lthr_measured_on, coach_briefing_enabled,
                   auto_adapt_enabled, push_to_garmin_enabled,
                   notification_preferences, coach_evening_enabled,
                   coach_evening_hour, ftp_w, css_sec_100m
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            RETURNING user_id, display_name, email, timezone, weekly_training_goal,
                      rest_day_preference, fatigue_threshold, fitness_goal,
                      notifications_enabled, theme, exercise_abbreviations,
                      weekly_volume_target_kg, lthr, max_hr, threshold_pace_sec_km,
                      lthr_measured_on, coach_briefing_enabled,
                   auto_adapt_enabled, push_to_garmin_enabled,
                   notification_preferences, coach_evening_enabled,
                   coach_evening_hour, ftp_w, css_sec_100m
            """,
            [
                user_id,
                display_name,
                email,
                timezone,
                weekly_training_goal,
                rest_days_str,
                fatigue_threshold,
                fitness_goal,
                notifications_enabled,
                theme,
                abbrev_json,
                weekly_volume_target_kg,
                lthr,
                max_hr,
                threshold_pace_sec_km,
                lthr_measured_on,
                coach_briefing_enabled,
                auto_adapt_enabled,
                push_to_garmin_enabled,
                notification_preferences,
                bool(coach_evening_enabled),
                coach_evening_hour or 20,
                ftp_w,
                css_sec_100m,
            ],
        ).fetchone()
        if row is None:
            raise RuntimeError("Failed to insert user settings")
        return _settings_from_row(row)
    finally:
        con.close()


def athlete_zone_model(user_id: int | None = None) -> ZoneModel:
    """Zone model from the stored threshold, or max HR, or the generic default."""
    user_id = resolve_athlete_id(user_id)
    settings = get_user_settings(user_id) or {}
    return ZoneModel.from_reference(
        lthr=settings.get("lthr"), max_hr=settings.get("max_hr")
    )
