"""The coach's evening message (ARE-64): a word about tomorrow, one question.

Opt-in (Réglages › Coach, off by default), sent from the hour the athlete
chose on their clock and outside quiet hours (``scheduler.run_evening_messages``).
Like the briefing it binds no tool: the facts are computed here and the model
answers in one request (``coaching.run_evening``), so an evening costs one
model request at most, and none when there is nothing to say.

Defaults (the owner validates them; docs/architecture.md):

- Something to say, or no request: a session planned tomorrow (pending or
  modified), or a notable signal: a race within ``RACE_SOON_DAYS`` (an active
  goal or a planned race), a low readiness this morning (under the rest band,
  ``adaptation.REPLACE_AT``, or a low morning check-in), or today's
  replanning of a missed session. Otherwise the evening is skipped, unwritten.
- Reachable, or no request: the message is meant to be answered tonight, so
  it is not written when its push cannot leave (notifications or the
  ``evening`` kind off, no Web Push keys, no subscribed device).
- Exactly once: the evening's row is claimed before the model request (the
  unique day key makes concurrent claims exclusive), and only the run that
  wrote the message pushes it. A failed run keeps its row (``failed``) and a
  stopped one its claim: neither is replayed, the next evening is a new day.
- The answer is kept once on the row and filed once in the journal
  (``memory.append_entry``, whose dated heading is the guard), where the next
  briefing and chat read it; the next briefing's facts quote it too.
  Recording it makes no model request.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from typing import TYPE_CHECKING, Any

import duckdb

from arete.dataio.db import db_connection, transaction
from arete.services.coaching_repository import naive_utc_now
from arete.services.settings import EVENING_DEFAULT_HOUR, athlete_today

if TYPE_CHECKING:
    from arete.garmin.models import PlannedSession
    from arete.services.coaching_rules import RuleFacts
    from arete.services.plan_repository import PlanDecision

logger = logging.getLogger(__name__)

#: Three sentences and a question; a model that ignores it is refused.
MAX_EVENING_CHARS = 600
MAX_ANSWER_CHARS = 1_000
#: A race this close, or closer, is worth a word on a rest day too.
RACE_SOON_DAYS = 7
#: The push: its question, opening the coach on this message.
PUSH_TITLE = "Chiron, pour demain"
JOURNAL_TITLE = "Question du soir"
_REASONS_FR = {
    "session": "une séance est prévue demain",
    "race": f"une course dans les {RACE_SOON_DAYS} jours",
    "readiness": "préparation basse ce matin",
    "replanned": "une séance manquée replanifiée aujourd'hui",
}
_WEEKDAYS = ("lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche")
_COLUMNS = (
    "id, date, status, reasons, text, question, error, created_at, written_at, "
    "answer, answered_at, journaled_at"
)
_SCOPE = "athlete_id = getvariable('arete_athlete_id') AND deleted_at IS NULL"


class EveningConflict(ValueError):
    """The answer conflicts with the stored one, or the question has passed."""


@dataclass(frozen=True)
class EveningMessage:
    id: int
    date: date
    status: str
    reasons: tuple[str, ...]
    text: str | None
    question: str | None
    error: str | None
    created_at: datetime
    written_at: datetime | None
    answer: str | None
    answered_at: datetime | None
    journaled_at: datetime | None

    def to_dict(self) -> dict[str, Any]:
        """What the athlete and the coach read: the run's state stays inside."""
        return {
            "id": self.id,
            "date": self.date.isoformat(),
            "for_date": (self.date + timedelta(days=1)).isoformat(),
            "reasons": list(self.reasons),
            "text": self.text,
            "question": self.question,
            "written_at": _utc(self.written_at),
            "answer": self.answer,
            "answered_at": _utc(self.answered_at),
        }


def _utc(at: datetime | None) -> str | None:
    """Stored in naive UTC; read with its offset."""
    return at.replace(tzinfo=UTC).isoformat() if at else None


def _from_row(row: tuple) -> EveningMessage:
    return EveningMessage(
        id=int(row[0]),
        date=row[1],
        status=row[2],
        reasons=tuple(r for r in (row[3] or "").split(",") if r),
        text=row[4],
        question=row[5],
        error=row[6],
        created_at=row[7],
        written_at=row[8],
        answer=row[9],
        answered_at=row[10],
        journaled_at=row[11],
    )


# --------------------------------------------------------------------------- #
# The athlete's choice
# --------------------------------------------------------------------------- #
def enabled(settings: dict) -> bool:
    return bool(settings.get("coach_evening_enabled", False))


def start_hour(settings: dict) -> int:
    return int(settings.get("coach_evening_hour") or EVENING_DEFAULT_HOUR)


def unreachable(settings: dict) -> str | None:
    """Why the evening's push could not leave now; None when it can."""
    from arete.services import notifications

    if not bool(settings.get("notifications_enabled", True)):
        return "notifications désactivées"
    if (reason := notifications.withheld(settings, "evening")) is not None:
        return reason
    if not notifications.configured():
        return "clés Web Push absentes du serveur"
    if not notifications.subscribed():
        return "aucun appareil abonné"
    return None


# --------------------------------------------------------------------------- #
# Whether tonight has something to say, and the facts
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class Survey:
    """What the evening reads before deciding, once: reads only."""

    day: date
    reasons: tuple[str, ...]
    facts: RuleFacts | None
    tomorrow: list[PlannedSession] = field(default_factory=list)
    races: list[tuple[date, str]] = field(default_factory=list)
    replanned: list[PlanDecision] = field(default_factory=list)


def survey(day: date | None = None) -> Survey:
    """Tonight's reasons to write about tomorrow; none means no request."""
    from arete.garmin.repository import GarminRepository
    from arete.services.adaptation import REPLACE_AT, declared_fatigue
    from arete.services.coaching_rules import rule_facts
    from arete.services.goals import list_goals
    from arete.services.missed_sessions import holds_the_day
    from arete.services.plan_repository import PlanDecisionRepository

    day = day or athlete_today()
    tomorrow = day + timedelta(days=1)
    horizon = day + timedelta(days=RACE_SOON_DAYS)
    ahead = [
        s
        for s in GarminRepository().list_planned_sessions(
            start_date=tomorrow, end_date=horizon, status=None, limit=50, ascending=True
        )
        if s.status.value in {"pending", "modified"}
    ]
    races = sorted(
        {
            *(
                (s.date, s.description or "course prévue")
                for s in ahead
                if s.session_type.value == "race"
            ),
            *(
                (g.race_date, g.name)
                for g in list_goals(today=day)
                if g.status == "active" and day < g.race_date <= horizon
            ),
        }
    )
    facts = rule_facts(day)
    low = facts.readiness_score is not None and facts.readiness_score < REPLACE_AT
    if facts.checkin is not None:
        low = (
            low or declared_fatigue(facts.checkin.sleep, facts.checkin.legs) is not None
        )
    replanned = [
        d for d in PlanDecisionRepository().list_for_day(day) if holds_the_day(d)
    ]
    planned = [s for s in ahead if s.date == tomorrow]
    reasons = tuple(
        reason
        for reason, present in (
            ("session", planned),
            ("race", races),
            ("readiness", low),
            ("replanned", replanned),
        )
        if present
    )
    return Survey(day, reasons, facts, planned, races, replanned)


def _today_lines(day: date) -> list[str]:
    """What the athlete trained today (Strava rows never reach the model)."""
    with db_connection() as con:
        rows = con.execute(
            "SELECT sport, name, duration_sec, distance_m FROM app.visible_actual_sessions "
            "WHERE date = ? AND source <> 'strava' ORDER BY id LIMIT 5",
            [day],
        ).fetchall()
        strength = con.execute(
            "SELECT count(*) FROM app.visible_strength_sessions WHERE date = ?", [day]
        ).fetchone()
    lines = [
        ", ".join(
            part
            for part in (
                f"{sport} « {name or 'sans titre'} »",
                f"{(seconds or 0) // 60} min",
                f"{meters / 1000:.1f} km" if meters else None,
            )
            if part
        )
        for sport, name, seconds, meters in rows
    ]
    if strength and strength[0]:
        lines.append(f"{strength[0]} séance(s) de musculation enregistrée(s)")
    return lines


def _weather_lines(day: date) -> list[str]:
    """Tomorrow's forecast where and when the athlete last started a session.

    One Open-Meteo request at most, bounded by its own timeout; never raises.
    """
    from arete.services.weather import fetch_weather

    with db_connection() as con:
        row = con.execute(
            "SELECT start_lat, start_lon, start_time FROM app.visible_actual_sessions "
            "WHERE start_lat IS NOT NULL AND start_lon IS NOT NULL "
            "AND start_time IS NOT NULL AND source NOT IN ('strava', 'fit_file') "
            "ORDER BY date DESC, start_time DESC LIMIT 1"
        ).fetchone()
    if row is None:
        return ["indisponible (aucun lieu de départ connu)"]
    lat, lon, start = row
    # Garmin's starts are local: the habitual hour, tomorrow, on the same clock.
    when = datetime.combine(day + timedelta(days=1), start.time())
    weather = fetch_weather(lat, lon, when, utc=False, today=day)
    if weather is None:
        return ["indisponible"]
    parts = [
        f"{weather.temperature_c:.0f} °C"
        if weather.temperature_c is not None
        else None,
        f"vent {weather.wind_kmh:.0f} km/h" if weather.wind_kmh is not None else None,
        f"humidité {weather.humidity_pct:.0f} %"
        if weather.humidity_pct is not None
        else None,
    ]
    return [
        f"vers {weather.observed_at:%H} h, près de ton dernier départ : "
        + ", ".join(p for p in parts if p)
    ]


def facts_text(evening: Survey) -> str:
    """Everything the evening message needs, so the model needs no tool."""
    from arete.services.briefing import _block, load_lines, session_line

    day = evening.day
    tomorrow = day + timedelta(days=1)

    def readiness() -> list[str]:
        if evening.facts is None:
            return ["indisponible"]
        lines = load_lines(evening.facts, day)
        if evening.facts.checkin is not None:
            lines.append(f"Check-in de ce matin : {evening.facts.checkin.describe()}")
        return lines

    def today() -> list[str]:
        lines = _today_lines(day) or ["aucune séance enregistrée"]
        lines += [
            f"Séance manquée replanifiée ce soir ({d.state}) : {d.reason}"
            for d in evening.replanned
        ]
        return lines

    races = [
        f"{label} le {_WEEKDAYS[when.weekday()]} {when.isoformat()} "
        f"(dans {(when - day).days} jours)"
        for when, label in evening.races
    ]
    return "\n\n".join(
        [
            f"Nous sommes {_WEEKDAYS[day.weekday()]} {day.isoformat()}, le soir. "
            f"Demain : {_WEEKDAYS[tomorrow.weekday()]} {tomorrow.isoformat()}.",
            "Pourquoi ce message : "
            + ", ".join(_REASONS_FR[r] for r in evening.reasons)
            + ".",
            _block(
                "Séance(s) prévue(s) demain",
                lambda: [session_line(s) for s in evening.tomorrow],
            ),
            _block("Météo prévue demain", lambda: _weather_lines(day)),
            _block("Charge, forme et récupération (ce matin)", readiness),
            _block("Aujourd'hui", today),
            *([_block("Course proche", lambda: races)] if races else []),
        ]
    )


# --------------------------------------------------------------------------- #
# Writing it once
# --------------------------------------------------------------------------- #
def closing_question(text: str) -> str:
    """The message's one question, its last sentence; ValueError otherwise."""
    if len(text) > MAX_EVENING_CHARS:
        raise ValueError(f"Message du soir trop long ({len(text)} caractères)")
    if not text.endswith("?") or text.count("?") != 1:
        raise ValueError("Le message du soir doit finir par une seule question")
    return re.split(r"(?<=[.!…])\s+", text)[-1]


def get_for_day(day: date) -> EveningMessage | None:
    """The evening's row whatever its state: any row holds the evening."""
    with db_connection() as con:
        row = con.execute(
            f"SELECT {_COLUMNS} FROM app.visible_coach_evening_messages WHERE date = ?",
            [day],
        ).fetchone()
    return _from_row(row) if row else None


def get(message_id: int) -> EveningMessage | None:
    """A written message of the scoped athlete; claims and failures stay hidden."""
    with db_connection() as con:
        row = con.execute(
            f"SELECT {_COLUMNS} FROM app.visible_coach_evening_messages "
            "WHERE id = ? AND status = 'ok'",
            [message_id],
        ).fetchone()
    return _from_row(row) if row else None


def _claim(day: date, reasons: tuple[str, ...]) -> int | None:
    """Take the evening before its model request; None when already held."""
    try:
        with db_connection() as con:
            row = con.execute(
                "INSERT INTO app.coach_evening_messages (date, reasons, created_at) "
                "VALUES (?, ?, ?) ON CONFLICT DO NOTHING RETURNING id",
                [day, ",".join(reasons), naive_utc_now()],
            ).fetchone()
    except (duckdb.ConstraintException, duckdb.TransactionException):
        return None  # a concurrent dispatch claimed the same evening first
    return int(row[0]) if row else None


def _settle(claim_id: int, **values: Any) -> EveningMessage | None:
    with db_connection() as con:
        row = con.execute(
            "UPDATE app.coach_evening_messages SET status = ?, text = ?, question = ?, "
            f"error = ?, written_at = ? WHERE {_SCOPE} AND id = ? "
            f"AND status = 'pending' RETURNING {_COLUMNS}",
            [
                values["status"],
                values.get("text"),
                values.get("question"),
                values.get("error"),
                naive_utc_now(),
                claim_id,
            ],
        ).fetchone()
    return _from_row(row) if row else None


def write(produce: Callable[[str], str], evening: Survey) -> EveningMessage | None:
    """Claim the evening and write its message in one model request.

    None when another run holds the evening. Never replays: a failed run is
    stored as ``failed`` and keeps the evening. Only a message returned with
    status ``ok`` may be pushed, so the push leaves once, from its writer.
    """
    assert evening.reasons, "an evening with nothing to say makes no request"
    claim_id = _claim(evening.day, evening.reasons)
    if claim_id is None:
        return None
    try:
        text = produce(facts_text(evening)).strip()
        question = closing_question(text)
    except Exception as exc:
        logger.warning("Evening message run failed", exc_info=True)
        return _settle(
            claim_id, status="failed", error=f"{type(exc).__name__}: {exc}"[:500]
        )
    logger.info("Evening message written (%d chars)", len(text))
    return _settle(claim_id, status="ok", text=text, question=question)


def announcement(message: EveningMessage) -> tuple[str, str, str]:
    """The push's title, body (the question) and the link opening the coach."""
    assert message.question is not None
    return PUSH_TITLE, message.question, f"/follow-up?evening={message.id}"


# --------------------------------------------------------------------------- #
# The athlete's answer
# --------------------------------------------------------------------------- #
def answer(message_id: int, text: str) -> dict[str, Any]:
    """Keep the athlete's answer once and file it in the journal once.

    Sending the same answer again is harmless (and files a journal entry a
    failed attempt left out); another answer is refused, as is one after the
    day the question was about. ``journal`` reports the filing apart: a
    failed filing never fails the saved answer.
    """
    text = text.strip()
    if not text or len(text) > MAX_ANSWER_CHARS:
        raise ValueError(f"Réponds en 1 à {MAX_ANSWER_CHARS} caractères.")
    message = None
    for attempt in range(2):
        try:
            message = _keep(message_id, text)
            break
        except duckdb.TransactionException as exc:
            # A concurrent answer won: the same text is this one, saved.
            if attempt:
                raise EveningConflict(
                    "Réponse concurrente : recharge le message."
                ) from exc
    assert message is not None
    return {**message.to_dict(), "journal": _file(message)}


def _keep(message_id: int, text: str) -> EveningMessage:
    with transaction() as con:
        row = con.execute(
            f"SELECT {_COLUMNS} FROM app.visible_coach_evening_messages "
            "WHERE id = ? AND status = 'ok'",
            [message_id],
        ).fetchone()
        if row is None:
            raise LookupError("Message du soir introuvable")
        message = _from_row(row)
        if message.answer is not None:
            if message.answer != text:
                raise EveningConflict("Une réponse est déjà enregistrée.")
            return message
        if athlete_today() > message.date + timedelta(days=1):
            raise EveningConflict("Cette question portait sur une journée passée.")
        row = con.execute(
            "UPDATE app.coach_evening_messages SET answer = ?, answered_at = ? "
            f"WHERE {_SCOPE} AND id = ? AND answer IS NULL RETURNING {_COLUMNS}",
            [text, naive_utc_now(), message_id],
        ).fetchone()
        if row is None:
            raise EveningConflict("Le message vient de changer : recharge-le.")
        return _from_row(row)


def _file(message: EveningMessage) -> str:
    """The answer's journal entry: ``written``, ``already`` or ``failed``."""
    if message.journaled_at is not None:
        return "already"
    from arete.services.memory import NOTES_LEDGER, append_entry

    try:
        # Dated by the evening: its heading is the "never twice" guard.
        written = append_entry(
            NOTES_LEDGER,
            JOURNAL_TITLE,
            f"« {message.question} » Réponse de l'athlète : « {message.answer} »",
            when=message.date,
        )
        with db_connection() as con:
            con.execute(
                "UPDATE app.coach_evening_messages SET journaled_at = ? "
                f"WHERE {_SCOPE} AND id = ? AND journaled_at IS NULL",
                [naive_utc_now(), message.id],
            )
    except Exception:
        logger.warning(
            "Evening answer %s not filed in the journal", message.id, exc_info=True
        )
        return "failed"
    return "written" if written else "already"


def answered_lines(evening: date) -> list[str]:
    """That evening's question and answer for the next briefing; [] unanswered."""
    message = get_for_day(evening)
    if message is None or message.status != "ok" or message.answer is None:
        return []
    return [f"Ta question : {message.question}", f"Réponse : {message.answer}"]
