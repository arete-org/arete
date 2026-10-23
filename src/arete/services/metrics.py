"""Training metrics shared by web and coaching surfaces."""

from __future__ import annotations

import logging
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Literal, NamedTuple

from pydantic import BaseModel, Field

from arete.dataio.db import connect
from arete.dataio.queries import daily_tss_by_date, training_loads
from arete.dataio.settings import get_user_settings
from arete.features.fitness import (
    DailyTSS,
    PerformanceModel,
    ReadinessLevel,
    compute_performance_model,
    ctl_atl_series,
    get_readiness_level,
)
from arete.features.recommendations import (
    RecommendationReport,
    generate_recommendations,
)
from arete.features.workload import (
    ACWRZone,
    DailyLoad,
    compute_workload_metrics,
)
from arete.garmin.readiness import (
    compute_readiness,
    fetch_window,
    training_readiness_from_rows,
)
from arete.services.athlete_scope import resolve_athlete_id
from arete.services.settings import athlete_today, today_in

logger = logging.getLogger(__name__)
TSS_PER_SESSION = 50.0
#: The regularity window: one missed week lowers it by one, never to zero.
RECENT_WEEKS = 12

#: garmin_training: the watch's morning Training Readiness; garmin: Arete's
#: score from Garmin's HRV, sleep and body battery; model: the CTL/ATL model.
ReadinessSource = Literal["garmin_training", "garmin", "model"]
READINESS_LOOKBACK_DAYS = 1


class WorkloadMetricsOut(BaseModel):
    """Workload metrics response."""

    acwr: float | None = Field(description="Acute:Chronic Workload Ratio")
    acwr_zone: str | None = Field(description="ACWR risk zone")
    acwr_ewma: float | None = Field(description="ACWR using EWMA method")
    monotony: float | None = Field(description="Training monotony (load variability)")
    monotony_zone: str | None = Field(description="Monotony zone")
    strain: float | None = Field(description="Training strain")
    strain_zone: str | None = Field(description="Strain zone")
    acute_load: float = Field(description="Acute load (7-day sum)")
    chronic_load: float | None = Field(description="Chronic load (28-day average)")
    days_analyzed: int = Field(description="Number of days with data")


class FitnessMetricsOut(BaseModel):
    """Fitness-Fatigue model response."""

    ctl: float = Field(description="Chronic Training Load (fitness)")
    atl: float = Field(description="Acute Training Load (fatigue)")
    tsb: float = Field(description="Training Stress Balance (form)")
    form_zone: str = Field(description="Current form zone")
    readiness_score: float = Field(
        description="Readiness 0-100: Garmin's (today, else yesterday), else the model's"
    )
    readiness_level: str = Field(description="Readiness level")
    readiness_source: ReadinessSource = Field(
        default="model", description="Where the readiness score comes from"
    )
    readiness_measured_on: date | None = Field(
        default=None, description="Day of the Garmin measurement (None for the model)"
    )
    ramp_rate: float | None = Field(description="CTL ramp rate (weekly change)")
    days_analyzed: int = Field(
        description="Days with load in the requested window (the model reads the whole history)"
    )


class StatBar(BaseModel):
    """A single stat bar (HP/MP/XP)."""

    current: float = Field(description="Current value")
    max: float = Field(description="Maximum value")
    label: str = Field(description="Human-readable label (French)")
    detail: str | None = Field(default=None, description="Raw value behind the bar")
    source: str | None = Field(default=None, description="Where the value comes from")


class PlayerStats(BaseModel):
    """RPG-style bars over real training data."""

    hp: StatBar = Field(
        description="Préparation: Garmin readiness (today or yesterday), else the CTL/ATL model"
    )
    mp: StatBar = Field(description="Fraîcheur: TSB mapped to 0-100")
    xp: StatBar = Field(description="Charge de la semaine: TSS vs the weekly goal")
    level: int = Field(description="Consecutive finished weeks at or above the goal")
    weeks_at_goal: int = Field(default=0, description="All-time count of weeks at goal")
    weekly_goal_tss: float = Field(default=0.0, description="Weekly TSS goal in use")
    recent_weeks_at_goal: int = Field(
        default=0, description="Weeks at goal among the last `recent_weeks` finished"
    )
    recent_weeks: int = Field(
        default=0,
        description=f"Finished weeks counted, at most {RECENT_WEEKS} (fewer at first)",
    )


class RecommendationOut(BaseModel):
    """Single recommendation."""

    priority: str
    category: str
    title: str
    message: str
    actions: list[str] = Field(default_factory=list)


class RecommendationsResponse(BaseModel):
    """Recommendations response."""

    risk_level: str = Field(description="Overall risk level")
    primary_concern: str | None = Field(description="Main area of concern")
    recommendations: list[RecommendationOut]
    workload_status: WorkloadMetricsOut | None = None
    fitness_status: FitnessMetricsOut | None = None


def _weekly_goal_tss(settings: dict) -> float:
    """Weekly TSS goal derived from the user's weekly session goal."""
    sessions = int(settings.get("weekly_training_goal") or 6)  # 0/None -> default
    return sessions * TSS_PER_SESSION


class WeekHistory(NamedTuple):
    """The finished weeks against the goal, from the same weekly totals."""

    streak: int  # consecutive, most recent first
    total: int  # all time
    recent: int  # among the last ``window``
    window: int  # finished weeks counted, at most RECENT_WEEKS


def _week_history(
    goal_tss: float, by_date: dict[date, float], today: date
) -> WeekHistory:
    """The finished weeks at goal: the streak, all time and over the last 12."""
    if not by_date:
        return WeekHistory(0, 0, 0, 0)
    weekly: dict[date, float] = {}
    for day, tss in by_date.items():
        monday = day - timedelta(days=day.weekday())
        weekly[monday] = weekly.get(monday, 0.0) + tss

    current_monday = today - timedelta(days=today.weekday())
    earliest = min(by_date)
    week_start = earliest - timedelta(days=earliest.weekday())
    reached: list[bool] = []
    while week_start < current_monday:
        reached.append(weekly.get(week_start, 0.0) >= goal_tss)
        week_start += timedelta(days=7)
    # A first week joined midway is not a missed week: the regularity starts
    # at the first full one (the streak and the all-time count are unchanged).
    first_partial = earliest.weekday() > 0 and bool(reached) and not reached[0]
    counted = reached[1:] if first_partial else reached

    streak = 0
    for ok in reversed(reached):  # most recent finished week first
        if not ok:
            break
        streak += 1
    recent = counted[-RECENT_WEEKS:]
    return WeekHistory(streak, sum(reached), sum(recent), len(recent))


# --------------------------------------------------------------------------- #
# One fitness series and one readiness, whatever the surface
# --------------------------------------------------------------------------- #
def fitness_history(by_date: Mapping[date, float], end: date) -> list[DailyTSS]:
    """Every day from the first session to ``end``, zeros on rest days."""
    if not by_date:
        return []
    first = min(by_date)
    return [
        DailyTSS(
            date=first + timedelta(days=i),
            tss=by_date.get(first + timedelta(days=i), 0.0),
        )
        for i in range((end - first).days + 1)
    ]


def fitness_series(
    by_date: Mapping[date, float], end: date
) -> list[tuple[DailyTSS, float, float]]:
    """Day-by-day (TSS, CTL, ATL) over the whole history, for charts."""
    return ctl_atl_series(fitness_history(by_date, end))


def fitness_model(
    by_date: Mapping[date, float], today: date, con=None
) -> PerformanceModel | None:
    """CTL/ATL/TSB for ``today`` over the whole history; None without any load.

    The dashboard, the daily tip, the briefing, ``/metrics/fitness`` and the
    Analytics chart all read this one series: each used to start its average
    on a different day and showed a different form for the same morning.
    """
    if not any(tss > 0 for tss in by_date.values()):
        return None
    history = [
        DailyTSS(date=d, tss=t) for d, t in sorted(by_date.items()) if d <= today
    ]
    return compute_performance_model(history, today, con=con)


@dataclass(frozen=True)
class Readiness:
    """The one readiness number every surface shows, and where it comes from."""

    score: float
    source: ReadinessSource
    measured_on: date | None  # the Garmin night; None for the model

    @property
    def level(self) -> str:
        return get_readiness_level(self.score).value


def current_readiness(
    today: date, window: Sequence[tuple], model: PerformanceModel | None
) -> Readiness | None:
    """The watch's Training Readiness this morning, else Arete's Garmin score
    (today's, yesterday's when the night is not in yet), else the CTL/ATL model."""
    training = training_readiness_from_rows(today, window)
    if training is not None:
        return Readiness(
            score=float(training), source="garmin_training", measured_on=today
        )
    for offset in range(READINESS_LOOKBACK_DAYS + 1):
        day = today - timedelta(days=offset)
        score = compute_readiness(day, window=window)
        if score is not None:
            return Readiness(score=float(score), source="garmin", measured_on=day)
    if model is None:
        return None
    return Readiness(
        score=round(model.readiness_score, 1), source="model", measured_on=None
    )


@dataclass(frozen=True)
class Form:
    """The daily load history, the model over it and the readiness: one read."""

    by_date: dict[date, float]
    model: PerformanceModel | None
    readiness: Readiness | None


def read_form(con, today: date) -> Form:
    """Up to three statements on ``con``: readiness window, load history and,
    when there is a load, the Banister coefficients."""
    window = fetch_window(con, today)
    by_date = daily_tss_by_date(con)
    model = fitness_model(by_date, today, con=con)
    return Form(by_date, model, current_readiness(today, window, model))


def _read_form(today: date) -> Form:
    con = connect()
    try:
        return read_form(con, today)
    finally:
        con.close()


def load_form(
    today: date | None = None,
) -> tuple[PerformanceModel | None, Readiness | None]:
    """The fitness model and the readiness for ``today``, on one connection."""
    form = _read_form(today or athlete_today())
    return form.model, form.readiness


def _recovery_bar(readiness: Readiness | None, today: date) -> StatBar:
    """HP: the readiness bar, labelled with where the number comes from."""
    if readiness is None:
        return StatBar(
            current=50.0,
            max=100,
            label="Préparation",
            detail="Aucune donnée de charge ni mesure Garmin",
            source="model",
        )
    if readiness.source == "garmin_training":
        return StatBar(
            current=readiness.score,
            max=100,
            label="Préparation",
            detail="Préparation à l'entraînement Garmin (ce matin)",
            source="garmin_training",
        )
    if readiness.source == "garmin":
        same_day = readiness.measured_on == today
        return StatBar(
            current=readiness.score,
            max=100,
            label="Préparation",
            detail=(
                "Garmin (VFC, sommeil, body battery)"
                if same_day
                else f"Garmin, mesure du {readiness.measured_on:%d/%m}"
            ),
            source="garmin" if same_day else "garmin_previous",
        )
    return StatBar(
        current=readiness.score,
        max=100,
        label="Préparation",
        detail="Estimée depuis la charge (aucune mesure Garmin récente)",
        source="model",
    )


def get_player_stats():
    """RPG bars over real data.

    - HP = Garmin readiness (HRV, sleep, body battery), yesterday's when the
      night is not published yet, model-based only as a last resort
    - MP = form: TSB mapped from -30..+30 onto 0..100
    - XP = this week's TSS against the goal derived from Settings
    - Level = consecutive finished weeks at or above that goal (kept for
      older readers; the dashboard shows the weeks at goal among the last 12)

    Four statements: settings, the readiness window, the daily TSS series
    (whole history, ~one row per training day) and the Banister coefficients.
    """
    settings = get_user_settings(user_id=resolve_athlete_id()) or {}
    today = today_in(settings.get("timezone"))
    return player_stats(settings, today, _read_form(today))


def player_stats(settings: dict, today: date, form: Form) -> PlayerStats:
    """The bars of ``get_player_stats`` from settings and a form already read."""
    goal_tss = _weekly_goal_tss(settings)
    by_date, model = form.by_date, form.model

    # --- HP: recovery ---
    hp = _recovery_bar(form.readiness, today)

    # --- MP: form (TSB) ---
    tsb = model.tsb if model else 0.0
    shown = round(tsb, 1) + 0.0  # never "-0,0": the dashboard's card shows "0,0"
    mp_current = round(max(0.0, min(100.0, (tsb + 30) * (100 / 60))), 1)
    mp = StatBar(
        current=mp_current,
        max=100,
        label="Fraîcheur",
        detail=f"TSB {shown:+.1f}".replace(".", ",") if shown else "TSB 0,0",
        source="model",
    )

    # --- XP: this week's load ---
    monday = today - timedelta(days=today.weekday())
    xp_current = round(sum(t for d, t in by_date.items() if monday <= d <= today), 1)
    goal_sessions = int(settings.get("weekly_training_goal") or 6)
    xp = StatBar(
        current=xp_current,
        max=goal_tss,
        label="Charge de la semaine",
        # The weeks at goal count this load goal, not the number of sessions.
        detail=f"Objectif {goal_tss:.0f} TSS · {goal_sessions} séances",
        source="model",
    )

    weeks = _week_history(goal_tss, by_date, today)
    return PlayerStats(
        hp=hp,
        mp=mp,
        xp=xp,
        level=weeks.streak,
        weeks_at_goal=weeks.total,
        weekly_goal_tss=goal_tss,
        recent_weeks_at_goal=weeks.recent,
        recent_weeks=weeks.window,
    )


def get_workload_metrics(
    days: int = 28,
):
    """Get workload metrics (ACWR, Monotony, Strain) from training history.

    Analyzes the last N days of training data and computes:
    - ACWR: Acute:Chronic Workload Ratio (injury risk indicator)
    - Monotony: Training load variability
    - Strain: Accumulated fatigue
    """
    target_date = athlete_today()
    return workload_metrics(training_loads(days=days, end=target_date), target_date)


def workload_metrics(loads: list[DailyLoad], target_date: date) -> WorkloadMetricsOut:
    """``get_workload_metrics`` over loads already read up to ``target_date``."""
    # Check if there's any training data
    has_data = any(load.duration_min > 0 for load in loads)
    if not has_data:
        # Return default values when no data
        return WorkloadMetricsOut(
            acwr=None,
            acwr_zone="unknown",
            acwr_ewma=None,
            monotony=None,
            monotony_zone="unknown",
            strain=None,
            strain_zone="unknown",
            acute_load=0.0,
            chronic_load=None,
            days_analyzed=0,
        )

    metrics = compute_workload_metrics(loads, target_date)

    return WorkloadMetricsOut(
        acwr=round(metrics.acwr, 3) if metrics.acwr else None,
        acwr_zone=metrics.acwr_zone.value if metrics.acwr_zone else None,
        acwr_ewma=round(metrics.acwr_ewma, 3) if metrics.acwr_ewma else None,
        monotony=round(metrics.monotony, 2) if metrics.monotony else None,
        monotony_zone=metrics.monotony_zone.value if metrics.monotony_zone else None,
        strain=round(metrics.strain, 1) if metrics.strain else None,
        strain_zone=metrics.strain_zone.value if metrics.strain_zone else None,
        acute_load=round(metrics.acute_load, 1),
        chronic_load=round(metrics.chronic_load, 1) if metrics.chronic_load else None,
        days_analyzed=len([load for load in loads if load.duration_min > 0]),
    )


def get_fitness_metrics(
    days: int = 42,
):
    """Get Fitness-Fatigue model metrics (CTL/ATL/TSB).

    Computes the Banister model over the whole history:
    - CTL: Chronic Training Load (42-day EWMA) = Fitness
    - ATL: Acute Training Load (7-day EWMA) = Fatigue
    - TSB: Training Stress Balance = Form (CTL - ATL)

    ``days`` only bounds ``days_analyzed``: the averages always walk the whole
    history, so this endpoint and every other surface read the same numbers.
    """
    target_date = athlete_today()
    return fitness_metrics(target_date, _read_form(target_date), days)


def fitness_metrics(target_date: date, form: Form, days: int = 42) -> FitnessMetricsOut:
    """``get_fitness_metrics`` from a form already read for ``target_date``."""
    by_date, model, readiness = form.by_date, form.model, form.readiness
    if model is None:
        return FitnessMetricsOut(
            ctl=0.0,
            atl=0.0,
            tsb=0.0,
            form_zone="neutral",
            readiness_score=readiness.score if readiness else 50.0,
            readiness_level=readiness.level if readiness else "moderate",
            readiness_source=readiness.source if readiness else "model",
            readiness_measured_on=readiness.measured_on if readiness else None,
            ramp_rate=None,
            days_analyzed=0,
        )

    assert readiness is not None  # a model always yields a readiness
    since = target_date - timedelta(days=days)
    return FitnessMetricsOut(
        ctl=round(model.ctl, 1),
        atl=round(model.atl, 1),
        tsb=round(model.tsb, 1),
        form_zone=model.form_zone.value,
        readiness_score=round(readiness.score, 1),
        readiness_level=readiness.level,
        readiness_source=readiness.source,
        readiness_measured_on=readiness.measured_on,
        ramp_rate=round(model.ramp_rate, 2) if model.ramp_rate else None,
        days_analyzed=sum(
            1 for d, t in by_date.items() if since <= d <= target_date and t > 0
        ),
    )


def get_recommendations(
    sport_type: Literal["cardio", "strength", "mixed"] = "mixed",
):
    """Get intelligent training recommendations based on current status.

    Analyzes workload and fitness metrics to provide actionable advice.
    """
    target_date = athlete_today()

    # Get current metrics
    workload = None
    loads = None
    try:
        loads = training_loads(days=28, end=target_date)
        if any(load.duration_min > 0 for load in loads):
            workload = compute_workload_metrics(loads, target_date)
    except Exception:
        logger.warning("Failed to compute workload metrics", exc_info=True)

    fitness = None
    readiness = None
    try:
        fitness, readiness = load_form(target_date)
    except Exception:
        logger.warning("Failed to compute fitness metrics", exc_info=True)

    # Generate recommendations even without data (will give default advice)
    report: RecommendationReport = generate_recommendations(
        acwr=workload.acwr if workload else None,
        acwr_zone=workload.acwr_zone if workload else ACWRZone.UNKNOWN,
        monotony=workload.monotony if workload else None,
        monotony_zone=workload.monotony_zone if workload else None,
        strain=workload.strain if workload else None,
        strain_zone=workload.strain_zone if workload else None,
        tsb=fitness.tsb if fitness else None,
        form_zone=fitness.form_zone if fitness else None,
        readiness=ReadinessLevel(readiness.level) if readiness else None,
        ramp_rate=fitness.ramp_rate if fitness else None,
        chronic_load=workload.chronic_load if workload and workload.chronic_load else 0,
        sport_type=sport_type,
    )

    # Determine risk level from report
    risk_level = report.risk_level

    # Primary concern
    primary_concern = report.primary_concern

    # Build response
    workload_out = None
    if workload and loads:
        workload_out = WorkloadMetricsOut(
            acwr=round(workload.acwr, 3) if workload.acwr else None,
            acwr_zone=workload.acwr_zone.value if workload.acwr_zone else None,
            acwr_ewma=round(workload.acwr_ewma, 3) if workload.acwr_ewma else None,
            monotony=round(workload.monotony, 2) if workload.monotony else None,
            monotony_zone=workload.monotony_zone.value
            if workload.monotony_zone
            else None,
            strain=round(workload.strain, 1) if workload.strain else None,
            strain_zone=workload.strain_zone.value if workload.strain_zone else None,
            acute_load=round(workload.acute_load, 1),
            chronic_load=round(workload.chronic_load, 1)
            if workload.chronic_load
            else None,
            days_analyzed=len([load for load in loads if load.duration_min > 0]),
        )

    fitness_out = get_fitness_metrics() if fitness else None

    return RecommendationsResponse(
        risk_level=risk_level,
        primary_concern=primary_concern,
        recommendations=[
            RecommendationOut(
                priority=r.priority.value,
                category=r.category.value,
                title=r.title,
                message=r.message,
                actions=r.actions,
            )
            for r in report.recommendations
        ],
        workload_status=workload_out,
        fitness_status=fitness_out,
    )


# --------------------------------------------------------------------------- #
# Running paces from the athlete's VDOT
# --------------------------------------------------------------------------- #
def current_vdot(con=None) -> tuple[float, str] | None:
    """(VDOT, source): Garmin's latest 10K prediction, else the threshold pace."""
    from arete.features.running import vdot_from_race, vdot_from_threshold_pace

    own = con is None
    con = con or connect()
    try:
        row = con.execute(
            "SELECT race_10k_sec FROM app.visible_daily_metrics WHERE user_id = getvariable('arete_athlete_id') AND race_10k_sec IS NOT NULL ORDER BY date DESC LIMIT 1"
        ).fetchone()
        if row and row[0]:
            return vdot_from_race(10_000, row[0]), "garmin_prediction"
        pace = (get_user_settings(user_id=resolve_athlete_id(), con=con) or {}).get(
            "threshold_pace_sec_km"
        )
    finally:
        if own:
            con.close()
    if pace:
        return vdot_from_threshold_pace(int(pace)), "threshold_pace"
    return None


def get_paces() -> dict:
    """Daniels training paces and race equivalents, or why there are none."""
    from arete.features.running import race_equivalents, training_paces

    found = current_vdot()
    if found is None:
        return {
            "vdot": None,
            "source": None,
            "paces": None,
            "equivalents": None,
            "reason": "Ni prédiction de course Garmin ni allure au seuil : "
            "synchronise Garmin ou renseigne ton allure au seuil.",
        }
    vdot, source = found
    return {
        "vdot": round(vdot, 1),
        "source": source,
        "paces": training_paces(vdot).to_dict(),
        "equivalents": race_equivalents(vdot),
        "reason": None,
    }
