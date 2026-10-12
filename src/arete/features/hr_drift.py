"""HR drift / aerobic decoupling analysis over per-km laps.

Pure computation (no DB, no HTTP): ``analyze_runs`` takes the session rows
selected by the API and returns per-run drift metrics, an athlete-specific
baseline regression and effort-class buckets.

The raw HR drift ((last-half HR - first-half HR) / first-half HR) is confounded by
distance, gradient and D+. For each run we compute:

1. **HR drift %** and **pace drift %** between the two halves of the run
2. **Cardiac decoupling %** (Friel) = pace_drift + hr_drift
   <5% excellent, 5-10% good, >10% under-trained aerobic base / fatigue / heat
3. **Residual drift** = decoupling - predicted_by_baseline, where the baseline
   is a linear regression of decoupling on distance, D+/km and average pace
   fitted on the athlete's own runs (needs >= 10 runs)
4. **Drift score** from the run type, HR drift and residual
"""

from __future__ import annotations

import json
from collections import defaultdict
from typing import Any, TypedDict

MIN_RUNS_FOR_BASELINE = 10
KM_LAP_MIN_M = 900
KM_LAP_MAX_M = 1100
MIN_KM_LAPS = 4


class Run(TypedDict, total=False):
    id: int
    date: str
    name: str | None
    distance_km: float | None
    elevation_m: int | None
    duration_min: int | None
    avg_hr: int | None
    avg_pace_sec_km: int | None
    hr_drift_pct: float
    pace_drift_pct: float
    decoupling_pct: float
    splits: list[dict[str, float]]
    expected_decoupling_pct: float | None
    drift_residual_pct: float | None
    run_type: str
    tags: list[str]
    drift_score: str


def run_from_row(row: tuple[Any, ...]) -> Run | None:
    """Per-run drift metrics from an actual_sessions row.

    Row: (id, date, name, distance_m, ascent_m, moving_time_sec, avg_hr,
    avg_pace_sec_km, laps_json). Returns None when the run lacks 4 full 1-km laps.
    """
    rid, date_v, name, dist_m, dplus, dur, avg_hr, pace_sec, laps_str = row
    try:
        laps = json.loads(laps_str) if laps_str else []
    except (json.JSONDecodeError, TypeError):
        return None

    km_laps = [
        lap
        for lap in laps
        if KM_LAP_MIN_M <= (lap.get("distance") or 0) <= KM_LAP_MAX_M
        and lap.get("average_heartrate")
        and lap.get("average_speed")
    ]
    if len(km_laps) < MIN_KM_LAPS:
        return None

    hr_series = [float(lap["average_heartrate"]) for lap in km_laps]
    pace_series = [3600.0 / float(lap["average_speed"]) for lap in km_laps]
    elev_series = [float(lap.get("total_elevation_gain") or 0) for lap in km_laps]

    n = len(km_laps)
    half = n // 2
    first_hr = sum(hr_series[:half]) / half
    last_hr = sum(hr_series[-half:]) / half
    first_pace = sum(pace_series[:half]) / half
    last_pace = sum(pace_series[-half:]) / half
    if first_hr <= 0 or first_pace <= 0:
        return None

    hr_drift_pct = (last_hr - first_hr) / first_hr * 100
    pace_drift_pct = (last_pace - first_pace) / first_pace * 100  # >0 = slowing

    return Run(
        id=rid,
        date=str(date_v),
        name=name,
        distance_km=round(dist_m / 1000, 1) if dist_m else None,
        elevation_m=int(dplus) if dplus else None,
        duration_min=int(dur / 60) if dur else None,
        avg_hr=int(avg_hr) if avg_hr else None,
        avg_pace_sec_km=pace_sec,
        hr_drift_pct=round(hr_drift_pct, 1),
        pace_drift_pct=round(pace_drift_pct, 1),
        decoupling_pct=round(pace_drift_pct + hr_drift_pct, 1),
        splits=[
            {
                "km": i + 1,
                "hr": round(hr_series[i], 1),
                "pace_sec_km": round(pace_series[i]),
                "elev_m": round(elev_series[i]),
            }
            for i in range(n)
        ],
    )


def _elev_per_km(run: Run) -> float:
    return (run.get("elevation_m") or 0) / max(run.get("distance_km") or 1, 1)


def classify_run_type(run: Run) -> str:
    elev_per_km = _elev_per_km(run)
    pace = run.get("avg_pace_sec_km") or 0
    dist = run.get("distance_km") or 0
    if dist < 12 and pace < 360 and elev_per_km < 20:
        return "intensity"
    if elev_per_km > 30 and dist >= 15:
        return "trail_long"
    if elev_per_km > 30:
        return "trail_short"
    if dist >= 18:
        return "long_run"
    return "base"


def score_run(run_type: str, hr_drift: float, residual: float | None) -> str:
    def ok(limit: float) -> bool:
        return residual is None or residual < limit

    if run_type == "intensity":
        if hr_drift < 5:
            return "excellent"
        if hr_drift < 12:
            return "good" if ok(8) else "moderate"
        if hr_drift < 18:
            return "moderate"
        return "concerning"
    if run_type in ("trail_long", "trail_short"):
        if hr_drift < 0:
            return "excellent"
        if hr_drift < 5:
            return "excellent" if ok(5) else "good"
        if hr_drift < 10:
            return "good" if ok(8) else "moderate"
        return "concerning"
    # base / long_run
    if hr_drift < 0:
        return "excellent"
    if hr_drift < 3:
        return "excellent" if ok(5) else "good"
    if hr_drift < 6:
        return "good" if ok(8) else "moderate"
    if hr_drift < 10:
        return "moderate"
    return "concerning"


def effort_class(run: Run) -> str:
    d = run.get("distance_km") or 0
    elev_per_km = _elev_per_km(run)
    if d < 10:
        return "short"
    if d < 18:
        return "moderate_flat" if elev_per_km < 30 else "moderate_hilly"
    if elev_per_km < 40:
        return "long_flat"
    if elev_per_km < 80:
        return "long_hilly"
    return "long_mountain"


def _features(run: Run) -> list[float]:
    return [
        float(run.get("distance_km") or 0),
        _elev_per_km(run),
        float(run.get("avg_pace_sec_km") or 0),
    ]


def fit_baseline(runs: list[Run]) -> dict[str, Any] | None:
    """OLS of decoupling on (distance_km, elev_per_km, avg_pace_sec_km)."""
    if len(runs) < MIN_RUNS_FOR_BASELINE:
        return None
    import numpy as np  # here, not at module level: the API boot skips numpy

    X = np.array([_features(r) for r in runs], dtype=float)
    y = np.array([r["decoupling_pct"] for r in runs], dtype=float)

    X_mean = X.mean(axis=0)
    X_std = X.std(axis=0)
    X_std[X_std == 0] = 1.0
    X_full = np.column_stack([np.ones(len(X)), (X - X_mean) / X_std])
    coeffs, *_ = np.linalg.lstsq(X_full, y, rcond=None)
    y_pred = X_full @ coeffs
    ss_res = float(np.sum((y - y_pred) ** 2))
    ss_tot = float(np.sum((y - y.mean()) ** 2))
    r_squared = 1 - ss_res / ss_tot if ss_tot > 0 else 0.0

    # Back to original units: y = b0 + b1*x1 + b2*x2 + b3*x3
    slopes = [float(coeffs[i + 1] / X_std[i]) for i in range(3)]
    intercept = float(coeffs[0] - sum(slopes[i] * X_mean[i] for i in range(3)))
    return {
        "formula": "decoupling = b0 + b1*distance_km + b2*elev_per_km + b3*avg_pace_sec_km",
        "coefficients": {
            "intercept": round(intercept, 3),
            "distance_km": round(slopes[0], 3),
            "elev_per_km": round(slopes[1], 3),
            "avg_pace_sec_km": round(slopes[2], 3),
        },
        "r_squared": round(r_squared, 3),
        "n_samples": len(runs),
        "_slopes": slopes,
        "_intercept": intercept,
    }


def analyze_runs(rows: list[tuple[Any, ...]]) -> dict[str, Any]:
    """Full analysis for the API: runs, baseline and effort buckets."""
    runs = [r for r in (run_from_row(row) for row in rows) if r is not None]
    baseline = fit_baseline(runs)

    for run in runs:
        residual: float | None = None
        if baseline is not None:
            x = _features(run)
            expected = baseline["_intercept"] + sum(
                s * xi for s, xi in zip(baseline["_slopes"], x, strict=True)
            )
            residual = run["decoupling_pct"] - expected
            run["expected_decoupling_pct"] = round(expected, 1)
            run["drift_residual_pct"] = round(residual, 1)
        else:
            run["expected_decoupling_pct"] = None
            run["drift_residual_pct"] = None

        run["run_type"] = classify_run_type(run)
        tags: list[str] = []
        if run["hr_drift_pct"] < 0:
            tags.append("negative_hr_drift")
        if run["pace_drift_pct"] > 15:
            tags.append("large_pace_slowdown")
        if residual is not None:
            if run["decoupling_pct"] > 10:
                tags.append("high_coupling")
            if residual > 5:
                tags.append("worse_than_baseline")
            if residual < -5:
                tags.append("well_below_baseline")
        run["tags"] = tags
        run["drift_score"] = score_run(run["run_type"], run["hr_drift_pct"], residual)

    buckets: dict[str, list[float]] = defaultdict(list)
    for run in runs:
        buckets[effort_class(run)].append(run["decoupling_pct"])
    bucket_summary = {
        k: {
            "n": len(v),
            "avg_decoupling_pct": round(sum(v) / len(v), 1),
            "best_decoupling_pct": round(min(v), 1),
            "worst_decoupling_pct": round(max(v), 1),
        }
        for k, v in sorted(buckets.items())
    }

    public_baseline = (
        {k: v for k, v in baseline.items() if not k.startswith("_")}
        if baseline
        else None
    )
    return {
        "runs": runs,
        "count": len(runs),
        "baseline": public_baseline,
        "effort_buckets": bucket_summary,
    }
