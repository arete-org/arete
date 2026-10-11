"""The briefing producer: one agent run a day, with a deterministic floor.

Called from two places — the scheduler after a successful sync, and
``GET /tips/daily`` when the day has no briefing yet. Both go through
``get_or_create_briefing``.

Sync on purpose. The scheduler already offloads blocking work with
an AnyIO worker and the API route is a plain ``def``, so staying
synchronous keeps this inside existing precedent instead of inventing a
blocking-DB-in-an-async-handler story the codebase does not have.

It never raises. A failed run is stored with ``status='failed'`` so it stays
visible, and the rule text is stored alongside so the dashboard always has
something concrete and numeric to show.
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Callable
from datetime import date, timedelta
from typing import TYPE_CHECKING

from arete.dataio.settings import get_user_settings
from arete.services.athlete_scope import resolve_athlete_id
from arete.services.coaching_repository import Briefing, BriefingRepository
from arete.services.settings import athlete_today

if TYPE_CHECKING:
    from arete.services.coaching_rules import RuleFacts

logger = logging.getLogger(__name__)

#: Bound on what we persist — a model that ignores "2 to 3 sentences" must not
#: push an essay into the dashboard card.
MAX_BRIEFING_CHARS = 1200


def briefing_enabled(user_id: int | None = None) -> bool:
    """Whether the athlete wants a written briefing at all."""
    user_id = resolve_athlete_id(user_id)
    settings = get_user_settings(user_id) or {}
    return bool(settings.get("coach_briefing_enabled", True))


def _rule_floor(target_date: date) -> tuple[str, str, RuleFacts | None]:
    """The deterministic tip, its priority and its facts — never raises.

    The facts are read once per briefing and handed to the model's facts too.
    They are None when they could not be computed: unknown, not empty.
    """
    from arete.services.coaching_rules import daily_rule_tip, rule_facts

    try:
        facts = rule_facts(target_date)
        text, priority = daily_rule_tip(facts)
    except Exception:
        logger.warning("Rule-based tip failed", exc_info=True)
        return (
            "Pas assez de données pour un conseil aujourd'hui. "
            "Synchronise tes activités pour en avoir un.",
            "info",
            None,
        )
    return text, priority, facts


_WEEKDAYS = ("lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche")
_GOALS = {
    "build": "progresser (bloc de développement)",
    "peak": "affûtage avant un objectif",
    "maintenance": "maintien",
    "recovery": "récupération",
}


def _fmt(value: float | None, pattern: str) -> str:
    return pattern.format(value) if value is not None else "indisponible"


def _clock(seconds: int) -> str:
    """41:10 or 1:31:05, how a race time is read."""
    hours, rest = divmod(int(seconds), 3600)
    minutes, secs = divmod(rest, 60)
    return f"{hours}:{minutes:02d}:{secs:02d}" if hours else f"{minutes}:{secs:02d}"


def _block(title: str, read: Callable[[], list[str]]) -> str:
    """One section of the facts; a failed read says so instead of failing."""
    try:
        lines = read()
    except Exception:
        logger.warning("Briefing facts: %s unavailable", title, exc_info=True)
        lines = ["indisponible"]
    return f"{title} :\n" + "\n".join(f"- {line}" for line in lines or ["aucune"])


def briefing_facts(
    target_date: date, rule_text: str, facts: RuleFacts | None = None
) -> str:
    """Everything the briefing needs, computed here so the model needs no tool.

    The agent used to read its load and form through tools — at least three
    model requests and 99 s on the free tier — while the rule floor had just
    computed the same numbers. It never saw today's plan either. ``facts``
    are the floor's; without them the load section reads its own.
    """
    from arete.garmin.repository import GarminRepository
    from arete.services.analytics import list_sessions
    from arete.services.coaching_rules import rule_facts

    def load() -> list[str]:
        nonlocal facts
        if facts is None:
            facts = rule_facts(target_date)
        if facts.readiness_score is None:
            readiness = "Préparation : indisponible"
        elif facts.readiness_source == "garmin_training":
            readiness = (
                "Préparation à l'entraînement Garmin ce matin : "
                f"{facts.readiness_score:.0f}/100"
            )
        elif facts.readiness_source == "garmin" and facts.readiness_measured_on:
            night = (
                "cette nuit"
                if facts.readiness_measured_on == target_date
                else f"mesure du {facts.readiness_measured_on:%d/%m}"
            )
            readiness = (
                f"Préparation Garmin (VFC, sommeil, {night}) : "
                f"{facts.readiness_score:.0f}/100"
            )
        else:
            readiness = (
                "Préparation estimée par la charge (pas de mesure Garmin récente) : "
                f"{facts.readiness_score:.0f}/100"
            )
        return [
            f"Charge aiguë/chronique (ACWR, sur 28 jours) : {_fmt(facts.acwr, '{:.2f}')}",
            f"Fraîcheur (TSB) : {_fmt(facts.tsb, '{:+.0f}')}",
            readiness,
            f"Objectif de la période : {_GOALS.get(facts.fitness_goal, facts.fitness_goal)}",
        ]

    def planned() -> list[str]:
        sessions = GarminRepository().list_planned_sessions(
            start_date=target_date, end_date=target_date, status=None, limit=5
        )
        return [
            " — ".join(
                str(part)
                for part in (
                    s.session_type.value,
                    f"{s.target_duration_min} min" if s.target_duration_min else None,
                    s.target_hr_zone,
                    s.description,
                )
                if part
            )
            for s in sessions
        ]

    def decisions() -> list[str]:
        from arete.services.adaptation import describe
        from arete.services.plan_repository import PlanDecisionRepository

        lines = []
        for d in PlanDecisionRepository().list_for_day(target_date):
            if d.reverted_at is not None:
                lines.append(f"décision annulée par l'athlète : {d.reason}")
                continue
            before = d.original or {}
            planned = describe(
                str(before.get("session_type") or "séance"),
                before.get("target_duration_min"),
                before.get("target_hr_zone"),
            )
            verdict = {
                "keep": "maintenue",
                "ease": "allégée",
                "replace_easy": "remplacée par de la récupération",
                "rest": "remplacée par du repos",
            }.get(d.decision, d.decision)
            lines.append(f"{planned} : {verdict} — raison : {d.reason}")
        return lines

    def predictions() -> list[str]:
        from arete.dataio.db import connect

        con = connect()
        try:
            row = con.execute(
                "SELECT race_5k_sec, race_10k_sec, race_half_sec, race_marathon_sec FROM app.visible_daily_metrics WHERE user_id = getvariable('arete_athlete_id') AND date <= ? AND race_10k_sec IS NOT NULL ORDER BY date DESC LIMIT 1",
                [target_date],
            ).fetchone()
        finally:
            con.close()
        if not row:
            return []
        labels = ("5 km", "10 km", "semi", "marathon")
        return [
            " · ".join(
                f"{label} {_clock(seconds)}"
                for label, seconds in zip(labels, row, strict=True)
                if seconds
            )
        ]

    def recent() -> list[str]:
        rows = list_sessions(limit=3, for_model=True)["sessions"]
        return [
            ", ".join(
                part
                for part in (
                    f"{r['date']} {r['sport']} « {r['name'] or 'sans titre'} »",
                    f"{(r['duration_sec'] or 0) // 60} min",
                    f"{r['distance_m'] / 1000:.1f} km" if r["distance_m"] else None,
                    f"FC moy {r['avg_hr']:.0f}" if r["avg_hr"] else None,
                    f"allure {r['pace_display']}" if r["avg_pace_sec_km"] else None,
                    f"RPE {r['rpe']}" if r["rpe"] else None,
                    f"notes : {r['notes']}" if r["notes"] else None,
                )
                if part
            )
            for r in rows
        ]

    def yesterday() -> list[str]:
        previous = BriefingRepository().get_for_day(target_date - timedelta(days=1))
        return [previous.text] if previous else []

    weekday = _WEEKDAYS[target_date.weekday()]
    return "\n\n".join(
        [
            f"Nous sommes {weekday} {target_date.isoformat()}.",
            f"Conseil calculé par les règles : {rule_text}",
            _block("Charge, forme et récupération", load),
            _block("Séance(s) prévue(s) aujourd'hui", planned),
            _block("Décision du coach pour aujourd'hui", decisions),
            _block("Prédictions de course Garmin", predictions),
            _block("Dernières séances réalisées", recent),
            _block("Ton briefing d'hier", yesterday),
        ]
    )


def generate_briefing(
    *,
    produce: Callable[[str], str],
    trigger: str = "api",
    target_date: date | None = None,
    user_id: int | None = None,
) -> Briefing:
    """Produce and persist one briefing. Never raises.

    The rule floor is computed first and always: it supplies the priority (the
    card's colour must not depend on a model) and it is the text we store when
    the agent is disabled or fails, or when there is nothing to coach on.
    """
    user_id = resolve_athlete_id(user_id)
    target_date = target_date or athlete_today()
    repo = BriefingRepository()
    rule_text, priority, facts = _rule_floor(target_date)

    def store(text: str, source: str, status: str, error: str | None) -> Briefing:
        repo.create(
            text=text,
            briefing_date=target_date,
            priority=priority,
            source=source,
            status=status,
            error=error,
            trigger=trigger,
            user_id=user_id,
        )
        stored = repo.get_for_day(target_date, user_id=user_id)
        if stored is not None:
            return stored
        # Only reachable when we just stored a failure: hand back the floor.
        return Briefing(
            id=0,
            date=target_date,
            text=rule_text,
            priority=priority,
            source="rules",
            status="ok",
            error=error,
            trigger=trigger,
            created_at=None,
        )

    if not briefing_enabled(user_id):
        logger.info("Coach briefing disabled; storing the rule tip")
        return store(rule_text, "rules", "ok", None)

    # No load, no form, no readiness and nothing planned for the day: a model
    # request would only restate the rule text. Facts that could not be read
    # (None) still go to the model, and so does a plan built before any sync.
    if facts is not None and facts.is_empty and not _plans_the_day(target_date):
        logger.info("Coach briefing: no training data; model skipped")
        return store(rule_text, "rules", "ok", None)

    try:
        text = produce(briefing_facts(target_date, rule_text, facts))
    except Exception as exc:
        # A visible failure beats a silently empty card: the failed row is
        # kept for the audit view, and the floor is what gets served.
        logger.warning("Briefing agent run failed", exc_info=True)
        repo.create(
            text=rule_text,
            briefing_date=target_date,
            priority=priority,
            source="agent",
            status="failed",
            error=f"{type(exc).__name__}: {exc}"[:500],
            trigger=trigger,
            user_id=user_id,
        )
        return store(rule_text, "rules", "ok", None)

    logger.info("Briefing written by the agent (%d chars)", len(text))
    return store(text, "agent", "ok", None)


def _plans_the_day(target_date: date) -> bool:
    """Whether a session is planned that day; True when the plan cannot be read."""
    from arete.garmin.repository import GarminRepository

    try:
        return bool(
            GarminRepository().list_planned_sessions(
                start_date=target_date, end_date=target_date, status=None, limit=1
            )
        )
    except Exception:
        logger.warning("Could not read the day's plan", exc_info=True)
        return True


#: Two tabs of one athlete opening the dashboard at once must not pay for two
#: briefings, and one athlete's run (up to five minutes) must not hold up the
#: others: one lock per athlete. Past this many athletes the table starts over,
#: which at worst lets a concurrent request produce a duplicate briefing (one
#: extra model request, never an error).
MAX_PRODUCE_LOCKS = 256
_produce_locks: dict[int, threading.Lock] = {}
_produce_locks_guard = threading.Lock()


def _athlete_lock(user_id: int) -> threading.Lock:
    """The lock that serializes one athlete's briefing production."""
    with _produce_locks_guard:
        if user_id not in _produce_locks and len(_produce_locks) >= MAX_PRODUCE_LOCKS:
            _produce_locks.clear()
        return _produce_locks.setdefault(user_id, threading.Lock())


def get_or_create_briefing(
    *,
    produce: Callable[[str], str],
    trigger: str = "api",
    target_date: date | None = None,
    user_id: int | None = None,
) -> Briefing:
    """The day's briefing, producing it once if the day has none."""
    user_id = resolve_athlete_id(user_id)
    target_date = target_date or athlete_today()
    existing = BriefingRepository().get_for_day(target_date, user_id=user_id)
    if existing is not None:
        return existing
    with _athlete_lock(user_id):
        existing = BriefingRepository().get_for_day(target_date, user_id=user_id)
        if existing is not None:
            return existing
        return generate_briefing(
            produce=produce, trigger=trigger, target_date=target_date, user_id=user_id
        )
