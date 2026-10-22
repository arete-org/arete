"""The briefing producer: one agent run a day, with a deterministic floor.

Called from two places — the scheduler after a successful sync, and
``POST /tips/daily``, the request the dashboard sends (without waiting on it)
when ``GET /tips/daily`` answers that the day has no briefing yet. Both go
through ``get_or_create_briefing``: a reading request never runs the model.

Sync on purpose. The scheduler already offloads blocking work with
an AnyIO worker and the API route is a plain ``def``, so staying
synchronous keeps this inside existing precedent instead of inventing a
blocking-DB-in-an-async-handler story the codebase does not have.

It never raises. A failed run is stored with ``status='failed'`` so it stays
visible, and the rule text is stored alongside so the dashboard always has
something concrete and numeric to show.
"""

from __future__ import annotations

import hashlib
import logging
import threading
from collections.abc import Callable
from datetime import date, timedelta
from typing import TYPE_CHECKING

from arete.dataio.settings import get_user_settings
from arete.features.workload import format_acwr
from arete.services.athlete_scope import resolve_athlete_id
from arete.services.coaching_repository import Briefing, BriefingRepository
from arete.services.plan_repository import MISSED_REPLAN
from arete.services.settings import athlete_today

if TYPE_CHECKING:
    from arete.garmin.models import PlannedSession
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


def bullet_block(title: str, read: Callable[[], list[str]]) -> str:
    """One section of the facts, shared by the missions that list them; a failed
    read says so instead of failing."""
    try:
        lines = read()
    except Exception:
        logger.warning("Briefing facts: %s unavailable", title, exc_info=True)
        lines = ["indisponible"]
    return f"{title} :\n" + "\n".join(f"- {line}" for line in lines or ["aucune"])


def load_lines(facts: RuleFacts, day: date) -> list[str]:
    """Load, form, the readiness and where it comes from: the facts' lines,
    shared with the evening message (``evening_message``)."""
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
            if facts.readiness_measured_on == day
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
        # A decimal comma: the model copies it into the French briefing.
        "Charge aiguë/chronique (ACWR, sur 28 jours) : "
        + (format_acwr(facts.acwr) if facts.acwr is not None else "indisponible"),
        f"Fraîcheur (TSB) : {_fmt(facts.tsb, '{:+.0f}')}",
        readiness,
        f"Objectif de la période : {_GOALS.get(facts.fitness_goal, facts.fitness_goal)}",
    ]


def session_line(s: PlannedSession) -> str:
    """One planned session as the facts list it."""
    return " — ".join(
        str(part)
        for part in (
            s.session_type.value,
            f"{s.target_duration_min} min" if s.target_duration_min else None,
            s.target_hr_zone,
            s.description,
            f"statut : {s.status.value}",
        )
        if part
    )


def briefing_facts(
    target_date: date, rule_text: str, facts: RuleFacts | None = None
) -> str:
    """Everything the briefing needs, computed here so the model needs no tool.

    The agent used to read its load and form through tools — at least three
    model requests and 99 s on the free tier — while the rule floor had just
    computed the same numbers. It never saw today's plan either. ``facts``
    are the floor's; without them the load section reads its own. The
    morning check-in (today's and yesterday's) appears only once answered,
    the pain declared within three days only once declared.
    """
    from arete.garmin.repository import GarminRepository
    from arete.services.analytics import list_sessions
    from arete.services.coaching_rules import rule_facts

    def load() -> list[str]:
        nonlocal facts
        if facts is None:
            facts = rule_facts(target_date)
        return load_lines(facts, target_date)

    def planned() -> list[str]:
        sessions = GarminRepository().list_planned_sessions(
            start_date=target_date, end_date=target_date, status=None, limit=5
        )
        return [session_line(s) for s in sessions]

    def decisions() -> list[str]:
        from arete.services.adaptation import describe
        from arete.services.plan_repository import PlanDecisionRepository

        lines = []
        for d in PlanDecisionRepository().list_for_day(target_date):
            if d.state in {"pending", "discussion", "dismissed"}:
                lines.append(f"Proposition {d.state}, non appliquée : {d.reason}")
                continue
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
                "move": "déplacée",
                "drop": "laissée de côté (séance manquée)",
            }.get(d.decision, d.decision)
            line = f"{planned} : {verdict} — raison : {d.reason}"
            replaced = before.get("replaced")
            if isinstance(replaced, dict) and replaced.get("reason"):
                # The athlete's choice replaced the system's suggestion: the
                # morning's, or the evening's replanning of a missed session.
                when = (
                    "soir"
                    if replaced.get("readiness_source") == MISSED_REPLAN
                    else "matin"
                )
                line += f" (proposition du {when} remplacée : {replaced['reason']})"
            lines.append(line)
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
    try:
        from arete.services import checkins

        # Yesterday's too: one answered after its briefing reaches the next.
        declared = [
            f"{'ce matin' if c.date == target_date else 'hier'} : {c.describe()}"
            for c in checkins.recent(2, today=target_date)
        ]
    except Exception:
        logger.warning("Briefing facts: check-in unavailable", exc_info=True)
        declared = ["indisponible"]
    try:
        from arete.services import body_log
        from arete.services.adaptation import pain_under_load

        days = {0: "aujourd'hui", 1: "hier", 2: "avant-hier"}
        start = target_date - timedelta(days=body_log.PAIN_RECENT_DAYS - 1)
        hurts = [
            f"{days.get((target_date - p.date).days, p.date.isoformat())} : "
            f"{p.describe()}"
            for p in body_log.list_pain(start, target_date)
        ]
        if hurts:
            if facts is None:
                facts = rule_facts(target_date)
            # The fact only: the day's decision, listed below, says what it did.
            signal = pain_under_load(body_log.pain_phrase(list(facts.pain)), facts.acwr)
            if signal:
                hurts.append(f"Signal pour la décision du jour : {signal}")
    except Exception:
        logger.warning("Briefing facts: declared pain unavailable", exc_info=True)
        hurts = ["indisponible"]
    try:
        from arete.services import evening_message

        # Last evening's question, once the athlete answered it (ARE-64).
        answered = evening_message.answered_lines(target_date - timedelta(days=1))
    except Exception:
        # Omitted, like a missing answer: a failed read must not move the digest.
        logger.warning("Briefing facts: evening answer unavailable", exc_info=True)
        answered = []
    return "\n\n".join(
        [
            f"Nous sommes {weekday} {target_date.isoformat()}.",
            f"Conseil calculé par les règles : {rule_text}",
            bullet_block("Charge, fraîcheur et préparation", load),
            # Only once answered: a day without one keeps its facts (and digest).
            *(
                [bullet_block("Check-in déclaré par l'athlète", lambda: declared)]
                if declared
                else []
            ),
            # Only once declared, like the check-in.
            *(
                [bullet_block("Douleurs déclarées (3 derniers jours)", lambda: hurts)]
                if hurts
                else []
            ),
            *(
                [
                    bullet_block(
                        "Ta question d'hier soir et sa réponse", lambda: answered
                    )
                ]
                if answered
                else []
            ),
            bullet_block("Séance(s) prévue(s) aujourd'hui", planned),
            bullet_block("Décision du coach pour aujourd'hui", decisions),
            bullet_block("Prédictions de course Garmin", predictions),
            bullet_block("Dernières séances réalisées", recent),
            bullet_block("Ton briefing d'hier", yesterday),
        ]
    )


def generate_briefing(
    *,
    produce: Callable[[str], str],
    trigger: str = "api",
    target_date: date | None = None,
    user_id: int | None = None,
    keep: Briefing | None = None,
) -> Briefing:
    """Produce and persist one briefing. Never raises.

    The rule floor is computed first and always: it supplies the priority (the
    card's colour must not depend on a model) and it is the text we store when
    the agent is disabled or fails, or when there is nothing to coach on.
    ``keep`` is the briefing a rewrite replaces: a failed rewrite records its
    failure and keeps serving it rather than the rule text.
    """
    user_id = resolve_athlete_id(user_id)
    target_date = target_date or athlete_today()
    repo = BriefingRepository()
    rule_text, priority, facts = _rule_floor(target_date)
    digest: str | None = None

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
            facts_digest=digest,
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

    written_from = briefing_facts(target_date, rule_text, facts)
    digest = facts_digest(written_from)
    # No load, no form, no readiness and nothing planned for the day: a model
    # request would only restate the rule text. Facts that could not be read
    # (None) still go to the model, and so does a plan built before any sync.
    if facts is not None and facts.is_empty and not _plans_the_day(target_date):
        logger.info("Coach briefing: no training data; model skipped")
        return store(rule_text, "rules", "ok", None)

    try:
        text = produce(written_from)
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
        if keep is not None:
            return keep
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
#: others: one lock per athlete. Past this many athletes the table starts over;
#: the claim stored in the database still stops a duplicate run.
MAX_PRODUCE_LOCKS = 256
_produce_locks: dict[int, threading.Lock] = {}
_produce_locks_guard = threading.Lock()

#: A claim older than this belongs to a run that cannot still be going: the
#: run is bounded to 300 s (``MAX_RUN_SECONDS``), and so is the function.
CLAIM_EXPIRY = timedelta(seconds=330)


def _athlete_lock(user_id: int) -> threading.Lock:
    """The lock that serializes one athlete's briefing production."""
    with _produce_locks_guard:
        if user_id not in _produce_locks and len(_produce_locks) >= MAX_PRODUCE_LOCKS:
            _produce_locks.clear()
        return _produce_locks.setdefault(user_id, threading.Lock())


def _lost_run(_facts: str) -> str:
    raise RuntimeError("the previous run was stopped before it stored a briefing")


def get_or_create_briefing(
    *,
    produce: Callable[[str], str],
    trigger: str = "api",
    target_date: date | None = None,
    user_id: int | None = None,
    replacing: Briefing | None = None,
) -> Briefing | None:
    """The day's briefing, producing it once if the day has none.

    None while another request or instance produces it: the caller reports
    "pending" instead of holding a worker for the length of a model run.
    ``replacing`` is a stored briefing the scheduler rewrites (see
    ``facts_changed``), kept if the rewrite fails; any other briefing of the
    day is returned.
    A claim left by a stopped run is settled with the rule text and a failed
    row, never by a second model run.
    """
    user_id = resolve_athlete_id(user_id)
    target_date = target_date or athlete_today()
    repo = BriefingRepository()

    def current() -> Briefing | None:
        existing = repo.get_for_day(target_date, user_id=user_id)
        if existing is not None and replacing is not None:
            return None if existing.id == replacing.id else existing
        return existing

    if (existing := current()) is not None:
        return existing
    lock = _athlete_lock(user_id)
    if not lock.acquire(blocking=False):
        return None
    try:
        if (existing := current()) is not None:
            return existing
        claim = repo.claim(
            target_date, trigger=trigger, expiry=CLAIM_EXPIRY, user_id=user_id
        )
        if claim is None:
            return None
        claim_id, lost = claim
        if lost:
            logger.warning("Briefing claim of a stopped run settled without a model")
        try:
            return generate_briefing(
                produce=_lost_run if lost else produce,
                trigger=trigger,
                target_date=target_date,
                user_id=user_id,
                keep=replacing,
            )
        finally:
            repo.release(claim_id)
    finally:
        lock.release()


def facts_digest(facts_text: str) -> str:
    """Identifies the facts a briefing was written from (stored with it)."""
    return hashlib.sha256(facts_text.encode()).hexdigest()


def facts_changed(briefing: Briefing) -> bool:
    """Whether the facts the briefing was written from have changed since.

    Recomputed from the database, without a model request: the day's health,
    sessions, plan and decisions as the briefing reads them. A briefing stored
    without a digest (before it existed, or with the briefing disabled)
    counts as changed.
    """
    if briefing.facts_digest is None:
        return True
    rule_text, _, facts = _rule_floor(briefing.date)
    current = facts_digest(briefing_facts(briefing.date, rule_text, facts))
    return current != briefing.facts_digest
