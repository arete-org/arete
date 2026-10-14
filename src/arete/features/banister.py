"""Personalized Banister model coefficient fitting.

Fits athlete-specific k1/k2/baseline parameters from training history,
with speed per heartbeat (the inverse of cardiac cost) as the performance
proxy: Banister's performance rises with fitness and falls with fatigue.
"""

from __future__ import annotations

import logging
from datetime import date
from typing import TYPE_CHECKING

from arete.dataio.db import connect
from arete.dataio.queries import RUNNING_SPORTS, daily_tss, sql_in
from arete.features.fitness import DailyTSS
from arete.services.athlete_scope import resolve_athlete_id

if TYPE_CHECKING:
    import numpy as np

logger = logging.getLogger(__name__)


def get_tss_history(con, start_date: date, end_date: date) -> list[DailyTSS]:
    """Daily TSS between two dates (shared query, see arete.dataio.queries)."""
    return daily_tss(con, start_date, end_date)


def get_running_sessions(con, start_date: date, end_date: date) -> list[dict]:
    """Fetch running sessions with HR and speed data."""
    rows = con.execute(
        f"""
        SELECT date, avg_hr, avg_speed_mps
        FROM app.visible_actual_sessions
        WHERE sport IN ({sql_in(RUNNING_SPORTS)})
          AND avg_hr IS NOT NULL
          AND avg_speed_mps IS NOT NULL
          AND avg_speed_mps > 0
          AND date >= ? AND date <= ?
          AND user_id = getvariable('arete_athlete_id')
        ORDER BY date ASC
        """,
        [start_date, end_date],
    ).fetchall()

    return [
        {"date": r[0], "avg_hr": float(r[1]), "avg_speed_mps": float(r[2])}
        for r in rows
    ]


def compute_efficiency(avg_hr: float, avg_speed_mps: float) -> float:
    """Cardiac efficiency: HR per km/h. Lower = more efficient."""
    speed_kmh = avg_speed_mps * 3.6
    return avg_hr / speed_kmh


def compute_performance_proxy(avg_hr: float, avg_speed_mps: float) -> float:
    """Metres per hour per beat per minute, x1000: higher = better.

    ``1000 / compute_efficiency``: 12 km/h at 150 bpm gives 80. The Banister
    equation (baseline + k1*CTL - k2*ATL) models a performance that fitness
    raises and fatigue lowers; regressing the cardiac cost instead, which
    fitness lowers, made both clamped coefficients 0 on real data.
    """
    return 1000.0 / compute_efficiency(avg_hr, avg_speed_mps)


def _ridge(
    X: np.ndarray, y: np.ndarray, alpha: float
) -> tuple[np.ndarray, float, float]:
    """Ridge regression with an unpenalised intercept (closed form).

    Same estimator as sklearn's Ridge(alpha, fit_intercept=True): centre X and y,
    solve (X'X + alpha*I) w = X'y, intercept = mean(y) - mean(X) @ w.
    Returns (coefficients, intercept, r2).
    """
    import numpy as np  # here, not at module level: the API boot skips numpy

    x_mean = X.mean(axis=0)
    y_mean = float(y.mean())
    Xc = X - x_mean
    yc = y - y_mean
    n_features = X.shape[1]
    w = np.linalg.solve(Xc.T @ Xc + alpha * np.eye(n_features), Xc.T @ yc)
    intercept = y_mean - float(x_mean @ w)
    y_pred = X @ w + intercept
    ss_res = float(np.sum((y - y_pred) ** 2))
    ss_tot = float(np.sum((y - y_mean) ** 2))
    r2 = 1.0 - ss_res / ss_tot if ss_tot > 0 else 0.0
    return w, intercept, r2


def fit_coefficients(sessions: list[dict]) -> dict | None:
    """Fit Banister coefficients from session data.

    Args:
        sessions: list of dicts with 'ctl', 'atl', 'avg_hr', 'avg_speed_mps'

    Returns:
        dict with k1, k2, baseline, r2, n_samples, or None if insufficient data
    """
    if len(sessions) < 10:
        return None
    import numpy as np  # here, not at module level: the API boot skips numpy

    X = np.column_stack(
        [
            [s["ctl"] for s in sessions],
            [s["atl"] for s in sessions],
        ]
    )
    y = np.array(
        [compute_performance_proxy(s["avg_hr"], s["avg_speed_mps"]) for s in sessions]
    )

    coef, intercept, r2 = _ridge(X, y, alpha=1.0)

    # Model: proxy = baseline + k1*CTL - k2*ATL (fitness helps, fatigue hurts)
    k1 = max(0.0, float(coef[0]))
    k2 = max(0.0, -float(coef[1]))
    baseline = float(intercept)

    return {
        "k1": round(k1, 4),
        "k2": round(k2, 4),
        "baseline": round(baseline, 2),
        "r2": round(r2, 4),
        "n_samples": len(sessions),
    }


def load_coefficients(user_id: int | None = None, con=None) -> dict | None:
    """Load personalized Banister coefficients from DB (on ``con`` if given).

    Returns None if coefficients are not available or R² is too low.
    """
    user_id = resolve_athlete_id(user_id)
    own = con is None
    con = con or connect()
    try:
        row = con.execute(
            "SELECT k1, k2, baseline, r2 FROM app.visible_banister_coefficients WHERE user_id = ?",
            [user_id],
        ).fetchone()
        if row and row[3] and float(row[3]) > 0.1:
            return {
                "k1": float(row[0]),
                "k2": float(row[1]),
                "baseline": float(row[2]),
                "r2": float(row[3]),
            }
        return None
    finally:
        if own:
            con.close()


def store_coefficients(coeffs: dict, user_id: int | None = None) -> None:
    """UPSERT Banister coefficients into DB."""
    user_id = resolve_athlete_id(user_id)
    con = connect()
    try:
        con.execute(
            """
            INSERT INTO app.banister_coefficients (user_id, k1, k2, baseline, r2, n_samples, fitted_at)
            VALUES (?, ?, ?, ?, ?, ?, now())
            ON CONFLICT (user_id) DO UPDATE SET
                k1 = EXCLUDED.k1,
                k2 = EXCLUDED.k2,
                baseline = EXCLUDED.baseline,
                r2 = EXCLUDED.r2,
                n_samples = EXCLUDED.n_samples,
                fitted_at = now()
            """,
            [
                user_id,
                coeffs["k1"],
                coeffs["k2"],
                coeffs["baseline"],
                coeffs["r2"],
                coeffs["n_samples"],
            ],
        )
        con.commit()
    finally:
        con.close()
