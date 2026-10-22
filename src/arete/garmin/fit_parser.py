"""FIT file parser for Garmin activities.

Parses .FIT files and extracts key metrics.
Uses fitparse library for FIT protocol decoding.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any, BinaryIO

from arete.features.hr_zones import ZoneModel

if TYPE_CHECKING:
    from arete.garmin.time_series import TimeSeriesData, WorkoutStructure

logger = logging.getLogger(__name__)


def _first_present(fields: dict[str, Any], *names: str) -> Any:
    """The first of ``names`` with a value (0 included), else None."""
    for name in names:
        if fields.get(name) is not None:
            return fields[name]
    return None


def laps_to_json(parsed: Any) -> str | None:
    """Serialize FIT laps in the shape the analytics expect (Strava lap fields).

    ``intensity`` (warmup/active/rest/cooldown) is the FIT lap's own: it is what
    tells a structured workout's work intervals from its recoveries.
    """
    structure = getattr(parsed, "workout_structure", None)
    if not structure or not structure.laps:
        return None
    laps = []
    for lap in structure.laps:
        intensity = getattr(lap, "intensity", None)
        laps.append(
            {
                "lap_index": lap.lap_number,
                "distance": round(lap.distance_m, 1),
                "elapsed_time": int(lap.duration_sec),
                "moving_time": int(lap.duration_sec),
                "average_speed": lap.avg_speed_mps,
                "average_heartrate": lap.avg_hr,
                "max_heartrate": lap.max_hr,
                "average_cadence": lap.avg_cadence,
                "total_elevation_gain": None,  # not exposed per lap by the parser
                "intensity": getattr(intensity, "value", intensity),
            }
        )
    return json.dumps(laps)


@dataclass
class HRZoneData:
    """Heart rate zone distribution."""

    # Boundaries come from ``arete.features.hr_zones``: threshold HR when the
    # athlete has one, max HR otherwise.
    zone1_sec: int = 0  # Recovery
    zone2_sec: int = 0  # Endurance
    zone3_sec: int = 0  # Tempo
    zone4_sec: int = 0  # Threshold
    zone5_sec: int = 0  # VO2max

    def to_json(self) -> str:
        """Convert to JSON string."""
        # Same shape as the Strava import ({"z1": sec, ...}) so analytics can merge both
        return json.dumps(
            {
                "z1": self.zone1_sec,
                "z2": self.zone2_sec,
                "z3": self.zone3_sec,
                "z4": self.zone4_sec,
                "z5": self.zone5_sec,
            }
        )

    @property
    def total_sec(self) -> int:
        """Total time with HR data."""
        return (
            self.zone1_sec
            + self.zone2_sec
            + self.zone3_sec
            + self.zone4_sec
            + self.zone5_sec
        )

    @property
    def dominant_zone(self) -> str:
        """Zone with most time."""
        zones = {
            "Z1": self.zone1_sec,
            "Z2": self.zone2_sec,
            "Z3": self.zone3_sec,
            "Z4": self.zone4_sec,
            "Z5": self.zone5_sec,
        }
        return max(zones, key=zones.get)  # type: ignore


@dataclass
class ParsedActivity:
    """Parsed activity data from FIT file."""

    # Basic info
    sport: str = "running"
    sub_sport: str | None = None
    name: str | None = None

    # Timestamps: UTC, without tzinfo (the FIT session's own clock)
    start_time: datetime | None = None
    end_time: datetime | None = None
    #: The device's offset from UTC when the file says it (FIT ``activity``
    #: local timestamp, an ISO offset in TCX/GPX), else None.
    utc_offset_sec: int | None = None

    # Core metrics
    duration_sec: int = 0
    elapsed_time_sec: int = 0
    distance_m: float = 0.0
    calories: int = 0

    # Heart rate
    avg_hr: int | None = None
    max_hr: int | None = None
    hr_zones: HRZoneData = field(default_factory=HRZoneData)

    # Speed/Pace
    avg_speed_mps: float | None = None
    max_speed_mps: float | None = None

    # Elevation
    ascent_m: float = 0.0
    descent_m: float = 0.0

    # GPS
    start_lat: float | None = None
    start_lon: float | None = None

    # Cadence (running/cycling)
    avg_cadence: int | None = None
    max_cadence: int | None = None

    # Power (if available)
    avg_power: int | None = None
    max_power: int | None = None
    normalized_power: int | None = None

    # Training effect (Garmin-specific)
    training_effect: float | None = None
    anaerobic_training_effect: float | None = None

    # Source file
    source_file: str | None = None

    # Detailed time series (only populated when parse_detailed=True)
    time_series: TimeSeriesData | None = None

    # Workout structure with laps (only populated when parse_detailed=True)
    workout_structure: WorkoutStructure | None = None

    @property
    def duration_min(self) -> float:
        """Duration in minutes."""
        return self.duration_sec / 60.0

    @property
    def distance_km(self) -> float:
        """Distance in kilometers."""
        return self.distance_m / 1000.0

    @property
    def avg_pace_sec_km(self) -> int | None:
        """Average pace in seconds per km."""
        if self.avg_speed_mps and self.avg_speed_mps > 0:
            return int(1000 / self.avg_speed_mps)
        return None

    @property
    def avg_pace_str(self) -> str | None:
        """Average pace as MM:SS string."""
        pace = self.avg_pace_sec_km
        if pace is None:
            return None
        minutes = pace // 60
        seconds = pace % 60
        return f"{minutes}:{seconds:02d}"

    def infer_session_type(self) -> str:
        """Infer session type from metrics."""
        if self.hr_zones.total_sec == 0:
            return "other"

        dominant = self.hr_zones.dominant_zone

        # Check for intervals (high variability in zones)
        z4_z5_pct = (self.hr_zones.zone4_sec + self.hr_zones.zone5_sec) / max(
            self.hr_zones.total_sec, 1
        )
        z1_z2_pct = (self.hr_zones.zone1_sec + self.hr_zones.zone2_sec) / max(
            self.hr_zones.total_sec, 1
        )

        if z4_z5_pct > 0.3 and z1_z2_pct > 0.3:
            return "intervals"

        # Check duration for long run
        if self.duration_min > 75 and dominant in ("Z1", "Z2"):
            return "long_run"

        # Zone-based classification
        zone_to_type = {
            "Z1": "recovery",
            "Z2": "endurance",
            "Z3": "tempo",
            "Z4": "intervals",
            "Z5": "intervals",
        }

        return zone_to_type.get(dominant, "endurance")


class FITParser:
    """Parser for Garmin FIT files.

    Extracts activity data from .FIT files using fitparse library.
    """

    def __init__(self, zones: ZoneModel | None = None, hr_max: int | None = None):
        """Initialize parser.

        Args:
            zones: Zone model to bucket heart rates with. Defaults to the model
                built from ``hr_max`` (or the generic default when neither is given).
            hr_max: Maximum heart rate, when no zone model is supplied.
        """
        self.zones = zones or ZoneModel.from_reference(max_hr=hr_max)

    @property
    def hr_max(self) -> int:
        """Reference heart rate the zones are built on."""
        return self.zones.reference

    def _get_hr_zone(self, hr: int) -> int:
        """Get zone number (1-5) for a heart rate value."""
        return self.zones.zone_of(hr)

    def parse_file(
        self, file_path: str | Path, detailed: bool = False
    ) -> ParsedActivity:
        """Parse a FIT file from disk.

        Args:
            file_path: Path to .FIT file.
            detailed: If True, extract full time series data for in-depth analysis.

        Returns:
            ParsedActivity with extracted data.

        Raises:
            FileNotFoundError: If file doesn't exist.
            ValueError: If file is not a valid FIT file.
        """
        path = Path(file_path)
        if not path.exists():
            raise FileNotFoundError(f"FIT file not found: {path}")

        if not path.suffix.lower() == ".fit":
            raise ValueError(f"Not a FIT file: {path}")

        with open(path, "rb") as f:
            activity = self.parse_stream(f, detailed=detailed)
            activity.source_file = path.name

        return activity

    def parse_stream(self, stream: BinaryIO, detailed: bool = False) -> ParsedActivity:
        """Parse a FIT file from a binary stream.

        Args:
            stream: Binary file-like object containing FIT data.
            detailed: If True, extract full time series data for in-depth analysis.

        Returns:
            ParsedActivity with extracted data.
        """
        try:
            from fitparse import FitFile
        except ImportError as err:
            logger.error("fitparse not installed. Install with: pip install fitparse")
            raise ImportError(
                "fitparse library required for FIT parsing. Install with: pip install fitparse"
            ) from err

        fit_file = FitFile(stream)
        activity = ParsedActivity()

        # Collect HR samples for zone calculation
        hr_samples: list[tuple[int, int]] = []  # (hr, duration_sec)
        last_timestamp: datetime | None = None

        # Time series data (only if detailed=True)
        time_series_points: list[Any] = []
        start_time: datetime | None = None

        # Lap data (only if detailed=True)
        lap_records: list[dict[str, Any]] = []

        for record in fit_file.get_messages():
            record_type = record.name

            if record_type == "session":
                self._parse_session_record(record, activity)
            elif record_type == "activity":
                self._parse_activity_record(record, activity)
            elif record_type == "lap" and detailed:
                # Extract lap data for interval detection
                lap_data = self._extract_lap_data(record)
                if lap_data:
                    lap_records.append(lap_data)
            elif record_type == "record":
                # Individual data points (for HR zone calculation)
                hr, ts = self._extract_hr_from_record(record)
                if hr and ts:
                    if last_timestamp:
                        delta = (ts - last_timestamp).total_seconds()
                        if 0 < delta < 10:  # Reasonable sample interval
                            hr_samples.append((hr, int(delta)))
                    last_timestamp = ts

                # Extract full time series if detailed mode
                if detailed:
                    point = self._extract_time_series_point(record, start_time)
                    if point:
                        if start_time is None and point.timestamp:
                            start_time = point.timestamp
                        time_series_points.append(point)

        # Calculate HR zones from samples
        activity.hr_zones = self._calculate_hr_zones(hr_samples)

        # Attach time series if detailed mode
        if detailed and time_series_points:
            from arete.garmin.time_series import TimeSeriesData

            activity.time_series = TimeSeriesData(points=time_series_points)

        # Build workout structure from laps if detailed mode
        if detailed and lap_records:
            activity.workout_structure = self._build_workout_structure(lap_records)

        return activity

    def _extract_time_series_point(
        self, record: Any, start_time: datetime | None
    ) -> Any:
        """Extract a time series point from a record.

        Args:
            record: FIT record message
            start_time: Activity start time for elapsed calculation

        Returns:
            TimeSeriesPoint or None if no valid data
        """
        from arete.garmin.time_series import TimeSeriesPoint

        fields = {f.name: f.value for f in record.fields}

        ts = fields.get("timestamp")
        if not ts:
            return None

        elapsed = 0
        if start_time:
            elapsed = int((ts - start_time).total_seconds())

        point = TimeSeriesPoint(
            timestamp=ts,
            elapsed_sec=elapsed,
            heart_rate=fields.get("heart_rate"),
            # Older devices write only the 16-bit fields, newer ones both.
            speed_mps=_first_present(fields, "enhanced_speed", "speed"),
            cadence=fields.get("cadence"),
            power=fields.get("power"),
            altitude=_first_present(fields, "enhanced_altitude", "altitude"),
            distance_m=fields.get("distance"),
            stance_time=fields.get("stance_time"),
            stance_time_balance=fields.get("stance_time_balance"),
            step_length=fields.get("step_length"),
            vertical_oscillation=fields.get("vertical_oscillation"),
            vertical_ratio=fields.get("vertical_ratio"),
        )

        # GPS
        if "position_lat" in fields and fields["position_lat"]:
            point.lat = self._semicircles_to_degrees(fields["position_lat"])
        if "position_long" in fields and fields["position_long"]:
            point.lon = self._semicircles_to_degrees(fields["position_long"])

        return point

    def _parse_session_record(self, record: Any, activity: ParsedActivity) -> None:
        """Extract data from session record."""
        fields = {f.name: f.value for f in record.fields}

        # Sport
        if "sport" in fields and fields["sport"]:
            activity.sport = str(fields["sport"]).lower()
        if "sub_sport" in fields and fields["sub_sport"]:
            activity.sub_sport = str(fields["sub_sport"]).lower()

        # Timestamps
        if "start_time" in fields:
            activity.start_time = fields["start_time"]
        if "timestamp" in fields:
            activity.end_time = fields["timestamp"]

        # Duration
        if "total_timer_time" in fields and fields["total_timer_time"]:
            activity.duration_sec = int(fields["total_timer_time"])
        if "total_elapsed_time" in fields and fields["total_elapsed_time"]:
            activity.elapsed_time_sec = int(fields["total_elapsed_time"])

        # Distance
        if "total_distance" in fields and fields["total_distance"]:
            activity.distance_m = float(fields["total_distance"])

        # Calories
        if "total_calories" in fields and fields["total_calories"]:
            activity.calories = int(fields["total_calories"])

        # Heart rate
        if "avg_heart_rate" in fields and fields["avg_heart_rate"]:
            activity.avg_hr = int(fields["avg_heart_rate"])
        if "max_heart_rate" in fields and fields["max_heart_rate"]:
            activity.max_hr = int(fields["max_heart_rate"])

        # Speed
        if "avg_speed" in fields and fields["avg_speed"]:
            activity.avg_speed_mps = float(fields["avg_speed"])
        if "max_speed" in fields and fields["max_speed"]:
            activity.max_speed_mps = float(fields["max_speed"])

        # Elevation
        if "total_ascent" in fields and fields["total_ascent"]:
            activity.ascent_m = float(fields["total_ascent"])
        if "total_descent" in fields and fields["total_descent"]:
            activity.descent_m = float(fields["total_descent"])

        # Cadence: on runs the FIT field is avg_running_cadence, in strides/min;
        # store steps/min like the Garmin API and the Strava import
        if fields.get("avg_running_cadence"):
            strides = fields["avg_running_cadence"] + (
                fields.get("avg_fractional_cadence") or 0
            )
            activity.avg_cadence = round(strides * 2)
        elif "avg_cadence" in fields and fields["avg_cadence"]:
            activity.avg_cadence = int(fields["avg_cadence"])
        if fields.get("max_running_cadence"):
            strides = fields["max_running_cadence"] + (
                fields.get("max_fractional_cadence") or 0
            )
            activity.max_cadence = round(strides * 2)
        elif "max_cadence" in fields and fields["max_cadence"]:
            activity.max_cadence = int(fields["max_cadence"])

        # Power
        if "avg_power" in fields and fields["avg_power"]:
            activity.avg_power = int(fields["avg_power"])
        if "max_power" in fields and fields["max_power"]:
            activity.max_power = int(fields["max_power"])
        if "normalized_power" in fields and fields["normalized_power"]:
            activity.normalized_power = int(fields["normalized_power"])

        # Training effect
        if "total_training_effect" in fields and fields["total_training_effect"]:
            activity.training_effect = float(fields["total_training_effect"])
        if (
            "total_anaerobic_training_effect" in fields
            and fields["total_anaerobic_training_effect"]
        ):
            activity.anaerobic_training_effect = float(
                fields["total_anaerobic_training_effect"]
            )

        # GPS start position
        if "start_position_lat" in fields and fields["start_position_lat"]:
            activity.start_lat = self._semicircles_to_degrees(
                fields["start_position_lat"]
            )
        if "start_position_long" in fields and fields["start_position_long"]:
            activity.start_lon = self._semicircles_to_degrees(
                fields["start_position_long"]
            )

    def _parse_activity_record(self, record: Any, activity: ParsedActivity) -> None:
        """The device's UTC offset, from the activity record's two clocks.

        That record closes the file: its local timestamp is the end, on the
        watch's clock, so it gives the offset, never the start (which stays the
        session's UTC start).
        """
        fields = {f.name: f.value for f in record.fields}
        local, utc = fields.get("local_timestamp"), fields.get("timestamp")
        if isinstance(local, datetime) and isinstance(utc, datetime):
            # Time zones are whole quarter hours; the two stamps may differ by seconds.
            offset = round((local - utc).total_seconds() / 900) * 900
            if abs(offset) <= 14 * 3600:
                activity.utc_offset_sec = offset

    def _extract_hr_from_record(
        self, record: Any
    ) -> tuple[int | None, datetime | None]:
        """Extract HR and timestamp from a data record."""
        fields = {f.name: f.value for f in record.fields}

        hr = fields.get("heart_rate")
        ts = fields.get("timestamp")

        if hr and isinstance(hr, int) and ts:
            return hr, ts
        return None, None

    def _calculate_hr_zones(self, hr_samples: list[tuple[int, int]]) -> HRZoneData:
        """Calculate time in each HR zone from samples.

        Args:
            hr_samples: List of (heart_rate, duration_seconds) tuples.

        Returns:
            HRZoneData with time per zone.
        """
        seconds = self.zones.seconds_in_zones(hr_samples)
        return HRZoneData(
            zone1_sec=seconds["z1"],
            zone2_sec=seconds["z2"],
            zone3_sec=seconds["z3"],
            zone4_sec=seconds["z4"],
            zone5_sec=seconds["z5"],
        )

    def _semicircles_to_degrees(self, semicircles: int) -> float:
        """Convert FIT semicircles to degrees."""
        return semicircles * (180.0 / (2**31))

    def _extract_lap_data(self, record: Any) -> dict[str, Any] | None:
        """Extract lap data from a lap record.

        Args:
            record: FIT lap record message

        Returns:
            Dict with lap data or None if invalid
        """
        fields = {f.name: f.value for f in record.fields}

        # Must have at least duration
        if not fields.get("total_timer_time"):
            return None

        return {
            "intensity": fields.get("intensity"),
            "lap_trigger": str(fields.get("lap_trigger", "unknown")),
            "start_time": fields.get("start_time"),
            "duration_sec": float(fields.get("total_timer_time", 0)),
            "distance_m": float(fields.get("total_distance", 0)),
            # Use enhanced_avg_speed if available, fallback to avg_speed (None check to preserve 0 values)
            "avg_speed_mps": fields.get("enhanced_avg_speed")
            if fields.get("enhanced_avg_speed") is not None
            else fields.get("avg_speed"),
            "max_speed_mps": fields.get("enhanced_max_speed")
            if fields.get("enhanced_max_speed") is not None
            else fields.get("max_speed"),
            "avg_hr": fields.get("avg_heart_rate"),
            "max_hr": fields.get("max_heart_rate"),
            "avg_cadence": fields.get("avg_cadence")
            if fields.get("avg_cadence") is not None
            else fields.get("avg_running_cadence"),
            "avg_power": fields.get("avg_power"),
            "avg_stance_time": fields.get("avg_stance_time"),
            "avg_vertical_oscillation": fields.get("avg_vertical_oscillation"),
        }

    def _build_workout_structure(
        self, lap_records: list[dict[str, Any]]
    ) -> WorkoutStructure:
        """Build workout structure from lap records.

        Args:
            lap_records: List of lap data dicts

        Returns:
            WorkoutStructure with analyzed laps
        """
        from arete.garmin.time_series import LapData, LapIntensity, WorkoutStructure

        structure = WorkoutStructure()
        lap_counter = 0

        for lap_data in lap_records:
            # Skip session_end laps
            trigger = str(lap_data.get("lap_trigger", "")).lower()
            if trigger == "session_end":
                continue

            lap_counter += 1
            lap = LapData(
                lap_number=lap_counter,
                intensity=LapIntensity.from_fit_value(lap_data.get("intensity")),
                trigger=trigger,
                duration_sec=lap_data.get("duration_sec", 0),
                start_time=lap_data.get("start_time"),
                distance_m=lap_data.get("distance_m", 0),
                avg_speed_mps=lap_data.get("avg_speed_mps"),
                max_speed_mps=lap_data.get("max_speed_mps"),
                avg_hr=lap_data.get("avg_hr"),
                max_hr=lap_data.get("max_hr"),
                avg_cadence=lap_data.get("avg_cadence"),
                avg_power=lap_data.get("avg_power"),
                avg_stance_time=lap_data.get("avg_stance_time"),
                avg_vertical_oscillation=lap_data.get("avg_vertical_oscillation"),
            )
            structure.laps.append(lap)

        # Analyze the structure
        structure.analyze()

        return structure
