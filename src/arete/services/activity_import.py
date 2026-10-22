"""Activity files from any watch: FIT, TCX, GPX, or a ZIP of them.

The watch-agnostic path into ``actual_sessions`` (Garmin's program is paused;
Coros, Polar, Suunto, Wahoo and Apple Watch users export files). One owner:
the Journal's import and ``POST /garmin/upload-fit`` both come here, and an
imported session gets what a Garmin sync gives one: plan matching, the
strength link and draft, the streams, terrain and weather, the game evidence
(captured with the row) and the daily feedback catch-up.

Every file is parsed in full before anything is written: a corrupt file
leaves no row. A session that starts within ``DUPLICATE_START_SEC`` of one
already stored, whatever its source, is refused; so is one with the same
sport and duration on a day whose session has no start time (a manual entry).

Times: an imported start is stored on the athlete's clock, like Garmin's
``startTimeLocal``, so the comparison holds across sources. The offset is the
device's when the file states it (FIT), else the athlete's timezone.
"""

from __future__ import annotations

import io
import logging
import threading
import zipfile
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from pathlib import PurePosixPath
from typing import Literal
from zoneinfo import ZoneInfo

from arete.dataio import settings as settings_repo
from arete.dataio.settings import athlete_zone_model
from arete.features.hr_zones import ZoneModel
from arete.garmin.activity_files import (
    MAX_FILE_BYTES,
    ActivityFileError,
    ActivityFormat,
    activity_format,
    gunzip_bounded,
    parse_activity,
)
from arete.garmin.fit_parser import ParsedActivity, laps_to_json
from arete.garmin.models import ActivitySource, ActualSession, canonical_sport
from arete.garmin.repository import GarminRepository
from arete.garmin.streams import ActivityStreams, from_time_series
from arete.garmin.sync import auto_match, pace_from_speed
from arete.services.session_conditions import enrich_sessions
from arete.services.settings import zone_of
from arete.strength.drafts import open_garmin_draft
from arete.strength.logging_service import link_garmin_strength

logger = logging.getLogger(__name__)

#: Files per upload, an archive's members included (the browser sends one at a time).
MAX_FILES = 10
#: Two starts closer than this are the same workout (two watches, a re-export).
DUPLICATE_START_SEC = 300
#: Without a start time: same sport and day, duration within max(2 min, 10 %).
DUPLICATE_DURATION_SEC = 120
DUPLICATE_DURATION_SHARE = 0.10
#: Parses at once per process; a file is parsed in the request's worker thread.
MAX_PARSERS = 2
PARSE_WAIT_SEC = 30

SERVER_ERROR = "Import interrompu par une erreur du serveur : réessaie ce fichier."
UNSUPPORTED = "Format non pris en charge : importe un fichier .fit, .tcx, .gpx ou .zip."
SOURCES: dict[ActivityFormat, ActivitySource] = {
    "fit": ActivitySource.FIT_FILE,
    "tcx": ActivitySource.TCX_FILE,
    "gpx": ActivitySource.GPX_FILE,
}
#: How a duplicate's source reads in the refusal.
SOURCE_WORDS = {
    "garmin_connect": "Garmin",
    "fit_file": "fichier FIT",
    "tcx_file": "fichier TCX",
    "gpx_file": "fichier GPX",
    "manual": "saisie manuelle",
}
GZIP_MAGIC = b"\x1f\x8b"
ZIP_MAGIC = b"PK\x03\x04"

_parse_slots = threading.BoundedSemaphore(MAX_PARSERS)
#: The duplicate check and the insert, as one step per process.
_commit_lock = threading.Lock()


@dataclass(frozen=True)
class ImportOutcome:
    """What became of one file. ``message`` is for the athlete (French)."""

    filename: str
    status: Literal["imported", "duplicate", "error"]
    message: str
    session_id: int | None = None
    duplicate_of: int | None = None
    date: date | None = None
    sport: str | None = None
    duration_sec: int | None = None
    distance_m: float | None = None
    planned_session_id: int | None = None


def import_upload(filename: str, content: bytes) -> list[ImportOutcome]:
    """One uploaded file: an activity, or a ZIP of at most ``MAX_FILES``.

    Never raises for a file: every problem is that file's outcome.
    """
    name = _display_name(filename)
    outcomes: list[ImportOutcome] = []
    imported: list[int] = []
    try:
        for member, data in _members(name, content):
            if isinstance(data, ActivityFileError):
                outcomes.append(ImportOutcome(member, "error", str(data)))
                continue
            try:
                outcome = import_file(member, data)
            except Exception:  # noqa: BLE001 - one file's failure, not the batch's
                # The insert is one transaction: a failure before its commit
                # leaves no row, and nothing after it raises (_after_commit).
                logger.exception("Import of %s failed", member)
                outcome = ImportOutcome(member, "error", SERVER_ERROR)
            outcomes.append(outcome)
            if outcome.status == "imported" and outcome.session_id is not None:
                imported.append(outcome.session_id)
    except ActivityFileError as exc:  # the upload itself (archive, compression)
        outcomes.append(ImportOutcome(name, "error", str(exc)))
    if imported:
        # Terrain and weather under one 20 s budget for the whole upload.
        enrich_sessions(imported)  # never raises
    return outcomes


def import_file(filename: str, content: bytes) -> ImportOutcome:
    """Parse, check for a duplicate, then commit one activity file."""
    fmt = activity_format(filename)
    if fmt is None:
        return ImportOutcome(filename, "error", UNSUPPORTED)
    zones = athlete_zone_model()
    if not _parse_slots.acquire(timeout=PARSE_WAIT_SEC):
        return ImportOutcome(
            filename, "error", "Trop d’imports en cours. Réessaie dans un instant."
        )
    try:
        parsed = parse_activity(fmt, content, zones)
        zone = zone_of((settings_repo.get_user_settings() or {}).get("timezone"))
        session = to_actual_session(parsed, fmt, filename, zone)
        streams = from_time_series(parsed.time_series, session.sport)
    except ActivityFileError as exc:
        return ImportOutcome(filename, "error", str(exc))
    finally:
        _parse_slots.release()
    repo = GarminRepository()
    session_id, twin = _commit(repo, session)
    if twin is not None:
        return ImportOutcome(
            filename,
            "duplicate",
            _duplicate_message(twin),
            duplicate_of=twin.id,
            date=twin.date,
            sport=twin.sport,
        )
    assert session_id is not None
    planned_id = _after_commit(repo, session_id, session, streams, zones)
    return ImportOutcome(
        filename,
        "imported",
        "Séance importée et associée à ta séance prévue."
        if planned_id
        else "Séance importée.",
        session_id=session_id,
        date=session.date,
        sport=session.sport,
        duration_sec=session.duration_sec,
        distance_m=session.distance_m,
        planned_session_id=planned_id,
    )


def to_actual_session(
    parsed: ParsedActivity, fmt: ActivityFormat, filename: str, zone: ZoneInfo
) -> ActualSession:
    """The stored session of a parsed file, its start on the athlete's clock."""
    assert parsed.start_time is not None  # parse_activity refuses a file without
    start = local_start(parsed.start_time, parsed.utc_offset_sec, zone)
    sport = canonical_sport(parsed.sport)
    duration = parsed.duration_sec or parsed.elapsed_time_sec
    # Some FIT files write only the enhanced speed fields the session read skips.
    speed = parsed.avg_speed_mps or (
        round(parsed.distance_m / duration, 3) if parsed.distance_m else None
    )
    return ActualSession(
        date=start.date(),
        sport=sport,
        # A FIT sub-sport says more than the zones, except the default one.
        session_type=parsed.sub_sport
        if parsed.sub_sport not in (None, "generic")
        else parsed.infer_session_type(),
        name=parsed.name,
        duration_sec=duration,
        moving_time_sec=parsed.duration_sec or None,
        distance_m=parsed.distance_m or None,
        calories=parsed.calories or None,
        avg_hr=parsed.avg_hr,
        max_hr=parsed.max_hr,
        hr_zones_json=parsed.hr_zones.to_json() if parsed.hr_zones.total_sec else None,
        avg_pace_sec_km=pace_from_speed(speed, sport),
        avg_speed_mps=speed,
        max_speed_mps=parsed.max_speed_mps,
        ascent_m=parsed.ascent_m or None,
        descent_m=parsed.descent_m or None,
        start_lat=parsed.start_lat,
        start_lon=parsed.start_lon,
        avg_cadence=parsed.avg_cadence,
        max_cadence=parsed.max_cadence,
        laps_json=laps_to_json(parsed),
        source=SOURCES[fmt],
        # The start makes the name unique: the game counts a session per name.
        source_file=f"{filename}@{start:%Y-%m-%dT%H:%M:%S}",
        start_time=start,
    )


def local_start(
    utc_start: datetime, offset_sec: int | None, zone: ZoneInfo
) -> datetime:
    """A naive UTC start on the device's clock if known, else the athlete's."""
    if offset_sec is not None:
        return utc_start + timedelta(seconds=offset_sec)
    return utc_start.replace(tzinfo=UTC).astimezone(zone).replace(tzinfo=None)


def find_duplicate(
    repo: GarminRepository, session: ActualSession
) -> ActualSession | None:
    """A stored session that is this workout, whatever its source."""
    assert session.start_time is not None
    nearby = repo.list_actual_sessions(
        start_date=session.date - timedelta(days=1),
        end_date=session.date + timedelta(days=1),
        limit=200,
        include_blobs=False,
    )
    tolerance = max(
        DUPLICATE_DURATION_SEC, int(session.duration_sec * DUPLICATE_DURATION_SHARE)
    )
    end = session.start_time + timedelta(seconds=session.duration_sec)
    for other in nearby:
        if other.start_time is not None:
            gap = abs((other.start_time - session.start_time).total_seconds())
            # A FIT upload from before ARE-143 stored its local end as start.
            if _legacy_fit(other):
                gap = min(gap, abs((other.start_time - end).total_seconds()))
            if gap <= DUPLICATE_START_SEC:
                return other
        elif (
            other.date == session.date
            and other.sport == session.sport
            and abs(other.duration_sec - session.duration_sec) <= tolerance
        ):
            return other
    return None


def _legacy_fit(session: ActualSession) -> bool:
    """A FIT upload of the old route: its name has no ``@start`` suffix."""
    return session.source == ActivitySource.FIT_FILE and "@" not in (
        session.source_file or ""
    )


def _commit(
    repo: GarminRepository, session: ActualSession
) -> tuple[int | None, ActualSession | None]:
    """The one place an imported session is written: (id, None) or (None, twin).

    The duplicate check and the insert run under one lock, so two requests of
    this process cannot both import one file. Another instance can (no lock
    spans instances); the athlete then sees two rows and deletes one.
    """
    with _commit_lock:
        twin = find_duplicate(repo, session)
        if twin is not None:
            return None, twin
        return repo.create_actual_session(session), None


def _after_commit(
    repo: GarminRepository,
    session_id: int,
    session: ActualSession,
    streams: ActivityStreams | None,
    zones: ZoneModel,
) -> int | None:
    """What a Garmin sync does after its insert. Never undoes the session."""
    planned_id: int | None = None
    try:
        planned_id = auto_match(repo, session_id, session, zones)
    except Exception:  # noqa: BLE001 - the session stays, unmatched
        logger.warning("Could not match imported session %s", session_id, exc_info=True)
    if session.sport == "strength":
        link_garmin_strength([session.date])  # never raises
        open_garmin_draft(session_id, session.date, [])  # never raises
    if streams is not None:
        try:
            repo.save_activity_streams(session_id, streams)
        except Exception:  # noqa: BLE001 - the session stays, without its charts
            logger.warning(
                "Could not store the streams of session %s", session_id, exc_info=True
            )
    return planned_id


def _duplicate_message(twin: ActualSession) -> str:
    source = (
        twin.source.value if isinstance(twin.source, ActivitySource) else twin.source
    )
    word = SOURCE_WORDS.get(str(source), "un ancien import")
    if twin.start_time is None:
        return (
            f"Doublon : une séance de même sport et de même durée existe déjà le "
            f"{twin.date:%d/%m/%Y} ({word}). Supprime-la pour importer ce fichier."
        )
    return (
        f"Doublon : cette séance est déjà dans Arete ({word}, le "
        f"{twin.start_time:%d/%m/%Y à %H:%M})."
    )


def _display_name(filename: str) -> str:
    """The file's own name, without a path or control characters."""
    name = PurePosixPath(filename.replace("\\", "/")).name
    name = "".join(ch for ch in name if ch.isprintable()).strip()
    return name[:120] or "activite"


def _without_gz(name: str) -> str:
    return name[:-3] if name.lower().endswith(".gz") else name


def _members(
    filename: str, content: bytes
) -> Iterator[tuple[str, bytes | ActivityFileError]]:
    """The activity files of an upload: itself, or an archive's members.

    Each member is read only when its turn comes, at most ``MAX_FILE_BYTES``
    whatever its header claims, so an archive bomb stops at the bound.
    """
    if not content:
        raise ActivityFileError("Fichier vide.")
    if content.startswith(GZIP_MAGIC):  # a .gz export, or the browser's compression
        content = gunzip_bounded(content)
        filename = _without_gz(filename)
    if not (filename.lower().endswith(".zip") or content.startswith(ZIP_MAGIC)):
        yield filename, content
        return
    try:
        archive = zipfile.ZipFile(io.BytesIO(content))
        infos = [
            info
            for info in archive.infolist()
            if not info.is_dir()
            and not info.filename.startswith("__MACOSX/")
            and not PurePosixPath(info.filename).name.startswith(".")
        ]
    except Exception as exc:  # noqa: BLE001 - BadZipFile, ValueError, NotImplementedError…
        raise ActivityFileError("Archive ZIP illisible.") from exc
    if not infos:
        raise ActivityFileError("Archive ZIP vide.")
    if len(infos) > MAX_FILES:
        raise ActivityFileError(
            f"L’archive contient {len(infos)} fichiers : {MAX_FILES} au maximum."
        )
    for info in infos:
        name = _display_name(info.filename)
        if info.flag_bits & 0x1:
            yield name, ActivityFileError("Fichier chiffré : non pris en charge.")
        elif activity_format(name) is None:
            yield name, ActivityFileError(UNSUPPORTED)
        elif info.file_size > MAX_FILE_BYTES:
            yield name, ActivityFileError("Fichier trop volumineux (10 Mo maximum).")
        else:
            try:
                with archive.open(info) as stream:
                    data = stream.read(MAX_FILE_BYTES + 1)
                if len(data) > MAX_FILE_BYTES:
                    raise ActivityFileError("Fichier trop volumineux (10 Mo maximum).")
                if data.startswith(GZIP_MAGIC):
                    data = gunzip_bounded(data)
                    name = _without_gz(name)
            except ActivityFileError as exc:
                yield name, exc
                continue
            except Exception as exc:  # noqa: BLE001 - zlib, CRC or truncated member
                logger.info("Unreadable archive member %s: %s", name, exc)
                yield name, ActivityFileError("Fichier illisible dans l’archive.")
                continue
            yield name, data
