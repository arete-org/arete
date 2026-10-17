"""Replan a missed session the same evening (ARE-61 Part 2): one proposal a day.

In the athlete's evening, after Garmin is refreshed, today's planned sessions
still pending with no activity that day are *missed*. The rules of « Modifier »
(``renegotiation``) decide what becomes of each, deterministically and with no
model request; the result is the day's proposals, answered together from the
coach card with the morning's machinery (``plan_adaptation.respond``): nothing
changes until the athlete accepts, every change is a revertable decision with
its reason, and Garmin follows after the answer.

Defaults (the owner validates them; docs/architecture.md):

- Missed: dated today on the athlete's clock, pending or modified (a skipped,
  completed or race session never is), with no training that day: a strength
  log, or an activity of at least ``TRAINING_MIN_SECONDS`` that is not a walk
  or a hike (an activity that matched no plan still counts: no proposal rather
  than a false one; a short or incidental one does not), and no decision of
  the day, except a morning
  proposal the athlete declined or a choice they reverted. A session moved by
  « Modifier » is judged on its new day; one adapted or renegotiated today is
  not missed. A day whose morning proposal is still open gets nothing: the
  day's proposals are answered as one group, and they must not mix.
- Proposed: a hard session (tempo, intervals, long run, or marked hard) moves
  to the day ``renegotiation.move_day`` finds (the next three days, nothing
  planned, within the ISO week, before the next race and out of its last two
  days, no hard session either side, one move per session); with two missed
  hard sessions the second takes the first's new day into account. An easy
  session, or one with no day, is dropped (skipped, kind ``drop``): catching
  it up would only load the week. Merging it into another session is not
  offered: no rule rewrites two sessions' targets or steps safely, and it
  would make a harder day.
- One proposal a day: once the day holds one of these decisions, answered or
  not, nothing more is proposed, so overlapping evening runs (Vercel's window,
  Docker's ticks) create it once and push once. A choice written over one
  (« Modifier » after « Non merci ») keeps it in ``original.replaced``, which
  still holds the day. The rows are written in one transaction; a concurrent
  run's insert of the same row fails the unique key. An activity synced after
  the proposal leaves it stale (``coach_today.card``, ``plan_adaptation``).
"""

from __future__ import annotations

from datetime import date
from typing import Any

from arete.garmin.models import PlannedSession, SessionStatus, SessionType
from arete.services.adaptation import Decision, describe
from arete.services.plan_repository import (
    MISSED_REPLAN,
    PlanDecision,
)
from arete.services.renegotiation import (
    day_fr,
    is_hard,
    move_day,
    move_limit,
)

#: The key session leads (intervals > tempo > others, then the longest).
_KEY_RANK = {"intervals": 2, "tempo": 1}
#: An activity shorter than this, or a walk, does not make a day trained.
TRAINING_MIN_SECONDS = 20 * 60


def holds_the_day(decision: PlanDecision) -> bool:
    """Whether this decision is, or replaced, the day's replanning."""
    replaced = (decision.original or {}).get("replaced")
    return decision.readiness_source == MISSED_REPLAN or (
        isinstance(replaced, dict) and replaced.get("readiness_source") == MISSED_REPLAN
    )


def trained_on(con, day: date) -> bool:
    """Whether the day holds training: a strength log, or an activity of
    ``TRAINING_MIN_SECONDS`` or more that is not a walk or a hike."""
    from arete.dataio.queries import WALKING_SPORTS, sql_in

    return (
        con.execute(
            "SELECT 1 FROM app.visible_actual_sessions WHERE date=? AND duration_sec>=? "
            f"AND lower(coalesce(sport,'')) NOT IN ({sql_in(WALKING_SPORTS)}) "
            "UNION ALL SELECT 1 FROM app.visible_strength_sessions WHERE date=? "
            "LIMIT 1",
            [day, TRAINING_MIN_SECONDS, day],
        ).fetchone()
        is not None
    )


def _planned(session: PlannedSession) -> str:
    return describe(
        session.session_type.value, session.target_duration_min, session.target_hr_zone
    )


def _replaceable(decision: PlanDecision) -> bool:
    """A decision of the day a replanning may be written over."""
    return decision.readiness_source != MISSED_REPLAN and (
        decision.state == "dismissed" or decision.reverted_at is not None
    )


def missed(
    sessions: list[PlannedSession],
    decisions: list[PlanDecision],
    *,
    trained: bool,
) -> list[PlannedSession] | None:
    """Today's missed sessions; pure. None when the day gets no proposal at all.

    ``sessions`` are today's planned sessions, ``decisions`` today's plan
    decisions, ``trained`` whether any activity or strength log is dated today.
    """
    if trained:
        return None
    if any(holds_the_day(d) for d in decisions):
        return None  # one proposal a day, answered or not, even written over
    if any(d.state in {"pending", "discussion"} for d in decisions):
        return None  # the open morning proposal comes first, never mixed
    by_session = {d.planned_session_id: d for d in decisions}
    out = []
    for session in sessions:
        if session.status not in (SessionStatus.PENDING, SessionStatus.MODIFIED):
            continue
        if session.session_type == SessionType.RACE:
            continue
        decided = by_session.get(session.id) if session.id is not None else None
        if decided is not None and not _replaceable(decided):
            continue
        out.append(session)
    return out


def propose(
    sessions: list[PlannedSession],
    today: date,
    week: list[PlannedSession],
    races: set[date],
    moved: set[int],
) -> list[tuple[PlannedSession, Decision, str, dict[str, Any] | None]]:
    """What becomes of each missed session; pure. ``moved``: sessions already
    moved once, which move no more."""

    def weight(session: PlannedSession) -> tuple[int, int]:
        return _KEY_RANK.get(session.session_type.value, 0), (
            session.target_duration_min or 0
        )

    # Every missed session leaves today (moved or dropped): none weighs on
    # another's choice from there; a moved one counts on its new day.
    leaving = {s.id for s in sessions}
    planned = [s for s in week if s.id not in leaving]
    out: list[tuple[PlannedSession, Decision, str, dict[str, Any] | None]] = []
    for session in sorted(sessions, key=weight, reverse=True):
        what = _planned(session)
        day = None
        if is_hard(session) and session.id not in moved:
            day = move_day(session, today, planned, races)
        if day is not None:
            when = day_fr(day)
            out.append(
                (
                    session,
                    Decision.MOVE,
                    f"Séance manquée aujourd’hui : la séance {what} passe à {when}, "
                    "premier jour libre sans séance dure la veille ni le lendemain.",
                    {"date": day.isoformat()},
                )
            )
            # The next missed session sees this one on its new day.
            planned.append(_on(session, day))
            continue
        if not is_hard(session):
            why = "une séance facile ne se rattrape pas, la semaine reste équilibrée sans elle"
        elif session.id in moved:
            why = "elle a déjà été déplacée une fois"
        else:
            limit = move_limit(today)
            why = (
                "c’est le dernier jour de la semaine"
                if limit == today
                else f"aucun jour ne la reçoit d’ici {day_fr(limit)}"
            )
        out.append(
            (
                session,
                Decision.DROP,
                f"Séance manquée aujourd’hui : la séance {what} est laissée de côté, "
                f"{why}.",
                None,
            )
        )
    return out


def _on(session: PlannedSession, day: date) -> PlannedSession:
    from dataclasses import replace

    return replace(session, date=day)


def replan(today: date | None = None) -> list[PlanDecision]:
    """Write today's replanning proposals once; those written now, else [].

    Reads first, without a request to Garmin; the caller refreshes Garmin
    only when ``candidates`` found something (``scheduler``). Never applies
    anything: the proposals wait for the athlete's answer.
    """
    import duckdb

    from arete.dataio.db import transaction
    from arete.services.plan_adaptation import snapshot
    from arete.services.plan_repository import AlreadyDecided, PlanDecisionRepository
    from arete.services.renegotiation import goal_races, move_window, moved_once
    from arete.services.settings import athlete_today

    day = today or athlete_today()
    races = goal_races(day)
    repo = PlanDecisionRepository()
    try:
        with transaction() as con:
            # Read inside the transaction: a concurrent run's rows are either
            # seen (nothing to do) or collide on the unique key below.
            sessions, decisions, trained = _day(con, day)
            found = missed(sessions, decisions, trained=trained)
            if not found:
                return []
            week = move_window(con, day)
            moved = {s.id for s in found if s.id is not None and moved_once(con, s.id)}
            by_session = {d.planned_session_id: d for d in decisions}
            written = []
            for session, kind, reason, adapted in propose(
                found, day, week, races, moved
            ):
                assert session.id is not None
                replaced = by_session.get(session.id)
                original = snapshot(session)
                if kind == Decision.MOVE:
                    original["date"] = session.date.isoformat()
                if replaced is not None:
                    original["replaced"] = {
                        "decision": replaced.decision,
                        "reason": replaced.reason,
                        "state": replaced.state,
                        "readiness_score": replaced.readiness_score,
                        "readiness_source": replaced.readiness_source,
                        "reverted": replaced.reverted_at is not None,
                    }
                    row = repo.reapply(
                        replaced.id,
                        replaced.revision,
                        decision=kind.value,
                        reason=reason,
                        original=original,
                        adapted=adapted,
                        session_revision=session.revision,
                        con=con,
                        state="pending",
                        origin=MISSED_REPLAN,
                    )
                    if row is None:
                        raise AlreadyDecided(f"session {session.id} on {day}")
                else:
                    row = repo.create(
                        day=day,
                        planned_session_id=session.id,
                        decision=kind.value,
                        reason=reason,
                        readiness_score=None,
                        readiness_source=MISSED_REPLAN,
                        acwr=None,
                        original=original,
                        adapted=adapted,
                        state="pending",
                        session_revision=session.revision,
                        con=con,
                    )
                written.append(row)
    except (
        AlreadyDecided,
        duckdb.ConstraintException,
        duckdb.TransactionException,
    ):
        return []  # another run wrote the day's proposal first
    return written


def candidates(today: date | None = None) -> bool:
    """Whether today may hold a missed session, before asking Garmin (one read)."""
    from arete.dataio.db import db_connection
    from arete.services.settings import athlete_today

    day = today or athlete_today()
    with db_connection() as con:
        sessions, decisions, trained = _day(con, day)
    return bool(missed(sessions, decisions, trained=trained))


def _day(con, day: date) -> tuple[list[PlannedSession], list[PlanDecision], bool]:
    from arete.garmin.repository import GarminRepository
    from arete.services.plan_repository import PlanDecisionRepository

    sessions = GarminRepository().list_planned_sessions(
        start_date=day,
        end_date=day,
        status=None,
        limit=20,
        ascending=True,
        connection=con,
    )
    decisions = PlanDecisionRepository().list_for_day(day, con=con)
    return sessions, decisions, trained_on(con, day)


def announcement(written: list[PlanDecision]) -> tuple[str, str]:
    """The push's title and body for the day's proposals."""
    if len(written) > 1:
        return (
            "Séances manquées ?",
            f"{len(written)} séances d’aujourd’hui sans activité : le coach propose "
            "de replanifier. Rien ne change sans ton accord.",
        )
    (decision,) = written
    what = describe(
        str((decision.original or {}).get("session_type") or "séance"),
        (decision.original or {}).get("target_duration_min"),
        None,
    )
    if decision.decision == Decision.MOVE:
        to = date.fromisoformat(str((decision.adapted or {})["date"]))
        change = f"de la déplacer à {day_fr(to)}"
    else:
        change = "de la laisser de côté"
    return (
        "Séance manquée ?",
        f"Séance {what} non faite aujourd’hui : le coach propose {change}. "
        "Rien ne change sans ton accord.",
    )
