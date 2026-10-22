"""The weekly review: last week against its plan, and changes for the days ahead.

Rules propose, the model explains, the athlete applies with one tap. The
proposals touch only sessions still to come this week (after today: today is
the daily adaptation's), and applying one checks the session has not changed
since it was proposed. One review per week, written once: on Sunday evening
for the week ending that day (``review_week``), on Monday as a fallback. A
claimed row (``PENDING``) keeps two runs from paying for the same review. The
text falls back to the rules' own sentence when the model fails, and is that
sentence alone for a week with nothing planned or done.
"""

from __future__ import annotations

import json
import logging
import math
from collections.abc import Callable
from dataclasses import asdict, dataclass
from datetime import UTC, date, datetime, time, timedelta
from typing import Any, Literal

import duckdb

from arete.dataio.db import connect, db_connection, transaction
from arete.dataio.queries import EXCLUDED_SOURCES_SQL, RUNNING_SPORTS, sql_in
from arete.garmin.models import PlannedSession, SessionStatus, SessionType
from arete.garmin.repository import GarminRepository
from arete.services.settings import QuietHours, athlete_now, athlete_today, utc_now

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


#: The week's review is written on Sunday evening on the athlete's clock
#: (ARE-60): from ``REVIEW_FROM_HOUR``, and not before
#: ``REVIEW_WINDOW_UTC_HOUR``, the daily sync's last cron window
#: (``vercel.json``), which serves it on Vercel (Hobby runs each cron once a
#: day, within its hour): 18:00 in Paris in summer, 17:00 in winter.
REVIEW_FROM_HOUR = 17
REVIEW_WINDOW_UTC_HOUR = 16


def review_evening(local: datetime, quiet_hours: QuietHours | None = None) -> bool:
    """Whether ``local`` (aware, the athlete's clock) is their Sunday review
    evening, outside ``quiet_hours`` when given."""
    if local.weekday() != 6:
        return False
    if quiet_hours is not None and quiet_hours.covers(local.time()):
        return False
    start = max(
        datetime.combine(local.date(), time(REVIEW_FROM_HOUR), local.tzinfo),
        datetime.combine(local.date(), time(REVIEW_WINDOW_UTC_HOUR), UTC),
    )
    return local >= start


def review_week(today: date) -> date:
    """Monday of the week a review written ``today`` covers.

    On Sunday the week ending that day (the evening's review); any other day
    the last finished week, so Monday's fallback writes the same one.
    """
    if today.weekday() == 6:
        return today - timedelta(days=6)
    return last_monday(today)


def week_facts(week_start: date, today: date) -> WeekFacts:
    from arete.services.coaching_rules import rule_facts

    end = week_start + timedelta(days=6)
    con = connect()
    try:
        # A session the athlete or the daily adaptation skipped was not due;
        # one a missed session's replanning let go (an applied ``drop``,
        # ARE-61) was due and missed: its skip must not raise the adherence.
        planned = con.execute(
            "WITH s AS (SELECT p.status, p.target_duration_min, "
            "(p.status = 'skipped' AND EXISTS (SELECT 1 FROM app.visible_plan_decisions d "
            "WHERE d.planned_session_id = p.id AND d.decision = 'drop' "
            "AND d.applied_at IS NOT NULL AND d.reverted_at IS NULL)) AS dropped "
            "FROM app.visible_planned_sessions p WHERE p.date BETWEEN ? AND ?) "
            "SELECT COUNT(*) FILTER (WHERE status <> 'skipped' OR dropped), "
            "COUNT(*) FILTER (WHERE status = 'completed'), "
            "COUNT(*) FILTER (WHERE status IN ('pending', 'modified') OR dropped), "
            "COALESCE(SUM(target_duration_min) FILTER (WHERE status <> 'skipped' OR dropped), 0) "
            "FROM s",
            [week_start, end],
        ).fetchone() or (0, 0, 0, 0)
        done = con.execute(
            f"SELECT COALESCE(SUM(duration_sec), 0) / 60, COUNT(*) FILTER (WHERE sport IN ({sql_in(RUNNING_SPORTS)})) FROM app.visible_actual_sessions WHERE user_id = getvariable('arete_athlete_id') AND date BETWEEN ? AND ? AND COALESCE(source, '') NOT IN ({EXCLUDED_SOURCES_SQL})",
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


def _decimal(value: float, spec: str) -> str:
    return format(value, spec).replace(".", ",")


def _past(value: float, limit: float, decimals: int) -> str:
    """``value`` with a decimal comma, never shown level with ``limit``.

    The rules compare raw values; rounded, 1.3004 would read « 1,30 (au-dessus
    de 1,3) ». Then one more decimal, rounded away from the limit, keeps the
    number shown strictly past it.
    """
    above = value > limit
    shown = float(format(value, f".{decimals}f"))
    if shown > limit if above else shown < limit:
        return _decimal(value, f".{decimals}f")
    scale = 10 ** (decimals + 1)
    edge = (math.ceil if above else math.floor)(value * scale) / scale
    return _decimal(edge, f".{decimals + 1}f")


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

    # « Ma semaine » shows these reasons: the dashboard's words, a decimal comma.
    why = []
    if facts.acwr is not None and facts.acwr > ACWR_HIGH:
        why.append(
            f"équilibre de charge {_past(facts.acwr, ACWR_HIGH, 2)} "
            f"(au-dessus de {_decimal(ACWR_HIGH, 'g')})"
        )
    if facts.tsb is not None and facts.tsb < TSB_LOW:
        why.append(
            f"fraîcheur {_past(facts.tsb, TSB_LOW, 0)} (sous {_decimal(TSB_LOW, 'g')})"
        )
    if facts.readiness_avg is not None and facts.readiness_avg < READINESS_LOW:
        why.append(
            f"préparation moyenne {_past(facts.readiness_avg, READINESS_LOW, 0)}/100 "
            f"(sous {_decimal(READINESS_LOW, 'g')})"
        )
    if why:
        reason = why[0] if len(why) == 1 else f"{', '.join(why[:-1])} et {why[-1]}"
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
    # A decimal comma, as in the briefing's facts and the reasons below: the
    # model copies these numbers into the review the athlete reads.
    def fmt(value: float | None, pattern: str) -> str:
        return (
            pattern.format(value).replace(".", ",")
            if value is not None
            else "indisponible"
        )

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


#: Source of a row a run claimed and has not written yet: never served.
PENDING = "pending"
#: A claim older than this belongs to a run stopped before it stored the
#: review (the function's 300 s, a crash): another run may take it over.
CLAIM_SECONDS = 600
_SCOPE = (
    "user_id = getvariable('arete_athlete_id') AND deleted_at IS NULL AND EXISTS "
    "(SELECT 1 FROM app.athletes scope_owner WHERE scope_owner.id=user_id "
    "AND scope_owner.deleted_at IS NULL)"
)


class ReviewInProgress(Exception):
    """Another run is writing this week's review."""


def get_review(week_start: date) -> Review | None:
    con = connect()
    try:
        row = con.execute(
            f"SELECT {_COLUMNS} FROM app.visible_weekly_reviews WHERE user_id = getvariable('arete_athlete_id') AND week_start = ? AND source <> '{PENDING}'",
            [week_start],
        ).fetchone()
    finally:
        con.close()
    return _from_row(row) if row else None


def get_review_by_id(review_id: int) -> Review | None:
    con = connect()
    try:
        row = con.execute(
            f"SELECT {_COLUMNS} FROM app.visible_weekly_reviews WHERE id = ? AND source <> '{PENDING}'",
            [review_id],
        ).fetchone()
    finally:
        con.close()
    return _from_row(row) if row else None


def current_review(today: date | None = None) -> Review | None:
    """The review the athlete reads now.

    On Sunday the week ending that day's once written, last week's until
    then; any other day the last finished week's.
    """
    today = today or athlete_today()
    review = get_review(review_week(today))
    if review is None and today.weekday() == 6:
        review = get_review(last_monday(today))
    return review


def _compose(
    produce: Callable[[str], str] | None, today: date, week_start: date
) -> tuple[str, str, str, list[Proposal]]:
    """The review's text, its source, the facts it was written from, its proposals."""
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
    from arete.services.coach_followup import context_block

    facts_message = facts_text(facts, proposals) + "\n\n" + context_block()
    text, source = rule_text(facts, proposals), "rules"
    if facts.is_empty:
        # The rule sentence already says all there is: no model request.
        logger.info("Weekly review: empty week; model skipped")
    elif produce is not None:
        try:
            text, source = produce(facts_message), "agent"
        except Exception:  # noqa: BLE001 - the rule text is the floor
            logger.warning("Weekly review agent run failed", exc_info=True)
    return text, source, facts_message, proposals


WeekState = Literal["none", "written", "running", "failed_today", "abandoned"]


def _state(row: tuple | None, *, scheduled: bool) -> WeekState:
    """What the week's row (``source, created_at``) says of its review.

    ``running``: a claim within ``CLAIM_SECONDS``. An older claim belongs to a
    run stopped before it stored anything: ``abandoned``, which may be taken
    over, except by a scheduled run on the athlete's day it was claimed
    (``failed_today``): the scheduler retries the next day, never the same one.
    """
    if row is None:
        return "none"
    if row[0] != PENDING:
        return "written"
    claimed_at = row[1].replace(tzinfo=UTC)
    if utc_now() - claimed_at < timedelta(seconds=CLAIM_SECONDS):
        return "running"
    local = athlete_now()
    if scheduled and claimed_at.astimezone(local.tzinfo).date() == local.date():
        return "failed_today"
    return "abandoned"


_ROW = (
    "SELECT id, source, created_at, text FROM app.visible_weekly_reviews "
    "WHERE user_id = getvariable('arete_athlete_id') AND week_start = ?"
)


def _source_of(text: str) -> str:
    """A restored review's source: the rules' sentence opens as ``rule_text``."""
    return "rules" if text.startswith("Semaine passée :") else "agent"


def week_state(week_start: date, *, scheduled: bool = True) -> WeekState:
    """The week's review state, read without writing (the scheduler's check)."""
    with db_connection() as con:
        row = con.execute(_ROW, [week_start]).fetchone()
    return _state(row[1:] if row else None, scheduled=scheduled)


def _claim(week_start: date, *, scheduled: bool) -> int | None:
    """Mark the week's review as being written; the row's id, None when taken.

    Taken: written, ``running`` or ``failed_today`` (``_state``); an abandoned
    claim is replaced. The unique week key makes concurrent claims exclusive.
    """
    now = utc_now()
    try:
        with transaction() as con:
            row = con.execute(_ROW, [week_start]).fetchone()
            state = _state(row[1:] if row else None, scheduled=scheduled)
            if state not in ("none", "abandoned"):
                return None
            if row is not None and row[3]:
                # A claim that still carries a review (an older in-place
                # rewrite stopped mid-way): that review was written, and
                # likely announced. Shown again, never rewritten nor pushed.
                logger.warning("Weekly review: claim %s restored as written", row[0])
                con.execute(
                    f"UPDATE app.weekly_reviews SET source = ? WHERE {_SCOPE} "
                    f"AND id = ? AND source = '{PENDING}' RETURNING id",
                    [_source_of(row[3]), row[0]],
                )
                return None
            if row is not None:
                logger.warning("Weekly review: stopped claim %s taken over", row[0])
                con.execute(
                    f"DELETE FROM app.weekly_reviews WHERE {_SCOPE} "
                    f"AND id = ? AND source = '{PENDING}'",
                    [row[0]],
                )
            claimed = con.execute(
                "INSERT INTO app.weekly_reviews "
                "(week_start, text, source, proposals_json, created_at) "
                f"VALUES (?, '', '{PENDING}', '[]', ?) "
                "ON CONFLICT DO NOTHING RETURNING id",
                [week_start, now.replace(tzinfo=None)],
            ).fetchone()
    except duckdb.TransactionException:
        return None  # a concurrent run claimed the same week first
    return int(claimed[0]) if claimed else None


def _release(claim_id: int) -> None:
    try:
        with db_connection() as con:
            con.execute(
                f"DELETE FROM app.weekly_reviews WHERE {_SCOPE} "
                f"AND id = ? AND source = '{PENDING}'",
                [claim_id],
            )
    except Exception:  # noqa: BLE001 - it expires after CLAIM_SECONDS anyway
        logger.warning("Weekly review claim %s not released", claim_id, exc_info=True)


def write_review(
    produce: Callable[[str], str] | None,
    *,
    today: date | None = None,
    scheduled: bool = True,
    week_start: date | None = None,
) -> Review | None:
    """Write the week's review once; None when it exists or a run holds it.

    ``week_start`` defaults to ``review_week(today)``. Only the call that
    returns a review may announce it, so the week's push goes out at most
    once. A failure after the claim keeps it for a scheduled run (its next
    attempt is the next day's) and frees it for the athlete's own request,
    which they may repeat.
    """
    today = today or athlete_today()
    week_start = week_start or review_week(today)
    claim_id = _claim(week_start, scheduled=scheduled)
    if claim_id is None:
        return None
    try:
        text, source, facts_message, proposals = _compose(produce, today, week_start)
        with db_connection() as con:
            row = con.execute(
                "UPDATE app.weekly_reviews SET text = ?, source = ?, facts = ?, "
                f"proposals_json = ?, created_at = ? WHERE {_SCOPE} "
                f"AND id = ? AND source = '{PENDING}' RETURNING {_COLUMNS}",
                [
                    text,
                    source,
                    facts_message,
                    json.dumps([asdict(p) for p in proposals], ensure_ascii=False),
                    utc_now().replace(tzinfo=None),
                    claim_id,
                ],
            ).fetchone()
    except Exception:
        if not scheduled:
            _release(claim_id)
        raise
    # None: a rewrite asked meanwhile replaced the claim; that one stands.
    return _from_row(row) if row else None


def requested_week(today: date, local: datetime | None = None) -> date:
    """The week the athlete's own « Faire / Refaire le bilan » writes.

    The week on screen (``current_review``): on Sunday, before the review
    evening and while this week's is not written, last week's. The ending
    week would be reviewed before the afternoon's sessions are imported, and
    the evening's run would then neither write nor announce it. From the
    evening on (quiet hours aside: the athlete is asking), the ending week.
    """
    week = review_week(today)
    if today.weekday() != 6:
        return week
    if review_evening(local or athlete_now()) or get_review(week) is not None:
        return week
    return last_monday(today)


def generate_review(
    produce: Callable[[str], str] | None,
    *,
    today: date | None = None,
    refresh: bool = False,
    review_id: int | None = None,
) -> Review:
    """The athlete's own request: « Faire le bilan » writes the week on screen
    (``requested_week``) once; « Refaire » (``refresh``) writes again the
    review the screen shows, ``review_id``, read from the athlete's own rows.

    Raises ``LookupError`` for an unknown ``review_id`` and
    ``ReviewInProgress`` while another run writes the week.
    """
    today = today or athlete_today()
    if review_id is not None:
        # Its row, claimed or not: a rewrite in progress answers in progress.
        with db_connection() as con:
            shown = con.execute(
                "SELECT week_start FROM app.visible_weekly_reviews WHERE id = ?",
                [review_id],
            ).fetchone()
        if shown is None:
            raise LookupError(f"review {review_id}")
        week_start = shown[0]
    else:
        week_start = requested_week(today)
    if refresh:
        return _rewrite(produce, today, week_start)
    existing = get_review(week_start)
    if existing is not None:
        return existing
    written = write_review(produce, today=today, scheduled=False, week_start=week_start)
    if written is None:
        written = get_review(week_start)
    if written is None:
        raise ReviewInProgress(week_start.isoformat())
    return written


class ReviewChanged(ReviewInProgress):
    """The review changed since the rewrite read it (another rewrite, an answer)."""


def _rewrite(
    produce: Callable[[str], str] | None, today: date, week_start: date
) -> Review:
    """« Refaire le bilan »: the week's written review, written again in place.

    The written review is never hidden nor touched before the new one is
    ready: it is read, the new text is composed, then the same row (same id,
    so « Ma semaine », the dashboard entry and open tabs keep working) is
    updated only if it is unchanged since the read (``created_at``, the
    version, which every rewrite moves forward; ``applied_json``,
    ``applied_at``), else ``ReviewChanged``. New proposals
    are not answered yet: ``applied_json``/``applied_at`` reset. Nothing is
    announced: the week was. A request stopped before the update leaves the
    review as it was. Two concurrent rewrites may both pay a model request;
    the second gets ``ReviewChanged``. Without a written review, the week is
    written as « Faire » would (``ReviewInProgress`` while a run holds it).
    """
    with db_connection() as con:
        row = con.execute(
            "SELECT id, created_at, applied_json, applied_at FROM app.visible_weekly_reviews "
            "WHERE user_id = getvariable('arete_athlete_id') AND week_start = ? "
            f"AND source <> '{PENDING}'",
            [week_start],
        ).fetchone()
    if row is None:
        written = write_review(
            produce, today=today, scheduled=False, week_start=week_start
        )
        if written is None:
            raise ReviewInProgress(week_start.isoformat())
        return written
    text, source, facts_message, proposals = _compose(produce, today, week_start)
    try:
        with db_connection() as con:
            updated = con.execute(
                "UPDATE app.weekly_reviews SET text = ?, source = ?, facts = ?, "
                "proposals_json = ?, applied_json = NULL, applied_at = NULL, "
                # The version moves forward even within one clock tick.
                "created_at = greatest(CAST(? AS TIMESTAMP), "
                "created_at + INTERVAL 1 MICROSECOND) "
                f"WHERE {_SCOPE} AND id = ? AND source <> '{PENDING}' "
                "AND created_at IS NOT DISTINCT FROM ? "
                "AND applied_json IS NOT DISTINCT FROM ? "
                f"AND applied_at IS NOT DISTINCT FROM ? RETURNING {_COLUMNS}",
                [
                    text,
                    source,
                    facts_message,
                    json.dumps([asdict(p) for p in proposals], ensure_ascii=False),
                    utc_now().replace(tzinfo=None),
                    *row,
                ],
            ).fetchone()
    except duckdb.TransactionException:
        updated = None
    if updated is None:
        raise ReviewChanged(week_start.isoformat())
    return _from_row(updated)


def _open(review: Review, today: date) -> int:
    """Proposals still to answer: not applied, for a day still to come."""
    return sum(
        1
        for p in review.proposals
        if p["index"] not in review.applied and p["date"] > today.isoformat()
    )


def pending_entry(today: date, con: duckdb.DuckDBPyConnection) -> dict[str, Any] | None:
    """The dashboard's way into « Ma semaine », on its shared connection.

    The current review until the athlete accepts it: on the evening it is
    written and the next day whatever it proposes, then while a proposal is
    still open. None otherwise.
    """
    weeks = [review_week(today)]
    if today.weekday() == 6:
        weeks.append(last_monday(today))
    rows = con.execute(
        f"SELECT {_COLUMNS} FROM app.visible_weekly_reviews "
        "WHERE user_id = getvariable('arete_athlete_id') "
        f"AND week_start IN (?, ?) AND source <> '{PENDING}' "
        "ORDER BY week_start DESC LIMIT 1",
        [weeks[0], weeks[-1]],
    ).fetchall()
    if not rows:
        return None
    review = _from_row(rows[0])
    remaining = _open(review, today)
    if review.applied_at is not None:
        return None
    if today > review.week_start + timedelta(days=7) and remaining == 0:
        return None
    return {
        "id": review.id,
        "week_start": review.week_start.isoformat(),
        "open": remaining,
    }


def recap(review: Review, today: date) -> dict[str, Any]:
    """The reviewed week in numbers, read now: a session imported since counts."""
    end = review.week_start + timedelta(days=6)
    facts = week_facts(review.week_start, min(today, end))
    return {
        "week_start": review.week_start.isoformat(),
        "week_end": end.isoformat(),
        "planned": facts.planned_due,
        "completed": facts.completed,
        "minutes_done": facts.minutes_done,
        "minutes_planned": facts.minutes_planned,
        "adherence": facts.adherence,
        "tsb": facts.tsb,
    }


class AlreadyApplied(Exception):
    pass


def _apply(
    review: Review,
    indices: list[int],
    applied: list[int] | None = None,
    stale: list[int] | None = None,
) -> tuple[list[int], list[int]]:
    """Write the chosen proposals' sessions; (applied, stale) indices.

    Given lists are filled as it goes, so a caller still knows what was
    written when a later proposal raises.
    """
    repo = GarminRepository()
    applied = [] if applied is None else applied
    stale = [] if stale is None else stale
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
    return applied, stale


def apply_review(
    review_id: int, indices: list[int], *, seen: datetime | None = None
) -> dict[str, Any]:
    """Planning's « Appliquer »: the chosen proposals, without the watch.

    Under the same guards as ``accept``: ``seen`` (the version the page
    read) refused once rewritten (``ReviewChanged``), the proposals reserved
    by compare-and-set before they are written, the stale ones given back.
    One whose session changed since is skipped.
    """
    review, raw = _read(review_id)
    if seen is not None and seen != review.created_at:
        raise ReviewChanged(str(review_id))
    known = {p["index"] for p in review.proposals}
    todo = [i for i in indices if i in known and i not in review.applied]
    if not todo:
        return {"applied": [], "stale": []}
    _reserve(review, raw, todo)
    applied: list[int] = []
    stale: list[int] = []
    unanswered = review.applied_at is None
    try:
        _apply(review, todo, applied, stale)
    except Exception:
        _give_back(
            review_id,
            [i for i in todo if i not in applied],
            unanswered=unanswered and not applied,
        )
        raise
    if stale:
        _give_back(review_id, stale, unanswered=unanswered and not applied)
    return {"applied": applied, "stale": stale}


def _give_back(review_id: int, indices: list[int], *, unanswered: bool = False) -> None:
    """Drop reserved ``indices`` that were not written from the stored value.

    Read and written in one transaction, so a concurrent answer's own
    indices stay; a lost write conflict is retried once (it only removes
    this answer's indices). ``unanswered`` also clears ``applied_at``. Never
    raises: the plan is written and the answer reports what was.
    """
    if not indices and not unanswered:
        return
    for attempt in (1, 2):
        try:
            with transaction() as con:
                row = con.execute(
                    "SELECT applied_json FROM app.visible_weekly_reviews WHERE id = ?",
                    [review_id],
                ).fetchone()
                if row is None:
                    return
                kept = sorted(set(json.loads(row[0] or "[]")) - set(indices))
                con.execute(
                    "UPDATE app.weekly_reviews SET applied_json = ?, "
                    "applied_at = CASE WHEN ? THEN NULL ELSE applied_at END "
                    f"WHERE {_SCOPE} AND id = ? RETURNING id",
                    [json.dumps(kept), unanswered and not kept, review_id],
                )
            return
        except duckdb.TransactionException:
            if attempt == 2:
                logger.warning("Weekly review %s: give-back lost twice", review_id)
        except Exception:  # noqa: BLE001 - reported as stale; the plan is written
            logger.warning(
                "Weekly review %s: reservation not given back", review_id, exc_info=True
            )
            return


class AcceptInProgress(Exception):
    """Another « Accepter » of this review changed it since it was read."""


def _read(review_id: int) -> tuple[Review, str | None]:
    """The review and its stored ``applied_json``, as one answer reads them."""
    with db_connection() as con:
        row = con.execute(
            f"SELECT {_COLUMNS}, applied_json FROM app.visible_weekly_reviews "
            f"WHERE id = ? AND source <> '{PENDING}'",
            [review_id],
        ).fetchone()
    if row is None:
        raise LookupError(f"review {review_id}")
    return _from_row(row[:-1]), row[-1]


def _reserve(review: Review, raw: str | None, indices: list[int]) -> None:
    """Take this answer's proposals before writing them, or refuse.

    Compare-and-set on the review's version (``created_at``), ``applied_json``
    and ``applied_at`` as this answer read them: of two concurrent answers
    (two tabs, a retry during the push), the second finds them changed (or
    loses the write conflict) and applies and pushes nothing. Raises
    ``LookupError`` when the review is gone, ``ReviewChanged`` when it was
    rewritten since the read, ``AcceptInProgress`` when taken.
    """
    reserved = json.dumps(sorted({*review.applied, *indices}))
    try:
        with db_connection() as con:
            taken = con.execute(
                "UPDATE app.weekly_reviews SET applied_json = ?, "
                f"applied_at = coalesce(applied_at, now()) WHERE {_SCOPE} AND id = ? "
                "AND created_at IS NOT DISTINCT FROM ? "
                "AND applied_json IS NOT DISTINCT FROM ? "
                "AND applied_at IS NOT DISTINCT FROM ? RETURNING id",
                [reserved, review.id, review.created_at, raw, review.applied_at],
            ).fetchone()
    except duckdb.TransactionException:
        taken = None
    if taken is None:
        current = get_review_by_id(review.id)
        if current is None:
            raise LookupError(f"review {review.id}")
        if current.created_at != review.created_at:
            raise ReviewChanged(str(review.id))
        raise AcceptInProgress(str(review.id))


#: Sessions the accepted week sends to Garmin besides the ones it changed.
KEY_TYPES = (SessionType.INTERVALS, SessionType.TEMPO, SessionType.LONG_RUN)


def accept(
    review_id: int,
    indices: list[int],
    *,
    follow_calendar: Callable[[], str] | None = None,
    seen: datetime | None = None,
) -> dict[str, Any]:
    """« Accepter » on « Ma semaine »: the chosen proposals, then the watch.

    The plan is written first and stays written: a stale proposal is
    reported and left as it is, and the Garmin push and the calendar follow
    best effort, each outcome reported as it came (``plan_adaptation.push_week``,
    ``follow_calendar``), never failing the answer. The review counts as
    answered from now on, even with nothing applied. An answer that applies
    nothing new to a review already answered sends nothing (``unchanged``).
    ``seen`` is the review's ``created_at`` as the page read it: a review
    rewritten since raises ``ReviewChanged``. An index the review never had
    raises ``ValueError``; one whose day went by since the page was read
    comes back stale with the others. Raises ``LookupError`` for an
    unknown or replaced review and ``AcceptInProgress`` while another answer
    to it runs (``_reserve``).
    """
    review, raw = _read(review_id)
    if seen is not None and seen != review.created_at:
        # Rewritten since the page read it (same id): its indices name other
        # proposals now.
        raise ReviewChanged(str(review_id))
    if not set(indices) <= {p["index"] for p in review.proposals}:
        raise ValueError("Proposition inconnue")
    # A day gone by since the page was read: reported stale, the rest applied.
    gone = athlete_today().isoformat()
    past = sorted(
        p["index"]
        for p in review.proposals
        if p["index"] in indices
        and p["index"] not in review.applied
        and p["date"] <= gone
    )
    todo = [i for i in indices if i not in review.applied and i not in past]
    if not todo and review.applied_at is not None:
        return {
            "applied": [],
            "stale": past,
            "garmin": {"state": "unchanged", "sessions": []},
            "calendar": "unchanged",
        }
    _reserve(review, raw, todo)
    applied: list[int] = []
    stale: list[int] = []
    try:
        _apply(review, todo, applied, stale)
    except Exception:
        # Nothing claims a proposal that was not written, nor an answer that
        # wrote nothing.
        _give_back(
            review_id,
            [i for i in todo if i not in applied],
            unanswered=review.applied_at is None and not applied,
        )
        raise
    result = {"applied": applied, "stale": sorted({*stale, *past})}
    if stale:  # the reservation took them: give back the ones not written
        _give_back(review_id, stale)
    garmin: dict[str, Any]
    try:
        from arete.services.plan_adaptation import push_week

        changed = {
            p["planned_session_id"]
            for p in review.proposals
            if p["index"] in result["applied"]
        }
        today = athlete_today()
        upcoming = GarminRepository().list_planned_sessions(
            start_date=today + timedelta(days=1),
            end_date=review.week_start + timedelta(days=13),
            status=None,
            limit=20,
            ascending=True,
        )
        withdraw = [
            s for s in upcoming if s.id in changed and s.status == SessionStatus.SKIPPED
        ]
        # The changed sessions first: their copy on Garmin no longer matches.
        send = sorted(
            (
                s
                for s in upcoming
                if s.status in (SessionStatus.PENDING, SessionStatus.MODIFIED)
                and (s.id in changed or s.session_type in KEY_TYPES)
            ),
            key=lambda s: (s.id not in changed, s.date),
        )
        garmin = push_week(send, withdraw)
    except Exception:  # noqa: BLE001 - the plan is written; the watch is best effort
        logger.warning("Weekly review %s: Garmin push failed", review_id, exc_info=True)
        garmin = {"state": "failed", "sessions": []}
    calendar = "disabled"
    if follow_calendar is not None:
        try:
            calendar = follow_calendar()
        except Exception:  # noqa: BLE001 - its contract is never to raise
            logger.warning(
                "Weekly review %s: calendar failed", review_id, exc_info=True
            )
            calendar = "failed"
    return {**result, "garmin": garmin, "calendar": calendar}
