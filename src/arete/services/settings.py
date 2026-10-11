"""Athlete settings and shared validation, independent of HTTP."""

import json
import logging
from datetime import UTC, date, datetime, time
from typing import Literal, get_args
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, Field, ValidationError, field_validator

from arete.dataio import settings as repo
from arete.services.athlete_scope import resolve_athlete_id

logger = logging.getLogger(__name__)

DEFAULT_TIMEZONE = "Europe/Paris"


# ---------- The athlete's day ----------
def utc_now() -> datetime:
    """The current instant, timezone-aware. Tests freeze time here."""
    return datetime.now(UTC)


def zone_of(name: str | None) -> ZoneInfo:
    """A stored timezone name; the default for an empty or unknown one."""
    try:
        return ZoneInfo(name or DEFAULT_TIMEZONE)
    except (ZoneInfoNotFoundError, ValueError):
        # The settings form validates the zone; only a hand-edited row lands here.
        logger.warning("Unknown timezone %r, using %s", name, DEFAULT_TIMEZONE)
        return ZoneInfo(DEFAULT_TIMEZONE)


def athlete_now() -> datetime:
    """Now on the scoped athlete's clock (their configured timezone).

    The server runs on UTC (Vercel): its own date is the athlete's yesterday
    for a few hours after their midnight. Whatever means "the athlete's day"
    (plan, briefing, review week, metric windows) reads this instead.
    """
    return utc_now().astimezone(
        zone_of((repo.get_user_settings() or {}).get("timezone"))
    )


def athlete_today() -> date:
    """The scoped athlete's calendar date."""
    return athlete_now().date()


def today_in(zone: str | None) -> date:
    """The calendar date in a timezone already read with the settings."""
    return utc_now().astimezone(zone_of(zone)).date()


# ---------- Notification preferences ----------
#: Every push the server sends names one of these. The last three are planned
#: (UX 2): their choice is stored now so the athlete sets it once.
NotificationKind = Literal[
    "briefing",
    "post_session",
    "weekly_review",
    "adapted_session",
    "imports",
    "checkin",
    "evening",
    "eve_reminder",
]
NOTIFICATION_KINDS: tuple[NotificationKind, ...] = get_args(NotificationKind)
_CLOCK = r"^([01][0-9]|2[0-3]):[0-5][0-9]$"


class QuietHours(BaseModel):
    """Local hours without pushes; may span midnight. Equal bounds mean none."""

    start: str = Field(default="21:30", pattern=_CLOCK)
    end: str = Field(default="07:00", pattern=_CLOCK)

    def covers(self, moment: time) -> bool:
        start, end = time.fromisoformat(self.start), time.fromisoformat(self.end)
        if start == end:
            return False
        if start < end:
            return start <= moment < end
        return moment >= start or moment < end


class NotificationPreferences(BaseModel):
    """Which pushes the athlete gets. A kind absent from ``kinds`` is on."""

    kinds: dict[NotificationKind, bool] = {}
    quiet_hours: QuietHours | None = Field(default_factory=QuietHours)

    def allows(self, kind: NotificationKind) -> bool:
        return self.kinds.get(kind, True)

    def complete(self) -> "NotificationPreferences":
        """Every kind spelled out, for the settings form."""
        kinds = {kind: self.allows(kind) for kind in NOTIFICATION_KINDS}
        return self.model_copy(update={"kinds": kinds})


def stored_preferences(raw: dict | None) -> NotificationPreferences:
    """The stored JSON, defaults when absent; a kind no longer known is ignored."""
    if not raw:
        return NotificationPreferences()
    stored = raw.get("kinds")
    kinds: dict = stored if isinstance(stored, dict) else {}
    cleaned = {
        **raw,
        "kinds": {k: v for k, v in kinds.items() if k in NOTIFICATION_KINDS},
    }
    try:
        return NotificationPreferences.model_validate(cleaned)
    except ValidationError:
        logger.warning("Unreadable notification preferences, using the defaults")
        return NotificationPreferences()


# ---------- User Settings ----------
class UserSettingsUpdate(BaseModel):
    display_name: str = "HUNTER"
    email: str | None = None
    timezone: str = "Europe/Paris"
    weekly_training_goal: int = Field(ge=1, le=14, default=6)
    rest_day_preference: list[str] = ["monday"]
    fatigue_threshold: int = Field(ge=50, le=100, default=85)
    fitness_goal: Literal["maintenance", "build", "peak", "recovery"] = "build"
    notifications_enabled: bool = True
    coach_briefing_enabled: bool = True
    auto_adapt_enabled: bool = True
    push_to_garmin_enabled: bool = False
    theme: Literal[
        "light", "dark", "darker", "abyss", "performance", "odyssey", "pierre", "prune"
    ] = "dark"
    exercise_abbreviations: dict[str, str] = {}
    weekly_volume_target_kg: int = Field(ge=1000, le=200000, default=20000)
    lthr: int | None = Field(ge=100, le=220, default=None)
    max_hr: int | None = Field(ge=120, le=230, default=None)
    threshold_pace_sec_km: int | None = Field(ge=120, le=900, default=None)
    # Set by the Garmin sync; sent back untouched by the settings form.
    lthr_measured_on: date | None = None
    # None keeps the stored choice: a client that predates it cannot reset it.
    notification_preferences: NotificationPreferences | None = None

    @field_validator("timezone")
    @classmethod
    def validate_timezone(cls, value: str) -> str:
        # Invalid zones would make activity capture and weekly settlement fail.
        try:
            ZoneInfo(value)
        except (ZoneInfoNotFoundError, ValueError) as exc:
            raise ValueError("Fuseau horaire inconnu.") from exc
        return value


class UserSettingsOut(BaseModel):
    user_id: int
    display_name: str
    email: str | None
    timezone: str
    weekly_training_goal: int
    rest_day_preference: list[str]
    fatigue_threshold: int
    fitness_goal: str
    notifications_enabled: bool
    coach_briefing_enabled: bool
    auto_adapt_enabled: bool = True
    push_to_garmin_enabled: bool = False
    theme: str
    exercise_abbreviations: dict[str, str]
    weekly_volume_target_kg: int
    lthr: int | None
    max_hr: int | None
    threshold_pace_sec_km: int | None
    lthr_measured_on: date | None
    notification_preferences: NotificationPreferences = Field(
        default_factory=lambda: NotificationPreferences().complete()
    )


def _settings_out(settings: dict) -> UserSettingsOut:
    prefs = stored_preferences(settings.get("notification_preferences"))
    return UserSettingsOut(**{**settings, "notification_preferences": prefs.complete()})


def get_settings():
    """Get current user settings."""
    settings = repo.get_user_settings(user_id=resolve_athlete_id())
    if not settings:
        # Return defaults if no settings exist
        return UserSettingsOut(
            user_id=resolve_athlete_id(),
            display_name="HUNTER",
            email=None,
            timezone="Europe/Paris",
            weekly_training_goal=6,
            rest_day_preference=["monday"],
            fatigue_threshold=85,
            fitness_goal="build",
            notifications_enabled=True,
            coach_briefing_enabled=True,
            theme="dark",
            exercise_abbreviations={},
            weekly_volume_target_kg=20000,
            lthr=None,
            max_hr=None,
            threshold_pace_sec_km=None,
            lthr_measured_on=None,
        )
    return _settings_out(settings)


def update_settings(payload: UserSettingsUpdate):
    """Update user settings."""
    settings = repo.upsert_user_settings(
        user_id=resolve_athlete_id(),
        display_name=payload.display_name,
        email=payload.email,
        timezone=payload.timezone,
        weekly_training_goal=payload.weekly_training_goal,
        rest_day_preference=payload.rest_day_preference,
        fatigue_threshold=payload.fatigue_threshold,
        fitness_goal=payload.fitness_goal,
        notifications_enabled=payload.notifications_enabled,
        coach_briefing_enabled=payload.coach_briefing_enabled,
        auto_adapt_enabled=payload.auto_adapt_enabled,
        push_to_garmin_enabled=payload.push_to_garmin_enabled,
        theme=payload.theme,
        exercise_abbreviations=payload.exercise_abbreviations,
        weekly_volume_target_kg=payload.weekly_volume_target_kg,
        lthr=payload.lthr,
        max_hr=payload.max_hr,
        threshold_pace_sec_km=payload.threshold_pace_sec_km,
        lthr_measured_on=payload.lthr_measured_on,
        notification_preferences=(
            json.dumps(payload.notification_preferences.model_dump())
            if payload.notification_preferences is not None
            else None
        ),
    )
    return _settings_out(settings)
