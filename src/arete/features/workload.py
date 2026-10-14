"""Training load and workload ratio calculations.

Key metrics implemented:
- Training Load (sRPE): session RPE × duration
- Acute Load: 7-day rolling sum (or EWMA)
- Chronic Load: 28-day rolling average (or EWMA)
- ACWR: Acute:Chronic Workload Ratio (coupled and uncoupled methods)
- Monotony: mean daily load / std dev (training variation)
- Strain: weekly load × monotony (injury risk indicator)

References:
- Gabbett TJ (2016) The training-injury prevention paradox
- Foster C (1998) Monitoring training in athletes with reference to overtraining syndrome
- Williams et al. (2017) EWMA for ACWR calculation
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, timedelta
from enum import Enum
from statistics import StatisticsError, mean, stdev
from typing import NamedTuple


class ACWRZone(Enum):
    """ACWR risk zones with associated injury risk."""

    UNDERTRAINED = "undertrained"  # < 0.8
    OPTIMAL = "optimal"  # 0.8 - 1.3
    CAUTION = "caution"  # 1.3 - 1.5
    DANGER = "danger"  # > 1.5
    UNKNOWN = "unknown"  # insufficient data


class MonotonyZone(Enum):
    """Training monotony interpretation zones."""

    IDEAL = "ideal"  # < 1.5 - good variation
    ACCEPTABLE = "acceptable"  # 1.5 - 2.0
    HIGH = "high"  # > 2.0 - injury risk


class StrainZone(Enum):
    """Training strain interpretation zones."""

    LOW = "low"  # < 2000
    OPTIMAL = "optimal"  # 2000 - 4000
    HIGH = "high"  # 4000 - 6000
    CRITICAL = "critical"  # > 6000


@dataclass
class DailyLoad:
    """A single day's training load."""

    date: date
    duration_min: int
    rpe: float

    @property
    def load(self) -> float:
        """sRPE = duration × RPE."""
        return self.duration_min * self.rpe


class ACWRResult(NamedTuple):
    """ACWR calculation result with zone."""

    value: float | None
    zone: ACWRZone
    acute_load: float
    chronic_load: float


@dataclass
class WorkloadMetrics:
    """Computed workload metrics for a given date."""

    date: date
    acute_load: float  # 7-day sum (or EWMA)
    chronic_load: float  # 28-day average (or EWMA)
    acwr: float | None  # Acute:Chronic ratio
    acwr_zone: ACWRZone
    acwr_ewma: float | None  # EWMA-based ACWR (more accurate)
    monotony: float | None  # mean / stdev
    monotony_zone: MonotonyZone | None
    strain: float | None  # weekly load × monotony
    strain_zone: StrainZone | None


# =============================================================================
# CORE CALCULATIONS
# =============================================================================


def calculate_training_load(duration_min: int, rpe: float) -> float:
    """Calculate session training load (sRPE method).

    Args:
        duration_min: Session duration in minutes
        rpe: Rate of Perceived Exertion (0-10 scale)

    Returns:
        Training load = duration × RPE

    Example:
        >>> calculate_training_load(60, 7)
        420.0
    """
    return float(duration_min * rpe)


def calculate_acute_load(loads: Sequence[DailyLoad], target_date: date) -> float:
    """Calculate acute load (sum of last 7 days including target_date).

    Args:
        loads: Sequence of daily loads
        target_date: Date to calculate acute load for

    Returns:
        Sum of training loads for the 7 days ending on target_date
    """
    start_date = target_date - timedelta(days=6)
    return sum(d.load for d in loads if start_date <= d.date <= target_date)


def calculate_chronic_load(loads: Sequence[DailyLoad], target_date: date) -> float:
    """Calculate chronic load (average weekly load over 28 days).

    Uses rolling 28-day window, calculates average of 4 weekly sums.

    Args:
        loads: Sequence of daily loads
        target_date: Date to calculate chronic load for

    Returns:
        Average weekly load over the 28-day period
    """
    weekly_loads = []
    for week in range(4):
        week_end = target_date - timedelta(days=week * 7)
        week_start = week_end - timedelta(days=6)
        week_load = sum(d.load for d in loads if week_start <= d.date <= week_end)
        weekly_loads.append(week_load)

    return mean(weekly_loads) if weekly_loads else 0.0


# =============================================================================
# EWMA (Exponentially Weighted Moving Average) - More accurate for ACWR
# =============================================================================


def _ewma_decay(days: int) -> float:
    """Calculate EWMA decay factor (lambda).

    λ = 2 / (N + 1) where N is the time constant in days.

    Args:
        days: Time constant (7 for acute, 28 for chronic)

    Returns:
        Decay factor
    """
    return 2.0 / (days + 1)


def calculate_ewma_load(
    loads: Sequence[DailyLoad],
    target_date: date,
    days: int,
) -> float:
    """Calculate Exponentially Weighted Moving Average of training load.

    EWMA gives more weight to recent training, providing a more
    responsive measure than simple moving averages.

    Formula: EWMA_t = Load_t × λ + EWMA_{t-1} × (1 - λ)
    Where λ = 2 / (N + 1)

    Args:
        loads: Sequence of daily loads (should cover at least 'days' period)
        target_date: End date for calculation
        days: Time constant (7 for acute, 28 for chronic)

    Returns:
        EWMA load value
    """
    decay = _ewma_decay(days)

    # Build daily load dict for easy lookup
    load_dict: dict[date, float] = {d.date: d.load for d in loads}

    # Calculate EWMA from oldest to newest
    start_date = target_date - timedelta(days=days - 1)
    ewma = 0.0

    for i in range(days):
        current_date = start_date + timedelta(days=i)
        daily_load = load_dict.get(current_date, 0.0)
        ewma = daily_load * decay + ewma * (1 - decay)

    return ewma


def calculate_acwr_ewma(
    loads: Sequence[DailyLoad],
    target_date: date,
    acute_days: int = 7,
    chronic_days: int = 28,
) -> float | None:
    """Calculate ACWR using EWMA method (uncoupled).

    The uncoupled ACWR uses separate EWMA calculations for acute
    and chronic loads, which is more mathematically sound than
    the traditional coupled method.

    Args:
        loads: Sequence of daily loads
        target_date: Date to calculate ACWR for
        acute_days: Acute period (default 7)
        chronic_days: Chronic period (default 28)

    Returns:
        ACWR ratio using EWMA, or None if chronic is 0
    """
    acute_ewma = calculate_ewma_load(loads, target_date, acute_days)
    chronic_ewma = calculate_ewma_load(loads, target_date, chronic_days)

    if chronic_ewma == 0:
        return None

    return acute_ewma / chronic_ewma


# =============================================================================
# ACWR ZONES AND INTERPRETATION
# =============================================================================


def calculate_acwr(acute: float, chronic: float) -> float | None:
    """Calculate Acute:Chronic Workload Ratio.

    Optimal zone: 0.8 - 1.3
    Danger zone: > 1.5 (high injury risk)

    Args:
        acute: Acute load (7-day sum)
        chronic: Chronic load (28-day avg weekly)

    Returns:
        ACWR ratio, or None if chronic is 0
    """
    if chronic == 0:
        return None
    return acute / chronic


def get_acwr_zone(acwr: float | None) -> ACWRZone:
    """Get risk zone for ACWR value.

    Zones based on Gabbett (2016) research:
    - < 0.8: Undertrained (detraining risk)
    - 0.8-1.3: Optimal (sweet spot)
    - 1.3-1.5: Caution (moderate injury risk)
    - > 1.5: Danger (2-4x injury risk)

    Args:
        acwr: ACWR value

    Returns:
        ACWRZone enum value
    """
    if acwr is None:
        return ACWRZone.UNKNOWN
    if acwr < 0.8:
        return ACWRZone.UNDERTRAINED
    if acwr <= 1.3:
        return ACWRZone.OPTIMAL
    if acwr <= 1.5:
        return ACWRZone.CAUTION
    return ACWRZone.DANGER


def get_acwr_result(
    loads: Sequence[DailyLoad],
    target_date: date,
) -> ACWRResult:
    """Calculate ACWR with full context.

    Args:
        loads: Sequence of daily loads
        target_date: Date to calculate ACWR for

    Returns:
        ACWRResult with value, zone, and component loads
    """
    acute = calculate_acute_load(loads, target_date)
    chronic = calculate_chronic_load(loads, target_date)
    acwr = calculate_acwr(acute, chronic)
    zone = get_acwr_zone(acwr)

    return ACWRResult(
        value=acwr,
        zone=zone,
        acute_load=acute,
        chronic_load=chronic,
    )


# =============================================================================
# MONOTONY
# =============================================================================


def calculate_monotony(loads: Sequence[DailyLoad], target_date: date) -> float | None:
    """Calculate training monotony over last 7 days.

    Monotony = mean daily load / standard deviation

    High monotony (> 2.0) indicates lack of variation → higher injury risk.
    Formula accounts for rest days (load = 0).

    Args:
        loads: Sequence of daily loads
        target_date: Date to calculate monotony for

    Returns:
        Monotony value, or None if insufficient variation
    """
    # Build 7-day load array, padding with zeros for days without training
    all_days = []
    for i in range(7):
        day = target_date - timedelta(days=i)
        day_load = next((d.load for d in loads if d.date == day), 0.0)
        all_days.append(day_load)

    if len(all_days) < 2:
        return None

    try:
        std = stdev(all_days)
        if std == 0:
            return None
        return mean(all_days) / std
    except StatisticsError:
        return None


def get_monotony_zone(monotony: float | None) -> MonotonyZone | None:
    """Get interpretation zone for monotony value.

    Zones based on Foster (1998):
    - < 1.5: Ideal variation
    - 1.5 - 2.0: Acceptable
    - > 2.0: High risk

    Args:
        monotony: Monotony value

    Returns:
        MonotonyZone enum value, or None if monotony is None
    """
    if monotony is None:
        return None
    if monotony < 1.5:
        return MonotonyZone.IDEAL
    if monotony <= 2.0:
        return MonotonyZone.ACCEPTABLE
    return MonotonyZone.HIGH


# =============================================================================
# STRAIN
# =============================================================================


def calculate_strain(weekly_load: float, monotony: float | None) -> float | None:
    """Calculate training strain.

    Strain = weekly load × monotony
    High strain (> 6000) associated with increased illness/injury risk.

    Args:
        weekly_load: Total load for the week
        monotony: Monotony value

    Returns:
        Strain value, or None if monotony is None
    """
    if monotony is None:
        return None
    return weekly_load * monotony


def get_strain_zone(strain: float | None) -> StrainZone | None:
    """Get interpretation zone for strain value.

    Zones based on Foster et al.:
    - < 2000: Low (may be undertrained)
    - 2000 - 4000: Optimal for progression
    - 4000 - 6000: High (monitor recovery)
    - > 6000: Critical (illness/injury risk)

    Args:
        strain: Strain value

    Returns:
        StrainZone enum value, or None if strain is None
    """
    if strain is None:
        return None
    if strain < 2000:
        return StrainZone.LOW
    if strain <= 4000:
        return StrainZone.OPTIMAL
    if strain <= 6000:
        return StrainZone.HIGH
    return StrainZone.CRITICAL


# =============================================================================
# COMPOSITE METRICS
# =============================================================================


def compute_workload_metrics(
    loads: Sequence[DailyLoad],
    target_date: date,
) -> WorkloadMetrics:
    """Compute all workload metrics for a given date.

    Calculates both traditional and EWMA-based metrics.

    Args:
        loads: Historical daily loads
        target_date: Date to compute metrics for

    Returns:
        WorkloadMetrics with all computed values and zones
    """
    # Core calculations
    acute = calculate_acute_load(loads, target_date)
    chronic = calculate_chronic_load(loads, target_date)
    acwr = calculate_acwr(acute, chronic)
    acwr_zone = get_acwr_zone(acwr)

    # EWMA-based ACWR (more accurate)
    acwr_ewma = calculate_acwr_ewma(loads, target_date)

    # Monotony and strain
    monotony = calculate_monotony(loads, target_date)
    monotony_zone = get_monotony_zone(monotony)
    strain = calculate_strain(acute, monotony)
    strain_zone = get_strain_zone(strain)

    return WorkloadMetrics(
        date=target_date,
        acute_load=acute,
        chronic_load=chronic,
        acwr=acwr,
        acwr_zone=acwr_zone,
        acwr_ewma=acwr_ewma,
        monotony=monotony,
        monotony_zone=monotony_zone,
        strain=strain,
        strain_zone=strain_zone,
    )


# =============================================================================
# UTILITY FUNCTIONS
# =============================================================================


def calculate_weekly_load(loads: Sequence[DailyLoad], target_date: date) -> float:
    """Calculate total load for the week ending on target_date.

    Args:
        loads: Sequence of daily loads
        target_date: End date of the week

    Returns:
        Sum of loads for the 7-day period
    """
    return calculate_acute_load(loads, target_date)


def calculate_load_change_percent(
    loads: Sequence[DailyLoad],
    target_date: date,
) -> float | None:
    """Calculate week-over-week load change percentage.

    Args:
        loads: Sequence of daily loads
        target_date: End date of current week

    Returns:
        Percentage change from previous week, or None if previous week is 0
    """
    current_week = calculate_weekly_load(loads, target_date)
    previous_week = calculate_weekly_load(loads, target_date - timedelta(days=7))

    if previous_week == 0:
        return None

    return ((current_week - previous_week) / previous_week) * 100


def get_safe_load_increase(chronic_load: float, max_acwr: float = 1.3) -> float:
    """Calculate maximum safe weekly load to stay within target ACWR.

    Args:
        chronic_load: Current chronic load
        max_acwr: Target maximum ACWR (default 1.3 for optimal zone)

    Returns:
        Maximum recommended weekly load
    """
    return chronic_load * max_acwr


def validate_rpe(rpe: float) -> bool:
    """Validate RPE is within acceptable range.

    Args:
        rpe: Rate of Perceived Exertion

    Returns:
        True if RPE is valid (0-10)
    """
    return 0 <= rpe <= 10
