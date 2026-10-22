"""One synthetic run, written as FIT bytes; the same run is in data/activities/.

No personal data: a straight 1.8 km line at 3 m/s from a made-up point,
10 minutes on 14 October 2026 from 06:30 UTC (08:30 in Paris), one sample
every 5 seconds, two 5-minute laps. ``run.tcx`` and ``run.gpx`` carry the same
samples, so the three formats must import to the same session.
"""

from __future__ import annotations

import struct
from datetime import UTC, datetime, timedelta
from pathlib import Path

DATA = Path(__file__).parent / "data" / "activities"
START = datetime(2026, 10, 14, 6, 30, tzinfo=UTC)
STEP_SEC = 5
SAMPLES = 121  # 0 … 600 s
SPEED = 3.0
LAT0, LON0 = 48.8000, 2.4000
METRES_PER_DEGREE = 111_194.93  # the haversine's, on a meridian
FIT_EPOCH = datetime(1989, 12, 31, tzinfo=UTC)


def sample(i: int) -> dict:
    """The i-th sample: time, position, altitude (50 → 62 → 50 m), HR, cadence."""
    t = i * STEP_SEC
    half = SAMPLES // 2
    return {
        "time": START + timedelta(seconds=t),
        "lat": LAT0 + SPEED * t / METRES_PER_DEGREE,
        "lon": LON0,
        "altitude": 50 + 12 * (i if i <= half else SAMPLES - 1 - i) / half,
        "distance": SPEED * t,
        "hr": 120 + (40 * i) // (SAMPLES - 1),
        "cadence": 85,  # strides per minute, the FIT convention
        "power": 250,
    }


# ─────────────────────────────────────────────────────────────────────────
# FIT encoding (FIT SDK protocol 2.0, little endian)
# ─────────────────────────────────────────────────────────────────────────

_CRC_TABLE = (
    0x0000, 0xCC01, 0xD801, 0x1400, 0xF001, 0x3C00, 0x2800, 0xE401,
    0xA001, 0x6C00, 0x7800, 0xB401, 0x5000, 0x9C01, 0x8801, 0x4400,
)  # fmt: skip


def _crc(data: bytes, crc: int = 0) -> int:
    for byte in data:
        for nibble in (byte & 0xF, byte >> 4):
            tmp = _CRC_TABLE[crc & 0xF]
            crc = ((crc >> 4) & 0x0FFF) ^ tmp ^ _CRC_TABLE[nibble]
    return crc


#: base type → (FIT code, struct format)
_TYPES = {
    "enum": (0x00, "B"),
    "uint8": (0x02, "B"),
    "uint16": (0x84, "H"),
    "sint32": (0x85, "i"),
    "uint32": (0x86, "I"),
}


def _message(local: int, number: int, fields: list[tuple[int, str, int]]) -> bytes:
    """A definition then its one data message: fields are (number, type, raw)."""
    definition = struct.pack("<BBBHB", 0x40 | local, 0, 0, number, len(fields))
    data = bytes([local])
    for field, kind, value in fields:
        code, fmt = _TYPES[kind]
        definition += struct.pack("<BBB", field, struct.calcsize(fmt), code)
        data += struct.pack("<" + fmt, value)
    return definition + data


def _stamp(at: datetime) -> int:
    return int((at - FIT_EPOCH).total_seconds())


def _semicircles(degrees: float) -> int:
    return round(degrees * 2**31 / 180)


def fit_activity(
    *,
    utc_offset_sec: int = 7200,
    shift: timedelta = timedelta(0),
    sessions: int = 1,
    empty_sessions: int = 0,
) -> bytes:
    """The run as a FIT file, with the device's local clock ``utc_offset_sec`` ahead.

    ``shift`` moves every timestamp; ``sessions`` repeats the session record,
    as a multisport file has one per leg; ``empty_sessions`` adds session
    records without time or sport, as some exports write after the real one.
    """

    def _stamp(at: datetime) -> int:
        return int((at + shift - FIT_EPOCH).total_seconds())

    samples = [sample(i) for i in range(SAMPLES)]
    end = samples[-1]["time"]
    body = _message(
        0, 0, [(0, "enum", 4), (1, "uint16", 255), (4, "uint32", _stamp(START))]
    )
    for s in samples:
        body += _message(
            1,
            20,
            [
                (253, "uint32", _stamp(s["time"])),
                (0, "sint32", _semicircles(s["lat"])),
                (1, "sint32", _semicircles(s["lon"])),
                (2, "uint16", round((s["altitude"] + 500) * 5)),
                (3, "uint8", s["hr"]),
                (4, "uint8", s["cadence"]),
                (5, "uint32", round(s["distance"] * 100)),
                (6, "uint16", round(SPEED * 1000)),
                (7, "uint16", s["power"]),
            ],
        )
    for lap in range(2):
        first, last = samples[lap * 60], samples[lap * 60 + 60]
        hrs = [s["hr"] for s in samples[lap * 60 : lap * 60 + 61]]
        body += _message(
            2,
            19,
            [
                (253, "uint32", _stamp(last["time"])),
                (2, "uint32", _stamp(first["time"])),
                (7, "uint32", 300_000),
                (8, "uint32", 300_000),
                (9, "uint32", 90_000),
                (15, "uint8", round(sum(hrs) / len(hrs))),
                (16, "uint8", max(hrs)),
                (23, "enum", 0),  # active
                (24, "enum", 1),  # time
            ],
        )
    body += sessions * _message(
        3,
        18,
        [
            (253, "uint32", _stamp(end)),
            (2, "uint32", _stamp(START)),
            (3, "sint32", _semicircles(LAT0)),
            (4, "sint32", _semicircles(LON0)),
            (5, "enum", 1),  # running
            (7, "uint32", 600_000),
            (8, "uint32", 600_000),
            (9, "uint32", 180_000),
            (11, "uint16", 120),
            (14, "uint16", 3000),
            (15, "uint16", 3000),
            (16, "uint8", 140),
            (17, "uint8", 160),
            (18, "uint8", 85),
            (22, "uint16", 12),
            (23, "uint16", 12),
        ],
    )
    body += empty_sessions * _message(
        5,
        18,
        [
            (253, "uint32", _stamp(end)),
            (2, "uint32", _stamp(end)),
            (5, "enum", 0),  # generic
            (7, "uint32", 0),
            (8, "uint32", 0),
        ],
    )
    body += _message(
        4,
        34,
        [
            (253, "uint32", _stamp(end)),
            (0, "uint32", 600_000),
            (1, "uint16", 1),
            (2, "enum", 0),
            (3, "enum", 26),
            (4, "enum", 1),
            (5, "uint32", _stamp(end) + utc_offset_sec),
        ],
    )
    header = struct.pack("<BBHI4s", 14, 0x20, 2132, len(body), b".FIT")
    header += struct.pack("<H", _crc(header))
    return header + body + struct.pack("<H", _crc(header + body))


def tcx_activity() -> bytes:
    return (DATA / "run.tcx").read_bytes()


def gpx_activity() -> bytes:
    return (DATA / "run.gpx").read_bytes()
