"""The athlete's own data, downloaded as one JSON document or a ZIP of CSV files.

Only an allowlist of tables leaves the database: sessions done and planned,
daily health metrics, strength sessions and their sets, goals, athlete facts,
weekly reviews, plus the coach's journal files. Credentials never do: Strava
tokens, push subscriptions, accounts, calendar actions and ``app.files`` (which
holds the Garmin session tokens) are not read at all. Strava rows are included:
this is the athlete's own download, not model input.

The body is built in memory and refused past ``EXPORT_LIMIT_BYTES``, under the
4.5 MB a Vercel function may answer: the caller narrows the date range or the
tables (the ZIP compresses the laps and splits that dominate the JSON).
"""

from __future__ import annotations

import csv
import io
import json
import zipfile
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, datetime
from typing import Any, Literal

from arete.dataio.db import db_connection
from arete.services.memory import ledger_lock, memory_root
from arete.services.settings import athlete_today

#: Vercel's response cap is 4.5 MB; headers and rounding need the margin.
EXPORT_LIMIT_BYTES = 4_000_000

ExportFormat = Literal["zip", "json"]

JOURNAL = "journal"


@dataclass(frozen=True)
class ExportTable:
    name: str
    #: A SELECT whose WHERE ends where the date bounds are appended.
    select: str
    #: Column filtered by the date range; None exports every row.
    date_column: str | None
    order_by: str


TABLES: tuple[ExportTable, ...] = (
    ExportTable(
        "actual_sessions",
        "SELECT * FROM app.visible_actual_sessions WHERE user_id = getvariable('arete_athlete_id')",
        "date",
        "date, id",
    ),
    ExportTable(
        "planned_sessions",
        "SELECT * FROM app.visible_planned_sessions WHERE user_id = getvariable('arete_athlete_id')",
        "date",
        "date, id",
    ),
    ExportTable(
        "daily_metrics",
        "SELECT * FROM app.visible_daily_metrics WHERE user_id = getvariable('arete_athlete_id')",
        "date",
        "date",
    ),
    ExportTable(
        "strength_sessions",
        "SELECT * FROM app.visible_strength_sessions WHERE user_id = getvariable('arete_athlete_id')",
        "date",
        "date, id",
    ),
    # One row per set, with its session and exercise spelled out: the three
    # junction tables are unreadable apart.
    ExportTable(
        "strength_sets",
        """SELECT ss.id AS strength_session_id, ss.date, se.exercise_order,
                  e.name AS exercise, e.category, e.primary_muscle,
                  se.target_sets, se.target_reps, se.target_rpe,
                  es.* EXCLUDE (session_exercise_id)
           FROM app.visible_exercise_sets es
           JOIN app.visible_session_exercises se ON es.session_exercise_id = se.id
           JOIN app.visible_strength_sessions ss ON se.session_id = ss.id
           LEFT JOIN app.visible_exercises e ON e.id = se.exercise_id
           WHERE ss.user_id = getvariable('arete_athlete_id')""",
        "ss.date",
        "ss.date, ss.id, se.exercise_order, es.set_number",
    ),
    ExportTable(
        "goals",
        "SELECT * FROM app.visible_goals WHERE user_id = getvariable('arete_athlete_id')",
        None,
        "race_date, id",
    ),
    ExportTable(
        "athlete_facts",
        "SELECT * FROM app.visible_athlete_facts WHERE user_id = getvariable('arete_athlete_id')",
        None,
        "since, id",
    ),
    ExportTable(
        "weekly_reviews",
        "SELECT * FROM app.visible_weekly_reviews WHERE user_id = getvariable('arete_athlete_id')",
        "week_start",
        "week_start",
    ),
)

#: Every name a caller may select, in download order.
EXPORT_NAMES: tuple[str, ...] = (*(t.name for t in TABLES), JOURNAL)


class ExportTooLarge(Exception):
    """The body would exceed what the deployment can answer."""

    def __init__(self, size: int) -> None:
        super().__init__(f"Export of {size} bytes exceeds {EXPORT_LIMIT_BYTES}")
        self.size = size


@dataclass(frozen=True)
class ExportData:
    start: date | None
    end: date | None
    tables: dict[str, tuple[list[str], list[tuple]]]
    journal: dict[str, str]


@dataclass(frozen=True)
class ExportFile:
    content: bytes
    filename: str
    media_type: str


def _selected(names: Sequence[str] | None) -> list[str]:
    if not names:
        return list(EXPORT_NAMES)
    unknown = sorted(set(names) - set(EXPORT_NAMES))
    if unknown:
        raise ValueError(f"Tables inconnues : {', '.join(unknown)}")
    return [n for n in EXPORT_NAMES if n in names]


def _journal() -> dict[str, str]:
    """The ledgers and their monthly archives, as the coach reads them."""
    with ledger_lock():
        return {
            path.name: path.read_text(encoding="utf-8")
            for path in sorted(memory_root().glob("*.md"))
            if path.is_file()
        }


def collect(
    start: date | None = None,
    end: date | None = None,
    names: Sequence[str] | None = None,
) -> ExportData:
    """Read the selected tables; the range filters the dated ones, inclusive."""
    if start and end and start > end:
        raise ValueError("La date de début suit la date de fin")
    selected = _selected(names)
    bounds = [start or date.min, end or date.max]
    tables: dict[str, tuple[list[str], list[tuple]]] = {}
    with db_connection() as con:
        for table in TABLES:
            if table.name not in selected:
                continue
            sql, params = table.select, []
            if table.date_column:
                sql += f" AND {table.date_column} BETWEEN ? AND ?"
                params = bounds
            result = con.execute(f"{sql} ORDER BY {table.order_by}", params)
            columns = [d[0] for d in result.description]
            tables[table.name] = (columns, result.fetchall())
    journal = _journal() if JOURNAL in selected else {}
    return ExportData(start=start, end=end, tables=tables, journal=journal)


def _cell(value: Any) -> Any:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, date | datetime):
        return value.isoformat()
    return value


def _json_value(value: Any) -> Any:
    if isinstance(value, date | datetime):
        return value.isoformat()
    return str(value)


def to_zip(data: ExportData) -> bytes:
    """One CSV per table (UTF-8 with BOM, so spreadsheets keep the accents)."""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, (columns, rows) in data.tables.items():
            text = io.StringIO()
            writer = csv.writer(text, lineterminator="\n")
            writer.writerow(columns)
            writer.writerows([_cell(v) for v in row] for row in rows)
            archive.writestr(f"{name}.csv", text.getvalue().encode("utf-8-sig"))
        for filename, content in data.journal.items():
            archive.writestr(f"{JOURNAL}/{filename}", content.encode("utf-8"))
    return buffer.getvalue()


def to_json(data: ExportData) -> bytes:
    document = {
        "exported_at": datetime.now().isoformat(timespec="seconds"),
        "start": data.start.isoformat() if data.start else None,
        "end": data.end.isoformat() if data.end else None,
        "tables": {
            name: [dict(zip(columns, row, strict=True)) for row in rows]
            for name, (columns, rows) in data.tables.items()
        },
        JOURNAL: data.journal,
    }
    return json.dumps(
        document, default=_json_value, ensure_ascii=False, separators=(",", ":")
    ).encode("utf-8")


def _filename(data: ExportData, fmt: ExportFormat, today: date) -> str:
    span = (
        f"{data.start or 'debut'}_{data.end or today}"
        if data.start or data.end
        else str(today)
    )
    return f"arete-export-{span}.{fmt}"


def build(
    fmt: ExportFormat,
    start: date | None = None,
    end: date | None = None,
    names: Sequence[str] | None = None,
    today: date | None = None,
) -> ExportFile:
    """The download, or ExportTooLarge when it would not fit in one response."""
    data = collect(start, end, names)
    content = to_zip(data) if fmt == "zip" else to_json(data)
    if len(content) > EXPORT_LIMIT_BYTES:
        raise ExportTooLarge(len(content))
    return ExportFile(
        content=content,
        filename=_filename(data, fmt, today or athlete_today()),
        media_type="application/zip" if fmt == "zip" else "application/json",
    )
