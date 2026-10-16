"""Renegotiate today's session in one sentence: fixed reasons, rule options.

The athlete says why today's planned session no longer fits (« Je suis cuit »,
« Pas le temps », « Douleur / gêne ») and picks one of the options the rules
below compute; « Autre… » opens the coach with the session instead
(``coach_context``). No model request. Applying writes the session and the
day's plan decision together, with the athlete's reason, revertable like the
morning's (``plan_adaptation.revert``); Garmin follows once, after the commit
(``plan_adaptation.follow_on_garmin``), and its outcome is reported apart.

Coaching defaults (the owner validates them; docs/architecture.md):

- Lighter (« Je suis cuit »): a tempo, intervals or long run becomes endurance
  Z2, an endurance run recovery Z1, a recovery run a shorter recovery, each at
  ``LIGHTER_SHARE`` of its duration (rounded to 5 min, at least
  ``MIN_MINUTES``; ``UNTIMED_MINUTES`` without a duration).
- Shorter (« Pas le temps »): the same session at ``LIGHTER_SHARE`` of its
  duration. A tempo or intervals described in words cannot be cut by a rule
  (its steps would no longer fit), so it becomes endurance Z2 instead.
- Moved (both): to the first day of the next ``MOVE_WINDOW_DAYS`` with nothing
  planned, before the next race, and, for a hard session (tempo, intervals,
  long run, race, or any session marked hard), with no hard session or race
  the day before or after. Without such a day, rest is offered instead.
- Pain (« Douleur / gêne »): rest, or ``PAIN_MINUTES`` of recovery Z1; never
  moved, never harder than planned.
- A session with explicit steps can only be moved or rested here: its steps
  are changed with the coach. A race is never renegotiated by a rule.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any

from arete.garmin.models import PlannedSession, SessionStatus, SessionType
from arete.services.adaptation import (
    ADAPTABLE_SPORTS,
    Decision,
    describe,
)
from arete.services.plan_repository import PlanDecision
from arete.services.settings import athlete_today

REASONS: dict[str, str] = {
    "tired": "Je suis cuit",
    "no_time": "Pas le temps",
    "pain": "Douleur / gêne",
}
#: Lighter and shorter versions keep this share of the planned duration.
LIGHTER_SHARE = 0.7
MIN_MINUTES = 20
#: The lighter version of a session planned without a duration.
UNTIMED_MINUTES = 30
#: The very easy alternative to rest when something hurts.
PAIN_MINUTES = 20
#: A session moves at most this many days ahead.
MOVE_WINDOW_DAYS = 3
#: Hard sessions, which never sit next to one another once moved.
_HARD_TYPES = frozenset({"tempo", "intervals", "long_run", "race"})

_WEEKDAYS = ("lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche")
_MONTHS = (
    "janvier",
    "février",
    "mars",
    "avril",
    "mai",
    "juin",
    "juillet",
    "août",
    "septembre",
    "octobre",
    "novembre",
    "décembre",
)


class Conflict(Exception):
    """The page acted on a state that changed: it must read the options again."""


def day_fr(day: date) -> str:
    """« jeudi 22 octobre »."""
    return f"{_WEEKDAYS[day.weekday()]} {day.day} {_MONTHS[day.month - 1]}"


@dataclass(frozen=True)
class Option:
    id: str
    decision: Decision
    label: str
    detail: str
    #: The decision's reason, shown on the card once applied.
    reason: str
    #: The fields written on the session.
    changes: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "decision": self.decision.value,
            "label": self.label,
            "detail": self.detail,
        }


@dataclass(frozen=True)
class Reason:
    id: str
    label: str
    options: tuple[Option, ...]
    note: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "label": self.label,
            "options": [o.to_dict() for o in self.options],
            "note": self.note,
        }


def is_hard(session: PlannedSession) -> bool:
    return (
        session.session_type.value in _HARD_TYPES or session.target_intensity == "hard"
    )


def _structured(session: PlannedSession) -> bool:
    return bool(session.prescription or session.structure_json)


def _cut(minutes: int | None) -> int | None:
    """The shorter duration, or None when the session cannot be any shorter."""
    if minutes is None:
        return UNTIMED_MINUTES
    cut = max(MIN_MINUTES, round(minutes * LIGHTER_SHARE / 5) * 5)
    return cut if cut < minutes else None


def _planned(session: PlannedSession) -> str:
    return describe(
        session.session_type.value,
        session.target_duration_min,
        session.target_hr_zone,
    )


def _origin(session: PlannedSession) -> str:
    return session.description or _planned(session)


def _rewrite(
    session: PlannedSession,
    reason: str,
    option: str,
    label: str,
    *,
    session_type: str,
    minutes: int,
    zone: str | None,
    intensity: str | None,
    described: bool = True,
) -> Option:
    """An option that rewrites the session's summary fields.

    The watch shows the description: it names what the session now is, and
    the original it replaces (as the morning's easing does), unless a type's
    template must stay undescribed to be sent as it now is.
    """
    words = describe(session_type, minutes, zone)
    shown = f"{words[0].upper()}{words[1:]}"
    title = shown.replace(f" {minutes} min", f" {minutes}'")
    decision = (
        Decision.REPLACE_EASY
        if session_type == "recovery" and session.session_type != SessionType.RECOVERY
        else Decision.EASE
    )
    return Option(
        option,
        decision,
        label,
        shown,
        f"{REASONS[reason]} : la séance {_planned(session)} devient {words}.",
        {
            "session_type": session_type,
            "target_duration_min": minutes,
            "target_hr_zone": zone,
            "target_intensity": intensity,
            "description": f"{title} (séance d'origine : {_origin(session)})"
            if described
            else None,
            "status": SessionStatus.MODIFIED,
        },
    )


def _lighter(session: PlannedSession) -> Option | None:
    """« Je suis cuit »: one step easier and shorter."""
    if _structured(session) or session.sport not in ADAPTABLE_SPORTS:
        return None
    kind = session.session_type.value
    planned = session.target_duration_min
    cut = _cut(planned)
    if kind in {"tempo", "intervals", "long_run"}:
        target, zone = "endurance", "Z2"
    elif kind == "endurance" or (kind == "recovery" and cut is not None):
        target, zone = "recovery", "Z1"
    else:
        return None
    minutes = cut or planned or UNTIMED_MINUTES
    return _rewrite(
        session,
        "tired",
        "lighter",
        "Version allégée",
        session_type=target,
        minutes=minutes,
        zone=zone,
        intensity="easy",
    )


def _shorter(session: PlannedSession) -> Option | None:
    """« Pas le temps »: the same session, shorter."""
    if _structured(session) or session.sport not in ADAPTABLE_SPORTS:
        return None
    kind = session.session_type.value
    cut = _cut(session.target_duration_min)
    if cut is None or kind not in {
        "tempo",
        "intervals",
        "long_run",
        "endurance",
        "recovery",
    }:
        return None
    if kind in {"tempo", "intervals"} and session.description:
        # Written steps do not shrink by a rule: an easy run of the time left.
        return _rewrite(
            session,
            "no_time",
            "shorter",
            "Version courte",
            session_type="endurance",
            minutes=cut,
            zone="Z2",
            intensity="easy",
        )
    return _rewrite(
        session,
        "no_time",
        "shorter",
        "Version courte",
        session_type=kind,
        minutes=cut,
        zone=session.target_hr_zone,
        intensity=session.target_intensity,
        # An undescribed tempo or intervals is its type's template, which
        # follows the duration; a description would leave it without steps.
        described=kind not in {"tempo", "intervals"},
    )


def _very_easy(session: PlannedSession) -> Option | None:
    """« Douleur / gêne »: a few easy minutes, never more than planned."""
    if _structured(session) or session.sport not in ADAPTABLE_SPORTS:
        return None
    planned = session.target_duration_min
    if session.session_type == SessionType.RECOVERY and (
        planned is not None and planned <= PAIN_MINUTES
    ):
        return None
    minutes = min(PAIN_MINUTES, planned) if planned else PAIN_MINUTES
    return _rewrite(
        session,
        "pain",
        "easy",
        "Très facile",
        session_type="recovery",
        minutes=minutes,
        zone="Z1",
        intensity="easy",
    )


def _rest(session: PlannedSession, reason: str) -> Option:
    return Option(
        "rest",
        Decision.REST,
        "Repos aujourd’hui",
        "La séance est sautée.",
        f"{REASONS[reason]} : repos à la place de la séance {_planned(session)}.",
        {"status": SessionStatus.SKIPPED},
    )


def move_day(
    session: PlannedSession,
    today: date,
    week: list[PlannedSession],
    races: set[date],
) -> date | None:
    """The day the session moves to, or None when no day fits.

    ``week`` holds the planned sessions from today to the day after the
    window; ``races`` the goal races' dates (a planned race counts too).
    """
    others = [
        s for s in week if s.id != session.id and s.status != SessionStatus.SKIPPED
    ]
    race_days = races | {s.date for s in others if s.session_type == SessionType.RACE}
    next_race = min((d for d in race_days if d > today), default=None)

    def hard_on(day: date) -> bool:
        return day in race_days or any(s.date == day and is_hard(s) for s in others)

    for offset in range(1, MOVE_WINDOW_DAYS + 1):
        day = today + timedelta(days=offset)
        if next_race is not None and day >= next_race:
            return None  # never on the race, nor after it
        if any(s.date == day for s in others):
            continue
        if is_hard(session) and (
            hard_on(day - timedelta(days=1)) or hard_on(day + timedelta(days=1))
        ):
            continue
        return day
    return None


def _move(session: PlannedSession, reason: str, day: date) -> Option:
    when = day_fr(day)
    return Option(
        "move",
        Decision.MOVE,
        f"Déplacer à {when}",
        "Premier jour libre, sans séance dure la veille ni le lendemain."
        if is_hard(session)
        else "Premier jour libre.",
        f"{REASONS[reason]} : la séance {_planned(session)} passe à {when}.",
        {"date": day},
    )


def propose(
    session: PlannedSession,
    today: date,
    week: list[PlannedSession],
    races: set[date],
) -> tuple[Reason, ...]:
    """Each reason's options for today's session; pure."""
    day = move_day(session, today, week, races)
    no_day = (
        None
        if day is not None
        else f"Pas de jour libre d’ici {day_fr(today + timedelta(days=MOVE_WINDOW_DAYS))} : "
        "allège ou repose-toi."
    )
    reasons = []
    for reason, change in (("tired", _lighter), ("no_time", _shorter)):
        options = [change(session)]
        options.append(_move(session, reason, day) if day else _rest(session, reason))
        reasons.append(
            Reason(
                reason,
                REASONS[reason],
                tuple(o for o in options if o is not None),
                no_day,
            )
        )
    pain = (_rest(session, "pain"), _very_easy(session))
    reasons.append(
        Reason(
            "pain",
            REASONS["pain"],
            tuple(o for o in pain if o is not None),
            "Avec une douleur, ni report ni séance plus dure. Si elle dure, "
            "parles-en au coach.",
        )
    )
    return tuple(reasons)


# --------------------------------------------------------------------------- #
# Reads and writes
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class _Day:
    session: PlannedSession
    today: date
    decision: PlanDecision | None
    blocked: str | None
    reasons: tuple[Reason, ...]

    @property
    def version(self) -> str:
        """What the page's options were computed from, compared on apply."""
        seen = {
            "session": [self.session.id, self.session.revision, str(self.session.date)],
            "decision": [self.decision.id, self.decision.revision]
            if self.decision
            else None,
            "blocked": self.blocked,
            "options": [
                [r.id, o.id, o.decision.value, o.changes]
                for r in self.reasons
                for o in r.options
            ],
        }
        raw = json.dumps(seen, sort_keys=True, default=str)
        return hashlib.sha256(raw.encode()).hexdigest()[:16]


def _replaceable(decision: PlanDecision) -> bool:
    """A decision of the day the athlete's choice may be written over."""
    return (
        decision.state == "dismissed"
        or decision.reverted_at is not None
        or (
            decision.state in {"pending", "discussion"}
            and decision.snoozed_until is not None
            and decision.snoozed_until > decision.date
        )
    )


def _blocked(
    session: PlannedSession, decision: PlanDecision | None, done: bool, export: str
) -> str | None:
    if done or session.status not in (SessionStatus.PENDING, SessionStatus.MODIFIED):
        return "Séance déjà faite ou sautée : rien à modifier."
    if session.session_type == SessionType.RACE:
        return "Jour de course : parles-en au coach."
    if decision is not None and not _replaceable(decision):
        if decision.state in {"pending", "discussion"}:
            return (
                "Le coach te propose déjà une adaptation de cette séance : "
                "réponds-y d’abord."
            )
        return "Séance déjà ajustée aujourd’hui : rétablis-la pour choisir autre chose."
    if export in {"working", "uncertain", "conflict"}:
        return "Vérifie d’abord l’envoi Garmin de cette séance dans le Planning."
    return None


def _read(session_id: int) -> _Day:
    """Today's session with everything its options depend on.

    Raises ``LookupError`` for a session the athlete cannot see, ``Conflict``
    for one that is no longer today's.
    """
    from arete.dataio.db import db_connection
    from arete.garmin.repository import GarminRepository
    from arete.services import garmin_export
    from arete.services.goals import list_goals
    from arete.services.plan_repository import PlanDecisionRepository

    today = athlete_today()
    repo = GarminRepository()
    with db_connection() as con:
        session = repo.get_planned_sessions([session_id], connection=con).get(
            session_id
        )
        if session is None:
            raise LookupError("Séance introuvable")
        if session.date != today:
            raise Conflict("Ce n’est plus la séance du jour : recharge la page.")
        week = repo.list_planned_sessions(
            start_date=today,
            end_date=today + timedelta(days=MOVE_WINDOW_DAYS + 1),
            status=None,
            limit=50,
            ascending=True,
            connection=con,
        )
        decision = next(
            (
                d
                for d in PlanDecisionRepository().list_for_day(today, con=con)
                if d.planned_session_id == session_id
            ),
            None,
        )
        done = (
            con.execute(
                "SELECT 1 FROM app.visible_actual_sessions WHERE planned_session_id=? LIMIT 1",
                [session_id],
            ).fetchone()
            is not None
        )
    export = (garmin_export.export_state(session_id) or {}).get("state") or ""
    races = {
        g.race_date
        for g in list_goals(today=today)
        if g.status == "active" and g.race_date > today
    }
    blocked = _blocked(session, decision, done, export)
    reasons = () if blocked else propose(session, today, week, races)
    return _Day(session, today, decision, blocked, reasons)


def options(session_id: int) -> dict[str, Any]:
    """The menu for today's session: each reason's options, or why there is none."""
    day = _read(session_id)
    return {
        "session_id": day.session.id,
        "date": day.today.isoformat(),
        "version": day.version,
        "blocked": day.blocked,
        "reasons": [r.to_dict() for r in day.reasons],
    }


def apply(session_id: int, reason: str, option_id: str, version: str) -> dict[str, Any]:
    """Write the chosen option and the day's decision together, then Garmin.

    ``version`` is the menu's as the page read it: any change since (the
    session, its decision, a day planned meanwhile) is a ``Conflict`` and
    nothing is written, so a stale tab or a second tap never applies twice.
    The write is reported whatever Garmin answers afterwards.
    """
    import duckdb

    from arete.dataio import plan_changes
    from arete.dataio.db import transaction
    from arete.garmin.repository import GarminRepository
    from arete.services.plan_adaptation import snapshot
    from arete.services.plan_repository import AlreadyDecided, PlanDecisionRepository

    day = _read(session_id)
    if version != day.version:
        raise Conflict("Ta séance a changé depuis : recharge les options.")
    if day.blocked:
        raise Conflict(day.blocked)
    option = next(
        (
            o
            for r in day.reasons
            if r.id == reason
            for o in r.options
            if o.id == option_id
        ),
        None,
    )
    if option is None:
        raise ValueError("Option inconnue pour cette séance.")
    session = day.session
    assert session.id is not None
    original = snapshot(session)
    if option.decision == Decision.MOVE:
        original["date"] = session.date.isoformat()
    adapted = {
        k: (v.isoformat() if isinstance(v, date) else v)
        for k, v in option.changes.items()
        if k != "status"
    } or None
    decisions = PlanDecisionRepository()
    try:
        with transaction() as con:
            # The session first: its compare-and-set is the transaction's
            # first read, so a write committed since the menu's is seen, and
            # one racing it conflicts.
            if not GarminRepository().update_planned_session_fields(
                session.id,
                expected_revision=session.revision,
                connection=con,
                **option.changes,
                garmin_pushed_at=None,
            ):
                raise Conflict("Ta séance a changé depuis : recharge les options.")
            if day.decision is None:
                decision = decisions.create(
                    day=day.today,
                    planned_session_id=session.id,
                    decision=option.decision.value,
                    reason=option.reason,
                    readiness_score=None,
                    readiness_source=None,
                    acwr=None,
                    original=original,
                    adapted=adapted,
                    state="applied",
                    session_revision=session.revision,
                    con=con,
                )
            else:
                reapplied = decisions.reapply(
                    day.decision.id,
                    day.decision.revision,
                    decision=option.decision.value,
                    reason=option.reason,
                    original=original,
                    adapted=adapted,
                    session_revision=session.revision,
                    con=con,
                )
                if reapplied is None:
                    raise Conflict("Ta séance a changé depuis : recharge les options.")
                decision = reapplied
    except (
        AlreadyDecided,
        duckdb.ConstraintException,
        duckdb.TransactionException,
    ) as exc:
        # A second tap or another tab committed first: nothing was written.
        raise Conflict("Ta séance vient d’être modifiée ailleurs : recharge.") from exc
    except ValueError as exc:  # the repository's guards (an unsettled export)
        raise Conflict(str(exc)) from exc
    plan_changes.touch()
    moved = option.changes.get("date")
    return {
        "decision": decision.to_dict(),
        "date": (moved or session.date).isoformat(),
        "garmin": _follow(decision),
    }


def _follow(decision: PlanDecision) -> str:
    """Garmin after the commit, in one word; never fails the written answer.

    ``sent`` or ``withdrawn`` (the copy Garmin holds), ``failed`` or
    ``not_started`` (left in the export state the card shows, never
    replayed), ``unchanged`` (Garmin holds no copy), ``disabled`` (no
    automatic push) or ``disconnected``.
    """
    import logging

    from arete.services.plan_adaptation import follow_on_garmin

    try:
        result = follow_on_garmin([decision])
    except Exception:  # noqa: BLE001 - the decision is committed
        logging.getLogger(__name__).warning("Garmin follow-up failed", exc_info=True)
        return "failed"
    if result["state"] != "done":
        return str(result["state"])
    sessions = result["sessions"]
    return str(sessions[0]["outcome"]) if sessions else "unchanged"


def coach_context(session_id: int) -> dict[str, Any]:
    """« Autre… »: the session and the rules' options, read for the coach."""
    from arete.garmin.repository import GarminRepository

    session = GarminRepository().get_planned_session(session_id)
    if session is None:
        raise LookupError("Séance introuvable")
    record: dict[str, Any] = {
        "seance": {
            "id": session.id,
            "date": session.date.isoformat(),
            "sport": session.sport,
            "type": session.session_type.value,
            "duree_min": session.target_duration_min,
            "zone": session.target_hr_zone,
            "intensite": session.target_intensity,
            "description": session.description,
            "statut": session.status.value,
            "etapes_explicites": _structured(session),
        },
        "motif": "Autre : l’athlète précise pourquoi dans son message.",
    }
    try:
        day = _read(session_id)
    except Conflict as exc:
        record["blocage"] = str(exc)
        return record
    if day.blocked:
        record["blocage"] = day.blocked
    else:
        record["options_des_regles"] = [
            {
                "motif": r.label,
                "options": [f"{o.label} : {o.detail}" for o in r.options],
            }
            for r in day.reasons
        ]
    return record
