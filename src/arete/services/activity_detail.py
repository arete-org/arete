"""One activity in detail: the session page and the coach's ``get_activity_detail``.

Everything is computed, deterministically, from what is stored: the session
row, its laps (``laps_json``), Strava's metric splits (``splits_json``), its HR
zones and, when a FIT file fed it, its kept streams, plus the terrain (GAP,
climbing speeds) and start weather ``session_conditions`` stored when the
session arrived. The analytics are the ones
``garmin/time_series`` always had and nothing called: decoupling, pace fade,
cadence variability, normalized power, and the work intervals of a structured
workout read from the FIT laps' intensity.

The page gets everything, streams down-sampled for a chart, and the block it
opens with (``summary``): the rule sentence when no feedback is stored, a
strength log's totals, how the session compared with its linked plan and the
next day's plan. The model gets a compact digest
without any stream, and never a Strava row (Strava's API agreement keeps its
data out of AI applications).
"""

from __future__ import annotations

import json
import logging
from datetime import date, timedelta
from typing import Any, Literal, TypedDict

from arete.dataio.queries import FOOT_SPORTS
from arete.dataio.settings import athlete_zone_model
from arete.features.overview import ZONES
from arete.garmin.matcher import PlanVerdict, SessionMatcher
from arete.garmin.models import ActualSession, PlannedSession
from arete.garmin.repository import GarminRepository
from arete.garmin.streams import ActivityStreams, downsample, route
from arete.garmin.time_series import (
    ActivityMetricsCalculator,
    LapData,
    LapIntensity,
    WorkoutStructure,
)
from arete.services.analytics import MODEL_EXCLUDED_SOURCES
from arete.services.coaching_repository import SessionFeedbackRepository
from arete.services.plan_repository import PlanDecisionRepository
from arete.services.session_conditions import get_terrain, get_weather
from arete.services.settings import athlete_today
from arete.strength.models import StrengthSession
from arete.strength.progression import ExerciseSession, WorkSet
from arete.strength.repository import StrengthRepository

logger = logging.getLogger(__name__)

#: Points per chart line: one per ~6 s on an hour, enough for a phone or a laptop.
CHART_POINTS = 600
#: Points of the SVG route trace.
ROUTE_POINTS = 400
#: What the coach reads at most; a 40-lap track session stays one tool result.
MODEL_LAPS = 15
MODEL_INTERVALS = 20
#: Below this the halves are too short for decoupling or fade to mean much.
MIN_ANALYSIS_SEC = 20 * 60
#: The terrain changed the effort by this fraction at least (GAP vs pace).
GAP_NOTABLE = 0.03
#: How far past the next day the page looks for the next open session.
NEXT_SESSION_DAYS = 7
#: Planned statuses still ahead of the athlete.
_OPEN_STATUSES = frozenset({"pending", "modified"})
#: Plan decisions that still shape their day (dismissed ones changed nothing).
_STANDING_DECISIONS = frozenset({"pending", "discussion", "applied"})


class TopLift(TypedDict):
    """The session's best e1RM and that exercise's previous session."""

    exercise: str
    e1rm_kg: float
    previous_kg: float | None
    previous_date: str | None


class StrengthTotals(TypedDict):
    """A linked Muscu log's working sets (never warm-ups)."""

    tonnage_kg: float
    sets: int
    top_e1rm: TopLift | None


class PlannedBrief(TypedDict):
    id: int
    date: str
    sport: str
    session_type: str
    description: str | None
    target_duration_min: int | None
    target_distance_km: float | None
    target_hr_zone: str | None
    status: str


class Proposal(TypedDict):
    planned_session_id: int
    decision: str
    reason: str
    state: str


class NextDay(TypedDict):
    """The day after the session, when it is today or tomorrow."""

    date: str
    relative: Literal["today", "tomorrow"]
    planned: list[PlannedBrief]
    #: That day's standing plan decisions (only today has any).
    proposals: list[Proposal]
    #: The first open session after that day, when that day has none.
    next: PlannedBrief | None


class PlanComparison(TypedDict):
    """The planned session this one is linked to, and how it compared."""

    planned: PlannedBrief
    #: ``garmin.matcher.plan_verdict``: None when nothing could be compared.
    verdict: PlanVerdict | None
    #: The planned zone's middle heart rate, which the intensity is read against.
    target_hr_bpm: int | None


class SessionSummary(TypedDict):
    """What the session page opens with, from stored rows only (no model call)."""

    #: The rules' sentence, only when the session has no stored feedback.
    rule_feedback: str | None
    strength: StrengthTotals | None
    #: None when the session is linked to no planned session.
    plan: PlanComparison | None
    next_day: NextDay | None


def _source(session: ActualSession) -> str:
    return getattr(session.source, "value", str(session.source))


def _pace(speed_mps: float | None) -> int | None:
    return round(1000 / speed_mps) if speed_mps and speed_mps > 0.5 else None


def _num(value: Any, digits: int = 1) -> float | None:
    return None if value is None else round(float(value), digits)


def _json_list(raw: str | None) -> list[dict[str, Any]]:
    if not raw:
        return []
    try:
        value = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return []
    return (
        [item for item in value if isinstance(item, dict)]
        if isinstance(value, list)
        else []
    )


def _zones(raw: str | None) -> dict[str, int] | None:
    """Seconds per zone, ``z1``..``z5``, whatever spelling the source used."""
    if not raw:
        return None
    try:
        value = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return None
    if not isinstance(value, dict):
        return None
    totals = dict.fromkeys(ZONES, 0)
    for name, seconds in value.items():
        digits = "".join(c for c in str(name) if c.isdigit())  # "Z1", "z1", "zone1"
        if f"z{digits}" in totals:
            totals[f"z{digits}"] += int(seconds or 0)
    return totals if sum(totals.values()) > 0 else None


def _laps(raw: str | None) -> list[dict[str, Any]]:
    """Laps in one shape, Garmin's FIT laps and Strava's alike."""
    laps = []
    for i, lap in enumerate(_json_list(raw), start=1):
        speed = lap.get("average_speed")
        laps.append(
            {
                "n": int(lap.get("lap_index") or i),
                "duration_sec": int(
                    lap.get("moving_time") or lap.get("elapsed_time") or 0
                ),
                "distance_m": _num(lap.get("distance")),
                "speed_mps": _num(speed, 2),
                "pace_sec_km": _pace(speed),
                "avg_hr": _num(lap.get("average_heartrate"), 0),
                "max_hr": _num(lap.get("max_heartrate"), 0),
                "cadence": _num(lap.get("average_cadence"), 0),
                "intensity": lap.get("intensity"),
            }
        )
    return laps


def _splits(raw: str | None) -> list[dict[str, Any]]:
    """Strava's metric splits (one per km), when the session has them."""
    splits = []
    for i, split in enumerate(_json_list(raw), start=1):
        speed = split.get("average_speed")
        splits.append(
            {
                "n": int(split.get("split") or i),
                "duration_sec": int(
                    split.get("moving_time") or split.get("elapsed_time") or 0
                ),
                "distance_m": _num(split.get("distance")),
                "pace_sec_km": _pace(speed),
                "avg_hr": _num(split.get("average_heartrate"), 0),
                "elevation_m": _num(split.get("elevation_difference")),
            }
        )
    return splits


def _intervals(laps: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Work intervals of a structured workout, from its laps' intensity.

    ``WorkoutStructure`` calls it an interval session with two work laps and a
    recovery at least. Laps without an intensity (Strava's, manual lap button)
    are never guessed into one.
    """
    if not any(lap["intensity"] for lap in laps):
        return None
    structure = WorkoutStructure(
        laps=[
            LapData(
                lap_number=lap["n"],
                intensity=LapIntensity.from_fit_value(lap["intensity"]),
                trigger="",
                duration_sec=lap["duration_sec"],
                distance_m=lap["distance_m"] or 0,
                avg_speed_mps=lap["speed_mps"],
                avg_hr=None if lap["avg_hr"] is None else int(lap["avg_hr"]),
                avg_cadence=None if lap["cadence"] is None else int(lap["cadence"]),
            )
            for lap in laps
        ]
    )
    structure.analyze()
    if not structure.is_interval_workout:
        return None
    return {
        "count": structure.num_work_intervals,
        "work_avg_sec": round(structure.avg_work_duration_sec),
        "rest_avg_sec": round(structure.avg_rest_duration_sec),
        "warmup_sec": round(sum(lap.duration_sec for lap in structure.warmup_laps)),
        "cooldown_sec": round(sum(lap.duration_sec for lap in structure.cooldown_laps)),
        "pace_cv_pct": _num(structure.work_pace_consistency_cv),
        "hr_progression_pct": _num(structure.work_hr_progression),
        "work": [
            {
                "n": i,
                "lap": lap.lap_number,
                "duration_sec": round(lap.duration_sec),
                "distance_m": _num(lap.distance_m),
                "pace_sec_km": _pace(lap.avg_speed_mps),
                "avg_hr": lap.avg_hr,
            }
            for i, lap in enumerate(structure.work_intervals, start=1)
        ],
    }


def _metrics(
    streams: ActivityStreams | None, sport: str, steady: bool
) -> dict[str, Any] | None:
    """Derived metrics from the streams (``ActivityMetricsCalculator``).

    Decoupling and drift compare the two halves of the effort: they are only
    reported on a steady session long enough for the halves to mean something.
    """
    if streams is None or len(streams) < 60:
        return None
    m = ActivityMetricsCalculator().calculate(streams.to_time_series())
    duration = streams.t[-1] - streams.t[0]
    halves = steady and duration >= MIN_ANALYSIS_SEC
    on_foot = sport in FOOT_SPORTS
    out: dict[str, Any] = {
        "hr_avg": _num(m.hr_avg, 0),
        "hr_max": m.hr_max,
        "hr_drift_pct": _num(m.hr_drift_pct) if halves else None,
        "decoupling_pct": _num(m.hr_decoupling_pct) if halves else None,
        "pace_fade_pct": _num(m.pace_fade_pct) if halves else None,
        "pace_first_half_sec_km": m.pace_first_half_sec_km
        if halves and on_foot
        else None,
        "pace_second_half_sec_km": m.pace_second_half_sec_km
        if halves and on_foot
        else None,
        "pace_cv_pct": _num(m.pace_cv * 100) if m.pace_cv is not None else None,
        "cadence_avg": m.cadence_avg,
        "cadence_cv_pct": _num(m.cadence_cv * 100)
        if m.cadence_cv is not None
        else None,
        "power_avg": m.power_avg,
        "power_np": m.power_normalized,
        "power_vi": _num(m.power_variability_index, 2),
    }
    return {key: value for key, value in out.items() if value is not None} or None


def _summary(session: ActualSession) -> dict[str, Any]:
    return {
        "id": session.id,
        "date": session.date.isoformat(),
        "start_time": session.start_time.isoformat() if session.start_time else None,
        "sport": session.sport,
        "session_type": session.session_type,
        "name": session.name,
        "duration_sec": session.duration_sec,
        "moving_time_sec": session.moving_time_sec,
        "distance_m": session.distance_m,
        "calories": session.calories,
        "avg_hr": session.avg_hr,
        "max_hr": session.max_hr,
        "avg_pace_sec_km": session.avg_pace_sec_km,
        "avg_speed_mps": session.avg_speed_mps,
        "max_speed_mps": session.max_speed_mps,
        "ascent_m": session.ascent_m,
        "descent_m": session.descent_m,
        "avg_cadence": session.avg_cadence,
        "max_cadence": session.max_cadence,
        "avg_watts": session.avg_watts,
        "rpe": session.rpe,
        "notes": session.notes,
        "source": _source(session),
        "device_name": session.device_name,
        "planned_session_id": session.planned_session_id,
        "adherence_score": session.adherence_score,
    }


def _analysis(
    session: ActualSession, streams: ActivityStreams | None
) -> tuple[list[dict[str, Any]], dict[str, Any] | None, dict[str, Any] | None]:
    laps = _laps(session.laps_json)
    intervals = _intervals(laps)
    metrics = _metrics(streams, session.sport, steady=intervals is None)
    return laps, intervals, metrics


def get_activity_detail(
    session_id: int, *, repo: GarminRepository | None = None
) -> dict[str, Any] | None:
    """Everything the session page draws, None when the session does not exist."""
    repo = repo or GarminRepository()
    session = repo.get_actual_session(session_id)
    if session is None:
        return None
    streams = repo.get_activity_streams(session_id)
    laps, intervals, metrics = _analysis(session, streams)
    feedback = SessionFeedbackRepository().get(session_id)
    links = _strength_links(session)
    return {
        "session": _summary(session),
        "zones": _zones(session.hr_zones_json),
        "laps": laps,
        "splits": _splits(session.splits_json),
        "intervals": intervals,
        "metrics": metrics,
        "streams": downsample(streams, CHART_POINTS) if streams else None,
        "route": route(streams, ROUTE_POINTS) if streams else None,
        "feedback": feedback.to_dict() if feedback else None,
        "terrain": get_terrain(session_id),
        "weather": get_weather(session_id),
        **links,
        "summary": _summary_block(
            session,
            has_feedback=feedback is not None,
            log_id=links["strength_log_id"],
            repo=repo,
        ),
    }


def _summary_block(
    session: ActualSession,
    *,
    has_feedback: bool,
    log_id: int | None,
    repo: GarminRepository,
) -> SessionSummary:
    log = StrengthRepository().get_session(log_id) if log_id else None
    return {
        "rule_feedback": None if has_feedback else _rule_feedback(session, log),
        "strength": _strength_totals(log) if log else None,
        "plan": _plan_comparison(session, repo),
        "next_day": _next_day(session.date, repo),
    }


def _plan_comparison(
    session: ActualSession, repo: GarminRepository
) -> PlanComparison | None:
    """The linked planned session against what was done, on the matcher's rules."""
    if session.planned_session_id is None:
        return None
    planned = repo.get_planned_session(session.planned_session_id)
    if planned is None or planned.id is None:
        return None
    matcher = SessionMatcher(zones=athlete_zone_model())
    target_hr = matcher.target_hr(planned)
    return {
        "planned": _brief(planned),
        "verdict": matcher.verdict(session, planned),
        "target_hr_bpm": None if target_hr is None else round(target_hr),
    }


def _rule_feedback(session: ActualSession, log: StrengthSession | None) -> str:
    """The sentence the rules write when the coach has not (yet) answered."""
    # Local: coaching_rules reads this module's analysis for its highlights.
    from arete.services import coaching_rules

    if log is not None:
        return coaching_rules.strength_rule_feedback(log)
    return coaching_rules.cardio_rule_feedback(session)


def _strength_totals(log: StrengthSession) -> StrengthTotals:
    """Tonnage, working sets and the top e1RM against that lift's last session."""
    assert log.id is not None
    best: dict[int, tuple[str, float]] = {}
    for ex in log.exercises:
        if ex.exercise_id is None:
            continue
        sets = [
            WorkSet(reps=s.reps or 0, weight_kg=s.weight_kg)
            for s in ex.sets
            if not s.is_warmup
        ]
        e1rm = ExerciseSession(log.id, log.date, sets).best_e1rm
        held = best.get(ex.exercise_id)
        if e1rm is not None and (held is None or e1rm > held[1]):
            name = ex.exercise.name if ex.exercise else "Exercice"
            best[ex.exercise_id] = (name, e1rm)
    top: TopLift | None = None
    if best:
        exercise_id, (name, e1rm) = max(best.items(), key=lambda item: item[1][1])
        history = (
            StrengthRepository()
            .working_sessions([exercise_id], exclude_session_id=log.id, before=log.date)
            .get(exercise_id, [])
        )
        # The latest earlier session that set an e1RM, every block of the lift in it.
        dated = [h for h in history if h.best_e1rm is not None]
        last = dated[-1].session_id if dated else None
        previous = [h.best_e1rm for h in dated if h.session_id == last and h.best_e1rm]
        top = {
            "exercise": name,
            "e1rm_kg": round(e1rm, 1),
            "previous_kg": round(max(previous), 1) if previous else None,
            "previous_date": dated[-1].date.isoformat() if dated else None,
        }
    return {
        "tonnage_kg": round(log.total_volume, 1),
        "sets": log.total_sets,
        "top_e1rm": top,
    }


def _brief(planned: PlannedSession) -> PlannedBrief:
    assert planned.id is not None
    return {
        "id": planned.id,
        "date": planned.date.isoformat(),
        "sport": planned.sport,
        "session_type": planned.session_type.value,
        "description": planned.description,
        "target_duration_min": planned.target_duration_min,
        "target_distance_km": planned.target_distance_km,
        "target_hr_zone": planned.target_hr_zone,
        "status": planned.status.value,
    }


def _next_day(session_date: date, repo: GarminRepository) -> NextDay | None:
    """What the plan holds the day after the session, while that day is ahead.

    The day after an older session is past: None. The morning's proposals
    exist for today only, so a session of yesterday also reads today's.
    """
    today = athlete_today()
    day = session_date + timedelta(days=1)
    if day < today or day > today + timedelta(days=1):
        return None
    planned = repo.list_planned_sessions(
        start_date=day,
        end_date=day + timedelta(days=NEXT_SESSION_DAYS),
        status=None,
        limit=20,
        ascending=True,
    )
    on_day = [p for p in planned if p.date == day and p.id is not None]
    later = next(
        (
            p
            for p in planned
            if p.date > day and p.id is not None and p.status.value in _OPEN_STATUSES
        ),
        None,
    )
    decisions = PlanDecisionRepository().list_for_day(day) if day == today else []
    return {
        "date": day.isoformat(),
        "relative": "today" if day == today else "tomorrow",
        "planned": [_brief(p) for p in on_day],
        "proposals": [
            {
                "planned_session_id": d.planned_session_id,
                "decision": d.decision,
                "reason": d.reason,
                "state": d.state,
            }
            for d in decisions
            if d.state in _STANDING_DECISIONS
            and d.reverted_at is None
            # A snoozed proposal is out of the athlete's way until then.
            and (d.snoozed_until is None or d.snoozed_until <= day)
        ],
        "next": _brief(later) if later and not on_day else None,
    }


def _strength_links(session: ActualSession) -> dict[str, int | None]:
    """A strength activity's Muscu log, or the day's unlinked one to link instead.

    Without a linked log the page offers to add the loads; a log of that day
    linked to no activity is probably this session, so the page says so.
    """
    if session.sport != "strength" or session.id is None:
        return {"strength_log_id": None, "strength_unlinked_log_id": None}
    repo = StrengthRepository()
    linked = repo.log_for_activity(session.id)
    return {
        "strength_log_id": linked,
        "strength_unlinked_log_id": None
        if linked
        else repo.unlinked_log_on(session.date),
    }


def _compact_lap(lap: dict[str, Any]) -> dict[str, Any]:
    keys = ("n", "duration_sec", "distance_m", "pace_sec_km", "avg_hr", "intensity")
    return {key: lap[key] for key in keys if lap.get(key) is not None}


def activity_detail_for_model(
    session_id: int, *, repo: GarminRepository | None = None
) -> dict[str, Any]:
    """The coach's digest of one session: numbers, no stream.

    Raises ``LookupError`` for an unknown session and ``PermissionError`` for a
    Strava row, whose data may not reach a model.
    """
    repo = repo or GarminRepository()
    session = repo.get_actual_session(session_id)
    if session is None:
        raise LookupError(f"Séance {session_id} introuvable.")
    if _source(session) in MODEL_EXCLUDED_SOURCES:
        raise PermissionError(
            "Séance importée de Strava : ses données ne peuvent pas être "
            "transmises au coach."
        )
    streams = repo.get_activity_streams(session_id)
    laps, intervals, metrics = _analysis(session, streams)
    summary = {
        key: value
        for key, value in _summary(session).items()
        if value is not None and key not in ("source", "device_name", "start_time")
    }
    if session.start_time:
        summary["start"] = session.start_time.strftime("%H:%M")
    digest: dict[str, Any] = {"session": summary, "streams_kept": streams is not None}
    zones = _zones(session.hr_zones_json)
    if zones:
        digest["zones_min"] = {zone: round(sec / 60) for zone, sec in zones.items()}
    if metrics:
        digest["analysis"] = metrics
    terrain = get_terrain(session_id)
    if terrain and terrain["gap_sec_km"]:
        digest["gap_sec_km"] = terrain["gap_sec_km"]
        digest["grade_factor"] = terrain["grade_factor"]
    if terrain and terrain["vam"]:
        digest["vam_best_m_h"] = {f"{m}min": v for m, v in terrain["vam"].items()}
    weather = get_weather(session_id)
    if weather:
        digest["weather"] = {
            key: weather[key]
            for key in ("temperature_c", "humidity_pct", "wind_kmh", "start_altitude_m")
            if weather[key] is not None
        }
    if intervals:
        digest["intervals"] = {
            **intervals,
            "work": intervals["work"][:MODEL_INTERVALS],
        }
    elif laps:
        digest["laps"] = [_compact_lap(lap) for lap in laps[:MODEL_LAPS]]
        if len(laps) > MODEL_LAPS:
            digest["laps_omitted"] = len(laps) - MODEL_LAPS
    return digest


def _mmss(sec: float) -> str:
    minutes, seconds = divmod(int(round(sec)), 60)
    return f"{minutes}:{seconds:02d}"


def analysis_lines(
    session_id: int, *, repo: GarminRepository | None = None
) -> list[str]:
    """The analysis in a few French lines, for the session feedback's facts."""
    try:
        digest = activity_detail_for_model(session_id, repo=repo)
    except (LookupError, PermissionError):
        return []
    lines: list[str] = []
    intervals = digest.get("intervals")
    if intervals:
        line = (
            f"Fractionné détecté : {intervals['count']} répétitions de "
            f"{_mmss(intervals['work_avg_sec'])} en moyenne"
        )
        if intervals.get("rest_avg_sec"):
            line += f", récupération {_mmss(intervals['rest_avg_sec'])}"
        if intervals.get("pace_cv_pct") is not None:
            line += f", régularité de l'allure {intervals['pace_cv_pct']} % d'écart"
        lines.append(line)
    # A flat run's GAP is its pace: only the terrain's effect is worth a line.
    if abs((digest.get("grade_factor") or 1) - 1) >= GAP_NOTABLE:
        line = f"Allure ajustée à la pente (GAP) : {_mmss(digest['gap_sec_km'])} /km"
        if "30min" in digest.get("vam_best_m_h", {}):
            line += f", meilleure montée 30 min {digest['vam_best_m_h']['30min']} m/h"
        lines.append(line)
    weather = digest.get("weather") or {}
    if "temperature_c" in weather:
        line = f"Météo au départ : {weather['temperature_c']:.0f} °C"
        if "humidity_pct" in weather:
            line += f", humidité {weather['humidity_pct']:.0f} %"
        if "start_altitude_m" in weather:
            line += f", départ à {weather['start_altitude_m']:.0f} m"
        lines.append(line)
    analysis = digest.get("analysis") or {}
    if "decoupling_pct" in analysis:
        lines.append(
            f"Découplage cardiaque (efficacité 2e moitié vs 1re) : "
            f"{analysis['decoupling_pct']} %"
        )
    if "pace_first_half_sec_km" in analysis and "pace_second_half_sec_km" in analysis:
        lines.append(
            f"Allure 1re moitié {_mmss(analysis['pace_first_half_sec_km'])} /km, "
            f"2e moitié {_mmss(analysis['pace_second_half_sec_km'])} /km"
        )
    if "cadence_cv_pct" in analysis and "cadence_avg" in analysis:
        lines.append(
            f"Cadence moyenne {analysis['cadence_avg']}, "
            f"variabilité {analysis['cadence_cv_pct']} %"
        )
    return lines
