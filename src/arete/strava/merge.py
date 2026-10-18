"""Linking a Strava copy of a workout to the Garmin session (Garmin wins).

Strava's API agreement (1 June 2026) forbids its data in the development or
operation of an AI application, and every Garmin row can reach the coach: no
Strava value is copied onto a Garmin row, only the link (ARE-126).
"""

from __future__ import annotations

from typing import Any

from arete.garmin.models import ActualSession

#: Fields only Strava fills: cleared when Garmin takes a Strava row over.
STRAVA_ONLY_FIELDS = (
    "suffer_score",
    "best_efforts_json",
    "splits_json",
    "avg_watts",
    "weighted_avg_watts",
    "workout_type",
)


def strava_extras(existing: ActualSession, strava: ActualSession) -> dict[str, Any]:
    """Columns to update on ``existing`` for its Strava copy: the link only."""
    return {"strava_activity_id": strava.garmin_activity_id}


def garmin_takeover(garmin: ActualSession) -> dict[str, Any]:
    """Columns to write on a Strava-created row when the Garmin copy arrives.

    The row becomes a Garmin row the coach reads: Strava-only values go.
    """
    fields: dict[str, Any] = {
        "source": garmin.source.value,
        "garmin_activity_id": garmin.garmin_activity_id,
        **dict.fromkeys(STRAVA_ONLY_FIELDS),
    }
    for col in (
        "session_type",
        "source_file",
        "hr_zones_json",
        "laps_json",
        "avg_cadence",
        "max_cadence",
        "descent_m",
        "name",
    ):
        value = getattr(garmin, col)
        if value not in (None, ""):
            fields[col] = value
    return fields
