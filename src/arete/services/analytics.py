"""Analytics API: one overview per period, and session reads and edits.

``/analytics/overview`` answers four questions in one round-trip — how much did
I train, how hard, how efficiently, how well did I recover — so the page can
render every card without fanning out to a dozen endpoints.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Mapping, Sequence
from datetime import date, timedelta

from arete.dataio.db import connect, db_connection
from arete.dataio.queries import (
    FOOT_SPORTS,
    MODEL_EXCLUDED_SOURCES,
    RUNNING_SPORTS,
    OverviewRow,
    daily_metrics_range,
    drift_rows,
    earliest_session_date,
    overview_rows,
    sql_in,
    terrain_rows,
)
from arete.dataio.settings import athlete_zone_model
from arete.features import insights
from arete.features import overview as ov
from arete.features.fitness import DailyTSS
from arete.features.periods import PeriodWindow, resolve_period
from arete.features.terrain import VAM_MINUTES
from arete.features.workload import (
    DailyLoad,
    calculate_acute_load,
    calculate_acwr,
    calculate_chronic_load,
    get_acwr_zone,
)
from arete.services.metrics import fitness_series
from arete.services.settings import athlete_today

logger = logging.getLogger(__name__)


#: Best-effort buckets, ascending by distance. These are the names Strava
#: wrote into ``best_efforts_json`` (the year review reads them) — matching is
#: case-insensitive because it is not consistent about it ("1K" and "5K" but
#: "1 mile", "50k"), and comparing spellings dropped every K distance from the
#: records.
EFFORT_NAMES = (
    "400m",
    "1/2 mile",
    "1K",
    "1 mile",
    "2 mile",
    "5K",
    "10K",
    "15K",
    "10 mile",
    "20K",
    "Half-Marathon",
    "30K",
    "Marathon",
    "50K",
)

#: Lookup from whatever spelling the data carries to the canonical name above.
_EFFORT_BY_KEY = {name.casefold(): name for name in EFFORT_NAMES}

ACWR_ZONE_FR = {
    "undertrained": "charge basse",
    "optimal": "zone optimale",
    "caution": "prudence",
    "danger": "zone à risque",
}

MIN_DRIFT_DURATION_SEC = 40 * 60


def _fetch_start(window: PeriodWindow) -> date:
    """First day to query: the previous window when there is one."""
    return window.prev_start or window.start


ACWR_HISTORY_DAYS = 28


def _days(start: date, end: date) -> list[date]:
    return [start + timedelta(days=i) for i in range((end - start).days + 1)]


def _between(rows: Sequence[OverviewRow], start: date, end: date) -> list[OverviewRow]:
    return [r for r in rows if start <= r.date <= end]


def _sport_totals(
    rows: Sequence[OverviewRow], start: date, end: date
) -> list[tuple[str, float, int]]:
    """(sport, hours, sessions) over the range, most hours first."""
    totals: dict[str, tuple[float, int]] = {}
    for r in _between(rows, start, end):
        hours, count = totals.get(r.sport, (0.0, 0))
        totals[r.sport] = (hours + r.duration_sec / 3600, count + 1)
    ranked = sorted(totals.items(), key=lambda item: item[1][0], reverse=True)
    return [(sport, hours, count) for sport, (hours, count) in ranked]


def _daily_tss(rows: Sequence[OverviewRow], start: date, end: date) -> list[DailyTSS]:
    by_date: dict[date, float] = {}
    for r in _between(rows, start, end):
        by_date[r.date] = by_date.get(r.date, 0.0) + r.tss
    return [DailyTSS(date=d, tss=by_date.get(d, 0.0)) for d in _days(start, end)]


def _daily_loads(
    rows: Sequence[OverviewRow], start: date, end: date
) -> list[DailyLoad]:
    """Same series as ``queries.daily_loads``: minutes and mean RPE (5 if unset)."""
    by_date: dict[date, list[OverviewRow]] = {}
    for r in _between(rows, start, end):
        by_date.setdefault(r.date, []).append(r)
    loads = []
    for d in _days(start, end):
        day = by_date.get(d)
        if not day:
            loads.append(DailyLoad(date=d, duration_min=0, rpe=0))
            continue
        rpes = [r.rpe if r.rpe is not None else 5 for r in day]
        minutes = int(sum(r.duration_sec for r in day) / 60.0)
        loads.append(DailyLoad(date=d, duration_min=minutes, rpe=sum(rpes) / len(rpes)))
    return loads


def _acwr(loads: list[DailyLoad], target: date) -> tuple[float | None, str | None]:
    """Acute:chronic ratio on the last day of the window, with a French label."""
    value = calculate_acwr(
        calculate_acute_load(loads, target), calculate_chronic_load(loads, target)
    )
    if value is None:
        return None, None
    return round(value, 2), ACWR_ZONE_FR.get(get_acwr_zone(value).value)


def effort_pace(row: OverviewRow) -> tuple[int | None, bool]:
    """(pace the trend reads, whether it is grade-adjusted) for one run.

    A hilly run (at least ``insights.FLAT_M_PER_KM`` of climbing per km) with
    a GAP from its streams is read at its GAP, so a mountain week does not
    look like lost form; a flat run keeps the pace it always had.
    """
    km = (row.distance_m or 0) / 1000
    hilly = km > 0 and (row.ascent_m or 0) / km >= insights.FLAT_M_PER_KM
    if hilly and row.gap_sec_km:
        return row.gap_sec_km, True
    return row.avg_pace_sec_km, False


def get_overview(period: str = "30d"):
    """Every analytics card for one period, with the previous one as reference.

    Five statements on one cursor (the zone model reads the settings on its
    own): the first session date, every session from the CTL warm-up on, the
    long runs with laps, the health metrics, and the stored terrain of every
    session on foot (the climbing records are all-time). The cards slice them.
    """
    with db_connection() as con:
        earliest = earliest_session_date(con)
        window = resolve_period(period, athlete_today(), earliest)
        start = _fetch_start(window)
        # The form chart walks the whole history, as every other surface does.
        tss_start = min(earliest or start, start)
        rows = overview_rows(con, tss_start, window.end)
        drifts = drift_rows(con, start, window.end, MIN_DRIFT_DURATION_SEC)
        health = daily_metrics_range(con, start, window.end)
        terrain = terrain_rows(con)

    shown = _between(rows, start, window.end)
    runs = [r for r in shown if r.sport in RUNNING_SPORTS]
    sessions = [(r.date, r.sport, r.duration_sec, r.distance_m) for r in shown]
    zones = [(r.date, r.hr_zones_json) for r in shown if r.hr_zones_json is not None]
    sports_cur = _sport_totals(rows, window.start, window.end)
    sports_prev = (
        _sport_totals(rows, window.prev_start, window.prev_end)
        if window.prev_start and window.prev_end
        else []
    )
    paces = [
        (r.date, pace, r.distance_m, r.duration_sec, graded)
        for r in runs
        for pace, graded in [effort_pace(r)]
        if pace is not None
    ]
    efficiency = [
        (r.date, r.avg_hr, r.avg_pace_sec_km, r.duration_sec)
        for r in runs
        if r.avg_hr is not None
        and r.avg_pace_sec_km is not None
        and r.avg_pace_sec_km > 0
    ]
    climbs = [
        (r.date, r.sport, r.distance_m, r.ascent_m)
        for r in shown
        if r.sport in FOOT_SPORTS
    ]
    cadences = [
        (r.date, r.avg_cadence, r.avg_pace_sec_km)
        for r in runs
        if r.avg_cadence is not None
    ]
    climbs_vam = [(t.date, t.session_id, t.name, t.vam) for t in terrain]
    descents = [
        (t.date, json.loads(t.descent_json))
        for t in terrain
        if t.sport in RUNNING_SPORTS and t.descent_json and start <= t.date
    ]
    pmc_series = fitness_series(
        {t.date: t.tss for t in _daily_tss(rows, tss_start, window.end)}, window.end
    )
    loads_start = window.end - timedelta(days=ACWR_HISTORY_DAYS)
    acwr, acwr_zone = _acwr(_daily_loads(rows, loads_start, window.end), window.end)

    recovery = ov.build_recovery_cards(health, window)
    return {
        "hr_zone_model": athlete_zone_model().as_dict(),
        "period": window.period,
        "bucket": window.bucket,
        "start": window.start.isoformat(),
        "end": window.end.isoformat(),
        "prev_start": window.prev_start.isoformat() if window.prev_start else None,
        "prev_end": window.prev_end.isoformat() if window.prev_end else None,
        "cards": {
            "volume": ov.build_volume_card(sessions, window, RUNNING_SPORTS),
            "pmc": ov.build_pmc_card(pmc_series, window, acwr, acwr_zone),
            "zones": ov.build_zones_card(zones, window),
            "sports": ov.build_sports_card(sports_cur, sports_prev),
            "decoupling": ov.build_decoupling_card(drifts, efficiency, window),
            "pace": ov.build_pace_card(paces, window),
            "elevation": ov.build_elevation_card(climbs, window, RUNNING_SPORTS),
            "cadence": ov.build_cadence_card(cadences, window),
            "vam": ov.build_vam_card(climbs_vam, window, VAM_MINUTES),
            "descent": ov.build_descent_card(descents, window),
            **recovery,
        },
    }


def best_efforts(rows: Sequence[tuple]) -> dict[str, dict]:
    """Fastest effort per canonical distance over ``best_effort_rows`` rows."""
    bests: dict[str, dict] = {}
    for efforts_json, row_date, activity_name, activity_id in rows:
        efforts = (
            json.loads(efforts_json) if isinstance(efforts_json, str) else efforts_json
        )
        if not isinstance(efforts, list):
            continue
        for effort in efforts:
            name = _EFFORT_BY_KEY.get(str(effort.get("name", "")).casefold())
            elapsed = effort.get("elapsed_time", 0)
            if name is None or elapsed <= 0:
                continue
            if name not in bests or elapsed < bests[name]["time_sec"]:
                bests[name] = {
                    "name": name,
                    "time_sec": elapsed,
                    "time_display": ov.format_hms(elapsed),
                    "date": str(row_date),
                    "activity_name": activity_name or "",
                    "activity_id": activity_id,
                }
    return bests


# ---------- Session CRUD ----------


_EDITABLE_SESSION_FIELDS = ("rpe", "notes")


def update_session(session_id: int, fields: Mapping[str, int | str | None]):
    """Update RPE and/or notes for an actual session.

    Every given field is written, ``None`` included: that is how the athlete
    clears an RPE. Absent fields are left alone.
    """
    unknown = set(fields) - set(_EDITABLE_SESSION_FIELDS)
    if unknown:
        raise ValueError(f"Not editable: {sorted(unknown)}")
    columns = [name for name in _EDITABLE_SESSION_FIELDS if name in fields]
    if not columns:
        return {"success": True}
    con = connect(read_only=False)
    try:
        con.execute(
            f"UPDATE app.actual_sessions SET {', '.join(f'{c} = ?' for c in columns)} WHERE user_id = getvariable('arete_athlete_id') AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM app.athletes scope_owner WHERE scope_owner.id=user_id AND scope_owner.deleted_at IS NULL) AND (id = ?) ",
            [*(fields[c] for c in columns), session_id],
        )
        return {"success": True}
    finally:
        con.close()


def list_sessions(limit: int = 20, offset: int = 0, *, for_model: bool = False):
    """List recent actual sessions (Log page; ``for_model`` for the coach)."""
    excluded = MODEL_EXCLUDED_SOURCES if for_model else ()
    with db_connection() as con:
        rows = con.execute(
            f"""
            SELECT id, date, sport, name, duration_sec, distance_m,
                   avg_hr, avg_pace_sec_km, rpe, notes, source, calories
            FROM app.visible_actual_sessions
            WHERE user_id = getvariable('arete_athlete_id')
              {f"AND source NOT IN ({sql_in(excluded)})" if excluded else ""}
            ORDER BY date DESC, id DESC
            LIMIT ? OFFSET ?
            """,
            [limit, offset],
        ).fetchall()

    sessions = []
    for r in rows:
        sessions.append(
            {
                "id": r[0],
                "date": str(r[1]),
                "sport": r[2],
                "name": r[3],
                "duration_sec": r[4],
                "distance_m": r[5],
                "avg_hr": r[6],
                "avg_pace_sec_km": r[7],
                "pace_display": ov.format_pace(r[7]),
                "rpe": r[8],
                "notes": r[9],
                "source": r[10],
                "calories": r[11],
            }
        )
    return {"sessions": sessions}


def get_session(session_id: int) -> dict | None:
    """Exact source of a personal record; never match an activity by its title."""
    with db_connection() as con:
        row = con.execute(
            "SELECT id,date,name,sport,duration_sec,distance_m,avg_hr,hr_zones_json,source FROM app.visible_actual_sessions WHERE id=? AND user_id = getvariable('arete_athlete_id')",
            [session_id],
        ).fetchone()
    if row is None:
        return None
    return dict(
        zip(
            (
                "id",
                "date",
                "name",
                "sport",
                "duration_sec",
                "distance_m",
                "avg_hr",
                "hr_zones_json",
                "source",
            ),
            row,
            strict=True,
        )
    )
