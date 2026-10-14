"""Fitness-Fatigue model (Banister) and performance prediction.

Implements:
- CTL (Chronic Training Load) - "Fitness"
- ATL (Acute Training Load) - "Fatigue"
- TSB (Training Stress Balance) - "Form"
- Performance prediction
- Readiness scoring

References:
- Banister et al. (1975) - Fitness-Fatigue model
- Busso (2003) - Non-linear model extensions
- Coggan - PMC (Performance Management Chart)
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, timedelta
from enum import Enum
from typing import NamedTuple


class FormZone(Enum):
    """Training Stress Balance (Form) interpretation zones."""

    FRESHEST = "freshest"  # TSB > 25 - Peak performance, may be detrained
    FRESH = "fresh"  # TSB 10-25 - Good for racing/testing
    NEUTRAL = "neutral"  # TSB -10 to 10 - Normal training
    TIRED = "tired"  # TSB -25 to -10 - Accumulating fatigue
    EXHAUSTED = "exhausted"  # TSB < -25 - Risk of overtraining


class ReadinessLevel(Enum):
    """Overall readiness assessment."""

    OPTIMAL = "optimal"  # Green light, perform well
    GOOD = "good"  # Can train hard
    MODERATE = "moderate"  # Train cautiously
    LOW = "low"  # Recovery focus
    CRITICAL = "critical"  # Rest required


@dataclass
class DailyTSS:
    """A single day's Training Stress Score."""

    date: date
    tss: float  # Training Stress Score


class FitnessMetrics(NamedTuple):
    """Fitness-Fatigue model output."""

    ctl: float  # Chronic Training Load (Fitness)
    atl: float  # Acute Training Load (Fatigue)
    tsb: float  # Training Stress Balance (Form)
    form_zone: FormZone


@dataclass
class PerformanceModel:
    """Complete performance model state."""

    date: date
    ctl: float
    atl: float
    tsb: float
    form_zone: FormZone
    readiness_score: float
    readiness_level: ReadinessLevel
    predicted_performance: float | None
    ramp_rate: float | None  # Weekly CTL change


# =============================================================================
# CTL / ATL / TSB (BANISTER MODEL)
# =============================================================================


def calculate_ctl(
    tss_values: Sequence[DailyTSS],
    target_date: date,
    time_constant: int = 42,
) -> float:
    """Calculate Chronic Training Load (CTL) - "Fitness".

    CTL is an exponentially weighted average of daily TSS
    with a 42-day time constant (default).

    CTL_today = CTL_yesterday + (TSS_today - CTL_yesterday) / τ

    Args:
        tss_values: Sequence of daily TSS values
        target_date: Date to calculate CTL for
        time_constant: Time constant in days (default 42)

    Returns:
        CTL value
    """
    # Build TSS dict for easy lookup
    tss_dict: dict[date, float] = {d.date: d.tss for d in tss_values}

    ctl = 0.0
    for current_date in _ewma_days(tss_dict, target_date, time_constant * 2):
        daily_tss = tss_dict.get(current_date, 0.0)
        ctl = ctl + (daily_tss - ctl) / time_constant

    return ctl


def _ewma_days(
    tss_dict: dict[date, float], target_date: date, min_days: int
) -> list[date]:
    """Days an EWMA walks to reach ``target_date``.

    From the first day of the given history, so every caller holding the same
    history reads the same number (the dashboard and the Analytics chart used
    to start their averages at different days), and never fewer than
    ``min_days`` before the target, the warm-up a short series needs.
    """
    start = target_date - timedelta(days=min_days)
    earlier = [d for d in tss_dict if d < start]
    if earlier:
        start = min(earlier)
    return [start + timedelta(days=i) for i in range((target_date - start).days + 1)]


def ctl_atl_series(
    tss_values: Sequence[DailyTSS],
    ctl_time_constant: int = 42,
    atl_time_constant: int = 7,
) -> list[tuple[DailyTSS, float, float]]:
    """Day-by-day CTL/ATL EWMA over a contiguous TSS series (for charts)."""
    ctl = 0.0
    atl = 0.0
    out = []
    for day in tss_values:
        ctl = ctl + (day.tss - ctl) / ctl_time_constant
        atl = atl + (day.tss - atl) / atl_time_constant
        out.append((day, ctl, atl))
    return out


def calculate_atl(
    tss_values: Sequence[DailyTSS],
    target_date: date,
    time_constant: int = 7,
) -> float:
    """Calculate Acute Training Load (ATL) - "Fatigue".

    ATL is an exponentially weighted average of daily TSS
    with a 7-day time constant (default).

    ATL_today = ATL_yesterday + (TSS_today - ATL_yesterday) / τ

    Args:
        tss_values: Sequence of daily TSS values
        target_date: Date to calculate ATL for
        time_constant: Time constant in days (default 7)

    Returns:
        ATL value
    """
    tss_dict: dict[date, float] = {d.date: d.tss for d in tss_values}

    atl = 0.0
    for current_date in _ewma_days(tss_dict, target_date, time_constant * 4):
        daily_tss = tss_dict.get(current_date, 0.0)
        atl = atl + (daily_tss - atl) / time_constant

    return atl


def calculate_tsb(ctl: float, atl: float) -> float:
    """Calculate Training Stress Balance (TSB) - "Form".

    TSB = CTL - ATL

    Positive TSB = Fresh (fitness > fatigue)
    Negative TSB = Fatigued (fatigue > fitness)

    Args:
        ctl: Chronic Training Load
        atl: Acute Training Load

    Returns:
        TSB value
    """
    return ctl - atl


def get_form_zone(tsb: float) -> FormZone:
    """Determine form zone from TSB value.

    Args:
        tsb: Training Stress Balance

    Returns:
        FormZone enum value
    """
    if tsb > 25:
        return FormZone.FRESHEST
    if tsb >= 10:
        return FormZone.FRESH
    if tsb >= -10:
        return FormZone.NEUTRAL
    if tsb >= -25:
        return FormZone.TIRED
    return FormZone.EXHAUSTED


def calculate_fitness_metrics(
    tss_values: Sequence[DailyTSS],
    target_date: date,
    ctl_constant: int = 42,
    atl_constant: int = 7,
) -> FitnessMetrics:
    """Calculate complete Fitness-Fatigue metrics.

    Args:
        tss_values: Sequence of daily TSS values
        target_date: Date to calculate for
        ctl_constant: CTL time constant (default 42)
        atl_constant: ATL time constant (default 7)

    Returns:
        FitnessMetrics with CTL, ATL, TSB, and form zone
    """
    ctl = calculate_ctl(tss_values, target_date, ctl_constant)
    atl = calculate_atl(tss_values, target_date, atl_constant)
    tsb = calculate_tsb(ctl, atl)
    form_zone = get_form_zone(tsb)

    return FitnessMetrics(
        ctl=ctl,
        atl=atl,
        tsb=tsb,
        form_zone=form_zone,
    )


# =============================================================================
# RAMP RATE
# =============================================================================


def calculate_ramp_rate(
    tss_values: Sequence[DailyTSS],
    target_date: date,
    ctl_constant: int = 42,
) -> float | None:
    """Calculate weekly CTL ramp rate.

    Ramp rate = CTL change per week.

    Recommended limits:
    - < 5 points/week: Safe progression
    - 5-7 points/week: Aggressive but manageable
    - > 7 points/week: Risk of injury/overtraining

    Args:
        tss_values: Sequence of daily TSS values
        target_date: Date to calculate for
        ctl_constant: CTL time constant (default 42)

    Returns:
        Weekly CTL change, or None if insufficient data
    """
    ctl_current = calculate_ctl(tss_values, target_date, ctl_constant)
    ctl_week_ago = calculate_ctl(
        tss_values,
        target_date - timedelta(days=7),
        ctl_constant,
    )

    return ctl_current - ctl_week_ago


def is_ramp_rate_safe(ramp_rate: float, max_safe: float = 7.0) -> bool:
    """Check if ramp rate is within safe limits.

    Args:
        ramp_rate: Weekly CTL change
        max_safe: Maximum safe increase per week (default 7)

    Returns:
        True if ramp rate is safe
    """
    return ramp_rate <= max_safe


# =============================================================================
# READINESS SCORING
# =============================================================================


def calculate_readiness_score(
    tsb: float,
    ramp_rate: float | None = None,
    hrv_score: float | None = None,
    sleep_quality: float | None = None,
    subjective_feeling: float | None = None,
) -> float:
    """Calculate composite readiness score (0-100).

    Combines multiple factors:
    - TSB (Training Stress Balance) - primary factor
    - Ramp rate - training load increase
    - HRV (if available) - physiological readiness
    - Sleep quality (if available)
    - Subjective feeling (if available)

    Args:
        tsb: Training Stress Balance
        ramp_rate: Weekly CTL change (optional)
        hrv_score: HRV readiness score 0-100 (optional)
        sleep_quality: Sleep score 0-100 (optional)
        subjective_feeling: Self-reported feeling 1-10 (optional)

    Returns:
        Readiness score 0-100
    """
    scores = []
    weights = []

    # TSB component (40% weight)
    # Map TSB to 0-100 scale
    # TSB -40 -> 0, TSB +40 -> 100, TSB 0 -> 50
    tsb_score = max(0, min(100, 50 + tsb * 1.25))
    scores.append(tsb_score)
    weights.append(0.40)

    # Ramp rate component (20% weight)
    if ramp_rate is not None:
        # Lower ramp = higher readiness
        # 0 ramp -> 100, 10+ ramp -> 0
        ramp_score = max(0, 100 - ramp_rate * 10)
        scores.append(ramp_score)
        weights.append(0.20)

    # HRV component (20% weight if available)
    if hrv_score is not None:
        scores.append(hrv_score)
        weights.append(0.20)

    # Sleep component (10% weight if available)
    if sleep_quality is not None:
        scores.append(sleep_quality)
        weights.append(0.10)

    # Subjective feeling (10% weight if available)
    if subjective_feeling is not None:
        # Convert 1-10 to 0-100
        feeling_score = (subjective_feeling - 1) * (100 / 9)
        scores.append(feeling_score)
        weights.append(0.10)

    # Normalize weights
    total_weight = sum(weights)
    normalized_weights = [w / total_weight for w in weights]

    # Weighted average
    readiness = sum(s * w for s, w in zip(scores, normalized_weights, strict=True))

    return round(readiness, 1)


def get_readiness_level(readiness_score: float) -> ReadinessLevel:
    """Get readiness level from score.

    Args:
        readiness_score: Readiness score 0-100

    Returns:
        ReadinessLevel enum value
    """
    if readiness_score >= 80:
        return ReadinessLevel.OPTIMAL
    if readiness_score >= 65:
        return ReadinessLevel.GOOD
    if readiness_score >= 50:
        return ReadinessLevel.MODERATE
    if readiness_score >= 35:
        return ReadinessLevel.LOW
    return ReadinessLevel.CRITICAL


# =============================================================================
# PERFORMANCE PREDICTION
# =============================================================================


def predict_performance(
    ctl: float,
    atl: float,
    k1: float = 1.0,
    k2: float = 2.0,
    baseline: float = 100.0,
) -> float:
    """Predict performance using Banister model.

    Performance = baseline + k1 × CTL - k2 × ATL

    The k1 and k2 parameters can be individualized
    through historical performance data.

    Args:
        ctl: Chronic Training Load
        atl: Acute Training Load
        k1: Fitness gain factor (default 1.0)
        k2: Fatigue impact factor (default 2.0)
        baseline: Baseline performance level

    Returns:
        Predicted performance index
    """
    return baseline + k1 * ctl - k2 * atl


def estimate_days_to_peak(
    current_tsb: float,
    target_tsb: float = 20.0,
    daily_tsb_recovery: float = 3.0,
) -> int:
    """Estimate days needed to reach peak form.

    Simple estimation assuming rest/reduced training.

    Args:
        current_tsb: Current TSB
        target_tsb: Target TSB for peak (default 20)
        daily_tsb_recovery: Expected daily TSB gain at rest

    Returns:
        Estimated days to peak
    """
    if current_tsb >= target_tsb:
        return 0

    tsb_needed = target_tsb - current_tsb
    return max(1, int(tsb_needed / daily_tsb_recovery))


def recommend_taper_duration(ctl: float) -> int:
    """Recommend taper duration based on fitness level.

    Higher CTL = longer taper needed.

    Args:
        ctl: Current CTL

    Returns:
        Recommended taper days
    """
    if ctl < 50:
        return 5  # Low fitness, short taper
    if ctl < 80:
        return 7
    if ctl < 100:
        return 10
    return 14  # High fitness, longer taper


# =============================================================================
# COMPLETE MODEL
# =============================================================================


def compute_performance_model(
    tss_values: Sequence[DailyTSS],
    target_date: date,
    hrv_score: float | None = None,
    sleep_quality: float | None = None,
    subjective_feeling: float | None = None,
    con=None,
) -> PerformanceModel:
    """Compute complete performance model state.

    Args:
        tss_values: Historical TSS values
        target_date: Date to compute for
        hrv_score: Optional HRV readiness score
        sleep_quality: Optional sleep quality score
        subjective_feeling: Optional subjective feeling (1-10)
        con: Open connection the Banister coefficients are read on, if any

    Returns:
        PerformanceModel with all metrics
    """
    metrics = calculate_fitness_metrics(tss_values, target_date)
    ramp_rate = calculate_ramp_rate(tss_values, target_date)

    readiness = calculate_readiness_score(
        tsb=metrics.tsb,
        ramp_rate=ramp_rate,
        hrv_score=hrv_score,
        sleep_quality=sleep_quality,
        subjective_feeling=subjective_feeling,
    )
    readiness_level = get_readiness_level(readiness)

    # Try personalized Banister coefficients (lazy import avoids circular)
    try:
        from arete.features.banister import load_coefficients

        coeffs = load_coefficients(con=con)
    except Exception:
        coeffs = None

    if coeffs:
        predicted_perf = predict_performance(
            metrics.ctl,
            metrics.atl,
            k1=coeffs["k1"],
            k2=coeffs["k2"],
            baseline=coeffs["baseline"],
        )
    else:
        predicted_perf = predict_performance(metrics.ctl, metrics.atl)

    return PerformanceModel(
        date=target_date,
        ctl=round(metrics.ctl, 1),
        atl=round(metrics.atl, 1),
        tsb=round(metrics.tsb, 1),
        form_zone=metrics.form_zone,
        readiness_score=readiness,
        readiness_level=readiness_level,
        predicted_performance=round(predicted_perf, 1),
        ramp_rate=round(ramp_rate, 1) if ramp_rate else None,
    )


# =============================================================================
# TSS CONVERSION UTILITIES
# =============================================================================


def srpe_to_tss(
    duration_min: int,
    rpe: float,
    ftp_equivalent: float = 100.0,
) -> float:
    """Convert sRPE training load to approximate TSS.

    Rough conversion for athletes without power meters.

    Args:
        duration_min: Session duration
        rpe: Rate of Perceived Exertion (1-10)
        ftp_equivalent: Baseline for scaling

    Returns:
        Approximate TSS
    """
    # sRPE load
    srpe_load = duration_min * rpe

    # Normalize: 60 min at RPE 5 ≈ 50 TSS
    return srpe_load / 6


def trimp_to_tss(trimp: float, ftp_trimp: float = 100.0) -> float:
    """Convert TRIMP to approximate TSS.

    Args:
        trimp: TRIMP value
        ftp_trimp: TRIMP value for 1-hour threshold session

    Returns:
        Approximate TSS
    """
    # 1 hour at threshold ≈ 100 TSS
    return (trimp / ftp_trimp) * 100


def strength_volume_to_tss(
    volume_kg: float,
    intensity_pct: float,
    duration_min: int,
) -> float:
    """Convert strength training metrics to approximate TSS.

    Rough approximation for mixed training.

    Args:
        volume_kg: Total volume (tonnage)
        intensity_pct: Average intensity (0-1)
        duration_min: Session duration

    Returns:
        Approximate TSS
    """
    # Base TSS from duration and intensity
    base_tss = duration_min * (intensity_pct**2)

    # Volume factor
    volume_factor = min(2.0, volume_kg / 5000)  # Cap at 2x for heavy sessions

    return base_tss * (0.5 + 0.5 * volume_factor)
