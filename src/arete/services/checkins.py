"""The morning check-in: how the night and the legs feel, in ten seconds.

One row per athlete and day (``app.daily_checkins``, migration 49): sleep and
legs 1-5, an optional "motivation / stress" 1-5 and a short note, 1 always the
worst. The answer is a fact for the day's readiness decision
(``adaptation.declared_fatigue``: low answers lower it, never raise it) and
for the briefing. No model reads the note on its own.

The same row records the day's one check-in push (``prompt``): the push is
claimed before it is sent, so two dispatches never send it twice, and it is
never sent once the day is answered.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from typing import Any

from arete.dataio.db import db_connection
from arete.services.settings import athlete_today, utc_now, zone_of

logger = logging.getLogger(__name__)

#: How far back an answer may be given or corrected, and read (``recent``).
MAX_DAYS = 14
MAX_NOTE_CHARS = 280
SCALE = range(1, 6)

_COLUMNS = "date, sleep, legs, mood, note, answered_at, updated_at"


@dataclass(frozen=True)
class Checkin:
    date: date
    sleep: int
    legs: int
    mood: int | None
    note: str | None
    #: Naive UTC, as stored.
    answered_at: datetime
    updated_at: datetime

    def to_dict(self) -> dict[str, Any]:
        return {
            "date": self.date.isoformat(),
            "sleep": self.sleep,
            "legs": self.legs,
            "mood": self.mood,
            "note": self.note,
            "answered_at": self.answered_at.replace(tzinfo=UTC).isoformat(),
            "updated_at": self.updated_at.replace(tzinfo=UTC).isoformat(),
        }

    def describe(self) -> str:
        """The answer as the briefing's facts read it, in French."""
        parts = [f"sommeil {self.sleep}/5", f"jambes {self.legs}/5"]
        if self.mood is not None:
            parts.append(f"motivation / stress {self.mood}/5")
        line = ", ".join(parts) + " (1 = très mauvais, 5 = excellent)"
        return f"{line} ; mot de l'athlète : « {self.note} »" if self.note else line


class CheckinError(ValueError):
    """An answer the check-in refuses (its message is shown to the athlete)."""


def _row(row) -> Checkin:
    return Checkin(*row)


def get(day: date | None = None, con=None) -> Checkin | None:
    """The day's answered check-in (today by default), None when unanswered."""
    day = day or athlete_today()
    sql = f"SELECT {_COLUMNS} FROM app.visible_daily_checkins WHERE date = ? AND answered_at IS NOT NULL"
    if con is not None:
        row = con.execute(sql, [day]).fetchone()
    else:
        with db_connection() as own:
            row = own.execute(sql, [day]).fetchone()
    return _row(row) if row else None


def recent(days: int = MAX_DAYS, today: date | None = None) -> list[Checkin]:
    """The answered check-ins of the last ``days`` days, today included, newest first."""
    if days not in range(1, MAX_DAYS + 1):
        raise CheckinError(f"De 1 à {MAX_DAYS} jours.")
    today = today or athlete_today()
    with db_connection() as con:
        rows = con.execute(
            f"SELECT {_COLUMNS} FROM app.visible_daily_checkins "
            "WHERE answered_at IS NOT NULL AND date BETWEEN ? AND ? ORDER BY date DESC",
            [today - timedelta(days=days - 1), today],
        ).fetchall()
    return [_row(r) for r in rows]


def save(
    day: date,
    *,
    sleep: int,
    legs: int,
    mood: int | None = None,
    note: str | None = None,
) -> Checkin:
    """Record the day's answer; answering again replaces it (idempotent).

    The first answer's time is kept, and so is the day's push record.
    """
    today = athlete_today()
    if day > today:
        raise CheckinError("Ce jour n'est pas encore arrivé.")
    if day <= today - timedelta(days=MAX_DAYS):
        raise CheckinError(f"Un check-in se corrige jusqu'à {MAX_DAYS} jours après.")
    for value in (sleep, legs, mood):
        # The HTTP schema validates too; this guards every other caller.
        if value is not None and value not in SCALE:
            raise CheckinError("Une réponse va de 1 à 5.")
    note = (note or "").strip() or None
    if note is not None and len(note) > MAX_NOTE_CHARS:
        raise CheckinError(f"Le mot tient en {MAX_NOTE_CHARS} caractères.")
    now = utc_now().replace(tzinfo=None)
    with db_connection() as con:
        con.execute(
            "INSERT INTO app.daily_checkins "
            "(date, sleep, legs, mood, note, answered_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (athlete_id, date) DO UPDATE SET "
            "sleep = EXCLUDED.sleep, legs = EXCLUDED.legs, mood = EXCLUDED.mood, "
            "note = EXCLUDED.note, updated_at = EXCLUDED.updated_at, "
            "answered_at = coalesce(answered_at, EXCLUDED.answered_at)",
            [day, sleep, legs, mood, note, now, now],
        )
        saved = get(day, con)
    assert saved is not None
    return saved


def decided_today() -> bool:
    """Whether today's scheduled run (which decides the day's plan) has finished.

    Its durable marker is ``app.athletes.last_sync_at``, naive UTC, dated by
    the run's claim on the athlete's clock.
    """
    from arete.dataio.settings import get_user_settings

    with db_connection() as con:
        row = con.execute(
            "SELECT last_sync_at FROM app.athletes WHERE id = getvariable('arete_athlete_id')"
        ).fetchone()
    if not row or row[0] is None:
        return False
    ran: datetime = row[0]
    zone = zone_of((get_user_settings() or {}).get("timezone"))
    return ran.replace(tzinfo=UTC).astimezone(zone).date() == athlete_today()


# --------------------------------------------------------------------------- #
# The day's push
# --------------------------------------------------------------------------- #
PROMPT_TITLE = "Check-in du matin"
PROMPT_BODY = "Sommeil, jambes : deux réponses pour ajuster la séance du jour."
#: A rest day has no session to adjust: the answer still reaches the coach.
PROMPT_BODY_REST = "Sommeil, jambes : deux réponses pour le coach ce matin."
#: The dashboard opens with the card in view.
PROMPT_URL = "/?checkin=1"


def prompt() -> str:
    """Send the day's check-in push, at most once a day. Never raises.

    Nothing is sent, and the day is not spent, when the athlete has turned
    notifications or this kind off, is in quiet hours, or has no device to
    reach (no Web Push keys on the server, no subscription): a later dispatch
    may still send it. Once claimed the day's push is never sent again, even
    when no device received it.
    """
    from arete.dataio.settings import get_user_settings
    from arete.services import notifications

    try:
        day = athlete_today()
        settings = get_user_settings() or {}
        if not bool(settings.get("notifications_enabled", True)):
            return "notifications désactivées"
        if (reason := notifications.withheld(settings, "checkin")) is not None:
            return reason
        if not notifications.configured():
            return "clés Web Push absentes du serveur"
        if not notifications.subscribed():
            return "aucun appareil abonné"
        body = PROMPT_BODY if _trains(day) else PROMPT_BODY_REST
        with db_connection() as con:
            claimed = con.execute(
                "INSERT INTO app.daily_checkins (date, prompted_at) VALUES (?, ?) "
                "ON CONFLICT DO NOTHING RETURNING date",
                [day, utc_now().replace(tzinfo=None)],
            ).fetchone()
    except Exception as e:  # noqa: BLE001 - background job must not die
        return f"failed: {e}"
    if claimed is None:
        return "already answered or prompted"
    result = notifications.notify(PROMPT_TITLE, body, PROMPT_URL, kind="checkin")
    return result.skipped_reason or f"{result.sent} sent"


def _trains(day: date) -> bool:
    """Whether a session is still to do that day: the answer may adjust it."""
    from arete.garmin.repository import GarminRepository

    sessions = GarminRepository().list_planned_sessions(
        start_date=day, end_date=day, status=None, limit=10
    )
    return any(s.status.value in {"pending", "modified"} for s in sessions)


def replan(checkin: Checkin) -> bool:
    """Ask today's decision again after a low answer, once the run has made it.

    Before the scheduled run nothing is needed: the run reads the answer with
    the night's Garmin data. After it, the existing preparation
    (``coach_today.prepare``) decides the sessions the run kept; one it
    already proposed to change keeps its proposal. Either way the result is a
    proposal the athlete validates, never a change to the plan. The scheduled
    run calls this too once it is stamped finished, for an answer given while
    it ran (after its decision, before its stamp).

    Whether a new proposal came of it: none without a readiness, a session
    to adapt or one not already decided. Read after the preparation whatever
    its outcome, so a proposal written before a later step failed counts.
    Never raises: the answer is already saved, and a failure here (a write
    conflict with a concurrent run) is logged, never replayed.
    """
    from arete.services.adaptation import declared_fatigue
    from arete.services.coach_today import prepare
    from arete.services.plan_repository import PlanDecisionRepository

    try:
        if checkin.date != athlete_today():
            return False
        if declared_fatigue(checkin.sleep, checkin.legs) is None:
            return False
        if not decided_today():
            return False
        decisions = PlanDecisionRepository()
        before = {d.id for d in decisions.list_for_day(checkin.date)}
    except Exception:  # noqa: BLE001 - the answer stands; the decision is unchanged
        logger.warning("Check-in replan not started", exc_info=True)
        return False
    try:
        prepare()
    except Exception:  # noqa: BLE001 - a step may fail after the proposal was written
        logger.warning("Check-in replan failed", exc_info=True)
    try:
        # Read whatever happened: a proposal written before a later step
        # failed still exists, and the browser must show it.
        after = {d.id for d in decisions.list_for_day(checkin.date)}
    except Exception:  # noqa: BLE001
        logger.warning("Check-in replan outcome unread", exc_info=True)
        return False
    return bool(after - before)
