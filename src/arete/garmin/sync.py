"""Garmin Connect activity synchronization (via arete.garmin.client).

Provides automated sync of activities from Garmin Connect to Arete.
Respects rate limits and handles authentication securely.
"""

from __future__ import annotations

import json
import logging
import time
from collections.abc import Callable, Generator
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any, Literal

from garminconnect import GarminConnectTooManyRequestsError

from arete.config import config
from arete.dataio.settings import athlete_zone_model
from arete.features.hr_zones import ZoneModel, samples_from_laps
from arete.garmin.client import GarminAuthError, GarminClient
from arete.garmin.fit_parser import FITParser, laps_to_json
from arete.garmin.matcher import SessionMatcher
from arete.garmin.models import (
    ActivitySource,
    ActualSession,
    SessionStatus,
    canonical_sport,
)
from arete.garmin.repository import GarminRepository
from arete.garmin.streams import ActivityStreams, from_time_series
from arete.garmin.threshold import refresh_threshold
from arete.strength.drafts import open_garmin_draft
from arete.strength.logging_service import link_garmin_strength
from arete.strength.models import GarminExerciseSummary

logger = logging.getLogger(__name__)

MAX_SYNC_ACTIVITIES = 200
HISTORY_BATCH_SIZE = 20
MAX_HISTORY_ACTIVITIES = 20_000


# Rate limiting configuration (conservative to avoid bans)
RATE_LIMITS = {
    "delay_between_requests": 3.0,  # seconds
    "delay_after_error": 60.0,  # seconds
    "delay_after_429": 300.0,  # 5 minutes
    "max_activities_per_sync": 50,  # per session
    "max_retries": 3,
}


@dataclass
class SyncResult:
    """Result of a sync operation."""

    success: bool
    activities_synced: int = 0
    activities_merged: int = 0
    activities_matched: int = 0
    activities_skipped: int = 0
    errors: list[str] = field(default_factory=list)
    last_activity_date: date | None = None
    #: Sessions this run created or took over from Strava, for the feedback.
    session_ids: list[int] = field(default_factory=list)
    next_history_offset: int | None = None
    history_anchor: int | None = None


@dataclass(frozen=True)
class SyncProgress:
    """Observed work, not an estimate of elapsed time."""

    stage: Literal["preparing", "fetching", "processing", "fit", "saving", "finalizing"]
    completed: int = 0
    total: int | None = None
    activity_name: str | None = None


@dataclass
class GarminActivity:
    """Parsed Garmin activity metadata."""

    activity_id: int
    activity_name: str
    activity_type: str
    start_time: datetime
    duration_sec: int
    distance_m: float | None
    avg_hr: int | None
    max_hr: int | None
    calories: int | None
    avg_speed_mps: float | None
    max_speed_mps: float | None
    ascent_m: float | None
    descent_m: float | None
    avg_cadence: int | None
    max_cadence: int | None
    moving_duration_sec: int | None = None
    #: False when Garmin sent no start time and the sync time stands in for it.
    start_time_known: bool = True
    #: What a strength activity's watch recognised: exercises, sets, reps.
    exercise_summaries: list[GarminExerciseSummary] = field(default_factory=list)

    @classmethod
    def from_api_response(cls, data: dict[str, Any]) -> GarminActivity:
        """Create from Garmin Connect API response."""
        # Warn if startTimeLocal is missing (fallback to now is a data quality issue)
        if "startTimeLocal" not in data:
            import logging

            logging.getLogger(__name__).warning(
                "Missing startTimeLocal for activity %s, using current time",
                data.get("activityId", "unknown"),
            )
        return cls(
            activity_id=data["activityId"],
            activity_name=data.get("activityName", ""),
            activity_type=data.get("activityType", {}).get("typeKey", "unknown"),
            start_time=datetime.fromisoformat(
                data["startTimeLocal"].replace("Z", "+00:00")
            )
            if "startTimeLocal" in data
            else datetime.now(UTC),
            duration_sec=int(data.get("duration", 0)),
            distance_m=data.get("distance"),
            avg_hr=data.get("averageHR"),
            max_hr=data.get("maxHR"),
            calories=data.get("calories"),
            avg_speed_mps=data.get("averageSpeed"),
            max_speed_mps=data.get("maxSpeed"),
            ascent_m=data.get("elevationGain"),
            descent_m=data.get("elevationLoss"),
            avg_cadence=data.get("averageRunningCadenceInStepsPerMinute")
            or data.get("averageBikingCadenceInRevPerMinute"),
            max_cadence=data.get("maxRunningCadenceInStepsPerMinute")
            or data.get("maxBikingCadenceInRevPerMinute"),
            moving_duration_sec=int(data["movingDuration"])
            if data.get("movingDuration")
            else None,
            start_time_known="startTimeLocal" in data,
            exercise_summaries=exercise_summaries(data.get("summarizedExerciseSets")),
        )

    def to_actual_session(self) -> ActualSession:
        """Convert to ActualSession model."""
        sport = self._map_activity_type()
        return ActualSession(
            date=self.start_time.date(),
            sport=sport,
            session_type=self.activity_type,
            name=self.activity_name or None,
            duration_sec=self.duration_sec,
            moving_time_sec=self.moving_duration_sec or self.duration_sec,
            avg_pace_sec_km=pace_from_speed(self.avg_speed_mps, sport),
            distance_m=self.distance_m,
            calories=self.calories,
            avg_hr=self.avg_hr,
            max_hr=self.max_hr,
            avg_speed_mps=self.avg_speed_mps,
            max_speed_mps=self.max_speed_mps,
            ascent_m=self.ascent_m,
            descent_m=self.descent_m,
            avg_cadence=self.avg_cadence,
            max_cadence=self.max_cadence,
            source=ActivitySource.GARMIN_CONNECT,
            garmin_activity_id=str(self.activity_id),
            start_time=self.start_time,
        )

    def _map_activity_type(self) -> str:
        """Map Garmin activity type to Arete sport type."""
        return canonical_sport(self.activity_type)


#: Garmin lists one summary per exercise category; more is not a real session.
MAX_EXERCISE_SUMMARIES = 30


def exercise_summaries(raw: Any) -> list[GarminExerciseSummary]:
    """``summarizedExerciseSets`` of an activity, malformed entries left out."""

    def count(value: Any) -> int | None:
        number = isinstance(value, int | float) and not isinstance(value, bool)
        return int(value) if number and value > 0 else None

    summaries: list[GarminExerciseSummary] = []
    for item in raw if isinstance(raw, list) else []:
        if not isinstance(item, dict) or not isinstance(item.get("category"), str):
            continue
        sub = item.get("subCategory")
        summaries.append(
            GarminExerciseSummary(
                category=item["category"],
                sub_category=sub if isinstance(sub, str) else None,
                sets=count(item.get("sets")),
                reps=count(item.get("reps")),
            )
        )
    return summaries[:MAX_EXERCISE_SUMMARIES]


FOOT_SPORTS_FOR_PACE = {"running", "walking", "hiking"}


def pace_from_speed(avg_speed_mps: float | None, sport: str) -> int | None:
    """sec/km from m/s, only for sports where pace is meaningful."""
    if not avg_speed_mps or avg_speed_mps <= 0 or sport not in FOOT_SPORTS_FOR_PACE:
        return None
    return int(round(1000 / avg_speed_mps))


def zones_from_laps(laps_json: str | None, zones: ZoneModel) -> str | None:
    """Time per zone from lap averages, for sessions without a FIT file."""
    if not laps_json:
        return None
    try:
        laps = json.loads(laps_json) if isinstance(laps_json, str) else laps_json
    except (json.JSONDecodeError, TypeError):
        return None
    samples = samples_from_laps(laps)
    if not samples:
        return None
    return json.dumps(zones.seconds_in_zones(samples))


def rescore(
    repo: GarminRepository,
    actual_id: int,
    session: ActualSession,
    planned_id: int,
    zones: ZoneModel | None = None,
) -> None:
    """Score a session against the plan it is already linked to, on its own
    values: a Garmin takeover keeps the link but not Strava's adherence."""
    planned = repo.get_planned_session(planned_id)
    if planned is None:
        return
    match = SessionMatcher(zones=zones or athlete_zone_model()).find_match(
        session, [planned]
    )
    if match.planned_session is not None:
        repo.update_actual_session_match(actual_id, planned_id, match.adherence_score)


def auto_match(
    repo: GarminRepository,
    actual_id: int,
    session: ActualSession,
    zones: ZoneModel | None = None,
) -> int | None:
    """Link an actual session to the best pending planned session of the same day(s).

    Returns the planned session id when a match is recorded, else None.
    """
    candidates = [
        p
        for p in repo.get_potential_matches(session)
        # A session the daily adaptation rewrote is still the day's plan.
        if p.status in (SessionStatus.PENDING, SessionStatus.MODIFIED)
        and p.id is not None
        and p.sport == session.sport
    ]
    if not candidates:
        return None
    matcher = SessionMatcher(zones=zones or athlete_zone_model())
    match = matcher.find_match(session, candidates)
    if (
        not match.is_matched
        or match.planned_session is None
        or match.planned_session.id is None
    ):
        return None
    planned_id = match.planned_session.id
    repo.update_actual_session_match(actual_id, planned_id, match.adherence_score)
    repo.update_planned_session_status(planned_id, SessionStatus.COMPLETED)
    logger.info(
        "Matched actual %s to planned %s (%.0f%%)",
        actual_id,
        planned_id,
        match.adherence_score,
    )
    return planned_id


def complete_planned(repo: GarminRepository, day: date, sport: str) -> int | None:
    """Mark the first pending planned session of ``sport`` on ``day`` as completed.

    Used for sessions that only exist in the strength log (no actual_sessions row).
    """
    for planned in repo.list_planned_sessions(start_date=day, end_date=day, limit=50):
        if (
            planned.sport == sport
            and planned.status == SessionStatus.PENDING
            and planned.id is not None
        ):
            repo.update_planned_session_status(planned.id, SessionStatus.COMPLETED)
            return planned.id
    return None


#: Values only Strava filled on the rows it created (its description in
#: ``notes``): cleared when Garmin takes such a row over.
STRAVA_ONLY_FIELDS = (
    "suffer_score",
    "best_efforts_json",
    "splits_json",
    "avg_watts",
    "weighted_avg_watts",
    "workout_type",
    "device_name",
    "notes",
)

#: Computed from the row's measures when it was matched to its plan: Strava's
#: on a legacy row, so cleared on a takeover rather than read by the coach.
DERIVED_FROM_STRAVA = ("adherence_score", "intensity_deviation")

#: What a Garmin import measures: on a takeover, its value replaces Strava's,
#: an empty one included.
GARMIN_MEASURED_FIELDS = (
    "date",
    "sport",
    "session_type",
    "start_time",
    "duration_sec",
    "moving_time_sec",
    "distance_m",
    "calories",
    "avg_hr",
    "max_hr",
    "hr_zones_json",
    "avg_pace_sec_km",
    "avg_speed_mps",
    "max_speed_mps",
    "ascent_m",
    "descent_m",
    "start_lat",
    "start_lon",
    "avg_cadence",
    "max_cadence",
    "avg_vertical_oscillation",
    "avg_ground_contact_time",
    "avg_stride_length",
    "laps_json",
    "name",
    "source_file",
    "garmin_activity_id",
)


def garmin_takeover(garmin: ActualSession) -> dict[str, Any]:
    """Columns to write on a legacy Strava row when Garmin imports that workout.

    Strava was retired as a data source (its API agreement forbids its data in
    an AI application, ARE-126), but the rows it created stay. The row becomes
    a Garmin row the coach reads, so Garmin's values win: every measured one
    replaces Strava's and the Strava-only ones go, ``notes`` included (Strava
    put its description there; a note the athlete added cannot be told apart
    and goes too). The plan link and the RPE stay; the adherence computed from
    Strava's values is cleared.
    """
    return {
        "source": garmin.source.value,
        **{column: getattr(garmin, column) for column in GARMIN_MEASURED_FIELDS},
        **dict.fromkeys(STRAVA_ONLY_FIELDS),
        **dict.fromkeys(DERIVED_FROM_STRAVA),
    }


class GarminSyncClient:
    """Syncs activities from Garmin Connect into the local database."""

    def __init__(
        self,
        client: GarminClient | None = None,
        repository: GarminRepository | None = None,
        zones: ZoneModel | None = None,
    ):
        self.client = client or GarminClient()
        self._repository = repository
        self._last_request_time = 0.0
        self._zones = zones
        self.scan_incomplete = False

    @property
    def zones(self) -> ZoneModel:
        """Zone model built from the athlete's settings, read once per sync."""
        if self._zones is None:
            self._zones = athlete_zone_model()
        return self._zones

    @property
    def repository(self) -> GarminRepository:
        """Get or create repository."""
        if self._repository is None:
            self._repository = GarminRepository()
        return self._repository

    def is_authenticated(self) -> bool:
        """True when a saved Garmin session can be restored."""
        return self.client.is_authenticated()

    def login(self, email: str | None = None, password: str | None = None) -> str:
        """Authenticate with Garmin Connect. Returns "ok" or "needs_mfa".

        Credentials come from the account connection form, never deployment settings.
        """
        if not email or not password:
            raise ValueError(
                "Garmin credentials required. Connect Garmin from Settings."
            )
        status = self.client.login(email, password)
        logger.info("Garmin login: %s", status)
        return status

    def logout(self) -> None:
        """Clear saved authentication tokens."""
        self.client.logout()

    def _rate_limit(self) -> None:
        """Apply rate limiting between requests."""
        if (budget := getattr(self.client, "sync_budget", None)) is not None:
            budget.check()
            return
        elapsed = time.time() - self._last_request_time
        if elapsed < RATE_LIMITS["delay_between_requests"]:
            time.sleep(RATE_LIMITS["delay_between_requests"] - elapsed)
        self._last_request_time = time.time()

    def get_activities(
        self,
        start_date: date | None = None,
        end_date: date | None = None,
        limit: int = 50,
    ) -> list[GarminActivity]:
        """Fetch activities between two dates (inclusive), newest first."""
        if not 1 <= limit <= MAX_SYNC_ACTIVITIES:
            raise ValueError("limit must be between 1 and 200")
        from arete.services.settings import athlete_today

        end_date = end_date or athlete_today()
        start_date = start_date or end_date - timedelta(days=30)
        activities: list[GarminActivity] = []
        self.scan_incomplete = True
        for page in range(6):
            self._rate_limit()
            raw = self.client.activity_page(page * 50, 50)
            parsed = [GarminActivity.from_api_response(item) for item in raw]
            if any(not item.start_time_known for item in parsed):
                raise ValueError("Date Garmin manquante ; couverture non vérifiée.")
            for item in parsed:
                if start_date <= item.start_time.date() <= end_date:
                    if len(activities) == limit:
                        return activities
                    activities.append(item)
            if len(raw) < 50 or any(
                item.start_time.date() < start_date for item in parsed
            ):
                self.scan_incomplete = False
                break
        return activities

    def download_fit_file(
        self, activity_id: int, output_dir: Path | None = None
    ) -> Path | None:
        """Download the original FIT file for an activity (cached on disk)."""
        output_dir = output_dir or config.fit_dir
        output_dir.mkdir(parents=True, exist_ok=True)
        output_path = output_dir / f"{activity_id}.fit"
        if output_path.exists():
            logger.debug(f"FIT file already exists: {output_path}")
            return output_path

        self._rate_limit()
        try:
            fit_data = self.client.download_fit(activity_id)
        except GarminConnectTooManyRequestsError:
            raise
        except Exception as e:
            logger.error(f"Failed to download FIT file {activity_id}: {e}")
            return None
        if not fit_data:
            return None
        output_path.write_bytes(fit_data)
        logger.info(f"Downloaded FIT file: {output_path}")
        return output_path

    def sync_activities(
        self,
        start_date: date | None = None,
        end_date: date | None = None,
        download_fit: bool = True,
        max_activities: int | None = None,
        history_offset: int | None = None,
        history_anchor: int | None = None,
    ) -> SyncResult:
        """Run the same workflow without exposing intermediate progress."""
        for event in self.iter_sync_activities(
            start_date,
            end_date,
            download_fit,
            max_activities,
            history_offset,
            history_anchor,
        ):
            if isinstance(event, SyncResult):
                return event
        raise AssertionError("Sync must produce a terminal result")

    def iter_sync_activities(
        self,
        start_date: date | None = None,
        end_date: date | None = None,
        download_fit: bool = True,
        max_activities: int | None = None,
        history_offset: int | None = None,
        history_anchor: int | None = None,
        activity_batch: list[GarminActivity] | None = None,
        sync_result: SyncResult | None = None,
        checkpoint: Callable[[], None] | None = None,
    ) -> Generator[SyncProgress | SyncResult, None, None]:
        """Yield progress around bounded work without a background job or queue.

        Closing stops before the next step. An in-flight Garmin call or
        database write cannot be undone.
        """
        yield SyncProgress("preparing")
        result = sync_result if sync_result is not None else SyncResult(success=False)
        effective_max: int = (
            max_activities
            if max_activities is not None
            else int(RATE_LIMITS["max_activities_per_sync"])
        )

        if not 1 <= effective_max <= MAX_SYNC_ACTIVITIES:
            raise ValueError("max_activities must be between 1 and 200")

        if history_offset is not None:
            if not 0 <= history_offset <= MAX_HISTORY_ACTIVITIES:
                raise ValueError("History offset outside the import limit")
            if start_date or end_date or effective_max != HISTORY_BATCH_SIZE:
                raise ValueError("History requires undated batches of 20 activities")
            if (history_offset > 0) != (history_anchor is not None):
                raise ValueError("History continuation requires the preceding activity")

        # Garmin retests the threshold on its own: pick it up before parsing, so
        # the sessions arriving now are read against the current zones.
        if activity_batch is None and history_offset in (None, 0):
            self.refresh_threshold()

        if history_offset is None:
            from arete.services.settings import athlete_today

            # The athlete's day, as the health sync: an activity just after
            # their midnight is still on the server's yesterday.
            if end_date is None:
                end_date = athlete_today()
            if start_date is None:
                # A newer Strava or manual row must not skip Garmin activities.
                last_day, _ = self.repository.last_garmin_import()
                start_date = last_day or end_date - timedelta(days=30)
            logger.info(f"Syncing activities from {start_date} to {end_date}")
        else:
            logger.info("Syncing Garmin history at offset %s", history_offset)

        try:
            yield SyncProgress("fetching")
            if activity_batch is not None:
                activities = activity_batch
            elif history_offset is None:
                activities = self.get_activities(
                    start_date=start_date, end_date=end_date, limit=effective_max
                )
            else:
                # HTTP batches use fresh clients. Pace pages even when every
                # activity is already imported and no FIT request slows them.
                self._last_request_time = time.time()
                self._rate_limit()
                # Re-read the preceding boundary because Garmin offsets shift
                # if activities change during a long import. Fail explicitly
                # instead of silently skipping history.
                overlap = int(history_offset > 0)
                raw = self.client.activity_page(
                    history_offset - overlap, HISTORY_BATCH_SIZE + overlap
                )
                if overlap and (not raw or raw[0].get("activityId") != history_anchor):
                    raise ValueError(
                        "L’historique Garmin a changé pendant l’import. "
                        "Relance la synchronisation ; les séances importées sont conservées."
                    )
                raw = raw[overlap:]
                if history_offset + len(raw) > MAX_HISTORY_ACTIVITIES:
                    raise ValueError(
                        "Limite de 20 000 activités atteinte ; import incomplet."
                    )
                # A malformed page is an error, never the end of the archive.
                activities = [GarminActivity.from_api_response(item) for item in raw]
                if len(raw) == HISTORY_BATCH_SIZE:
                    result.next_history_offset = history_offset + len(raw)
                    result.history_anchor = activities[-1].activity_id

            total = len(activities)
            yield SyncProgress("processing", total=total)
            for index, activity in enumerate(activities):
                try:
                    if checkpoint is not None:
                        checkpoint()
                    # Check if already synced
                    if self._is_already_synced(activity.activity_id):
                        result.activities_skipped += 1
                        yield SyncProgress("processing", index + 1, total)
                        continue

                    # Convert and save
                    session = activity.to_actual_session()

                    # Optionally download and parse FIT for detailed data
                    streams: ActivityStreams | None = None
                    if download_fit:
                        yield SyncProgress("fit", index, total, activity.activity_name)
                        fit_path = self.download_fit_file(activity.activity_id)
                        if fit_path:
                            session, streams = self._enrich_from_fit(session, fit_path)
                        else:
                            result.errors.append(
                                f"Fichier FIT indisponible : {activity.activity_name} "
                                f"({activity.activity_id}). Données détaillées indisponibles."
                            )

                    yield SyncProgress("saving", index, total, activity.activity_name)
                    if checkpoint is not None:
                        checkpoint()
                    # Same workout on a legacy Strava row? Garmin takes it over.
                    twin = self.repository.find_overlapping_session(
                        session.start_time, session.duration_sec
                    )
                    if (
                        twin is not None
                        and twin.id is not None
                        and twin.source == ActivitySource.STRAVA
                    ):
                        self.repository.update_actual_session_fields(
                            twin.id, **garmin_takeover(session)
                        )
                        actual_id = twin.id
                        result.activities_merged += 1
                        result.session_ids.append(actual_id)
                        if twin.planned_session_id is None:
                            if auto_match(
                                self.repository, twin.id, session, self.zones
                            ):
                                result.activities_matched += 1
                        else:
                            rescore(
                                self.repository,
                                twin.id,
                                session,
                                twin.planned_session_id,
                                self.zones,
                            )
                    else:
                        actual_id = self.repository.create_actual_session(session)
                        result.activities_synced += 1
                        result.session_ids.append(actual_id)
                        if auto_match(self.repository, actual_id, session, self.zones):
                            result.activities_matched += 1
                    # The Muscu log of that day may already be saved; a day
                    # guessed from the sync time could pair the wrong one.
                    if session.sport == "strength" and activity.start_time_known:
                        link_garmin_strength([session.date])
                    # Still without its log: a session awaiting its loads.
                    if session.sport == "strength":
                        open_garmin_draft(
                            actual_id, session.date, activity.exercise_summaries
                        )
                    if streams is not None and not self._save_streams(
                        actual_id, streams
                    ):
                        result.errors.append(
                            f"Flux non enregistrés pour la séance {actual_id}."
                        )
                    result.last_activity_date = activity.start_time.date()

                    logger.info(
                        f"Synced: {activity.activity_name} ({activity.start_time.date()})"
                    )

                except Exception as e:
                    from arete.garmin.sync_budget import SyncStopped

                    if isinstance(e, SyncStopped):
                        raise
                    error_msg = f"Failed to sync activity {activity.activity_id}: {e}"
                    logger.error(error_msg)
                    result.errors.append(error_msg)
                yield SyncProgress("processing", index + 1, total)

            if self.scan_incomplete:
                result.errors.append(
                    "Limite de lecture atteinte ; historique incomplet."
                )
            result.success = not result.errors
            logger.info(
                f"Sync complete: {result.activities_synced} synced, "
                f"{result.activities_merged} merged into Strava rows, "
                f"{result.activities_skipped} skipped, "
                f"{len(result.errors)} errors"
            )

        except (GarminAuthError, Exception) as e:
            result.errors.append(f"Garmin API error: {e}")
            logger.error(f"Sync failed: {e}")

        yield result

    def _is_already_synced(self, activity_id: int) -> bool:
        """Check if activity is already in database."""
        return self.repository.has_garmin_activity(activity_id)

    def _enrich_from_fit(
        self, session: ActualSession, fit_path: Path
    ) -> tuple[ActualSession, ActivityStreams | None]:
        """Enrich session with detailed data from FIT file, and keep its streams."""
        streams = None
        try:
            parser = FITParser(zones=self.zones)
            parsed = parser.parse_file(fit_path, detailed=True)

            # Update with more detailed data from FIT
            if parsed.hr_zones:
                session.hr_zones_json = parsed.hr_zones.to_json()
            session.laps_json = laps_to_json(parsed) or session.laps_json
            if session.avg_pace_sec_km is None:
                session.avg_pace_sec_km = pace_from_speed(
                    parsed.avg_speed_mps, session.sport
                )

            # Update cadence from FIT (may be more accurate)
            if parsed.avg_cadence:
                session.avg_cadence = parsed.avg_cadence
            if parsed.max_cadence:
                session.max_cadence = parsed.max_cadence

            session.source_file = str(fit_path.name)
            streams = from_time_series(parsed.time_series, session.sport)

        except Exception as e:
            logger.warning(f"Could not parse FIT file {fit_path}: {e}")

        return session, streams

    def _save_streams(self, actual_id: int, streams: ActivityStreams) -> bool:
        """Keep a session's streams; a failure leaves the session without them."""
        try:
            self.repository.save_activity_streams(actual_id, streams)
            return True
        except Exception as e:
            logger.warning(
                "Could not store the streams of session %s: %s", actual_id, e
            )
            return False

    def reprocess_existing(self, fit_dir: Path | None = None) -> dict[str, int]:
        """Fill analytics columns on already-synced Garmin sessions.

        Recomputes pace from speed, re-reads laps / HR zones from the FIT files on
        disk and fetches the activity names from Garmin. Idempotent.
        """
        fit_dir = fit_dir or config.fit_dir
        sessions = [
            s
            for s in self.repository.list_actual_sessions(limit=10000)
            if s.source == ActivitySource.GARMIN_CONNECT and s.id is not None
        ]
        if not sessions:
            return {"sessions": 0, "updated": 0, "named": 0}

        names: dict[str, str] = {}
        try:
            dates = [s.date for s in sessions]
            for data in self.client.activities(min(dates), max(dates)):
                if isinstance(data, dict) and data.get("activityId"):
                    names[str(data["activityId"])] = data.get("activityName") or ""
        except Exception as e:
            logger.warning("Could not fetch activity names: %s", e)

        updated = named = matched = kept = 0
        # Strength sessions typed in the Log complete the planned strength session of the day
        from arete.strength.repository import StrengthRepository

        for logged in StrengthRepository().list_sessions(limit=1000):
            if complete_planned(self.repository, logged.date, "strength"):
                matched += 1
        for session in sessions:
            if (
                session.planned_session_id is None
                and session.id is not None
                and auto_match(self.repository, session.id, session, self.zones)
            ):
                matched += 1
            fields: dict[str, Any] = {}
            if session.avg_pace_sec_km is None:
                pace = pace_from_speed(session.avg_speed_mps, session.sport)
                if pace:
                    fields["avg_pace_sec_km"] = pace
            if session.moving_time_sec is None and session.duration_sec:
                fields["moving_time_sec"] = session.duration_sec
            if not session.name and names.get(session.garmin_activity_id or ""):
                fields["name"] = names[session.garmin_activity_id or ""]
                named += 1
            fit_path = fit_dir / f"{session.garmin_activity_id}.fit"
            if fit_path.exists():
                try:
                    parsed = FITParser(zones=self.zones).parse_file(
                        fit_path, detailed=True
                    )
                    laps = laps_to_json(parsed)
                    if laps:
                        fields["laps_json"] = laps
                    if parsed.hr_zones and parsed.hr_zones.total_sec:
                        fields["hr_zones_json"] = parsed.hr_zones.to_json()
                    streams = from_time_series(parsed.time_series, session.sport)
                    if (
                        streams
                        and session.id
                        and self._save_streams(session.id, streams)
                    ):
                        kept += 1
                except Exception as e:
                    logger.warning("FIT reparse failed for %s: %s", fit_path, e)
            elif session.laps_json:
                # No FIT on disk: per-lap average HR is the next best sample.
                zones = zones_from_laps(session.laps_json, self.zones)
                if zones:
                    fields["hr_zones_json"] = zones
            if fields:
                assert session.id is not None
                self.repository.update_actual_session_fields(session.id, **fields)
                updated += 1
        logger.info(
            "Reprocessed %d Garmin sessions (%d updated, %d named, %d matched, "
            "%d with streams)",
            len(sessions),
            updated,
            named,
            matched,
            kept,
        )
        return {
            "sessions": len(sessions),
            "updated": updated,
            "named": named,
            "matched": matched,
            "streams": kept,
        }

    def refresh_threshold(self) -> dict[str, Any]:
        """Adopt Garmin's latest threshold, and rebuild the zone model with it."""
        outcome = refresh_threshold(self.client)
        if outcome.get("updated"):
            self._zones = None  # next session is bucketed on the new threshold
        return outcome

    def recompute_zones(self, fit_dir: Path | None = None) -> dict[str, Any]:
        """Rewrite every session's HR zones with the athlete's current model.

        Uses the FIT samples when the file is on disk, lap averages otherwise.
        Needs no Garmin connection: run it after changing the threshold.
        """
        fit_dir = fit_dir or config.fit_dir
        zones = self.zones
        sessions = [
            s for s in self.repository.list_actual_sessions(limit=10000) if s.id
        ]
        from_fit = from_laps = unchanged = 0

        for session in sessions:
            payload: str | None = None
            fit_path = fit_dir / f"{session.garmin_activity_id}.fit"
            if session.garmin_activity_id and fit_path.exists():
                try:
                    parsed = FITParser(zones=zones).parse_file(fit_path)
                    if parsed.hr_zones and parsed.hr_zones.total_sec:
                        payload = parsed.hr_zones.to_json()
                        from_fit += 1
                except Exception as e:
                    logger.warning("FIT reparse failed for %s: %s", fit_path, e)
            if payload is None:
                payload = zones_from_laps(session.laps_json, zones)
                if payload:
                    from_laps += 1
            if payload is None or payload == session.hr_zones_json:
                unchanged += 1
                continue
            assert session.id is not None
            self.repository.update_actual_session_fields(
                session.id, hr_zones_json=payload
            )

        logger.info(
            "Recomputed HR zones on %s (%d from FIT, %d from laps, %d unchanged)",
            zones.basis,
            from_fit,
            from_laps,
            unchanged,
        )
        return {
            "sessions": len(sessions),
            "from_fit": from_fit,
            "from_laps": from_laps,
            "unchanged": unchanged,
            "model": zones.as_dict(),
        }

    def get_user_summary(self) -> dict[str, Any]:
        """Garmin profile of the authenticated user."""
        return self.client.profile()
