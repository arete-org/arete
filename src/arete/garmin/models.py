"""Data models for Garmin pipeline.

Dataclass models for planned/actual sessions and matching results.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime
from enum import Enum
from typing import Any


class SessionType(str, Enum):
    """Types of training sessions."""

    # Cardio types
    RECOVERY = "recovery"
    ENDURANCE = "endurance"
    TEMPO = "tempo"
    INTERVALS = "intervals"
    LONG_RUN = "long_run"

    # Strength types
    STRENGTH = "strength"
    HYPERTROPHY = "hypertrophy"
    POWER = "power"
    DELOAD = "deload"

    # General types
    CROSS_TRAINING = "cross_training"
    RACE = "race"
    OTHER = "other"


class SessionStatus(str, Enum):
    """Status of a planned session."""

    PENDING = "pending"
    COMPLETED = "completed"
    SKIPPED = "skipped"
    MODIFIED = "modified"


class MatchConfidence(str, Enum):
    """Confidence level of session matching."""

    HIGH = "high"  # Same date, same type, duration within 20%
    MEDIUM = "medium"  # Same date, similar duration
    LOW = "low"  # Same date only
    NONE = "none"  # No match found


class ActivitySource(str, Enum):
    """Source of activity data."""

    FIT_FILE = "fit_file"
    GARMIN_CONNECT = "garmin_connect"
    STRAVA = "strava"
    MANUAL = "manual"


#: The sport names Arete stores. Garmin, Strava, FIT files, the planning page
#: and the coach each spell sports their own way; matching a planned session
#: to a realised one compares ``sport`` exactly, so every write path goes
#: through :func:`canonical_sport`. The raw source type stays in
#: ``session_type`` (trail runs keep ``trail_running`` / ``TrailRun`` there).
CANONICAL_SPORTS: tuple[str, ...] = (
    "running",
    "cycling",
    "swimming",
    "strength",
    "walking",
    "hiking",
    "rowing",
    "yoga",
    "other",
)

SPORT_ALIASES: dict[str, str] = {
    # Running (Garmin typeKeys and lowercased Strava types)
    "run": "running",
    "trail_run": "running",
    "trailrun": "running",
    "trail_running": "running",
    "treadmill_running": "running",
    "track_running": "running",
    "virtual_run": "running",
    "virtualrun": "running",
    # Cycling
    "ride": "cycling",
    "virtual_ride": "cycling",
    "virtualride": "cycling",
    "indoor_cycling": "cycling",
    "road_biking": "cycling",
    "mountain_biking": "cycling",
    "mountainbikeride": "cycling",
    "gravel_cycling": "cycling",
    "gravelride": "cycling",
    "ebikeride": "cycling",
    # Swimming
    "swim": "swimming",
    "lap_swimming": "swimming",
    "open_water_swimming": "swimming",
    # Strength
    "weight_training": "strength",
    "weighttraining": "strength",
    "strength_training": "strength",
    "crossfit": "strength",
    "training": "strength",
    # Walking / hiking
    "walk": "walking",
    "casual_walking": "walking",
    "speed_walking": "walking",
    "indoor_walking": "walking",
    "hike": "hiking",
    # Rowing
    "indoor_rowing": "rowing",
    # Everything Arete has no family for
    "workout": "other",
    "elliptical": "other",
    "generic": "other",
}


def canonical_sport(raw: str | None) -> str:
    """One spelling per sport, whatever the source called it."""
    key = (raw or "").strip().lower()
    if key in CANONICAL_SPORTS:
        return key
    return SPORT_ALIASES.get(key, "other")


@dataclass
class PlannedSession:
    """A planned training session."""

    id: int | None = None
    user_id: int | None = None
    date: date = field(default_factory=date.today)
    sport: str = "running"
    session_type: SessionType = SessionType.ENDURANCE
    target_duration_min: int | None = None
    target_distance_km: float | None = None
    target_hr_zone: str | None = None
    target_intensity: str | None = None  # 'easy', 'moderate', 'hard'
    description: str | None = None
    source: str = "manual"  # 'manual', 'llm', 'coach'
    status: SessionStatus = SessionStatus.PENDING
    created_at: datetime | None = None
    prescription: dict[str, Any] | None = None
    provenance: list[dict[str, Any]] | None = None
    revision: int = 1
    structure_json: str | None = None  # explicit workout steps, see workout_structure
    garmin_workout_id: str | None = None  # the copy scheduled on Garmin's calendar
    garmin_schedule_id: str | None = None
    garmin_pushed_at: datetime | None = None
    goal_id: int | None = None  # set when a goal's plan generated it
    #: A Hyrox or hybrid plan's session kind (``features.hybrid_plan``).
    plan_kind: str | None = None

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for DB insertion."""
        return {
            "id": self.id,
            "user_id": self.user_id,
            "date": self.date,
            "sport": self.sport,
            "session_type": self.session_type.value,
            "target_duration_min": self.target_duration_min,
            "target_distance_km": self.target_distance_km,
            "target_hr_zone": self.target_hr_zone,
            "target_intensity": self.target_intensity,
            "description": self.description,
            "source": self.source,
            "status": self.status.value,
        }


@dataclass
class ActualSession:
    """An actual training session (from Garmin/FIT)."""

    id: int | None = None
    planned_session_id: int | None = None
    user_id: int | None = None
    date: date = field(default_factory=date.today)
    sport: str = "running"
    session_type: str | None = None

    # Core metrics
    duration_sec: int = 0
    distance_m: float | None = None
    calories: int | None = None

    # Heart rate
    avg_hr: int | None = None
    max_hr: int | None = None
    hr_zones_json: str | None = None  # JSON string

    # Pace/Speed
    avg_pace_sec_km: int | None = None
    avg_speed_mps: float | None = None
    max_speed_mps: float | None = None

    # Elevation
    ascent_m: float | None = None
    descent_m: float | None = None

    # GPS
    start_lat: float | None = None
    start_lon: float | None = None

    # Running dynamics
    avg_cadence: int | None = None
    max_cadence: int | None = None
    avg_vertical_oscillation: float | None = None  # mm
    avg_ground_contact_time: int | None = None  # ms
    avg_stride_length: float | None = None  # meters

    # Source
    source: ActivitySource = ActivitySource.FIT_FILE
    source_file: str | None = None
    garmin_activity_id: str | None = None
    strava_activity_id: str | None = None  # set when a Strava copy was merged in

    # Adherence (computed)
    adherence_score: float | None = None
    intensity_deviation: float | None = None

    # Timestamps
    start_time: datetime | None = None
    created_at: datetime | None = None

    # Analytics / detail data
    name: str | None = None
    notes: str | None = None
    rpe: int | None = None
    workout_type: str | None = None
    moving_time_sec: int | None = None
    suffer_score: int | None = None
    laps_json: str | None = None
    splits_json: str | None = None
    best_efforts_json: str | None = None
    avg_watts: int | None = None
    weighted_avg_watts: int | None = None
    device_name: str | None = None

    @property
    def duration_min_raw(self) -> float:
        """Duration in minutes (raw float)."""
        return self.duration_sec / 60.0

    @property
    def duration_min(self) -> str:
        """Duration as MM:SS string."""
        total_minutes = int(self.duration_sec // 60)
        remaining_seconds = int(self.duration_sec % 60)
        return f"{total_minutes}:{remaining_seconds:02d}"

    @property
    def distance_km(self) -> float | None:
        """Distance in kilometers (rounded to 2 decimals)."""
        return round(self.distance_m / 1000.0, 2) if self.distance_m else None

    @property
    def avg_pace_min_km(self) -> str | None:
        """Average pace as MM:SS string."""
        if self.avg_pace_sec_km is None:
            return None
        minutes = self.avg_pace_sec_km // 60
        seconds = self.avg_pace_sec_km % 60
        return f"{minutes}:{seconds:02d}"

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for DB insertion."""
        return {
            "id": self.id,
            "planned_session_id": self.planned_session_id,
            "user_id": self.user_id,
            "date": self.date,
            "sport": self.sport,
            "session_type": self.session_type,
            "duration_sec": self.duration_sec,
            "distance_m": self.distance_m,
            "calories": self.calories,
            "avg_hr": self.avg_hr,
            "max_hr": self.max_hr,
            "hr_zones_json": self.hr_zones_json,
            "avg_pace_sec_km": self.avg_pace_sec_km,
            "avg_speed_mps": self.avg_speed_mps,
            "max_speed_mps": self.max_speed_mps,
            "ascent_m": self.ascent_m,
            "descent_m": self.descent_m,
            "start_lat": self.start_lat,
            "start_lon": self.start_lon,
            "avg_cadence": self.avg_cadence,
            "max_cadence": self.max_cadence,
            "avg_vertical_oscillation": self.avg_vertical_oscillation,
            "avg_ground_contact_time": self.avg_ground_contact_time,
            "avg_stride_length": self.avg_stride_length,
            "source": self.source.value,
            "source_file": self.source_file,
            "garmin_activity_id": self.garmin_activity_id,
            "adherence_score": self.adherence_score,
            "intensity_deviation": self.intensity_deviation,
            "start_time": self.start_time,
        }


@dataclass
class SessionMatch:
    """Result of matching an actual session to a planned session."""

    actual_session: ActualSession
    planned_session: PlannedSession | None
    confidence: MatchConfidence
    adherence_score: float  # 0-100
    duration_deviation_pct: float  # % deviation from planned
    intensity_deviation_pct: float | None  # % deviation from planned HR zone
    notes: list[str] = field(default_factory=list)

    @property
    def is_matched(self) -> bool:
        """Whether a match was found."""
        return (
            self.planned_session is not None and self.confidence != MatchConfidence.NONE
        )

    def summary(self) -> str:
        """Human-readable summary."""
        if not self.is_matched:
            return "Séance non planifiée (activité spontanée)"

        confidence_fr = {
            MatchConfidence.HIGH: "élevée",
            MatchConfidence.MEDIUM: "moyenne",
            MatchConfidence.LOW: "faible",
        }

        if self.planned_session is None:
            return f"Pas de correspondance - Adhérence: {self.adherence_score:.0f}%"
        return (
            f"Match {confidence_fr.get(self.confidence, 'inconnue')} avec "
            f"'{self.planned_session.description or self.planned_session.session_type.value}' - "
            f"Adhérence: {self.adherence_score:.0f}%"
        )
