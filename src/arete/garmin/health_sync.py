"""Garmin daily metrics sync (HRV, sleep, body battery, stress).

Fetches one day of health metrics from Garmin Connect and persists
to app.daily_metrics. Computes a daily readiness score from the signals.

Readiness formula (0-100):
  - 40% HRV vs personal baseline (higher = better recovery)
  - 30% Sleep score / duration
  - 30% Body battery high (peak charge)
  - Penalty: high stress avg or RHR > personal baseline

Note: Personal baselines for HRV/RHR are derived from a 14-day rolling average
in the same table. This module is the entry point; the readiness computation
is in `compute_readiness()` and can also be re-run retroactively.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any

from arete.dataio.db import connect
from arete.garmin.client import GarminAuthError, GarminClient
from arete.services.athlete_scope import resolve_athlete_id

logger = logging.getLogger(__name__)


# ---------- Per-day fetchers (raw Garmin JSON -> daily_metrics columns) ----------


def _fetch_hrv(client: GarminClient, target_date: date) -> dict[str, Any]:
    try:
        data = client.hrv(target_date) or {}
    except Exception as e:
        logger.warning("HRV fetch failed for %s: %s", target_date, e)
        return {}
    summary = data.get("hrvSummary") or {}
    return {
        "hrv_last_night": summary.get("lastNightAvg"),
        "hrv_weekly_avg": summary.get("weeklyAvg"),
        "hrv_status": summary.get("status"),
    }


def _fetch_sleep(client: GarminClient, target_date: date) -> dict[str, Any]:
    try:
        data = client.sleep(target_date) or {}
    except Exception as e:
        logger.warning("Sleep fetch failed for %s: %s", target_date, e)
        return {}
    dto = data.get("dailySleepDTO") or {}
    if not dto.get("id"):
        return {}
    score = (dto.get("sleepScores") or {}).get("overall") or {}
    return {
        "sleep_duration_sec": dto.get("sleepTimeSeconds"),
        "sleep_score": score.get("value"),
        "sleep_deep_sec": dto.get("deepSleepSeconds"),
        "sleep_light_sec": dto.get("lightSleepSeconds"),
        "sleep_rem_sec": dto.get("remSleepSeconds"),
        "sleep_awake_sec": dto.get("awakeSleepSeconds"),
    }


def _fetch_stress(client: GarminClient, target_date: date) -> dict[str, Any]:
    try:
        data = client.stress(target_date) or {}
    except Exception as e:
        logger.warning("Stress fetch failed for %s: %s", target_date, e)
        return {}
    return {
        "stress_avg": data.get("avgStressLevel"),
        "stress_max": data.get("maxStressLevel"),
    }


def _fetch_body_battery(client: GarminClient, target_date: date) -> dict[str, Any]:
    try:
        days = client.body_battery(target_date)
    except Exception as e:
        logger.warning("BodyBattery fetch failed for %s: %s", target_date, e)
        return {}
    if not days:
        return {}
    day = days[0]
    values = [
        v[1]
        for v in (day.get("bodyBatteryValuesArray") or [])
        if isinstance(v, list | tuple) and len(v) > 1 and v[1] is not None
    ]
    return {
        "body_battery_charged": day.get("charged"),
        "body_battery_drained": day.get("drained"),
        "body_battery_high": max(values) if values else None,
        "body_battery_low": min(values) if values else None,
    }


def _fetch_steps(client: GarminClient, target_date: date) -> dict[str, Any]:
    try:
        items = client.steps(target_date)
    except Exception as e:
        logger.warning("Steps fetch failed for %s: %s", target_date, e)
        return {}
    if not items:
        return {}
    return {"steps": items[0].get("totalSteps")}


def _fetch_resting_hr(client: GarminClient, target_date: date) -> dict[str, Any]:
    try:
        data = client.resting_hr(target_date) or {}
    except Exception as e:
        logger.warning("Resting HR fetch failed for %s: %s", target_date, e)
        return {}
    metrics = (data.get("allMetrics") or {}).get("metricsMap") or {}
    entries = metrics.get("WELLNESS_RESTING_HEART_RATE") or []
    value = (
        entries[0].get("value") if entries and isinstance(entries[0], dict) else None
    )
    return {"resting_hr": value}


def _int(value: Any) -> int | None:
    try:
        return int(round(float(value))) if value is not None else None
    except (TypeError, ValueError):
        return None


def _fetch_training_readiness(
    client: GarminClient, target_date: date
) -> dict[str, Any]:
    """Garmin's morning Training Readiness: score 0-100, level, feedback."""
    try:
        data = client.training_readiness(target_date) or {}
    except Exception as e:
        logger.warning("Training readiness fetch failed for %s: %s", target_date, e)
        return {}
    if not isinstance(data, dict):
        return {}
    return {
        "training_readiness_score": _int(data.get("score")),
        "training_readiness_level": data.get("level"),
        "training_readiness_feedback": data.get("feedbackShort"),
    }


def _training_status_phrase(data: dict[str, Any]) -> str | None:
    latest = (data.get("mostRecentTrainingStatus") or {}).get(
        "latestTrainingStatusData"
    ) or {}
    for device in latest.values() if isinstance(latest, dict) else []:
        if isinstance(device, dict):
            phrase = device.get("trainingStatusFeedbackPhrase")
            status = device.get("trainingStatus")
            if phrase or status is not None:
                return str(phrase or status)
    return None


def _vo2max(data: Any) -> float | None:
    entries = data if isinstance(data, list) else [data]
    for entry in entries:
        generic = (entry or {}).get("generic") if isinstance(entry, dict) else None
        if isinstance(generic, dict):
            value = generic.get("vo2MaxPreciseValue") or generic.get("vo2MaxValue")
            if value is not None:
                return float(value)
    return None


def _fetch_performance(client: GarminClient, target_date: date) -> dict[str, Any]:
    """Garmin's fitness metrics, for the last day of a sync only.

    They move slowly and some endpoints (race predictions) only answer for
    "latest": one call each per run keeps the daily sync cheap.
    """
    metrics: dict[str, Any] = {}
    reads = (
        ("training status", lambda: client.training_status(target_date)),
        ("VO2max", lambda: client.max_metrics(target_date)),
        ("race predictions", client.race_predictions),
        ("endurance score", lambda: client.endurance_score(target_date)),
        ("hill score", lambda: client.hill_score(target_date)),
    )
    raw: dict[str, Any] = {}
    for name, read in reads:
        try:
            raw[name] = read()
        except Exception as e:
            logger.warning("%s fetch failed for %s: %s", name, target_date, e)
    status = raw.get("training status")
    if isinstance(status, dict):
        metrics["training_status"] = _training_status_phrase(status)
    metrics["vo2max_run"] = _vo2max(raw.get("VO2max"))
    races = raw.get("race predictions")
    if isinstance(races, list):  # the dated form answers a list of days
        races = races[-1] if races else None
    if isinstance(races, dict):
        metrics["race_5k_sec"] = _int(races.get("time5K"))
        metrics["race_10k_sec"] = _int(races.get("time10K"))
        metrics["race_half_sec"] = _int(races.get("timeHalfMarathon"))
        metrics["race_marathon_sec"] = _int(races.get("timeMarathon"))
    for name, column in (
        ("endurance score", "endurance_score"),
        ("hill score", "hill_score"),
    ):
        value = raw.get(name)
        if isinstance(value, dict):
            metrics[column] = _int(value.get("overallScore"))
    return metrics


# ---------- Aggregation + persistence ----------


@dataclass
class DailySyncResult:
    date: date
    success: bool
    fields_synced: int
    error: str | None = None


def _gather_metrics(
    client: GarminClient, target_date: date, *, performance: bool = True
) -> dict[str, Any]:
    """Fetch all signals for one day. Failures on individual signals are non-fatal.

    ``performance`` adds Garmin's slow-moving fitness metrics (training status,
    VO2max, race predictions, endurance and hill scores).
    """
    metrics: dict[str, Any] = {"date": target_date, "source": "garmin"}
    for fetch in (
        _fetch_hrv,
        _fetch_sleep,
        _fetch_stress,
        _fetch_body_battery,
        _fetch_steps,
        _fetch_resting_hr,
        _fetch_training_readiness,
    ):
        metrics.update(fetch(client, target_date))
    if performance:
        metrics.update(_fetch_performance(client, target_date))
    return {k: v for k, v in metrics.items() if v is not None}


def _upsert_daily_metrics(metrics: dict[str, Any]) -> None:
    """Insert or replace a single daily_metrics row."""
    con = connect()
    try:
        cols = [k for k in metrics if k != "date"]
        placeholders = ", ".join(["?"] * (len(cols) + 2))  # +2 for user_id, date
        col_list = ", ".join(["user_id", "date", *cols])
        update_set = ", ".join(f"{c} = EXCLUDED.{c}" for c in cols)
        values = [
            resolve_athlete_id(),
            metrics["date"],
            *[metrics.get(c) for c in cols],
        ]
        con.execute(
            f"""
            INSERT INTO app.daily_metrics ({col_list})
            VALUES ({placeholders})
            ON CONFLICT (user_id, date) DO UPDATE SET {update_set}
            """,
            values,
        )
        con.commit()
    finally:
        con.close()


def sync_day(
    target_date: date,
    client: GarminClient | None = None,
    *,
    performance: bool = True,
) -> DailySyncResult:
    """Sync one day of Garmin health data."""
    client = client or GarminClient()
    from arete.garmin.sync_budget import SyncBudget

    budget = getattr(client, "sync_budget", None)
    budget = budget if isinstance(budget, SyncBudget) else None
    error_count = len(budget.errors) if budget else 0
    try:
        client.connect()
    except GarminAuthError as e:
        return DailySyncResult(
            date=target_date, success=False, fields_synced=0, error=str(e)
        )
    try:
        metrics = _gather_metrics(client, target_date, performance=performance)
    except Exception as e:
        logger.exception("Failed to gather metrics for %s", target_date)
        return DailySyncResult(
            date=target_date, success=False, fields_synced=0, error=str(e)
        )
    try:
        _upsert_daily_metrics(metrics)
    except Exception as e:
        logger.exception("Failed to upsert metrics for %s", target_date)
        return DailySyncResult(
            date=target_date, success=False, fields_synced=0, error=str(e)
        )
    failed = budget is not None and (budget.stopped or len(budget.errors) > error_count)
    return DailySyncResult(
        date=target_date,
        success=not failed,
        fields_synced=len(metrics) - 2,
        error=(budget.stopped or "; ".join(budget.errors[error_count:]))
        if failed and budget
        else None,
    )  # Exclude the date and source metadata from the measurement count.


def sync_range(start: date, end: date) -> list[DailySyncResult]:
    """Sync a range of dates with one authenticated session.

    Seven calls per day, plus five for Garmin's fitness metrics on the last
    day only: they move slowly, and race predictions only answer for "latest".
    """
    client = GarminClient()
    results: list[DailySyncResult] = []
    cur = start
    while cur <= end:
        r = sync_day(cur, client, performance=cur == end)
        results.append(r)
        if r.success:
            logger.info("Synced %s (%d fields)", cur, r.fields_synced)
        else:
            logger.warning("Failed %s: %s", cur, r.error)
        cur += timedelta(days=1)
    return results
