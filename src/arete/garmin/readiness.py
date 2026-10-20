"""Daily readiness score from Garmin health metrics.

Formula (0-100):
  - 40% HRV score   : last_night_hrv / 14d_baseline, clamped 0.5-1.5
  - 30% Sleep score : sleep_duration / personal_target, clipped 0.5-1.2
  - 30% Body Battery: peak BB / 100, capped at 1.0
  - Penalty: -5 per +1 std-dev above 14d baseline for stress_avg
  - Penalty: -3 per +5 bpm above 14d baseline for RHR (when available)

Returns a 0-100 integer. If 14-day baseline is unavailable (cold start),
falls back to fixed thresholds and returns 50 (neutral).
"""

from __future__ import annotations

import logging
from collections.abc import Sequence
from datetime import date, timedelta

import duckdb

from arete.dataio.db import connect

logger = logging.getLogger(__name__)


HRV_WEIGHT = 0.40
SLEEP_WEIGHT = 0.30
BB_WEIGHT = 0.30
SLEEP_TARGET_SEC = 8 * 3600  # 8h default target
BASELINE_DAYS = 14
_DAY_FIELDS = (
    "hrv_last_night",
    "sleep_duration_sec",
    "body_battery_high",
    "stress_avg",
    "resting_hr",
)


def _fetch_day_metrics(target_date: date) -> dict | None:
    """Load one row from app.daily_metrics."""
    con = connect()
    try:
        row = con.execute(
            """
            SELECT hrv_last_night, sleep_duration_sec, body_battery_high,
                   stress_avg, resting_hr
            FROM app.visible_daily_metrics
            WHERE user_id = getvariable('arete_athlete_id') AND date = ?
            """,
            [target_date],
        ).fetchone()
    finally:
        con.close()
    if not row:
        return None
    return dict(zip(_DAY_FIELDS, row, strict=True))


def _fetch_baseline(target_date: date, days: int = BASELINE_DAYS) -> dict | None:
    """Compute 14-day mean + stddev for stress and RHR (excludes target_date)."""
    start = target_date - timedelta(days=days)
    con = connect()
    try:
        rows = con.execute(
            """
            SELECT hrv_last_night, sleep_duration_sec, body_battery_high,
                   stress_avg, resting_hr
            FROM app.visible_daily_metrics
            WHERE user_id = getvariable('arete_athlete_id')
              AND date >= ? AND date < ?
              AND hrv_last_night IS NOT NULL
            """,
            [start, target_date],
        ).fetchall()
    finally:
        con.close()
    return _baseline_stats(rows)


def _baseline_stats(rows: Sequence[tuple]) -> dict | None:
    """Mean + stddev per metric over (hrv, sleep, bb, stress, rhr) rows."""
    if len(rows) < 5:
        return None

    def stats(idx: int) -> tuple[float, float] | None:
        vals = [r[idx] for r in rows if r[idx] is not None]
        if len(vals) < 5:
            return None
        mean = sum(vals) / len(vals)
        var = sum((v - mean) ** 2 for v in vals) / len(vals)
        return mean, var**0.5

    return {
        "hrv_mean": stats(0),
        "sleep_mean": stats(1),
        "bb_mean": stats(2),
        "stress_mean_std": stats(3),
        "rhr_mean_std": stats(4),
    }


def fetch_window(
    con: duckdb.DuckDBPyConnection, end: date, days: int = BASELINE_DAYS + 1
) -> list[tuple]:
    """(date, hrv, sleep, bb, stress, rhr, Garmin Training Readiness) rows
    from ``end - days`` to ``end``.

    The default covers ``end`` and the day before, each with its baseline.
    """
    return con.execute(
        """
        SELECT date, hrv_last_night, sleep_duration_sec, body_battery_high,
               stress_avg, resting_hr, training_readiness_score
        FROM app.visible_daily_metrics
        WHERE user_id = getvariable('arete_athlete_id') AND date >= ? AND date <= ?
        """,
        [end - timedelta(days=days), end],
    ).fetchall()


def readiness_from_rows(target_date: date, rows: Sequence[tuple]) -> int | None:
    """``compute_readiness`` over rows already read by ``fetch_window``."""
    width = len(_DAY_FIELDS) + 1
    day_row = next((r[1:width] for r in rows if r[0] == target_date), None)
    start = target_date - timedelta(days=BASELINE_DAYS)
    baseline_rows = [
        r[1:width] for r in rows if start <= r[0] < target_date and r[1] is not None
    ]
    day = dict(zip(_DAY_FIELDS, day_row, strict=True)) if day_row else None
    return _score(day, _baseline_stats(baseline_rows))


def training_readiness_from_rows(
    target_date: date, rows: Sequence[tuple]
) -> int | None:
    """Garmin's own morning Training Readiness for that day, from ``fetch_window``."""
    width = len(_DAY_FIELDS) + 1
    for r in rows:
        if r[0] == target_date and len(r) > width and r[width] is not None:
            return int(r[width])
    return None


def compute_readiness(
    target_date: date, *, window: Sequence[tuple] | None = None
) -> int | None:
    """Compute readiness score (0-100) for the given date.

    Returns None if no data for that day. ``window`` (rows from
    ``fetch_window``) spares the two reads.
    """
    if window is not None:
        return readiness_from_rows(target_date, window)
    day = _fetch_day_metrics(target_date)
    if not day or day.get("hrv_last_night") is None:
        return None
    return _score(day, _fetch_baseline(target_date))


def _score(day: dict | None, baseline: dict | None) -> int | None:
    if not day or day.get("hrv_last_night") is None:
        return None  # cold start: need at least HRV

    # Sub-score: HRV (0-1, higher is better)
    hrv = day["hrv_last_night"]
    if baseline and baseline["hrv_mean"]:
        hrv_baseline = baseline["hrv_mean"][0]
        hrv_ratio = hrv / hrv_baseline if hrv_baseline > 0 else 1.0
    else:
        hrv_ratio = 1.0
    hrv_score = max(0.0, min(1.0, (hrv_ratio - 0.5) / 1.0))  # 0.5→0, 1.5→1

    # Sub-score: sleep (0-1)
    sleep_sec = day.get("sleep_duration_sec") or 0
    sleep_ratio = sleep_sec / SLEEP_TARGET_SEC if SLEEP_TARGET_SEC > 0 else 0
    sleep_score = max(0.0, min(1.0, (sleep_ratio - 0.5) / 0.7))  # 0.5→0, 1.2→1

    # Sub-score: body battery (0-1)
    bb = day.get("body_battery_high") or 0
    bb_score = min(1.0, max(0.0, bb / 100.0))

    base_score = (
        (HRV_WEIGHT * hrv_score) + (SLEEP_WEIGHT * sleep_score) + (BB_WEIGHT * bb_score)
    )
    base_0_100 = base_score * 100

    # Penalties
    penalty = 0
    if baseline and baseline["stress_mean_std"] and day.get("stress_avg") is not None:
        mean, std = baseline["stress_mean_std"]
        if std > 0:
            z = (day["stress_avg"] - mean) / std
            if z > 0:
                penalty += 5 * z  # -5 per +1 std
    if baseline and baseline["rhr_mean_std"] and day.get("resting_hr") is not None:
        mean, std = baseline["rhr_mean_std"]
        if std > 0:
            z = (day["resting_hr"] - mean) / std
            if z > 0:
                penalty += 3 * z  # -3 per +1 std

    final = max(0, min(100, int(base_0_100 - penalty)))
    return final


def update_readiness_for_date(target_date: date) -> int | None:
    """Compute readiness and write to DB. Returns the score or None."""
    score = compute_readiness(target_date)
    if score is None:
        return None
    con = connect()
    try:
        con.execute(
            """
            UPDATE app.daily_metrics
            SET readiness_score = ?
            WHERE user_id = getvariable('arete_athlete_id') AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM app.athletes scope_owner WHERE scope_owner.id=user_id AND scope_owner.deleted_at IS NULL) AND (user_id = getvariable('arete_athlete_id') AND date = ?)
            RETURNING date
            """,
            [score, target_date],
        )
        con.commit()
    finally:
        con.close()
    return score


def update_readiness_range(start: date, end: date) -> int:
    """Recompute readiness for a range. Returns count of days updated."""
    n = 0
    cur = start
    while cur <= end:
        if update_readiness_for_date(cur) is not None:
            n += 1
        cur += timedelta(days=1)
    return n
