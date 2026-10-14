"""Garmin daily health metrics API endpoints.

Endpoints for:
- Syncing HRV, sleep, body battery, stress, RHR from Garmin Connect
- Fetching daily readiness score
- Viewing recent health trends
"""

from __future__ import annotations

import logging
from datetime import date, timedelta
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from arete.config import config
from arete.dataio.db import connect, db_connection
from arete.dataio.queries import daily_metrics_range
from arete.garmin.readiness import update_readiness_range
from arete.services.settings import athlete_today

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/garmin/health", tags=["garmin-health"])


class SyncResultResponse(BaseModel):
    start: str
    end: str
    days_synced: int
    days_failed: int
    errors: list[str] = []


class DailyMetricsResponse(BaseModel):
    date: str
    hrv_weekly_avg: int | None = None
    hrv_last_night: int | None = None
    hrv_status: str | None = None
    sleep_duration_sec: int | None = None
    sleep_score: int | None = None
    sleep_deep_sec: int | None = None
    sleep_light_sec: int | None = None
    sleep_rem_sec: int | None = None
    sleep_awake_sec: int | None = None
    body_battery_charged: int | None = None
    body_battery_drained: int | None = None
    body_battery_high: int | None = None
    body_battery_low: int | None = None
    resting_hr: int | None = None
    stress_avg: int | None = None
    stress_max: int | None = None
    steps: int | None = None
    intensity_minutes: int | None = None
    readiness_score: int | None = None
    source: str | None = None
    fetched_at: str | None = None
    # Garmin's own training metrics
    training_readiness_score: int | None = None
    training_readiness_level: str | None = None
    training_readiness_feedback: str | None = None
    training_status: str | None = None
    vo2max_run: float | None = None
    race_5k_sec: int | None = None
    race_10k_sec: int | None = None
    race_half_sec: int | None = None
    race_marathon_sec: int | None = None
    endurance_score: int | None = None
    hill_score: int | None = None


@router.post("/sync", response_model=SyncResultResponse)
def trigger_sync(
    start: date = Query(default_factory=lambda: athlete_today() - timedelta(days=7)),
    end: date = Query(default_factory=athlete_today),
) -> SyncResultResponse:
    """Trigger a sync of Garmin health metrics for [start, end] range.

    Requires a Garmin login (Settings > System) — tokens live in $ARETE_GARMIN_TOKENS_DIR.
    Returns count of days synced + any per-day errors.
    """
    if end < start:
        raise HTTPException(status_code=400, detail="end must be >= start")
    if (end - start).days > 60:
        raise HTTPException(
            status_code=400, detail="Range too large (max 60 days per sync)"
        )

    from arete.garmin.health_sync import sync_range  # garminconnect

    results = sync_range(start, end)
    synced = sum(1 for r in results if r.success)
    failed = sum(1 for r in results if not r.success)
    errors = [f"{r.date}: {r.error}" for r in results if not r.success]

    if synced > 0:
        try:
            update_readiness_range(start, end)
        except Exception as e:
            logger.warning("Readiness recompute failed: %s", e)

    return SyncResultResponse(
        start=start.isoformat(),
        end=end.isoformat(),
        days_synced=synced,
        days_failed=failed,
        errors=errors,
    )


@router.get("/daily", response_model=DailyMetricsResponse)
def get_daily_metrics(
    target_date: date = Query(default_factory=date.today, alias="date"),
) -> DailyMetricsResponse:
    """Get stored health metrics + readiness for one day."""
    con = connect()
    try:
        row = con.execute(
            """
            SELECT date, hrv_weekly_avg, hrv_last_night, hrv_status,
                   sleep_duration_sec, sleep_score, sleep_deep_sec, sleep_light_sec,
                   sleep_rem_sec, sleep_awake_sec,
                   body_battery_charged, body_battery_drained,
                   body_battery_high, body_battery_low,
                   resting_hr, stress_avg, stress_max, steps, intensity_minutes,
                   readiness_score, source, fetched_at,
                   training_readiness_score, training_readiness_level,
                   training_readiness_feedback, training_status, vo2max_run,
                   race_5k_sec, race_10k_sec, race_half_sec, race_marathon_sec,
                   endurance_score, hill_score
            FROM app.visible_daily_metrics
            WHERE user_id = getvariable('arete_athlete_id') AND date = ?
            """,
            [target_date],
        ).fetchone()
    finally:
        con.close()

    if not row:
        raise HTTPException(
            status_code=404,
            detail=f"No metrics for {target_date}. Run POST /garmin/health/sync first.",
        )

    def _to_str(v: Any) -> str | None:
        if v is None:
            return None
        return str(v.isoformat()) if hasattr(v, "isoformat") else str(v)

    return DailyMetricsResponse(
        date=str(row[0]),
        hrv_weekly_avg=row[1],
        hrv_last_night=row[2],
        hrv_status=row[3],
        sleep_duration_sec=row[4],
        sleep_score=row[5],
        sleep_deep_sec=row[6],
        sleep_light_sec=row[7],
        sleep_rem_sec=row[8],
        sleep_awake_sec=row[9],
        body_battery_charged=row[10],
        body_battery_drained=row[11],
        body_battery_high=row[12],
        body_battery_low=row[13],
        resting_hr=row[14],
        stress_avg=row[15],
        stress_max=row[16],
        steps=row[17],
        intensity_minutes=row[18],
        readiness_score=row[19],
        source=row[20],
        fetched_at=_to_str(row[21]),
        training_readiness_score=row[22],
        training_readiness_level=row[23],
        training_readiness_feedback=row[24],
        training_status=row[25],
        vo2max_run=row[26],
        race_5k_sec=row[27],
        race_10k_sec=row[28],
        race_half_sec=row[29],
        race_marathon_sec=row[30],
        endurance_score=row[31],
        hill_score=row[32],
    )


@router.get("/range")
def get_metrics_range(
    start: date = Query(default_factory=lambda: athlete_today() - timedelta(days=30)),
    end: date = Query(default_factory=athlete_today),
) -> dict:
    """Get metrics for a range (e.g. for chart visualization)."""
    with db_connection() as con:
        days = daily_metrics_range(con, start, end)

    return {"start": start.isoformat(), "end": end.isoformat(), "days": days}


@router.get("/status")
def sync_status() -> dict:
    """Health sync state from local state: no Garmin login, no ``garminconnect``.

    ``tokens_present`` means usable session tokens are stored, as for
    ``GET /garmin/sync/status``: tokens Garmin refused count as absent.
    """
    from arete.garmin import token_store

    tokens_present, _ = token_store.session_status()
    con = connect()
    try:
        stats = con.execute(
            """
            SELECT COUNT(*), MIN(date), MAX(date), MAX(fetched_at)
            FROM app.visible_daily_metrics WHERE user_id = getvariable('arete_athlete_id')
            """
        ).fetchone() or (0, None, None, None)
    finally:
        con.close()

    return {
        "tokens_present": tokens_present,
        "tokens_dir": str(config.garmin_tokens_dir),
        "days_stored": stats[0] or 0,
        "first_date": str(stats[1]) if stats[1] else None,
        "last_date": str(stats[2]) if stats[2] else None,
        "last_sync": stats[3].isoformat() if stats[3] else None,
    }
