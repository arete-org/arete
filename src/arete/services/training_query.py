"""Declared longitudinal reads, with one observation per entity.

Only this service writes SQL. Model arguments select catalog entries and bound
parameters; they never supply identifiers, expressions, joins or statements.
Stored local dates are authoritative (including sleep's recorded waking day).
"""

from __future__ import annotations

from collections import defaultdict
from datetime import date, timedelta
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from arete.dataio.db import db_connection
from arete.dataio.queries import SPORT_GROUPS, sql_in
from arete.services.analytics import MODEL_EXCLUDED_SOURCES

MAX_DAYS = 366
MAX_OBSERVATIONS = 2000
MAX_SETS = 20000
Entity = Literal["sessions", "days", "plans", "strength"]
FieldName = Literal[
    "id",
    "date",
    "sport",
    "name",
    "source",
    "status",
    "distance_m",
    "duration_sec",
    "avg_hr",
    "avg_pace_sec_km",
    "ascent_m",
    "gap_sec_km",
    "temperature_c",
    "rpe",
    "sleep_duration_sec",
    "hrv_last_night",
    "resting_hr",
    "sleep_score",
    "readiness_score",
    "has_feedback",
    "completed",
    "target_distance_km",
    "target_duration_min",
    "volume_kg",
]


class QueryFilter(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    field: FieldName
    op: Literal["eq", "ne", "lt", "lte", "gt", "gte", "contains", "missing"] = "eq"
    value: str | float | bool | None = None


class TrainingQuery(BaseModel):
    model_config = ConfigDict(extra="forbid")
    entity: Entity
    start_date: date
    end_date: date
    metric: FieldName | None = None
    aggregate: Literal["sum", "avg", "min", "max", "count"] = "avg"
    group_by: Literal["none", "day", "week", "month", "sport", "status"] = "none"
    filters: list[QueryFilter] = Field(default_factory=list, max_length=8)
    fields: list[FieldName] = Field(default_factory=list, max_length=8)
    limit: int = Field(default=50, ge=1, le=50)
    offset: int = Field(default=0, ge=0, le=MAX_OBSERVATIONS)

    @model_validator(mode="after")
    def validate_window(self) -> TrainingQuery:
        if not 0 <= (self.end_date - self.start_date).days < MAX_DAYS:
            raise ValueError(f"Use an inclusive window of 1 to {MAX_DAYS} local days")
        return self


# Units also declare the scalar type. A field must belong to its entity before
# it can enter a projection, predicate or aggregate.
UNITS = {
    "id": "identifier",
    "date": "local date",
    "sport": "text",
    "name": "text",
    "source": "text",
    "status": "text",
    "distance_m": "m",
    "duration_sec": "s",
    "avg_hr": "bpm",
    "avg_pace_sec_km": "s/km",
    "ascent_m": "m",
    "gap_sec_km": "s/km",
    "temperature_c": "°C",
    "rpe": "1–10",
    "sleep_duration_sec": "s",
    "hrv_last_night": "ms",
    "resting_hr": "bpm",
    "sleep_score": "0–100",
    "readiness_score": "0–100",
    "has_feedback": "0/1",
    "completed": "0/1",
    "target_distance_km": "km",
    "target_duration_min": "min",
    "volume_kg": "kg·reps",
}
DAILY_FIELDS = frozenset(
    {
        "sleep_duration_sec",
        "hrv_last_night",
        "resting_hr",
        "sleep_score",
        "readiness_score",
    }
)
FIELDS = {
    "sessions": frozenset(
        {
            "id",
            "date",
            "sport",
            "name",
            "source",
            "distance_m",
            "duration_sec",
            "avg_hr",
            "avg_pace_sec_km",
            "ascent_m",
            "gap_sec_km",
            "temperature_c",
            "rpe",
            "has_feedback",
            *DAILY_FIELDS,
        }
    ),
    "days": frozenset({"id", "date", "source", *DAILY_FIELDS}),
    "plans": frozenset(
        {
            "id",
            "date",
            "sport",
            "source",
            "status",
            "completed",
            "target_distance_km",
            "target_duration_min",
        }
    ),
    "strength": frozenset({"id", "date", "name", "duration_sec", "rpe", "volume_kg"}),
}
DEFAULT_FIELDS = {
    "sessions": ["sport", "name", "distance_m", "duration_sec", "avg_pace_sec_km"],
    "days": ["sleep_duration_sec", "hrv_last_night", "resting_hr"],
    "plans": ["sport", "status", "completed", "target_duration_min"],
    "strength": ["name", "duration_sec", "volume_kg"],
}
PREFIX = {
    "sessions": "actual",
    "days": "day",
    "plans": "planned",
    "strength": "strength",
}
EXCLUDED = sql_in(MODEL_EXCLUDED_SOURCES)
SOURCES = {
    "sessions": f"""
        SELECT s.*, t.gap_sec_km, w.temperature_c,
          d.sleep_duration_sec, d.hrv_last_night, d.resting_hr, d.sleep_score,
          d.readiness_score, CAST(f.actual_session_id IS NOT NULL AS INTEGER) has_feedback
        FROM app.visible_actual_sessions s
        LEFT JOIN app.visible_activity_terrain t ON t.actual_session_id=s.id
        LEFT JOIN app.visible_activity_weather w ON w.actual_session_id=s.id
        LEFT JOIN app.visible_session_feedback f ON f.actual_session_id=s.id
        LEFT JOIN app.visible_daily_metrics d ON d.date=s.date AND d.user_id=s.user_id
          AND (d.source IS NULL OR d.source NOT IN ({EXCLUDED}))
        WHERE s.source NOT IN ({EXCLUDED})
    """,
    "days": f"""
        SELECT CAST(date AS VARCHAR) id, * FROM app.visible_daily_metrics
        WHERE source IS NULL OR source NOT IN ({EXCLUDED})
    """,
    "plans": f"""
        SELECT p.*, CAST(EXISTS (
          SELECT 1 FROM app.visible_actual_sessions s
          WHERE s.planned_session_id=p.id AND s.source NOT IN ({EXCLUDED})
        ) AS INTEGER) completed FROM app.visible_planned_sessions p
        WHERE p.source IS NULL OR p.source NOT IN ({EXCLUDED})
    """,
    "strength": f"""
        SELECT s.id, s.date, s.name, s.duration_min*60 duration_sec, s.overall_rpe rpe,
          NULL::DOUBLE volume_kg FROM app.visible_strength_sessions s
        WHERE s.actual_session_id IS NULL OR EXISTS (
          SELECT 1 FROM app.visible_actual_sessions a
          WHERE a.id=s.actual_session_id AND a.source NOT IN ({EXCLUDED})
        )
    """,
}


def _validate(query: TrainingQuery) -> None:
    fields = FIELDS[query.entity]
    selected = set(query.fields) | {f.field for f in query.filters}
    if query.metric:
        selected.add(query.metric)
    if not selected <= fields:
        raise ValueError(f"Fields for {query.entity}: {', '.join(sorted(fields))}")
    if query.group_by in {"sport", "status"} and query.group_by not in fields:
        raise ValueError(f"Cannot group {query.entity} by {query.group_by}")
    if not query.metric and query.group_by != "none":
        raise ValueError("Grouping requires a metric")
    if query.metric and query.offset:
        raise ValueError("Aggregates cannot be paginated; narrow the window")
    if query.metric in DAILY_FIELDS and query.entity != "days":
        raise ValueError("Aggregate daily measurements with entity=days, once per day")
    if (
        query.metric
        and query.aggregate != "count"
        and UNITS[query.metric]
        in {
            "identifier",
            "local date",
            "text",
        }
    ):
        raise ValueError("This metric supports count only")
    for item in query.filters:
        if item.op == "missing":
            if item.value is not None:
                raise ValueError("missing takes a null value")
            continue
        if item.value is None:
            raise ValueError("Use missing to filter unknown measurements")
        if isinstance(item.value, str) and len(item.value) > 200:
            raise ValueError("Filter text is limited to 200 characters")
        textual = UNITS[item.field] in {"text", "local date"} or (
            item.field == "id" and query.entity == "days"
        )
        if textual != isinstance(item.value, str):
            raise ValueError(f"Wrong filter value type for {item.field}")
        if item.op == "contains" and UNITS[item.field] != "text":
            raise ValueError("contains requires a text field")
        if item.field == "date" or (item.field == "id" and query.entity == "days"):
            date.fromisoformat(str(item.value))


def _predicate(item: QueryFilter) -> tuple[str, list[Any]]:
    # FieldName validation and _validate are mandatory before this function.
    column = f'"{item.field}"'
    if item.op == "missing":
        return f"{column} IS NULL", []
    if item.field == "sport" and item.op in {"eq", "ne"} and item.value in SPORT_GROUPS:
        values = SPORT_GROUPS[str(item.value)]
        operator = "IN" if item.op == "eq" else "NOT IN"
        return f"{column} {operator} ({','.join('?' for _ in values)})", list(values)
    if item.op == "contains":
        return f"contains(lower({column}), lower(?))", [item.value]
    operator = {"eq": "=", "ne": "!=", "lt": "<", "lte": "<=", "gt": ">", "gte": ">="}[
        item.op
    ]
    return f"{column} {operator} ?", [item.value]


def _strength_volume(con: Any, rows: list[dict[str, Any]]) -> None:
    """Reuse the strength calculator; unknown loads must not become zero."""
    from arete.features.strength import calculate_volume

    if not rows:
        return
    sets = con.execute(
        f"""SELECT se.session_id, es.reps, es.weight_kg
        FROM app.visible_session_exercises se
        JOIN app.visible_exercise_sets es ON es.session_exercise_id=se.id
        WHERE se.session_id IN ({",".join("?" for _ in rows)})
          AND NOT es.is_warmup LIMIT ?""",
        [*[row["id"] for row in rows], MAX_SETS + 1],
    ).fetchall()
    if len(sets) > MAX_SETS:
        raise ValueError(f"Set limit ({MAX_SETS}) exceeded; narrow the window")
    volumes: dict[int, list[float | None]] = defaultdict(list)
    for session_id, reps, weight in sets:
        volumes[session_id].append(
            None if weight is None else calculate_volume(1, reps, weight)
        )
    for row in rows:
        values = volumes[row["id"]]
        row["volume_kg"] = (
            sum(v for v in values if v is not None)
            if values and None not in values
            else None
        )


def _matches_volume(row: dict[str, Any], item: QueryFilter) -> bool:
    value = row["volume_kg"]
    if item.op == "missing":
        return value is None
    if value is None:
        return False
    assert isinstance(item.value, (float, bool))
    other = item.value
    return bool(
        {
            "eq": value == other,
            "ne": value != other,
            "lt": value < other,
            "lte": value <= other,
            "gt": value > other,
            "gte": value >= other,
        }[item.op]
    )


def _bucket(row: dict[str, Any], group: str) -> str:
    day = row["date"]
    if group == "none":
        return "all"
    if group == "week":
        return str(day - timedelta(days=day.weekday()))
    if group == "month":
        return str(day.replace(day=1))
    return str(day if group == "day" else row[group])


def _aggregate(
    rows: list[dict[str, Any]], query: TrainingQuery
) -> list[dict[str, Any]]:
    assert query.metric is not None
    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        groups[_bucket(row, query.group_by)].append(row)
    if not groups and query.group_by == "none":
        groups["all"] = []
    if len(groups) > query.limit:
        raise ValueError(
            "Group limit exceeded; use larger buckets or a narrower window"
        )
    result = []
    for bucket, observations in sorted(groups.items()):
        values = [r[query.metric] for r in observations if r[query.metric] is not None]
        value: Any = None
        if query.aggregate == "count":
            value = len(values)
        elif values:
            if query.aggregate == "sum":
                value = sum(values)
            elif query.aggregate == "avg":
                value = sum(values) / len(values)
            elif query.aggregate == "min":
                value = min(values)
            else:
                value = max(values)
        result.append(
            {
                "group": bucket,
                "value": value,
                "observations": len(observations),
                "known": len(values),
                "missing": len(observations) - len(values),
                "source_ids": [r["source_id"] for r in observations],
            }
        )
    return result


def query_training(query: TrainingQuery) -> dict[str, Any]:
    """One bounded read; no imports, enrichment, model calls or arbitrary SQL."""
    _validate(query)
    clauses = ["date BETWEEN ? AND ?"]
    params: list[Any] = [query.start_date, query.end_date]
    for item in query.filters:
        if item.field != "volume_kg":
            clause, values = _predicate(item)
            clauses.append(clause)
            params.extend(values)
    columns = sorted(FIELDS[query.entity])
    with db_connection() as con:
        cursor = con.execute(
            f"SELECT {', '.join(columns)} FROM ({SOURCES[query.entity]}) observations "
            f"WHERE {' AND '.join(clauses)} ORDER BY date, id LIMIT ?",
            [*params, MAX_OBSERVATIONS + 1],
        )
        rows = [dict(zip(columns, values, strict=True)) for values in cursor.fetchall()]
        if len(rows) > MAX_OBSERVATIONS:
            raise ValueError(
                f"Observation limit ({MAX_OBSERVATIONS}) exceeded; narrow the window"
            )
        if query.entity == "strength":
            _strength_volume(con, rows)
    for item in query.filters:
        if item.field == "volume_kg":
            rows = [r for r in rows if _matches_volume(r, item)]
    for row in rows:
        row["source_id"] = f"{PREFIX[query.entity]}:{row['id']}"
    selected = list(
        dict.fromkeys(["id", "date", *(query.fields or DEFAULT_FIELDS[query.entity])])
    )
    units = {key: UNITS[key] for key in selected}
    if query.metric:
        result = _aggregate(rows, query)
        units = {
            "value": "observations"
            if query.aggregate == "count"
            else UNITS[query.metric]
        }
    else:
        result = [
            {key: row[key] for key in [*selected, "source_id"]}
            for row in rows[query.offset : query.offset + query.limit]
        ]
    return {
        "entity": query.entity,
        "grain": "one " + PREFIX[query.entity],
        "window": {
            "start": str(query.start_date),
            "end": str(query.end_date),
            "inclusive": True,
        },
        "metric": query.metric,
        "aggregate": query.aggregate if query.metric else None,
        "rows": result,
        "units": units,
        "coverage": {
            "matching_observations": len(rows),
            "days_with_data": len({r["date"] for r in rows}),
            "window_days": (query.end_date - query.start_date).days + 1,
            "first_date": str(rows[0]["date"]) if rows else None,
            "last_date": str(rows[-1]["date"]) if rows else None,
            "provider_coverage": "Not inferred from database rows; see Garmin freshness context",
        },
        "limits": {
            "max_observations": MAX_OBSERVATIONS,
            "max_days": MAX_DAYS,
            "has_more": not query.metric and query.offset + query.limit < len(rows),
            "next_offset": query.offset + query.limit
            if not query.metric and query.offset + query.limit < len(rows)
            else None,
        },
        "semantics": (
            "Stored athlete-local dates; sleep belongs to its recorded waking day. "
            "NULL is unknown; aggregates ignore unknowns and report missing counts. "
            "Session means are unweighted. Daily fields on sessions are context/filter values only. "
            "Plans are prescriptions; completed counts authoritative actual links, not proposed matches. "
            "RPE and strength are athlete statements; has_feedback indicates coach interpretation, "
            "not a measurement. Terrain is calculated; weather is an external estimate. "
            "Associations do not establish causation."
        ),
    }
