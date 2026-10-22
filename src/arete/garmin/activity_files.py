"""FIT, TCX and GPX activity files, read into one shape: ``ParsedActivity``.

Any watch exports one of these (Coros, Polar, Suunto, Wahoo, Apple Watch
through an export app, Garmin). FIT goes through ``FITParser``; TCX and GPX are
XML, read here with expat under a strict profile: no DOCTYPE, so no entity
(billion laughs, quadratic blowup) and no external reference (XXE); a bounded
element count; namespaces dropped, since TCX and GPX extensions travel under
several prefixes and versions.

Times come out as in a FIT parse: naive UTC, the device offset kept apart when
the file states one. Pure parsing: no database, no network.
"""

from __future__ import annotations

import gzip
import io
import math
import xml.parsers.expat
import zlib
from datetime import UTC, datetime, timedelta
from typing import Literal
from xml.etree.ElementTree import Element, TreeBuilder

from arete.features.hr_zones import ZoneModel
from arete.garmin.fit_parser import FITParser, HRZoneData, ParsedActivity
from arete.garmin.models import canonical_sport
from arete.garmin.streams import STRIDE_CADENCE_SPORTS
from arete.garmin.time_series import (
    LapData,
    LapIntensity,
    TimeSeriesData,
    TimeSeriesPoint,
    WorkoutStructure,
)

ActivityFormat = Literal["fit", "tcx", "gpx"]

#: One activity file, after decompression.
MAX_FILE_BYTES = 10 * 1024 * 1024
#: XML elements per file: a 10 MB TCX holds about 400,000.
MAX_XML_ELEMENTS = 1_000_000
#: Track points per file: more than 48 hours at 1 Hz.
MAX_POINTS = 200_000
#: A longer silence between two GPS points is a pause, not movement.
PAUSE_GAP_SEC = 60
#: Elevation changes smaller than this are GPS or barometer noise.
ELEVATION_HYSTERESIS_M = 3.0
#: No activity lasts longer; also keeps sums inside the INTEGER columns.
MAX_DURATION_SEC = 7 * 86400
MAX_CALORIES = 50_000
#: Starts before this are a watch without a clock, not a recorded session.
EARLIEST_START = datetime(2000, 1, 1)
INVALID_START = (
    "Date de départ invalide : vérifie l’horloge de la montre ou refais l’export."
)


class ActivityFileError(ValueError):
    """A file Arete cannot import; the message is for the athlete (French)."""


def activity_format(filename: str) -> ActivityFormat | None:
    """The format an activity file's name announces (``.gz`` allowed)."""
    name = filename.lower().removesuffix(".gz")
    for fmt in ("fit", "tcx", "gpx"):
        if name.endswith(f".{fmt}"):
            return fmt
    return None


def gunzip_bounded(content: bytes) -> bytes:
    """A gzip payload's bytes, refused past ``MAX_FILE_BYTES`` (no gzip bomb)."""
    try:
        with gzip.GzipFile(fileobj=io.BytesIO(content)) as stream:
            data = stream.read(MAX_FILE_BYTES + 1)
    except (OSError, EOFError, zlib.error) as exc:
        raise ActivityFileError("Fichier compressé illisible.") from exc
    if len(data) > MAX_FILE_BYTES:
        raise ActivityFileError(
            "Fichier trop volumineux une fois décompressé (10 Mo maximum)."
        )
    return data


def parse_activity(
    fmt: ActivityFormat, content: bytes, zones: ZoneModel
) -> ParsedActivity:
    """One activity from a file's bytes; ``ActivityFileError`` otherwise."""
    if not content:
        raise ActivityFileError("Fichier vide.")
    if len(content) > MAX_FILE_BYTES:
        raise ActivityFileError("Fichier trop volumineux (10 Mo maximum).")
    if fmt == "fit":
        try:
            parsed = FITParser(zones=zones).parse_stream(
                io.BytesIO(content), detailed=True
            )
        except Exception as exc:  # fitparse raises its own errors and more
            raise ActivityFileError("Fichier FIT illisible ou corrompu.") from exc
        if parsed.session_count > 1:
            raise ActivityFileError(
                f"Ce fichier FIT contient {parsed.session_count} séances "
                "(multisport) : exporte chaque partie séparément."
            )
    else:
        root = _parse_xml(content, fmt)
        parsed = (_parse_tcx if fmt == "tcx" else _parse_gpx)(root, zones)
    if parsed.start_time is None:
        raise ActivityFileError(
            "Pas d’heure de départ : ce fichier décrit un itinéraire, "
            "pas une séance enregistrée."
        )
    latest = datetime.now(UTC).replace(tzinfo=None) + timedelta(days=1)
    if not EARLIEST_START <= parsed.start_time <= latest:
        raise ActivityFileError(
            INVALID_START.replace(" :", f" ({parsed.start_time:%d/%m/%Y}) :", 1)
        )
    if (parsed.duration_sec or parsed.elapsed_time_sec or 0) <= 0:
        raise ActivityFileError("Séance vide : aucune durée enregistrée.")
    if max(parsed.duration_sec or 0, parsed.elapsed_time_sec or 0) > MAX_DURATION_SEC:
        raise ActivityFileError("Durée invalide : plus de 7 jours d’enregistrement.")
    return parsed


# ─────────────────────────────────────────────────────────────────────────
# Safe XML
# ─────────────────────────────────────────────────────────────────────────


def _local(name: str) -> str:
    """``uri local`` (expat's namespace form) or ``prefix:local`` → ``local``."""
    return name.rsplit(" ", 1)[-1].rsplit(":", 1)[-1]


def _parse_xml(content: bytes, fmt: ActivityFormat) -> Element:
    """The document's tree, namespaces dropped; DTDs and entities refused."""
    label = fmt.upper()
    builder = TreeBuilder()
    count = 0

    def refuse(*_args: object) -> None:
        raise ActivityFileError(
            f"Fichier {label} refusé : il contient une déclaration XML "
            "(DOCTYPE ou entité) non autorisée."
        )

    def start(name: str, attributes: dict[str, str]) -> None:
        nonlocal count
        count += 1
        if count > MAX_XML_ELEMENTS:
            raise ActivityFileError(f"Fichier {label} trop complexe.")
        builder.start(_local(name), {_local(k): v for k, v in attributes.items()})

    parser = xml.parsers.expat.ParserCreate(namespace_separator=" ")
    parser.SetParamEntityParsing(xml.parsers.expat.XML_PARAM_ENTITY_PARSING_NEVER)
    parser.StartDoctypeDeclHandler = refuse
    parser.EntityDeclHandler = refuse
    parser.UnparsedEntityDeclHandler = refuse
    parser.ExternalEntityRefHandler = refuse  # type: ignore[assignment]
    parser.StartElementHandler = start
    parser.EndElementHandler = lambda name: builder.end(_local(name))
    parser.CharacterDataHandler = builder.data
    try:
        parser.Parse(content, True)
    except xml.parsers.expat.ExpatError as exc:
        raise ActivityFileError(f"Fichier {label} illisible : XML invalide.") from exc
    return builder.close()


def _child(element: Element | None, *path: str) -> Element | None:
    for name in path:
        if element is None:
            return None
        element = element.find(name)
    return element


def _text(element: Element | None, *path: str) -> str | None:
    found = _child(element, *path)
    text = found.text.strip() if found is not None and found.text else ""
    return text or None


def _number(
    value: str | None, low: float = -math.inf, high: float = math.inf
) -> float | None:
    """A finite number within [low, high], else None (bad values are dropped)."""
    if value is None:
        return None
    try:
        number = float(value)
    except ValueError:
        return None
    return number if math.isfinite(number) and low <= number <= high else None


def _time(value: str | None) -> tuple[datetime, int | None] | None:
    """(naive UTC instant, the stated UTC offset in seconds or None)."""
    if not value:
        return None
    try:
        stamp = datetime.fromisoformat(value.strip())
    except ValueError:
        return None
    if stamp.tzinfo is None:  # GPX and TCX times are UTC by definition
        return stamp, None
    delta = stamp.utcoffset()
    offset = int(delta.total_seconds()) if delta is not None else 0
    try:
        utc = stamp.astimezone(UTC).replace(tzinfo=None)
    except OverflowError as exc:  # 0001-01-01 with a positive offset
        raise ActivityFileError(INVALID_START) from exc
    return utc, offset or None


def _extension_value(element: Element, names: tuple[str, ...]) -> str | None:
    """First of ``names`` anywhere under the point's extensions."""
    extensions = element.find("extensions")
    if extensions is None:
        extensions = element.find("Extensions")
    if extensions is None:
        return None
    for node in extensions.iter():
        if node.tag in names and node.text and node.text.strip():
            return node.text.strip()
    return None


def _haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    radius = 6_371_000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * radius * math.asin(math.sqrt(min(1.0, a)))


# ─────────────────────────────────────────────────────────────────────────
# Points → activity (shared by TCX and GPX)
# ─────────────────────────────────────────────────────────────────────────


def _point(
    when: str | None,
    lat: float | None,
    lon: float | None,
    altitude: str | None,
    distance: str | None,
    heart_rate: str | None,
    cadence: str | None,
    power: str | None,
    speed: str | None,
) -> tuple[TimeSeriesPoint, int | None] | None:
    stamp = _time(when)
    if stamp is None:
        return None
    hr = _number(heart_rate, 20, 260)
    cad = _number(cadence, 0, 300)
    watts = _number(power, 0, 3000)
    return (
        TimeSeriesPoint(
            timestamp=stamp[0],
            heart_rate=None if hr is None else int(round(hr)),
            speed_mps=_number(speed, 0, 40),
            cadence=None if cad is None else int(round(cad)),
            power=None if watts is None else int(round(watts)),
            altitude=_number(altitude, -500, 9000),
            distance_m=_number(distance, 0, 2_000_000),
            lat=lat,
            lon=lon,
        ),
        stamp[1],
    )


def _position(lat: str | None, lon: str | None) -> tuple[float | None, float | None]:
    la, lo = _number(lat, -90, 90), _number(lon, -180, 180)
    return (la, lo) if la is not None and lo is not None else (None, None)


def _fill_distance_and_speed(segments: list[list[TimeSeriesPoint]]) -> None:
    """Cumulative distance from GPS when the file has none, and speeds from it.

    Distance does not grow across a segment break (a pause). Speed is the
    distance over the time since the previous point, averaged over five
    points, since GPS steps are noisy one by one.
    """
    total = 0.0
    has_distance = any(p.distance_m is not None for seg in segments for p in seg)
    for segment in segments:
        previous: TimeSeriesPoint | None = None
        for point in segment:
            if not has_distance:
                if (
                    previous is not None
                    and None not in (point.lat, point.lon, previous.lat, previous.lon)
                    and (point.timestamp - previous.timestamp).total_seconds()
                    <= PAUSE_GAP_SEC
                ):
                    total += _haversine_m(
                        previous.lat,  # type: ignore[arg-type]
                        previous.lon,  # type: ignore[arg-type]
                        point.lat,  # type: ignore[arg-type]
                        point.lon,  # type: ignore[arg-type]
                    )
                point.distance_m = round(total, 1) if point.lat is not None else None
            previous = point
    for segment in segments:
        if any(p.speed_mps is not None for p in segment):
            continue
        raw: list[float | None] = [None]
        for before, point in zip(segment, segment[1:], strict=False):
            dt = (point.timestamp - before.timestamp).total_seconds()
            if 0 < dt <= PAUSE_GAP_SEC and None not in (
                point.distance_m,
                before.distance_m,
            ):
                step = point.distance_m - before.distance_m  # type: ignore[operator]
                raw.append(max(0.0, step) / dt)
            else:
                raw.append(None)
        for index, point in enumerate(segment):
            window = [v for v in raw[max(0, index - 2) : index + 3] if v is not None]
            point.speed_mps = sum(window) / len(window) if window else None


def _elevation(points: list[TimeSeriesPoint]) -> tuple[float, float]:
    """(ascent, descent) in metres, ignoring changes under the hysteresis."""
    ascent = descent = 0.0
    reference: float | None = None
    for point in points:
        if point.altitude is None:
            continue
        if reference is None:
            reference = point.altitude
        elif point.altitude - reference >= ELEVATION_HYSTERESIS_M:
            ascent += point.altitude - reference
            reference = point.altitude
        elif reference - point.altitude >= ELEVATION_HYSTERESIS_M:
            descent += reference - point.altitude
            reference = point.altitude
    return round(ascent, 1), round(descent, 1)


def _stride_cadence(points: list[TimeSeriesPoint], sport: str) -> None:
    """Foot cadence in strides per minute, the FIT convention the streams double.

    Most exports write strides (about 85); some write steps (about 170). A
    median above 130 can only be steps for a human gait: halve it.
    """
    values = sorted(p.cadence for p in points if p.cadence)
    if sport not in STRIDE_CADENCE_SPORTS or not values:
        return
    if values[len(values) // 2] > 130:
        for point in points:
            if point.cadence is not None:
                point.cadence = int(round(point.cadence / 2))


def _hr_zones(points: list[TimeSeriesPoint], zones: ZoneModel) -> HRZoneData:
    samples: list[tuple[int, int]] = []
    for before, point in zip(points, points[1:], strict=False):
        dt = (point.timestamp - before.timestamp).total_seconds()
        # As FITParser: the sample's HR over the time since the previous one.
        if point.heart_rate and 0 < dt <= 30:
            samples.append((point.heart_rate, int(dt)))
    seconds = zones.seconds_in_zones(samples)
    return HRZoneData(
        zone1_sec=seconds["z1"],
        zone2_sec=seconds["z2"],
        zone3_sec=seconds["z3"],
        zone4_sec=seconds["z4"],
        zone5_sec=seconds["z5"],
    )


def _summarise(
    segments: list[list[TimeSeriesPoint]],
    offsets: list[int],
    activity: ParsedActivity,
    zones: ZoneModel,
) -> ParsedActivity:
    """Fill what the points alone say; the caller's values (laps) win."""
    _fill_distance_and_speed(segments)
    points = [p for segment in segments for p in segment]
    if len(points) > MAX_POINTS:
        raise ActivityFileError("Trop de points dans ce fichier (200 000 maximum).")
    _stride_cadence(points, canonical_sport(activity.sport))
    if offsets:
        activity.utc_offset_sec = offsets[0]
    if not points:
        return activity
    start = points[0].timestamp
    for point in points:
        point.elapsed_sec = max(0, int((point.timestamp - start).total_seconds()))
    activity.start_time = activity.start_time or start
    activity.end_time = points[-1].timestamp
    activity.elapsed_time_sec = activity.elapsed_time_sec or int(
        (points[-1].timestamp - activity.start_time).total_seconds()
    )
    if not activity.duration_sec:
        moving = 0.0
        for segment in segments:
            for before, point in zip(segment, segment[1:], strict=False):
                dt = (point.timestamp - before.timestamp).total_seconds()
                if 0 < dt <= PAUSE_GAP_SEC:
                    moving += dt
        activity.duration_sec = int(moving) or activity.elapsed_time_sec
    distances = [p.distance_m for p in points if p.distance_m is not None]
    if not activity.distance_m and distances:
        activity.distance_m = round(max(distances), 1)
    if activity.distance_m and activity.duration_sec and not activity.avg_speed_mps:
        activity.avg_speed_mps = round(activity.distance_m / activity.duration_sec, 3)
    speeds = [p.speed_mps for p in points if p.speed_mps is not None]
    if speeds and not activity.max_speed_mps:
        activity.max_speed_mps = round(max(speeds), 3)
    heart_rates = [p.heart_rate for p in points if p.heart_rate]
    if heart_rates:
        activity.avg_hr = activity.avg_hr or round(sum(heart_rates) / len(heart_rates))
        activity.max_hr = activity.max_hr or max(heart_rates)
    cadences = [p.cadence for p in points if p.cadence]
    if cadences and not activity.avg_cadence:
        factor = 2 if canonical_sport(activity.sport) in STRIDE_CADENCE_SPORTS else 1
        activity.avg_cadence = round(sum(cadences) / len(cadences) * factor)
        activity.max_cadence = max(cadences) * factor
    if not activity.ascent_m and not activity.descent_m:
        activity.ascent_m, activity.descent_m = _elevation(points)
    located = next((p for p in points if p.lat is not None), None)
    if located is not None:
        activity.start_lat, activity.start_lon = located.lat, located.lon
    activity.hr_zones = _hr_zones(points, zones)
    activity.time_series = TimeSeriesData(points=points)
    return activity


# ─────────────────────────────────────────────────────────────────────────
# TCX (Garmin Training Center, exported by Polar, Suunto, Coros, Wahoo…)
# ─────────────────────────────────────────────────────────────────────────

#: TCX lap intensity values (schema v2: Active, Resting).
_TCX_INTENSITY = {"active": LapIntensity.ACTIVE, "resting": LapIntensity.REST}


def _parse_tcx(root: Element, zones: ZoneModel) -> ParsedActivity:
    if root.tag != "TrainingCenterDatabase":
        raise ActivityFileError("Fichier TCX invalide : ce n’est pas un export TCX.")
    activities = root.findall("Activities/Activity")
    if not activities:
        raise ActivityFileError("Aucune activité dans ce fichier TCX.")
    if len(activities) > 1:
        raise ActivityFileError(
            "Ce fichier TCX contient plusieurs activités : exporte-les une par une."
        )
    node = activities[0]
    activity = ParsedActivity(sport=(node.get("Sport") or "other").strip().lower())
    activity.sport = canonical_sport(activity.sport)
    segments: list[list[TimeSeriesPoint]] = []
    offsets: list[int] = []
    laps: list[LapData] = []
    timer = distance = calories = 0.0
    max_speed: float | None = None
    for index, lap in enumerate(node.findall("Lap"), start=1):
        lap_start = _time(lap.get("StartTime"))
        lap_time = _number(_text(lap, "TotalTimeSeconds"), 0, 7 * 86400) or 0.0
        lap_distance = _number(_text(lap, "DistanceMeters"), 0, 2_000_000) or 0.0
        lap_max_speed = _number(_text(lap, "MaximumSpeed"), 0, 40)
        timer += lap_time
        distance += lap_distance
        calories += _number(_text(lap, "Calories"), 0, 20_000) or 0.0
        if lap_max_speed is not None:
            max_speed = max(max_speed or 0.0, lap_max_speed)
        avg_hr = _number(_text(lap, "AverageHeartRateBpm", "Value"), 20, 260)
        lap_max_hr = _number(_text(lap, "MaximumHeartRateBpm", "Value"), 20, 260)
        cadence = _number(_text(lap, "Cadence"), 0, 300) or _number(
            _extension_value(lap, ("AvgRunCadence",)), 0, 300
        )
        laps.append(
            LapData(
                lap_number=index,
                intensity=_TCX_INTENSITY.get(
                    (_text(lap, "Intensity") or "").lower(), LapIntensity.OTHER
                ),
                trigger=(_text(lap, "TriggerMethod") or "unknown").lower(),
                duration_sec=lap_time,
                start_time=lap_start[0] if lap_start else None,
                distance_m=lap_distance,
                avg_speed_mps=round(lap_distance / lap_time, 3) if lap_time else None,
                max_speed_mps=lap_max_speed,
                avg_hr=None if avg_hr is None else int(avg_hr),
                max_hr=None if lap_max_hr is None else int(lap_max_hr),
                avg_cadence=None if cadence is None else int(cadence),
            )
        )
        if activity.start_time is None and lap_start is not None:
            activity.start_time = lap_start[0]
            if lap_start[1] is not None:
                offsets.append(lap_start[1])
        for track in lap.findall("Track"):
            segment: list[TimeSeriesPoint] = []
            for trackpoint in track.findall("Trackpoint"):
                lat, lon = _position(
                    _text(trackpoint, "Position", "LatitudeDegrees"),
                    _text(trackpoint, "Position", "LongitudeDegrees"),
                )
                found = _point(
                    _text(trackpoint, "Time"),
                    lat,
                    lon,
                    altitude=_text(trackpoint, "AltitudeMeters"),
                    distance=_text(trackpoint, "DistanceMeters"),
                    heart_rate=_text(trackpoint, "HeartRateBpm", "Value"),
                    cadence=_text(trackpoint, "Cadence")
                    or _extension_value(trackpoint, ("RunCadence",)),
                    power=_extension_value(trackpoint, ("Watts",)),
                    speed=_extension_value(trackpoint, ("Speed",)),
                )
                if found is not None:
                    segment.append(found[0])
                    if found[1] is not None:
                        offsets.append(found[1])
            if segment:
                segments.append(segment)
    activity.duration_sec = int(round(timer))
    activity.distance_m = round(distance, 1)
    activity.calories = int(round(min(calories, MAX_CALORIES)))
    activity.max_speed_mps = max_speed
    laps_hr = [(lap.avg_hr, lap.duration_sec) for lap in laps if lap.avg_hr]
    if laps_hr and sum(t for _, t in laps_hr):
        activity.avg_hr = round(
            sum(hr * t for hr, t in laps_hr) / sum(t for _, t in laps_hr)
        )
    maxima = [lap.max_hr for lap in laps if lap.max_hr]
    activity.max_hr = max(maxima) if maxima else None
    if laps:
        structure = WorkoutStructure(laps=laps)
        structure.analyze()
        activity.workout_structure = structure
    return _summarise(segments, offsets, activity, zones)


# ─────────────────────────────────────────────────────────────────────────
# GPX (a track; heart rate, cadence and power in the Garmin/Cluetrust extensions)
# ─────────────────────────────────────────────────────────────────────────


def _parse_gpx(root: Element, zones: ZoneModel) -> ParsedActivity:
    if root.tag != "gpx":
        raise ActivityFileError("Fichier GPX invalide : ce n’est pas un export GPX.")
    tracks = root.findall("trk")
    if not tracks:
        raise ActivityFileError(
            "Aucune trace dans ce fichier GPX : ce n’est pas une séance enregistrée."
        )
    if len(tracks) > 1:
        raise ActivityFileError(
            "Ce fichier GPX contient plusieurs traces : exporte les séances une par une."
        )
    track = tracks[0]
    activity = ParsedActivity(sport=canonical_sport(_text(track, "type")))
    activity.name = (_text(track, "name") or _text(root, "metadata", "name") or "")[
        :200
    ] or None
    segments: list[list[TimeSeriesPoint]] = []
    offsets: list[int] = []
    for trkseg in track.findall("trkseg"):
        segment: list[TimeSeriesPoint] = []
        for trkpt in trkseg.findall("trkpt"):
            lat, lon = _position(trkpt.get("lat"), trkpt.get("lon"))
            found = _point(
                _text(trkpt, "time"),
                lat,
                lon,
                altitude=_text(trkpt, "ele"),
                distance=None,
                heart_rate=_extension_value(trkpt, ("hr", "heartrate")),
                cadence=_extension_value(trkpt, ("cad", "cadence")),
                power=_extension_value(trkpt, ("power", "PowerInWatts", "watts")),
                speed=_text(trkpt, "speed") or _extension_value(trkpt, ("speed",)),
            )
            if found is not None:
                segment.append(found[0])
                if found[1] is not None:
                    offsets.append(found[1])
        if segment:
            segments.append(segment)
    return _summarise(segments, offsets, activity, zones)
