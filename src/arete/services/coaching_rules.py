"""Tips endpoints: the daily briefing, and feedback on a finished session.

Both are the coaching agent's work now, and both keep the rule engine
underneath: the rules extract the facts and always produce a usable sentence,
the agent turns them into something worth reading and files what it learned in
its journal. When the agent is unavailable, the rule text is what ships.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date, timedelta
from typing import TYPE_CHECKING, Any, Literal

from pydantic import BaseModel, Field

from arete.dataio.queries import training_loads
from arete.dataio.settings import athlete_zone_model, get_user_settings
from arete.features.workload import compute_workload_metrics
from arete.garmin.repository import GarminRepository
from arete.services.activity_detail import analysis_lines
from arete.services.analytics import MODEL_EXCLUDED_SOURCES
from arete.services.athlete_scope import resolve_athlete_id
from arete.services.coaching_repository import SessionFeedbackRepository
from arete.services.session_feedback import (
    SessionEvidence,
    SessionFacts,
    batch_session_feedback,
)
from arete.services.settings import athlete_today
from arete.strength.repository import StrengthRepository

if TYPE_CHECKING:
    from arete.services.checkins import Checkin

logger = logging.getLogger(__name__)


GOAL_ADVICE: dict[str, str] = {
    "build": "Tu peux monter de 5 à 10 % de charge cette semaine.",
    "peak": "Garde du jus : qualité plutôt que volume d'ici l'objectif.",
    "maintenance": "Tiens ce niveau, inutile d'en rajouter.",
    "recovery": "Reste en dessous du seuil : la récupération est la priorité.",
}


DEFAULT_FATIGUE_THRESHOLD = 85


def generate_daily_tip(
    acwr: float | None,
    tsb: float | None,
    readiness_score: float | None,
    fatigue_threshold: int = DEFAULT_FATIGUE_THRESHOLD,
    fitness_goal: str = "build",
    readiness_source: str = "model",
) -> tuple[str, Literal["info", "warning", "alert"]]:
    """Rule-based daily tip, read against the athlete's own settings.

    Priority rules (first match wins):
    1. ACWR > 1.5 -> alert (injury danger)
    2. TSB < -25 -> alert (exhaustion)
    3. ACWR > 1.3 -> warning (overload)
    4. TSB < -10 -> warning (fatigue accumulating)
    5. readiness >= the athlete's fatigue threshold -> info (good form)
    6. ACWR 0.8-1.3 -> info (optimal zone), closed by the goal advice
    7. ACWR < 0.8 -> info (room to build), closed by the goal advice
    8. no metric at all -> info (log your sessions)

    Returns:
        (tip_text, priority)
    """
    goal_advice = GOAL_ADVICE.get(fitness_goal, GOAL_ADVICE["build"])
    if acwr is not None and acwr > 1.5:
        return (
            f"Ta charge aiguë dépasse largement la chronique (ACWR {acwr:.2f}). "
            "Réduis le volume dès aujourd'hui pour éviter la blessure.",
            "alert",
        )

    if tsb is not None and tsb < -25:
        return (
            f"Fraîcheur à {tsb:.0f} : tu es en épuisement. "
            "Prends une semaine de décharge.",
            "alert",
        )

    if acwr is not None and acwr > 1.3:
        return (
            f"Ta charge monte vite (ACWR {acwr:.2f}). "
            "Stabilise cette semaine et alterne séances dures et légères.",
            "warning",
        )

    if tsb is not None and tsb < -10:
        return (
            f"La fatigue s'accumule (fraîcheur {tsb:.0f}). "
            "Prévois une semaine de récupération bientôt.",
            "warning",
        )

    if readiness_score is not None and readiness_score >= fatigue_threshold:
        measured = "estimée" if readiness_source == "model" else "Garmin"
        return (
            f"Préparation {measured} à {readiness_score:.0f}/100, au-dessus de ton seuil de "
            f"{fatigue_threshold}. C'est le jour pour une séance dure ou un test.",
            "info",
        )

    if acwr is not None and 0.8 <= acwr <= 1.3:
        return (
            f"Charge équilibrée (ACWR {acwr:.2f}). {goal_advice}",
            "info",
        )

    if acwr is not None and acwr < 0.8:
        return (
            f"Charge basse par rapport à tes 4 dernières semaines (ACWR {acwr:.2f}). "
            f"{goal_advice}",
            "info",
        )

    return (
        "Enregistre tes séances régulièrement pour recevoir des conseils adaptés.",
        "info",
    )


@dataclass(frozen=True)
class RuleFacts:
    """What the daily tip is computed from; the briefing is written from it too."""

    acwr: float | None
    tsb: float | None
    readiness_score: float | None
    fatigue_threshold: int
    fitness_goal: str
    readiness_source: str = "model"  # see services.metrics.ReadinessSource
    readiness_measured_on: date | None = None
    #: False when a read failed: its metric is then unknown, not absent.
    complete: bool = True
    #: The day's morning check-in, None when unanswered (it lowers, never
    #: raises, the day's decision: ``adaptation.declared_fatigue``).
    checkin: Checkin | None = None

    @property
    def is_empty(self) -> bool:
        """Nothing to coach on: no load over 28 days, no form model, no readiness.

        What a fresh athlete reads: with no load and no Garmin night there is
        no modeled readiness either. A failed read is not an empty history.
        """
        return (
            self.complete
            and self.acwr is None
            and self.tsb is None
            and self.readiness_score is None
        )


def rule_facts(target_date: date | None = None) -> RuleFacts:
    """ACWR over 28 days, form over the whole history, the readiness every
    surface shows (Garmin first), the morning check-in and the athlete's own
    thresholds."""
    from arete.services.metrics import load_form

    target_date = target_date or athlete_today()
    complete = True

    acwr: float | None = None
    try:
        loads = training_loads(days=28, end=target_date)
        if any(load.duration_min > 0 for load in loads):
            acwr = compute_workload_metrics(loads, target_date).acwr
    except Exception:
        complete = False
        logger.warning("Failed to compute workload metrics for tip", exc_info=True)

    tsb: float | None = None
    readiness = None
    try:
        model, readiness = load_form(target_date)
        tsb = model.tsb if model else None
    except Exception:
        complete = False
        logger.warning("Failed to compute fitness metrics for tip", exc_info=True)

    from arete.services import checkins

    checkin = None
    try:
        checkin = checkins.get(target_date)
    except Exception:
        complete = False
        logger.warning("Failed to read the morning check-in", exc_info=True)

    settings = get_user_settings(user_id=resolve_athlete_id()) or {}
    return RuleFacts(
        acwr=acwr,
        tsb=tsb,
        readiness_score=readiness.score if readiness else None,
        fatigue_threshold=int(
            settings.get("fatigue_threshold") or DEFAULT_FATIGUE_THRESHOLD
        ),
        fitness_goal=str(settings.get("fitness_goal") or "build"),
        readiness_source=readiness.source if readiness else "model",
        readiness_measured_on=readiness.measured_on if readiness else None,
        complete=complete,
        checkin=checkin,
    )


def daily_rule_tip(
    facts: RuleFacts,
) -> tuple[str, Literal["info", "warning", "alert"]]:
    """The day's rule-based tip and its priority, read from its ``rule_facts``.

    The deterministic floor under everything the coach says: it always
    produces a concrete, numeric sentence, and it is what the dashboard shows
    when the agent is unavailable or its run fails. The priority it returns is
    the one used either way — it drives the card's colour and must not depend
    on a model.
    """
    return generate_daily_tip(
        facts.acwr,
        facts.tsb,
        facts.readiness_score,
        fatigue_threshold=facts.fatigue_threshold,
        fitness_goal=facts.fitness_goal,
        readiness_source=facts.readiness_source,
    )


class PostSessionResponse(BaseModel):
    """Post-session feedback response."""

    feedback: str = Field(description="Main feedback text in French")
    highlights: list[str] = Field(description="Key highlights in French")
    source: Literal["agent", "rules"] = Field(
        default="rules",
        description="Whether the coaching agent wrote it, or the rule engine did",
    )


_MUSCLE_FR: dict[str, str] = {
    "chest": "pectoraux",
    "shoulders": "épaules",
    "triceps": "triceps",
    "back": "dos",
    "biceps": "biceps",
    "forearms": "avant-bras",
    "abs": "abdominaux",
    "obliques": "obliques",
    "lower_back": "lombaires",
    "quads": "quadriceps",
    "hamstrings": "ischio-jambiers",
    "glutes": "fessiers",
    "calves": "mollets",
    "adductors": "adducteurs",
    "full_body": "corps entier",
}


def _muscle_label(key: str) -> str:
    return _MUSCLE_FR.get(key, key)


def _hr_zone_label(avg_hr: int) -> tuple[int, str]:
    """Zone number and French name for an average heart rate.

    Read against the athlete's own threshold, like every other zone in the
    app. The absolute bpm table this replaced was two zones off: at a
    threshold of 176, 155 bpm is endurance, and it was being reported as
    "zone 4 seuil".
    """
    return athlete_zone_model().labelled_zone_of(avg_hr)


def _pace_str(sec_per_km: float) -> str:
    """Convert seconds/km to mm:ss string."""
    minutes = int(sec_per_km) // 60
    seconds = int(sec_per_km) % 60
    return f"{minutes}:{seconds:02d}"


def _generate_strength_feedback(
    session_id: int,
) -> tuple[PostSessionResponse, SessionEvidence]:
    repo = StrengthRepository()
    session = repo.get_session(session_id)
    if session is None:
        raise LookupError("Strength session not found")
    evidence = SessionEvidence(
        date=session.date if isinstance(session.date, date) else athlete_today(),
        # The id keeps two same-named sessions of one day apart in the journal
        # (it files each heading once), while the same session stays one entry.
        title=f"musculation — {session.name or 'séance'} (#{session_id})",
        session_ref=f"strength:{session_id}",
        rpe=session.overall_rpe,
        notes=session.notes,
    )

    # Compute volume per muscle for this session
    session_volume: dict[str, float] = {}
    for ex in session.exercises:
        if ex.exercise is None:
            continue
        muscle = ex.exercise.primary_muscle.value
        for s in ex.sets:
            if s.is_warmup:
                continue
            vol = (s.reps or 0) * (s.weight_kg or 0)
            session_volume[muscle] = session_volume.get(muscle, 0) + vol

    if not session_volume:
        return PostSessionResponse(
            feedback="Séance enregistrée ! Continue à t'entraîner régulièrement.",
            highlights=["Séance complétée"],
        ), evidence

    # Compare vs last 4 weeks average
    session_date = session.date if isinstance(session.date, date) else athlete_today()
    end_ref = session_date - timedelta(days=1)
    start_ref = end_ref - timedelta(days=28)
    ref_volume = repo.get_volume_by_muscle(
        start_date=start_ref, end_date=end_ref, include_secondary=False
    )

    # Weeks in reference period (4)
    highlights: list[str] = []
    feedback_parts: list[str] = []

    for muscle, vol in sorted(session_volume.items(), key=lambda x: -x[1]):
        label = _muscle_label(muscle)
        ref_weekly = ref_volume.get(muscle, 0) / 4.0 if ref_volume.get(muscle) else 0

        if ref_weekly > 0:
            delta_pct = (vol - ref_weekly) / ref_weekly * 100
            if delta_pct > 5:
                highlights.append(
                    f"Volume {label} en hausse de {delta_pct:.0f}% vs les 4 dernières semaines"
                )
            elif delta_pct < -15:
                highlights.append(
                    f"Volume {label} en baisse de {abs(delta_pct):.0f}% — pense à progresser"
                )
        else:
            highlights.append(
                f"{label.capitalize()} travaillé ({vol:.0f} kg de volume)"
            )

    total_vol = sum(session_volume.values())
    muscles_worked = [_muscle_label(m) for m in session_volume]
    feedback_parts.append(
        f"Séance musculation terminée — {total_vol:.0f} kg de volume total "
        f"sur {', '.join(muscles_worked)}."
    )

    if session.overall_rpe:
        feedback_parts.append(f"RPE ressenti : {session.overall_rpe}/10.")

    if not highlights:
        highlights.append("Séance complétée avec succès")

    rule_feedback = " ".join(feedback_parts)
    rule_highlights = highlights[:5]

    return PostSessionResponse(
        feedback=rule_feedback,
        highlights=rule_highlights,
        source="rules",
    ), evidence


def _generate_cardio_feedback(
    session_id: int,
) -> tuple[PostSessionResponse, SessionEvidence]:
    repo = GarminRepository()
    session = repo.get_actual_session(session_id)
    if session is None:
        raise LookupError("Cardio session not found")
    evidence = SessionEvidence(
        date=session.date,
        # The start time keeps two same-named sessions of one day apart in the
        # journal (it files each heading once); the id when there is no time.
        title=(
            f"{session.sport or 'activité'} — {session.name or 'sans titre'} "
            + (
                f"({session.start_time:%H:%M})"
                if session.start_time
                else f"(#{session_id})"
            )
        ),
        session_ref=f"actual:{session_id}",
        sport=session.sport,
        rpe=session.rpe,
        notes=session.notes,
    )

    highlights: list[str] = []
    feedback_parts: list[str] = []

    sport = session.sport or "activité"
    duration_min = (session.duration_sec or 0) // 60

    feedback_parts.append(f"Séance de {sport} terminée ({duration_min} min).")

    # Imported strength activities often contain only HR, not mechanical load.
    is_strength = sport in {"strength", "strength_training", "musculation"}
    if is_strength:
        feedback_parts.append(
            "Le cardio seul ne permet pas de juger ce renforcement. "
            "Précise les exercices, séries, charges ou ton ressenti."
        )
    if not is_strength and session.avg_hr and session.max_hr:
        zone_num, zone_desc = _hr_zone_label(int(session.avg_hr))
        highlights.append(
            f"FC moyenne à {session.avg_hr:.0f} bpm, zone {zone_num} {zone_desc}"
        )
        highlights.append(f"FC max à {session.max_hr:.0f} bpm")

        if zone_num <= 2:
            feedback_parts.append("Bon travail de fond, intensité bien maîtrisée.")
        elif zone_num == 3:
            feedback_parts.append("Bon travail en tempo, au-dessus de l'endurance.")
        elif zone_num >= 4:
            feedback_parts.append("Séance intense — prévois une récupération adaptée.")

    # Pace feedback
    if session.avg_pace_sec_km and session.avg_pace_sec_km > 0:
        pace = _pace_str(session.avg_pace_sec_km)
        highlights.append(f"Allure moyenne : {pace} /km")

    # Distance
    if session.distance_m and session.distance_m > 0:
        km = session.distance_m / 1000
        highlights.append(f"Distance : {km:.1f} km")

    # Calories
    if session.calories and session.calories > 0:
        highlights.append(f"{session.calories} kcal dépensées")

    if not highlights:
        feedback_parts.append("Continue à t'entraîner régulièrement.")
        highlights.append("Séance complétée")

    rule_feedback = " ".join(feedback_parts)
    # The pace and heart analysis of the kept streams and laps, when there are.
    rule_highlights = highlights[:5] + analysis_lines(session_id, repo=repo)[:3]

    return PostSessionResponse(
        feedback=rule_feedback,
        highlights=rule_highlights,
        source="rules",
    ), evidence


def sync_feedback(
    session_ids: list[int],
    *,
    produce: Callable[[str, int], str],
) -> dict[str, Any]:
    """The coach's word on the sessions a sync imported: one model request.

    Strava rows stay out of the model's input, and a session that already has
    a stored feedback is not paid for twice. Each answer is stored for the
    session page (``trigger='sync'``). Never raises for one session's error.
    ``written`` lists the feedback stored by this run, which is what the
    post-session push announces: a session gets it once, like its feedback.
    """
    repo = GarminRepository()
    feedback_repo = SessionFeedbackRepository()
    done = feedback_repo.with_feedback(session_ids)
    candidates: list[tuple[int, SessionFacts]] = []
    for session_id in dict.fromkeys(session_ids):  # once each, in order
        session = repo.get_actual_session(session_id)
        if session is None or session_id in done:
            continue
        if getattr(session.source, "value", session.source) in MODEL_EXCLUDED_SOURCES:
            continue
        try:
            result, evidence = _generate_cardio_feedback(session_id)
        except Exception:
            logger.warning("No rule feedback for session %s", session_id, exc_info=True)
            continue
        candidates.append(
            (session_id, SessionFacts(result.feedback, result.highlights, evidence))
        )
    answers = batch_session_feedback(
        [facts for _, facts in candidates], produce=produce
    )
    written: list[dict[str, Any]] = []
    for (session_id, facts), (text, source) in zip(candidates, answers, strict=True):
        try:
            feedback_repo.save(session_id, text=text, source=source, trigger="sync")
        except Exception:
            logger.warning("Could not store feedback of %s", session_id, exc_info=True)
            continue
        written.append(
            {"session_id": session_id, "date": facts.evidence.date, "text": text}
        )
    return {
        "sessions": len(candidates),
        "agent": sum(1 for _, source in answers if source == "agent"),
        "written": written,
    }
