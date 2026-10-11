"""The weekly review: last week against its plan, and changes for the days ahead.

Rules propose, the model explains, the athlete applies with one tap. The
proposals touch only sessions still to come this week (after today: today is
the daily adaptation's), and applying one checks the session has not changed
since it was proposed. One review per finished week; the text falls back to
the rules' own sentence when the model fails, and is that sentence alone for
a week with nothing planned or done.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Callable
from dataclasses import asdict, dataclass
from datetime import date, datetime, timedelta
from typing import Any

from arete.dataio.db import connect
from arete.dataio.queries import RUNNING_SPORTS, sql_in
from arete.garmin.models import PlannedSession, SessionStatus, SessionType
from arete.garmin.repository import GarminRepository
from arete.services.settings import athlete_today

logger = logging.getLogger(__name__)

MAX_REVIEW_CHARS = 1200
MAX_PROPOSALS = 3
ACWR_HIGH = 1.3
TSB_LOW = -20.0
READINESS_LOW = 50.0
ADHERENCE_LOW = 0.6
LONG_RUN_CUT = 0.85


@dataclass(frozen=True)
class WeekFacts:
    week_start: date
    planned_due: int
    completed: int
    missed: int
    minutes_done: int
    minutes_planned: int
    runs_done: int
    acwr: float | None
    tsb: float | None
    readiness_avg: float | None

    @property
    def adherence(self) -> float | None:
        return self.completed / self.planned_due if self.planned_due else None

    @property
    def is_empty(self) -> bool:
        """Nothing planned, done or missed and no training volume: nothing to review."""
        return not (
            self.planned_due
            or self.completed
            or self.missed
            or self.minutes_done
            or self.minutes_planned
            or self.runs_done
        )


@dataclass(frozen=True)
class Proposal:
    index: int
    planned_session_id: int
    date: str
    session: str  # what is planned now, in French
    change: dict[str, Any]  # fields to write
    before: dict[str, Any]  # those fields as proposed against
    reason: str


def last_monday(today: date) -> date:
    return today - timedelta(days=today.weekday() + 7)


def week_facts(week_start: date, today: date) -> WeekFacts:
    from arete.services.coaching_rules import rule_facts

    end = week_start + timedelta(days=6)
    con = connect()
    try:
        # A session the athlete or the daily adaptation skipped was not due.
        planned = con.execute(
            "SELECT COUNT(*) FILTER (WHERE status <> 'skipped'), COUNT(*) FILTER (WHERE status = 'completed'), COUNT(*) FILTER (WHERE status IN ('pending', 'modified')), COALESCE(SUM(target_duration_min) FILTER (WHERE status <> 'skipped'), 0) FROM app.visible_planned_sessions WHERE date BETWEEN ? AND ?",
            [week_start, end],
        ).fetchone() or (0, 0, 0, 0)
        done = con.execute(
            f"SELECT COALESCE(SUM(duration_sec), 0) / 60, COUNT(*) FILTER (WHERE sport IN ({sql_in(RUNNING_SPORTS)})) FROM app.visible_actual_sessions WHERE user_id = getvariable('arete_athlete_id') AND date BETWEEN ? AND ?",
            [week_start, end],
        ).fetchone() or (0, 0)
        readiness = con.execute(
            "SELECT AVG(COALESCE(training_readiness_score, readiness_score)) FROM app.visible_daily_metrics WHERE user_id = getvariable('arete_athlete_id') AND date BETWEEN ? AND ?",
            [week_start, end],
        ).fetchone()
    finally:
        con.close()
    facts = rule_facts(today)
    return WeekFacts(
        week_start=week_start,
        planned_due=int(planned[0]),
        completed=int(planned[1]),
        missed=int(planned[2]),
        minutes_done=round(float(done[0])),
        minutes_planned=int(planned[3]),
        runs_done=int(done[1]),
        acwr=facts.acwr,
        tsb=facts.tsb,
        readiness_avg=float(readiness[0])
        if readiness and readiness[0] is not None
        else None,
    )


def _describe(s: PlannedSession) -> str:
    parts = [s.session_type.value]
    if s.target_duration_min:
        parts.append(f"{s.target_duration_min} min")
    if s.target_hr_zone:
        parts.append(s.target_hr_zone)
    return " ".join(parts)


def _before(s: PlannedSession) -> dict[str, Any]:
    return {
        "session_type": s.session_type.value,
        "target_duration_min": s.target_duration_min,
        "target_hr_zone": s.target_hr_zone,
        "target_intensity": s.target_intensity,
        "status": s.status.value,
    }


def propose(facts: WeekFacts, upcoming: list[PlannedSession]) -> list[Proposal]:
    """Changes for the sessions still to come; pure, at most three."""
    # Imported prescriptions were reviewed step by step: the rules leave them be.
    todo = [
        s
        for s in upcoming
        if s.id is not None
        and s.status in (SessionStatus.PENDING, SessionStatus.MODIFIED)
        and s.prescription is None
    ]
    out: list[Proposal] = []

    def add(s: PlannedSession, change: dict[str, Any], reason: str) -> None:
        assert s.id is not None
        out.append(
            Proposal(
                len(out),
                s.id,
                s.date.isoformat(),
                _describe(s),
                change,
                _before(s),
                reason,
            )
        )

    why = []
    if facts.acwr is not None and facts.acwr > ACWR_HIGH:
        why.append(f"charge aiguë/chronique à {facts.acwr:.2f}")
    if facts.tsb is not None and facts.tsb < TSB_LOW:
        why.append(f"fraîcheur à {facts.tsb:.0f}")
    if facts.readiness_avg is not None and facts.readiness_avg < READINESS_LOW:
        why.append(f"préparation moyenne {facts.readiness_avg:.0f}/100")
    if why:
        reason = " et ".join(why)
        hard = sorted(
            (
                s
                for s in todo
                if s.session_type in (SessionType.INTERVALS, SessionType.TEMPO)
            ),
            key=lambda s: (s.session_type != SessionType.INTERVALS, s.date),
        )
        if hard:
            add(
                hard[0],
                {
                    "session_type": "endurance",
                    "target_hr_zone": "Z2",
                    "target_intensity": "easy",
                },
                f"{reason[0].upper()}{reason[1:]} : la séance la plus dure passe en endurance Z2.",
            )
        long_runs = [
            s
            for s in todo
            if s.session_type == SessionType.LONG_RUN and s.target_duration_min
        ]
        if long_runs:
            s = long_runs[0]
            shorter = max(
                30, round((s.target_duration_min or 0) * LONG_RUN_CUT / 5) * 5
            )
            add(
                s,
                {"target_duration_min": shorter},
                f"{reason[0].upper()}{reason[1:]} : sortie longue raccourcie à {shorter} min.",
            )
    elif (
        facts.adherence is not None
        and facts.planned_due >= 3
        and facts.adherence < ADHERENCE_LOW
    ):
        easy = sorted(
            (
                s
                for s in todo
                if s.session_type in (SessionType.ENDURANCE, SessionType.RECOVERY)
            ),
            key=lambda s: (s.target_duration_min or 0, s.date),
        )
        if easy:
            add(
                easy[0],
                {"status": "skipped"},
                f"{facts.completed} séances faites sur {facts.planned_due} prévues : "
                "une séance facile en moins pour tenir les autres.",
            )
    return out[:MAX_PROPOSALS]


def facts_text(facts: WeekFacts, proposals: list[Proposal]) -> str:
    def fmt(value: float | None, pattern: str) -> str:
        return pattern.format(value) if value is not None else "indisponible"

    lines = [
        f"Semaine du {facts.week_start.isoformat()} au "
        f"{(facts.week_start + timedelta(days=6)).isoformat()}.",
        f"Séances prévues : {facts.planned_due}, faites : {facts.completed}, "
        f"non faites : {facts.missed}.",
        f"Volume : {facts.minutes_done} min réalisées pour {facts.minutes_planned} min prévues, "
        f"{facts.runs_done} sorties de course.",
        f"Charge aiguë/chronique (ACWR, 28 jours) : {fmt(facts.acwr, '{:.2f}')}.",
        f"Fraîcheur (TSB) : {fmt(facts.tsb, '{:+.0f}')}.",
        f"Préparation moyenne de la semaine : {fmt(facts.readiness_avg, '{:.0f}/100')}.",
        "Propositions des règles pour les jours qui viennent :",
        *(
            [f"- {p.date} {p.session} : {p.reason}" for p in proposals]
            or ["- aucune, rien à changer"]
        ),
    ]
    return "\n".join(lines)


def rule_text(facts: WeekFacts, proposals: list[Proposal]) -> str:
    head = (
        f"Semaine passée : {facts.completed} séances faites sur {facts.planned_due} prévues, "
        f"{facts.minutes_done} min au total."
    )
    if not proposals:
        return head + " Rien à changer pour la suite."
    return head + " " + " ".join(p.reason for p in proposals)


@dataclass(frozen=True)
class Review:
    id: int
    week_start: date
    text: str
    source: str
    proposals: list[dict[str, Any]]
    applied: list[int]
    created_at: datetime | None
    applied_at: datetime | None

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "week_start": self.week_start.isoformat(),
            "text": self.text,
            "source": self.source,
            "proposals": self.proposals,
            "applied": self.applied,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "applied_at": self.applied_at.isoformat() if self.applied_at else None,
        }


_COLUMNS = (
    "id, week_start, text, source, proposals_json, applied_json, created_at, applied_at"
)


def _from_row(row: tuple) -> Review:
    return Review(
        id=row[0],
        week_start=row[1],
        text=row[2],
        source=row[3],
        proposals=json.loads(row[4] or "[]"),
        applied=json.loads(row[5] or "[]"),
        created_at=row[6],
        applied_at=row[7],
    )


def get_review(week_start: date) -> Review | None:
    con = connect()
    try:
        row = con.execute(
            f"SELECT {_COLUMNS} FROM app.visible_weekly_reviews WHERE user_id = getvariable('arete_athlete_id') AND week_start = ?",
            [week_start],
        ).fetchone()
    finally:
        con.close()
    return _from_row(row) if row else None


def get_review_by_id(review_id: int) -> Review | None:
    con = connect()
    try:
        row = con.execute(
            f"SELECT {_COLUMNS} FROM app.visible_weekly_reviews WHERE id = ?",
            [review_id],
        ).fetchone()
    finally:
        con.close()
    return _from_row(row) if row else None


def generate_review(
    produce: Callable[[str], str] | None,
    *,
    today: date | None = None,
    refresh: bool = False,
) -> Review:
    """Last week's review, produced once (``refresh`` writes it again)."""
    today = today or athlete_today()
    week_start = last_monday(today)
    existing = get_review(week_start)
    if existing is not None and not refresh:
        return existing
    facts = week_facts(week_start, today)
    this_week_end = week_start + timedelta(days=13)
    upcoming = GarminRepository().list_planned_sessions(
        start_date=today + timedelta(days=1),
        end_date=this_week_end,
        status=None,
        limit=20,
        ascending=True,
    )
    proposals = propose(facts, upcoming)
    facts_message = facts_text(facts, proposals)
    text, source = rule_text(facts, proposals), "rules"
    if facts.is_empty:
        # The rule sentence already says all there is: no model request.
        logger.info("Weekly review: empty week; model skipped")
    elif produce is not None:
        try:
            text, source = produce(facts_message), "agent"
        except Exception:  # noqa: BLE001 - the rule text is the floor
            logger.warning("Weekly review agent run failed", exc_info=True)
    con = connect()
    try:
        con.execute(
            "DELETE FROM app.weekly_reviews WHERE user_id = getvariable('arete_athlete_id') AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM app.athletes scope_owner WHERE scope_owner.id=user_id AND scope_owner.deleted_at IS NULL) AND (user_id = getvariable('arete_athlete_id') AND week_start = ?) ",
            [week_start],
        )
        row = con.execute(
            "INSERT INTO app.weekly_reviews (week_start, text, source, facts, proposals_json) "
            f"VALUES (?, ?, ?, ?, ?) RETURNING {_COLUMNS}",
            [
                week_start,
                text,
                source,
                facts_message,
                json.dumps([asdict(p) for p in proposals], ensure_ascii=False),
            ],
        ).fetchone()
    finally:
        con.close()
    assert row is not None
    return _from_row(row)


class AlreadyApplied(Exception):
    pass


def apply_review(review_id: int, indices: list[int]) -> dict[str, Any]:
    """Apply the chosen proposals; one whose session changed since is skipped."""
    review = get_review_by_id(review_id)
    if review is None:
        raise LookupError(f"review {review_id}")
    repo = GarminRepository()
    applied, stale = [], []
    for proposal in review.proposals:
        if proposal["index"] not in indices or proposal["index"] in review.applied:
            continue
        session = repo.get_planned_session(proposal["planned_session_id"])
        if session is None or _before(session) != proposal["before"]:
            stale.append(proposal["index"])
            continue
        change = dict(proposal["change"])
        if change.get("status") != "skipped":
            change["status"] = SessionStatus.MODIFIED.value
        change["garmin_pushed_at"] = None  # a copy on the watch no longer matches
        try:
            repo.update_planned_session_fields(session.id or 0, **change)
        except ValueError:  # an export in progress or a reviewed prescription
            stale.append(proposal["index"])
            continue
        applied.append(proposal["index"])
    if applied:
        con = connect()
        try:
            con.execute(
                "UPDATE app.weekly_reviews SET applied_json = ?, applied_at = now() WHERE user_id = getvariable('arete_athlete_id') AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM app.athletes scope_owner WHERE scope_owner.id=user_id AND scope_owner.deleted_at IS NULL) AND (id = ?) ",
                [json.dumps(sorted({*review.applied, *applied})), review_id],
            )
        finally:
            con.close()
    return {"applied": applied, "stale": stale}
