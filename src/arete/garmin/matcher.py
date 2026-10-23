"""Session matching logic.

Matches actual sessions (from Garmin) to planned sessions.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Literal

from arete.features.hr_zones import ZoneModel
from arete.garmin.models import (
    ActualSession,
    MatchConfidence,
    PlannedSession,
    SessionMatch,
    SessionType,
)

logger = logging.getLogger(__name__)

#: Within this duration deviation a session earns full duration points.
DURATION_ON_PLAN = 0.1
#: Within this deviation from the planned zone's middle heart rate, full
#: intensity points.
INTENSITY_ON_PLAN = 0.1

PlanVerdict = Literal["on_plan", "shorter", "longer", "harder", "easier"]


def plan_verdict(
    duration_dev: float | None, intensity_dev: float | None
) -> PlanVerdict | None:
    """How a session compared with its plan, on the score's own full-points bands.

    Within both bands it was done as planned; otherwise the measure furthest
    outside its band names the difference (duration on a tie). None when
    neither can be measured (no target duration, no zone or no heart rate).
    """
    if duration_dev is None and intensity_dev is None:
        return None
    off: list[tuple[float, PlanVerdict]] = []
    if duration_dev is not None and abs(duration_dev) > DURATION_ON_PLAN:
        off.append(
            (
                abs(duration_dev) / DURATION_ON_PLAN,
                "longer" if duration_dev > 0 else "shorter",
            )
        )
    if intensity_dev is not None and abs(intensity_dev) > INTENSITY_ON_PLAN:
        off.append(
            (
                abs(intensity_dev) / INTENSITY_ON_PLAN,
                "harder" if intensity_dev > 0 else "easier",
            )
        )
    if not off:
        return "on_plan"
    return max(off, key=lambda item: item[0])[1]


@dataclass
class MatchingConfig:
    """Configuration for session matching."""

    # Date tolerance
    date_tolerance_days: int = 0  # Must be same day by default

    # Duration tolerance (% deviation allowed)
    duration_tolerance_pct: float = 0.25  # 25% deviation allowed

    # Type matching strictness
    require_type_match: bool = False  # If True, session types must match

    # Minimum confidence to accept match
    min_confidence: MatchConfidence = MatchConfidence.LOW


class SessionMatcher:
    """Matches actual training sessions to planned sessions.

    Implements matching logic:
    1. Find planned sessions on the same date
    2. Score matches based on duration, type, and intensity
    3. Return best match with confidence level
    """

    def __init__(
        self, config: MatchingConfig | None = None, zones: ZoneModel | None = None
    ):
        """Initialize matcher.

        Args:
            config: Matching configuration. Uses defaults if None.
            zones: The athlete's HR zones, which a planned "Z2" refers to.
                Defaults to the max-HR model, for callers without settings.
        """
        self.config = config or MatchingConfig()
        self.zones = zones or ZoneModel.from_reference()

    def find_match(
        self,
        actual: ActualSession,
        planned_sessions: list[PlannedSession],
    ) -> SessionMatch:
        """Find the best matching planned session for an actual session.

        Args:
            actual: The actual session to match.
            planned_sessions: List of candidate planned sessions.

        Returns:
            SessionMatch with best match (or no match if none found).
        """
        # Filter by date
        candidates = self._filter_by_date(actual.date, planned_sessions)

        if not candidates:
            return SessionMatch(
                actual_session=actual,
                planned_session=None,
                confidence=MatchConfidence.NONE,
                adherence_score=0.0,
                duration_deviation_pct=0.0,
                intensity_deviation_pct=None,
                notes=["Aucune séance planifiée pour cette date"],
            )

        # Score each candidate
        scored_matches: list[tuple[PlannedSession, float, list[str]]] = []

        for planned in candidates:
            score, notes = self._calculate_match_score(actual, planned)
            scored_matches.append((planned, score, notes))

        # Sort by score (highest first)
        scored_matches.sort(key=lambda x: x[1], reverse=True)

        best_planned, best_score, notes = scored_matches[0]

        # Determine confidence level
        confidence = self._score_to_confidence(best_score)

        # Calculate deviations
        duration_dev = self._calculate_duration_deviation(actual, best_planned)
        intensity_dev = self._calculate_intensity_deviation(actual, best_planned)

        return SessionMatch(
            actual_session=actual,
            planned_session=best_planned,
            confidence=confidence,
            adherence_score=best_score,
            duration_deviation_pct=duration_dev or 0.0,
            intensity_deviation_pct=intensity_dev,
            notes=notes,
        )

    def _filter_by_date(
        self,
        target_date: date,
        planned_sessions: list[PlannedSession],
    ) -> list[PlannedSession]:
        """Filter planned sessions by date tolerance."""
        tolerance = timedelta(days=self.config.date_tolerance_days)
        min_date = target_date - tolerance
        max_date = target_date + tolerance

        return [p for p in planned_sessions if min_date <= p.date <= max_date]

    def _calculate_match_score(
        self,
        actual: ActualSession,
        planned: PlannedSession,
    ) -> tuple[float, list[str]]:
        """Calculate match score (0-100) and notes.

        Scoring:
        - Base: 50 points for same date
        - Duration: up to 30 points based on deviation
        - Type: 10 points for matching type
        - Intensity: up to 10 points for matching HR zone
        """
        score = 0.0
        notes: list[str] = []

        # Base score for date match
        if actual.date == planned.date:
            score += 50
        else:
            days_diff = abs((actual.date - planned.date).days)
            score += max(0, 50 - days_diff * 25)
            notes.append(f"Date différente ({days_diff} jour(s))")

        # Duration match (up to 30 points)
        duration_dev = self._calculate_duration_deviation(actual, planned)
        if duration_dev is not None:
            if abs(duration_dev) <= DURATION_ON_PLAN:
                score += 30
            elif abs(duration_dev) <= 0.25:
                score += 20
                notes.append(f"Durée: {duration_dev:+.0%}")
            elif abs(duration_dev) <= 0.5:
                score += 10
                notes.append(f"Durée: {duration_dev:+.0%}")
            else:
                notes.append(f"Durée très différente: {duration_dev:+.0%}")
        else:
            score += 15  # Neutral if no planned duration

        # Type match (10 points)
        if actual.session_type and planned.session_type:
            actual_type = actual.session_type.lower()
            planned_type = (
                planned.session_type.value
                if isinstance(planned.session_type, SessionType)
                else planned.session_type.lower()
            )
            if actual_type == planned_type:
                score += 10
            elif self._types_similar(actual_type, planned_type):
                score += 5
                notes.append("Type de séance similaire")
            else:
                notes.append(f"Type différent: {actual_type} vs {planned_type}")
        else:
            score += 5  # Neutral if no type info

        # Intensity match (10 points)
        intensity_dev = self._calculate_intensity_deviation(actual, planned)
        if intensity_dev is not None:
            if abs(intensity_dev) <= INTENSITY_ON_PLAN:
                score += 10
            elif abs(intensity_dev) <= 0.2:
                score += 5
                notes.append(f"Intensité: {intensity_dev:+.0%}")
            else:
                notes.append(f"Intensité différente: {intensity_dev:+.0%}")
        else:
            score += 5  # Neutral if no HR data

        return min(100, score), notes

    def verdict(
        self, actual: ActualSession, planned: PlannedSession
    ) -> PlanVerdict | None:
        """How ``actual`` compared with ``planned`` (``plan_verdict``)."""
        return plan_verdict(
            self._calculate_duration_deviation(actual, planned),
            self._calculate_intensity_deviation(actual, planned),
        )

    def target_hr(self, planned: PlannedSession) -> float | None:
        """The heart rate a planned zone's intensity is measured against."""
        zone = (planned.target_hr_zone or "").upper()
        if zone not in ("Z1", "Z2", "Z3", "Z4", "Z5"):
            return None
        return _zone_midpoint(self.zones, int(zone[1]) - 1)

    def _calculate_duration_deviation(
        self,
        actual: ActualSession,
        planned: PlannedSession,
    ) -> float | None:
        """Calculate duration deviation as percentage.

        Returns None if no planned duration.
        """
        if not planned.target_duration_min:
            return None

        actual_min = actual.duration_sec / 60.0
        return (actual_min - planned.target_duration_min) / planned.target_duration_min

    def _calculate_intensity_deviation(
        self,
        actual: ActualSession,
        planned: PlannedSession,
    ) -> float | None:
        """Calculate intensity deviation based on HR zones.

        Returns None if no HR data or planned zone.
        """
        target_hr = self.target_hr(planned)
        if not actual.avg_hr or target_hr is None:
            return None
        return (actual.avg_hr - target_hr) / target_hr

    def _score_to_confidence(self, score: float) -> MatchConfidence:
        """Convert match score to confidence level."""
        if score >= 85:
            return MatchConfidence.HIGH
        elif score >= 65:
            return MatchConfidence.MEDIUM
        elif score >= 40:
            return MatchConfidence.LOW
        else:
            return MatchConfidence.NONE

    def _types_similar(self, type1: str, type2: str) -> bool:
        """Check if two session types are similar."""
        similar_groups = [
            {"recovery", "easy", "rest"},
            {"endurance", "easy", "aerobic"},
            {"tempo", "threshold", "lactate"},
            {"intervals", "vo2max", "speed", "track"},
            {"long_run", "long", "lsd"},
        ]

        return any(type1 in group and type2 in group for group in similar_groups)


def _zone_midpoint(zones: ZoneModel, index: int) -> float:
    """Middle heart rate of zone ``index`` (0-4) in the athlete's model."""
    low, high = zones.target_range(index + 1)
    return (low + high + 1) / 2
