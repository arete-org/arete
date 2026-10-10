"""The threshold Garmin measured, kept in sync with the settings.

Garmin retests the running lactate threshold on its own; the watch is the
source of truth. A newer measurement replaces the stored one, and from then on
new sessions are read against it. Sessions already synced keep the zones they
were given: they were correct for the threshold in force that day.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date, datetime
from typing import Any

from arete.dataio.settings import get_user_settings, upsert_user_settings
from arete.services.athlete_scope import resolve_athlete_id

logger = logging.getLogger(__name__)

# latestLactateThreshold reports speed in metres per second divided by ten.
GARMIN_SPEED_FACTOR = 10.0
MIN_PACE_SEC_KM = 120
MAX_PACE_SEC_KM = 900


@dataclass(frozen=True)
class ThresholdReading:
    """What Garmin last measured, in the units the app stores."""

    heart_rate: int | None
    pace_sec_km: int | None
    measured_on: date | None


def parse_threshold(payload: dict[str, Any] | None) -> ThresholdReading | None:
    """Read Garmin's ``speed_and_heart_rate`` block; None when it says nothing."""
    if not payload:
        return None
    heart_rate = _positive_int(payload.get("heartRate"))
    pace = _pace_from_speed(payload.get("speed"))
    measured_on = _as_date(payload.get("calendarDate"))
    if heart_rate is None and pace is None:
        return None
    return ThresholdReading(heart_rate, pace, measured_on)


def refresh_threshold(client: Any, user_id: int | None = None) -> dict[str, Any]:
    """Store Garmin's threshold when it is newer than the one on file.

    Returns what happened, so a sync can log it and the UI can show it.
    """
    user_id = resolve_athlete_id(user_id)
    settings = get_user_settings(user_id) or {}
    stored_on = _as_date(settings.get("lthr_measured_on"))
    stored_hr = settings.get("lthr")

    try:
        reading = parse_threshold(client.lactate_threshold())
    except Exception as exc:  # a threshold is a bonus, never a reason to fail a sync
        logger.warning("Could not read the Garmin threshold: %s", exc)
        return {"updated": False, "reason": "unavailable"}

    if reading is None:
        return {"updated": False, "reason": "not_measured"}

    same_value = reading.heart_rate == stored_hr and (
        reading.pace_sec_km == settings.get("threshold_pace_sec_km")
    )
    if (
        stored_on is not None
        and reading.measured_on is not None
        and reading.measured_on < stored_on
    ):
        return {
            "updated": False,
            "reason": "older",
            "lthr": stored_hr,
            "measured_on": stored_on.isoformat(),
        }
    if same_value and reading.measured_on == stored_on:
        return {
            "updated": False,
            "reason": "unchanged",
            "lthr": stored_hr,
            "measured_on": stored_on.isoformat() if stored_on else None,
        }

    payload = {k: v for k, v in settings.items() if k != "user_id"}
    payload.update(
        lthr=reading.heart_rate or stored_hr,
        threshold_pace_sec_km=reading.pace_sec_km
        or settings.get("threshold_pace_sec_km"),
        lthr_measured_on=reading.measured_on,
    )
    upsert_user_settings(user_id, **payload)
    # The values are health data: the logs only record that they changed.
    logger.info("Threshold updated from Garmin, measured %s", reading.measured_on)
    return {
        # The values already matched: only the test date was missing.
        "updated": not same_value,
        "reason": "dated" if same_value else "new_measurement",
        "lthr": reading.heart_rate,
        "previous_lthr": stored_hr,
        "threshold_pace_sec_km": reading.pace_sec_km,
        "measured_on": reading.measured_on.isoformat() if reading.measured_on else None,
    }


def _positive_int(value: Any) -> int | None:
    try:
        number = int(round(float(value)))
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


def _pace_from_speed(speed: Any) -> int | None:
    """Garmin's tenth-of-a-metre-per-second into seconds per kilometre."""
    try:
        mps = float(speed) * GARMIN_SPEED_FACTOR
    except (TypeError, ValueError):
        return None
    if mps <= 0:
        return None
    pace = int(round(1000 / mps))
    return pace if MIN_PACE_SEC_KM <= pace <= MAX_PACE_SEC_KM else None


def _as_date(value: Any) -> date | None:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if isinstance(value, str) and value:
        try:
            return datetime.fromisoformat(value).date()
        except ValueError:
            return None
    return None
