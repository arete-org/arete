"""FIT, TCX and GPX import: the watch-agnostic path (ARE-143)."""

from __future__ import annotations

import gzip
import io
import json
import zipfile
from datetime import date, datetime

import pytest
from activity_samples import fit_activity, gpx_activity, tcx_activity

from arete.dataio.db import connect, db_connection
from arete.dataio.init_duckdb import main as init_schema
from arete.features.hr_zones import ZoneModel
from arete.garmin.activity_files import (
    ActivityFileError,
    activity_format,
    parse_activity,
)
from arete.garmin.repository import GarminRepository
from arete.services import activity_import
from arete.services.activity_import import import_upload

SAMPLES = {"fit": fit_activity, "tcx": tcx_activity, "gpx": gpx_activity}
ZONES = ZoneModel.from_reference(lthr=165)


@pytest.fixture
def db(tmp_path, monkeypatch):
    """A database of its own: duplicates are judged against this test's rows."""
    monkeypatch.setenv("ARETE_DB", str(tmp_path / "import.duckdb"))
    monkeypatch.setenv("ARETE_DATA_DIR", str(tmp_path / "files"))
    monkeypatch.delenv("ARETE_AUTH", raising=False)
    init_schema()
    with db_connection() as con:
        con.execute("INSERT INTO app.athletes (id) VALUES (1) ON CONFLICT DO NOTHING")
    return tmp_path


def _sessions() -> list[tuple]:
    con = connect()
    try:
        return con.execute(
            "SELECT id, date, start_time, sport, source, duration_sec, distance_m, "
            "avg_hr, hr_zones_json, laps_json FROM app.visible_actual_sessions ORDER BY id"
        ).fetchall()
    finally:
        con.close()


def _one(filename: str, content: bytes):
    (outcome,) = import_upload(filename, content)
    return outcome


# ─────────────────────────────────────────────────────────────────────────
# Parsers
# ─────────────────────────────────────────────────────────────────────────


def test_the_three_formats_parse_to_the_same_activity():
    parsed = {fmt: parse_activity(fmt, make(), ZONES) for fmt, make in SAMPLES.items()}
    for fmt, activity in parsed.items():
        assert activity.sport == "running", fmt
        assert activity.start_time == datetime(2026, 10, 14, 6, 30), fmt
        assert activity.duration_sec == 600, fmt
        assert activity.distance_m == pytest.approx(1800, abs=1), fmt
        assert (activity.avg_hr, activity.max_hr) == (140, 160), fmt
        assert activity.avg_speed_mps == pytest.approx(3.0, abs=0.01), fmt
        assert activity.ascent_m == pytest.approx(12, abs=1), fmt
        assert activity.avg_cadence == 170, fmt  # steps per minute, as FIT
        assert activity.hr_zones.to_json() == parsed["fit"].hr_zones.to_json(), fmt
        assert activity.time_series is not None
        assert len(activity.time_series.points) == 121, fmt
    # Laps where the format has them.
    assert len(parsed["fit"].workout_structure.laps) == 2
    assert len(parsed["tcx"].workout_structure.laps) == 2
    assert parsed["gpx"].workout_structure is None
    assert parsed["gpx"].name == "Footing du matin"
    # Only FIT states the device's clock; the others fall back to the athlete's.
    assert parsed["fit"].utc_offset_sec == 7200
    assert parsed["tcx"].utc_offset_sec is None


def test_format_follows_the_extension_compressed_or_not():
    assert activity_format("Course.FIT") == "fit"
    assert activity_format("run.tcx.gz") == "tcx"
    assert activity_format("trace.gpx") == "gpx"
    assert activity_format("notes.txt") is None


BILLION_LAUGHS = b"""<?xml version="1.0"?>
<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;">
<!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">]>
<gpx><trk><name>&lol3;</name></trk></gpx>"""

XXE = b"""<?xml version="1.0"?>
<!DOCTYPE gpx [<!ENTITY secret SYSTEM "file:///etc/passwd">]>
<TrainingCenterDatabase><Activities><Activity Sport="Running"><Id>&secret;</Id>
</Activity></Activities></TrainingCenterDatabase>"""

EXTERNAL_DTD = b"""<?xml version="1.0"?>
<!DOCTYPE gpx SYSTEM "http://example.invalid/gpx.dtd"><gpx/>"""


@pytest.mark.parametrize(
    ("fmt", "content"),
    [("gpx", BILLION_LAUGHS), ("tcx", XXE), ("gpx", EXTERNAL_DTD)],
    ids=["billion-laughs", "xxe", "external-dtd"],
)
def test_malicious_xml_is_refused_before_any_expansion(fmt, content):
    with pytest.raises(ActivityFileError, match="DOCTYPE"):
        parse_activity(fmt, content, ZONES)


@pytest.mark.parametrize(
    ("fmt", "content", "message"),
    [
        ("gpx", b"<gpx><trk><trkseg>", "XML invalide"),
        ("gpx", b"<gpx><rte/></gpx>", "Aucune trace"),
        ("tcx", b"<gpx/>", "pas un export TCX"),
        ("fit", fit_activity()[:200], "FIT illisible"),
        ("fit", b"", "vide"),
        # A planned route: positions without times is not a recorded session.
        (
            "gpx",
            b'<gpx><trk><trkseg><trkpt lat="48.8" lon="2.4"/></trkseg></trk></gpx>',
            "itinéraire",
        ),
        (
            "tcx",
            b"<TrainingCenterDatabase><Activities><Activity/><Activity/>"
            b"</Activities></TrainingCenterDatabase>",
            "plusieurs activités",
        ),
    ],
    ids=[
        "truncated-xml",
        "route",
        "not-tcx",
        "truncated-fit",
        "empty",
        "no-times",
        "two",
    ],
)
def test_unreadable_files_are_refused_in_french(fmt, content, message):
    with pytest.raises(ActivityFileError, match=message):
        parse_activity(fmt, content, ZONES)


def test_absurd_values_are_dropped_not_stored():
    gpx = gpx_activity().replace(
        b"<gpxtpx:hr>130</gpxtpx:hr>", b"<gpxtpx:hr>999</gpxtpx:hr>"
    )
    activity = parse_activity("gpx", gpx, ZONES)
    assert activity.max_hr == 160
    assert all(p.heart_rate != 999 for p in activity.time_series.points)


def test_step_cadence_is_read_as_steps():
    # Some exports write steps per minute (170), not strides (85).
    gpx = gpx_activity().replace(b"<gpxtpx:cad>85<", b"<gpxtpx:cad>170<")
    assert parse_activity("gpx", gpx, ZONES).avg_cadence == 170


# ─────────────────────────────────────────────────────────────────────────
# Import service
# ─────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("fmt", ["fit", "tcx", "gpx"])
def test_each_format_imports_the_same_session_with_its_streams(db, fmt):
    outcome = _one(f"run.{fmt}", SAMPLES[fmt]())
    assert outcome.status == "imported", outcome.message
    assert outcome.message == "Séance importée."
    (
        (
            session_id,
            day,
            start,
            sport,
            source,
            duration,
            distance,
            avg_hr,
            zones,
            laps,
        ),
    ) = _sessions()
    assert session_id == outcome.session_id
    # 06:30 UTC is 08:30 in Paris: the device's offset (FIT) or the athlete's zone.
    assert (day, start) == (date(2026, 10, 14), datetime(2026, 10, 14, 8, 30))
    assert (sport, source) == ("running", f"{fmt}_file")
    assert (duration, round(distance), avg_hr) == (600, 1800, 140)
    assert sum(json.loads(zones).values()) == 600
    assert (laps is not None) == (fmt != "gpx")
    streams = GarminRepository().get_activity_streams(session_id)
    assert streams is not None and len(streams) == 121
    assert set(streams.channels()) == {
        "heart_rate",
        "speed_mps",
        "altitude_m",
        "distance_m",
        "cadence",
        "power_w",
        "lat",
        "lon",
    }
    assert streams.cadence[0] == 170  # stored in steps per minute
    # The game evidence is captured with the row, keyed by file and start.
    with db_connection() as con:
        (canonical,) = con.execute(
            "SELECT canonical_key FROM app.visible_game_events WHERE source_key=?",
            [f"actual:{session_id}"],
        ).fetchone()
    assert canonical == f"file:run.{fmt}@2026-10-14T08:30:00"


def test_the_same_run_from_another_watch_or_format_is_a_duplicate(db):
    assert _one("run.fit", fit_activity()).status == "imported"
    for name, content in (("run.tcx", tcx_activity()), ("run.gpx", gpx_activity())):
        outcome = _one(name, content)
        assert outcome.status == "duplicate"
        assert outcome.message == (
            "Doublon : cette séance est déjà dans Arete (fichier FIT, le 14/10/2026 à 08:30)."
        )
    assert len(_sessions()) == 1


def test_a_garmin_session_starting_within_five_minutes_is_the_same_workout(db):
    with db_connection() as con:
        con.execute(
            "INSERT INTO app.actual_sessions (user_id,date,start_time,sport,duration_sec,source,garmin_activity_id) "
            "VALUES (1,'2026-10-14','2026-10-14 08:34:00','running',620,'garmin_connect','77')"
        )
    outcome = _one("run.gpx", gpx_activity())
    assert outcome.status == "duplicate"
    assert "(Garmin, le 14/10/2026 à 08:34)" in outcome.message


def test_a_manual_entry_of_that_day_blocks_the_file_until_deleted(db):
    with db_connection() as con:
        con.execute(
            "INSERT INTO app.actual_sessions (user_id,date,sport,duration_sec,source) "
            "VALUES (1,'2026-10-14','running',660,'manual')"
        )
    outcome = _one("run.tcx", tcx_activity())
    assert outcome.status == "duplicate"
    assert outcome.message == (
        "Doublon : une séance de même sport et de même durée existe déjà le "
        "14/10/2026 (saisie manuelle). Supprime-la pour importer ce fichier."
    )


def test_a_later_session_on_the_same_day_is_not_a_duplicate(db):
    assert _one("run.fit", fit_activity()).status == "imported"
    later = tcx_activity().replace(b"T06:", b"T10:")
    assert _one("evening.tcx", later).status == "imported"
    assert len(_sessions()) == 2


def test_the_device_offset_wins_over_the_athletes_zone(db):
    # Recorded in New York (UTC-4): 02:30 on the watch, whatever the settings say.
    outcome = _one("ny.fit", fit_activity(utc_offset_sec=-4 * 3600))
    assert outcome.status == "imported"
    ((_, day, start, *_),) = _sessions()
    assert (day, start) == (date(2026, 10, 14), datetime(2026, 10, 14, 2, 30))


def test_an_offset_written_in_the_file_is_kept():
    gpx = gpx_activity().replace(b"Z</time>", b"+02:00</time>")
    activity = parse_activity("gpx", gpx, ZONES)
    assert activity.utc_offset_sec == 7200
    assert activity.start_time == datetime(2026, 10, 14, 4, 30)  # UTC


def test_a_corrupt_file_writes_nothing(db):
    for name, content in (
        ("broken.fit", fit_activity()[:-40]),
        ("broken.gpx", gpx_activity()[:5000]),
        ("bomb.gpx", BILLION_LAUGHS),
    ):
        outcome = _one(name, content)
        assert outcome.status == "error", name
    assert _sessions() == []
    with db_connection() as con:
        assert con.execute("SELECT count(*) FROM app.activity_streams").fetchone() == (
            0,
        )
        assert con.execute("SELECT count(*) FROM app.game_events").fetchone() == (0,)


def test_an_imported_run_completes_the_planned_session_of_the_day(db):
    with db_connection() as con:
        (planned_id,) = con.execute(
            "INSERT INTO app.planned_sessions (user_id,date,sport,session_type,target_duration_min,status) "
            "VALUES (1,'2026-10-14','running','endurance',10,'pending') RETURNING id"
        ).fetchone()
    outcome = _one("run.gpx", gpx_activity())
    assert outcome.planned_session_id == planned_id
    assert outcome.message == "Séance importée et associée à ta séance prévue."
    planned = GarminRepository().get_planned_session(planned_id)
    assert planned is not None and planned.status.value == "completed"


def test_imported_files_wait_for_the_daily_feedback_like_garmin_ones(db):
    from arete.services.coaching_repository import SessionFeedbackRepository

    outcome = _one("run.tcx", tcx_activity())
    assert SessionFeedbackRepository().pending_garmin() == ([outcome.session_id], 1)


def _zip(members: dict[str, bytes]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, content in members.items():
            archive.writestr(name, content)
    return buffer.getvalue()


def test_a_zip_gives_one_outcome_per_file(db):
    archive = _zip(
        {
            "export/run.fit": fit_activity(),
            "export/run.gpx": gpx_activity(),
            "export/evening.tcx.gz": gzip.compress(
                tcx_activity().replace(b"T06:", b"T18:")
            ),
            "export/notes.txt": b"hello",
            "__MACOSX/export/._run.fit": b"resource fork",
        }
    )
    outcomes = import_upload("export.zip", archive)
    assert [(o.filename, o.status) for o in outcomes] == [
        ("run.fit", "imported"),
        ("run.gpx", "duplicate"),
        ("evening.tcx", "imported"),
        ("notes.txt", "error"),
    ]
    assert outcomes[3].message.startswith("Format non pris en charge")
    assert len(_sessions()) == 2


def test_archive_and_compression_bombs_stop_at_the_bound(db, monkeypatch):
    monkeypatch.setattr("arete.garmin.activity_files.MAX_FILE_BYTES", 1000)
    monkeypatch.setattr(activity_import, "MAX_FILE_BYTES", 1000)
    (outcome,) = import_upload("run.gpx", gzip.compress(b" " * 5000))
    assert (
        outcome.message
        == "Fichier trop volumineux une fois décompressé (10 Mo maximum)."
    )
    (outcome,) = import_upload("all.zip", _zip({"big.gpx": b" " * 5000}))
    assert outcome.message == "Fichier trop volumineux (10 Mo maximum)."
    too_many = _zip({f"{i}.gpx": b"<gpx/>" for i in range(11)})
    (outcome,) = import_upload("all.zip", too_many)
    assert outcome.message == "L’archive contient 11 fichiers : 10 au maximum."
    assert _sessions() == []


def test_the_browser_compression_is_transparent(db):
    outcome = _one("run.gpx", gzip.compress(gpx_activity()))
    assert (outcome.filename, outcome.status) == ("run.gpx", "imported")


def test_an_unsupported_or_hostile_name_is_answered_not_written(db):
    (outcome,) = import_upload("../../etc/passwd", b"root:x:0:0")
    assert outcome.filename == "passwd"
    assert outcome.status == "error"
    assert _sessions() == []


# ─────────────────────────────────────────────────────────────────────────
# HTTP
# ─────────────────────────────────────────────────────────────────────────


def test_import_end_to_end_then_the_session_page_reads_it(db, client):
    response = client.post(
        "/activities/import",
        files={"file": ("run.tcx", tcx_activity(), "application/octet-stream")},
    )
    assert response.status_code == 200
    (result,) = response.json()["results"]
    assert result["status"] == "imported"
    assert (result["date"], result["sport"], result["duration_sec"]) == (
        "2026-10-14",
        "running",
        600,
    )
    detail = client.get(f"/analytics/sessions/{result['session_id']}/detail")
    assert detail.status_code == 200
    body = detail.json()
    assert body["session"]["source"] == "tcx_file"
    assert body["streams"]["heart_rate"]

    again = client.post(
        "/activities/import",
        files={"file": ("copy.tcx", tcx_activity(), "application/octet-stream")},
    )
    assert again.json()["results"][0]["status"] == "duplicate"


def test_an_upload_over_ten_megabytes_is_refused(db, client):
    response = client.post(
        "/activities/import",
        files={"file": ("big.gpx", b"x" * (10 * 1024 * 1024 + 1), "application/xml")},
    )
    assert response.status_code == 413
    assert response.json() == {"detail": "Fichier trop volumineux (10 Mo maximum)."}


def test_the_fit_route_imports_through_the_same_service(db, client):
    first = client.post(
        "/garmin/upload-fit",
        files={"file": ("run.fit", fit_activity(), "application/octet-stream")},
    )
    assert first.status_code == 200
    assert first.json()["activity"]["date"] == "2026-10-14"
    again = client.post(
        "/garmin/upload-fit",
        files={"file": ("run.fit", fit_activity(), "application/octet-stream")},
    )
    assert again.status_code == 409
    assert again.json()["detail"].startswith("Doublon")
    broken = client.post(
        "/garmin/upload-fit",
        files={"file": ("broken.fit", b"not a fit", "application/octet-stream")},
    )
    assert broken.status_code == 400
    assert broken.json() == {"detail": "Fichier FIT illisible ou corrompu."}


@pytest.mark.parametrize(
    ("name", "content", "message"),
    [
        ("run.fit.gz", gzip.compress(fit_activity())[:12] + b"\x00" * 40, "compressé"),
        ("all.zip", b"PK\x03\x04" + b"\x00" * 60, "Archive ZIP illisible."),
        ("all.zip", _zip({"a.gpx": b"<gpx/>"})[:-30], "Archive ZIP illisible."),
    ],
    ids=["corrupt-gzip", "zip-header-only", "truncated-zip"],
)
def test_a_corrupt_archive_or_compression_is_an_answer_not_a_crash(
    db, name, content, message
):
    (outcome,) = import_upload(name, content)
    assert outcome.status == "error"
    assert message in outcome.message
    assert _sessions() == []


def test_a_fit_uploaded_by_the_old_route_is_still_recognised(db):
    # The old route stored the activity record's local end (08:40) as start.
    with db_connection() as con:
        con.execute(
            "INSERT INTO app.actual_sessions (user_id,date,start_time,sport,duration_sec,source,source_file) "
            "VALUES (1,'2026-10-14','2026-10-14 08:40:00','running',600,'fit_file','run.fit')"
        )
    outcome = _one("run.gpx", gpx_activity())
    assert outcome.status == "duplicate"


def test_a_server_failure_on_one_file_spares_the_others(db, monkeypatch):
    create = GarminRepository.create_actual_session

    def fail_on_gpx(self, session):
        if session.source.value == "gpx_file":
            raise RuntimeError("database gone")
        return create(self, session)

    monkeypatch.setattr(GarminRepository, "create_actual_session", fail_on_gpx)
    later = tcx_activity().replace(b"T06:", b"T10:")
    outcomes = import_upload("two.zip", _zip({"a.gpx": gpx_activity(), "b.tcx": later}))
    assert [(o.filename, o.status) for o in outcomes] == [
        ("a.gpx", "error"),
        ("b.tcx", "imported"),
    ]
    assert outcomes[0].message == (
        "Import interrompu par une erreur du serveur : réessaie ce fichier."
    )
    assert len(_sessions()) == 1
