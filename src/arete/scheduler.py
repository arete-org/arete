"""Daily background sync (Garmin activities + health, Strava) inside the API.

Enabled by ``ARETE_AUTO_SYNC_HOUR`` (an hour on each athlete's clock). No extra
dependency: an asyncio task wakes up every few minutes and runs the blocking
syncs in a worker thread for the athletes whose day's run is owed by then.
Short ticks on purpose: a laptop that sleeps freezes the container's monotonic
clock, and a single long sleep would silently skip a day.
The last run is written next to the database, so a restart does not re-run a
sync that already happened — and does run the one that was missed.
Failures are logged and never stop the loop.
"""

from __future__ import annotations

import asyncio
import json
import logging
from contextvars import ContextVar
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from time import monotonic, sleep

import duckdb

from arete.config import config
from arete.dataio.db import db_connection
from arete.services.athlete_scope import athlete_scope, current_athlete_id
from arete.services.settings import (
    QuietHours,
    athlete_today,
    stored_preferences,
    utc_now,
    zone_of,
)

logger = logging.getLogger(__name__)

HEALTH_LOOKBACK_DAYS = 3
TICK_SECONDS = 300
STATE_FILENAME = "last_daily_sync.json"


#: Status of the most recent run, for ``GET /sync/status`` and the agent's
#: ``get_sync_status`` tool. Process-local and deliberately not persisted: it
#: answers "what happened on the run this process did", while the durable
#: "did today's run happen at all" lives in the JSON marker below.
_last_status: dict[int, dict[str, str]] = {}


def last_status() -> dict[str, str]:
    """Per-source status of the last sync this process ran ({} if none yet)."""
    return dict(_last_status.get(current_athlete_id(), {}))


def state_path() -> Path:
    """Where the last run is recorded (in the data directory)."""
    from arete.config import config

    return config.data_dir / STATE_FILENAME


def last_run_date() -> date | None:
    """Day of the last completed run, None when it never ran."""
    path = state_path()
    if not path.exists():
        return None
    try:
        payload = json.loads(path.read_text())
        return datetime.fromisoformat(payload["ran_at"]).date()
    except (ValueError, KeyError, OSError):
        logger.warning("Unreadable sync state at %s, treating as never run", path)
        return None


def record_run(when: datetime) -> None:
    path = state_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"ran_at": when.isoformat()}))
    except OSError as e:  # the sync itself succeeded; only the marker failed
        logger.warning("Could not record the sync state: %s", e)


def is_due(hour: int, now: datetime, last_run: date | None) -> bool:
    """True when the scheduled hour has passed and today's run is still owed."""
    if now.hour < hour:
        return False
    return last_run is None or last_run < now.date()


def daily_sync() -> dict[str, str]:
    """Run every configured sync once. Returns a short status per source."""
    status: dict[str, str] = {}
    imported = 0  # new sessions from any source, for the notification
    synced_ids: list[int] = []  # Garmin's, for the coach's feedback
    feedback: list[dict] | None = None  # stored by this run; None = not run

    from arete.garmin.client import GarminClient

    garmin = GarminClient()
    if garmin.has_tokens():
        from arete.services.garmin_sync import ensure_fresh

        try:
            result = ensure_fresh(force=True, daily=True)
            imported += result.get("imported", 0)
            synced_ids = list(result.get("session_ids", []))
            status["garmin_activities"] = (
                f"{result.get('imported', 0)} synced, {len(result.get('errors', []))} errors; {result['state']}"
            )
            status["garmin_health"] = str(
                result.get("health_checked_at") or "incomplete"
            )
            if conditions := result.get("conditions"):
                status["conditions"] = (
                    f"{conditions['terrain']} terrain, {conditions['weather']} weather"
                )
        except Exception as e:  # noqa: BLE001 - background job must not die
            status["garmin_activities"] = f"failed: {e}"
    else:
        status["garmin"] = "no tokens"

    # After the health data, before the briefing that explains it. Runs without
    # Garmin too: the readiness then comes from the load model.
    try:
        from arete.services.plan_adaptation import adapt_today

        decisions = adapt_today(respect_setting=True)
        kinds = ", ".join(sorted({d.decision for d in decisions})) or "none"
        status["plan"] = f"{len(decisions)} decisions ({kinds})"
    except Exception as e:  # noqa: BLE001 - background job must not die
        status["plan"] = f"failed: {e}"

    # After the decisions, so a session they changed goes out changed.
    if garmin.has_tokens():
        from arete.services.plan_adaptation import push_today

        status["garmin_push"] = push_today(garmin)

    from arete.api.strava import SyncRequest, _get_strava_tokens, sync

    if _get_strava_tokens():
        try:
            result = sync(SyncRequest(days=7))
            imported += int(result["imported"])
            status["strava"] = f"{result['imported']} imported"
        except Exception as e:  # noqa: BLE001
            status["strava"] = f"failed: {e}"
    else:
        status["strava"] = "not connected"

    # After the imports and the rest decisions: the dashboard then reads the
    # settled progression without a projection request of its own.
    if (game := settle_game()) is not None:
        status["gamification"] = game

    # After every plan change of the run (adaptation, completed sessions).
    from arete.calendar import sync_training_plan
    from arete.services.calendar_plan import DAILY

    status["google_calendar"] = sync_training_plan(DAILY)

    from arete.services.coach_followup import prepare as prepare_followup

    prepare_followup()

    # Before the briefing that reads the journal the feedback files; after the
    # bounded calendar run, so a slow model cannot starve it.
    from arete.services.coaching_repository import SessionFeedbackRepository

    feedback_ids = list(synced_ids)
    try:
        pending_ids, pending_count = SessionFeedbackRepository().pending_garmin()
        # At most 20 current imports plus 20 pending: still one model request,
        # with the existing five-session model cap and rule fallback for the rest.
        feedback_ids = list(dict.fromkeys([*synced_ids, *pending_ids]))
        status["feedback_pending"] = str(pending_count)
    except Exception as exc:  # noqa: BLE001 - preserve feedback for known commits
        status["feedback_pending"] = f"failed: {type(exc).__name__}"
    if feedback_ids:
        status["feedback"], feedback = write_sync_feedback(feedback_ids)

    # Garmin sessions are announced with their feedback, once; the rest (Strava,
    # or a failed feedback run) by the import count.
    unannounced = imported - (len(synced_ids) if feedback is not None else 0)
    if (announced := announce_sync(feedback or [], unannounced)) is not None:
        status["notification"] = announced
    logger.info("Daily sync: %s", status)
    _last_status[current_athlete_id()] = dict(status)
    return status


def settle_game() -> str | None:
    """Settle an opted-in athlete's RPG progression. Never raises.

    None when there is nothing to report: the deployment or the athlete has
    the RPG off. A sync with nothing pending writes nothing.
    """
    from arete.services import gamification

    try:
        if not gamification.preference()["enabled"]:
            return None
        state = gamification.sync()
    except Exception as e:  # noqa: BLE001 - background job must not die
        logger.warning("Gamification sync failed: %s", e)
        return f"failed: {e}"
    return f"{state['pending']} pending"


def settle_checkin() -> str | None:
    """A low check-in given while the run went on reaches the day's decision.

    The run decided before the answer, and the answer, seeing the run still
    going, waited for it: once the run is stamped finished, the day's
    preparation runs again (``checkins.replan``: only undecided sessions, a
    proposal to validate). None when the day has no answer. Never raises.
    """
    from arete.services import checkins

    try:
        checkin = checkins.get()
    except Exception as e:  # noqa: BLE001 - background job must not die
        return f"failed: {type(e).__name__}"
    if checkin is None:
        return None
    return "replanned" if checkins.replan(checkin) else "unchanged"


def write_sync_feedback(session_ids: list[int]) -> tuple[str, list[dict] | None]:
    """The coach's word on the sessions the sync imported. Never raises.

    One model request for the whole batch (``coaching.write_sync_feedback``);
    the rule text stands in for a failed or unusable answer. Returns the
    status and the feedback stored by this run (None when the run failed).
    """
    try:
        from arete.coaching import write_sync_feedback as write

        outcome = write(session_ids)
    except Exception as e:  # noqa: BLE001 - background job must not die
        logger.warning("Sync feedback failed: %s", e)
        return f"failed: {e}", None
    status = f"{outcome['sessions']} sessions ({outcome['agent']} by the coach)"
    return status, list(outcome.get("written", []))


def announce_sync(feedback: list[dict], unannounced: int) -> str | None:
    """At most one notification per sync: the coach's sentence, else the count.

    ``feedback`` is what this run stored, so a session is announced once: a
    later sync finds its feedback and writes none. No model request here; the
    sentence was already paid for. The body stays short for the lock screen.
    """
    from arete.services.notifications import first_sentence, notify

    if feedback:
        latest = max(feedback, key=lambda f: (f["date"], f["session_id"]))
        url = f"/log/sessions/{latest['session_id']}?rpe=1"
        if len(feedback) == 1:
            title, body = "Séance analysée", first_sentence(latest["text"])
        else:
            prefix = f"{len(feedback)} séances analysées. "
            title = "Séances analysées"
            body = prefix + first_sentence(latest["text"], 160 - len(prefix))
        result = notify(title, body, url, kind="post_session")
    elif unannounced > 0:
        result = notify(
            "Arete",
            f"{unannounced} séance(s) importée(s)",
            "/log?tab=cardio",
            kind="imports",
        )
    else:
        return None  # nothing new: no notification
    return result.skipped_reason or f"{result.sent} sent"


#: How long the daily sync waits for a briefing the dashboard is writing
#: before comparing its facts; past it, that briefing stands as written.
BRIEFING_WAIT_SECONDS = 60
BRIEFING_POLL_SECONDS = 5
#: When the running dispatch stops starting model calls; unset outside one.
_model_deadline: ContextVar[float | None] = ContextVar("model_deadline", default=None)


def write_daily_briefing() -> str:
    """Have the coach write the day's briefing, after the sync that feeds it.

    Kept out of ``daily_sync`` so the sync's status dict stays about sources.
    Log-and-continue: the briefing must never be able to break the loop, and
    it has its own rule floor, so a failure here is already handled downstream.
    """
    from arete.coaching import get_or_create_briefing
    from arete.services.briefing import briefing_enabled, facts_changed
    from arete.services.coaching_repository import BriefingRepository

    if not briefing_enabled():
        return "disabled"
    repo = BriefingRepository()
    # Waiting never eats the dispatch's model budget (``SCHEDULE_MODEL_SECONDS``):
    # a rewrite started past it would outlive the function.
    deadline = monotonic() + BRIEFING_WAIT_SECONDS
    model_deadline = _model_deadline.get()
    if model_deadline is not None:
        deadline = min(deadline, model_deadline)
    try:
        while True:
            # A briefing the dashboard asked for is rewritten only when its
            # facts changed since (this sync's health, sessions, decisions);
            # the dashboard then says it was updated after the sync. One this
            # job already wrote (a cron that fires twice) is kept.
            existing = repo.get_for_day(athlete_today())
            if existing is not None and (
                existing.trigger == "scheduler" or not facts_changed(existing)
            ):
                return existing.source
            briefing = get_or_create_briefing(trigger="scheduler", replacing=existing)
            if briefing is not None:
                break
            # The dashboard's request is writing it: compare once it is stored.
            if monotonic() >= deadline:
                return "in progress"
            sleep(BRIEFING_POLL_SECONDS)
    except Exception as e:  # noqa: BLE001 - background job must not die
        logger.warning("Daily briefing failed: %s", e)
        return f"failed: {e}"
    if existing is not None and briefing.id == existing.id:
        return "rewrite failed; kept"  # the athlete already read this one
    logger.info("Daily briefing: %s", briefing.source)
    from arete.services.notifications import first_sentence, notify

    notify("Briefing du coach", first_sentence(briefing.text), "/", kind="briefing")
    return briefing.source


#: The week's push: once per week, by the run that wrote the review.
REVIEW_TITLE = "Ta semaine est prête"
REVIEW_URL = "/planning/semaine"


def write_weekly_review(today: date | None = None) -> str:
    """The fallback: last week's review when Sunday evening's was missed.

    Every daily run but Sunday's (whose evening pass writes the ending week,
    ``run_sunday_reviews``) writes it if still missing, until the next
    Sunday: a written week costs one read and no import of the coach, a
    failed run waits for the next day (``weekly_review._claim``), and a week
    with nothing planned or done (a new athlete's) is not written. A review
    already written, by then or by the athlete, is neither written nor
    announced again. Never raises.
    """
    today = today or athlete_today()
    if today.weekday() == 6:
        return "sunday evening"
    return announce_review(today, fallback=True)


#: What a week's state says when there is nothing to write (``week_state``).
_HELD = {
    "written": "already written",
    "running": "in progress",
    "failed_today": "failed earlier today; next attempt tomorrow",
}


def _held(week: date) -> str | None:
    """Why this run writes no review for ``week``; None when it may."""
    from arete.services.weekly_review import week_state

    return _HELD.get(week_state(week))


def announce_review(today: date | None = None, *, fallback: bool = False) -> str:
    """Write the week's review and push it, once per week. Never raises.

    One model request at most (``coaching.write_scheduled_review``); only the
    run that wrote it sends « Ta semaine est prête », which the athlete's
    ``weekly_review`` choice and quiet hours may hold back (dropped, as every
    push: the review waits in the app). A week with nothing planned or done
    is never announced (its review is the rules' « 0 séances sur 0 »); the
    ``fallback`` does not even write it.
    """
    try:
        from arete.services.weekly_review import review_week, week_facts

        today = today or athlete_today()
        week = review_week(today)
        if (held := _held(week)) is not None:
            return held
        empty = week_facts(week, today).is_empty
        if empty and fallback:
            return "empty week: nothing to review"
        from arete.coaching import write_scheduled_review

        review = write_scheduled_review()
        if review is None:  # claimed by another run meanwhile
            return _held(week) or "in progress"
    except Exception as e:  # noqa: BLE001 - background job must not die
        logger.warning("Weekly review failed: %s", e)
        return f"failed: {e}"
    written = f"{review.source}, {len(review.proposals)} proposals"
    if empty:
        return f"{written}; no push: empty week"
    from arete.services.notifications import first_sentence, notify

    result = notify(
        REVIEW_TITLE, first_sentence(review.text), REVIEW_URL, kind="weekly_review"
    )
    return f"{written}; {result.skipped_reason or f'{result.sent} sent'}"


#: Most athletes one dispatch reads. Time, not this count, bounds a dispatch:
#: one athlete's run lasts from seconds to minutes.
MAX_SCHEDULED_ATHLETES = 10
#: No athlete is claimed after this, so the last one keeps three minutes before
#: Vercel stops the function (``maxDuration`` 300 s in ``vercel.json``).
SCHEDULE_DISPATCH_SECONDS = 120
#: No briefing or review starts after this. The dashboard writes the day's
#: briefing on demand, and the week's review is one click away in Planning.
SCHEDULE_MODEL_SECONDS = 210
#: Nominal length of a claim; reclaiming goes by calendar day, not by this.
SCHEDULE_LEASE_SECONDS = 900
#: Most athletes one dispatch reads to find those owed today (5-10 expected).
MAX_SCANNED_ATHLETES = 500
#: No run starts before this hour on the athlete's clock unless
#: ``ARETE_AUTO_SYNC_HOUR`` names another: Garmin has the night's sleep and HRV
#: once the watch syncs after waking.
DEFAULT_SYNC_HOUR = 7
#: Markers are naive UTC TIMESTAMPs that the dispatch writes from its own
#: clock, so no session's TimeZone enters them, and ``epoch`` reads a naive
#: TIMESTAMP as UTC. The trusted scheduler reads every athlete's zone and quiet
#: hours from the base table in the same query. Least recent activity first: a
#: lease a failed run took today counts as today's.
_CANDIDATES = (
    "SELECT a.id, a.last_sync_at, a.sync_lease_until, "
    "epoch(a.last_sync_at), epoch(a.sync_lease_until), "
    "s.timezone, s.notification_preferences "
    "FROM app.athletes a LEFT JOIN app.user_settings s "
    "ON s.user_id = a.id AND s.deleted_at IS NULL "
    "WHERE a.deleted_at IS NULL "
    "ORDER BY greatest(a.last_sync_at, a.sync_lease_until) NULLS FIRST, a.id "
    "LIMIT ?"
)


def owed_today(
    last_sync: float | None,
    lease: float | None,
    now: float,
    zone: str | None,
    *,
    sync_hour: int = 0,
    quiet_hours: QuietHours | None = None,
) -> bool:
    """Owed now and not held by a run claimed today, on the athlete's clock.

    Epoch seconds in, so the database's and the server's timezones never
    matter. Nothing is owed before ``sync_hour`` (the night's data is not in
    yet) nor during quiet hours, which would drop the run's pushes. A lease
    is dated by its claim, ``SCHEDULE_LEASE_SECONDS`` earlier. One dated
    before today belongs to a run that failed or was stopped: the next day's
    dispatch starts a new day (every step is idempotent per day), the same
    day never retries.
    """
    local = datetime.fromtimestamp(now, zone_of(zone))
    if local.hour < sync_hour:
        return False
    if quiet_hours is not None and quiet_hours.covers(local.time()):
        return False

    def before_today(epoch: float | None) -> bool:
        if epoch is None:
            return True
        return datetime.fromtimestamp(epoch, local.tzinfo).date() < local.date()

    claimed = None if lease is None else lease - SCHEDULE_LEASE_SECONDS
    return before_today(last_sync) and before_today(claimed)


def _quiet_hours(raw: str | None) -> QuietHours | None:
    """The stored preferences' quiet hours; the defaults when unreadable."""
    try:
        stored = json.loads(raw) if raw else None
    except ValueError:
        stored = None
    return stored_preferences(stored if isinstance(stored, dict) else None).quiet_hours


def _owed(row: tuple, now: datetime, sync_hour: int) -> bool:
    last_sync, lease, zone, preferences = row[3:]
    return owed_today(
        last_sync,
        lease,
        now.timestamp(),
        zone,
        sync_hour=sync_hour,
        quiet_hours=_quiet_hours(preferences),
    )


def _naive_utc(moment: datetime) -> datetime:
    """How a marker is stored: the UTC wall clock, without an offset."""
    return moment.astimezone(UTC).replace(tzinfo=None)


def run_scheduled_batch() -> dict:
    """Claim the athletes owed today, one at a time, within the function's time.

    Each athlete has a durable daily marker (``last_sync_at``) and a lease. A
    failed or interrupted run keeps its lease until the next day: it is never
    replayed the same day. Several cron windows a day may overlap; a dispatch
    skips an athlete another one claimed first. On Sunday evening it then
    writes the week's reviews (``run_sunday_reviews``).
    """
    started = monotonic()
    sync_hour = config.auto_sync_hour
    if sync_hour is None:
        sync_hour = DEFAULT_SYNC_HOUR
    with db_connection() as con:
        candidates = con.execute(_CANDIDATES, [MAX_SCANNED_ATHLETES]).fetchall()
    # Athletes past the bound are left for a later window.
    deferred = len(candidates) == MAX_SCANNED_ATHLETES
    if deferred:
        logger.warning("Dispatch read %d athletes, the scan bound", len(candidates))
    scanned_at = utc_now()
    rows = [row for row in candidates if _owed(row, scanned_at, sync_hour)]
    outcomes: dict[str, dict] = {}
    deferred = deferred or len(rows) > MAX_SCHEDULED_ATHLETES
    for row in rows[:MAX_SCHEDULED_ATHLETES]:
        athlete_id, last_sync, stale_lease = row[:3]
        if monotonic() - started >= SCHEDULE_DISPATCH_SECONDS:
            deferred = True
            break
        # Still owed at the claim, which dates the run: a scan just before the
        # athlete's midnight must not stamp the next day as done.
        claimed_at = utc_now()
        if not _owed(row, claimed_at, sync_hour):
            continue
        if not _claim(athlete_id, last_sync, stale_lease, claimed_at):
            continue
        if stale_lease is not None:
            logger.warning(
                "Athlete %s: lease of a failed or stopped run (%s) reclaimed",
                athlete_id,
                stale_lease,
            )
        outcomes[str(athlete_id)] = _run_athlete(
            athlete_id, started, claimed_at, row[5]
        )
    # After the day's runs, in the time they left.
    return {
        "athletes": outcomes,
        "deferred": deferred,
        "reviews": run_sunday_reviews(started),
    }


def _claim(
    athlete_id: int,
    last_sync: datetime | None,
    lease: datetime | None,
    claimed_at: datetime,
) -> bool:
    """Take the athlete's lease, unless another dispatch took it first.

    Compare-and-set on the markers this dispatch read as owed: a concurrent
    dispatch that claimed or finished the athlete has changed one of them.
    """
    until = claimed_at + timedelta(seconds=SCHEDULE_LEASE_SECONDS)
    try:
        with db_connection() as con:
            row = con.execute(
                "UPDATE app.athletes SET sync_lease_until=? "
                "WHERE id=? AND deleted_at IS NULL "
                "AND last_sync_at IS NOT DISTINCT FROM ? "
                "AND sync_lease_until IS NOT DISTINCT FROM ? RETURNING id",
                [_naive_utc(until), athlete_id, last_sync, lease],
            ).fetchone()
    except duckdb.TransactionException:
        logger.info("Athlete %s claimed by a concurrent dispatch", athlete_id)
        return False
    return row is not None


def _run_athlete(
    athlete_id: int, started: float, claimed_at: datetime, zone: str | None
) -> dict:
    with athlete_scope(athlete_id):
        from arete.dataio import mirror

        try:
            if config.is_remote_db:
                mirror.hydrate()
            status = daily_sync()
            tz = zone_of(zone)
            claim_day = claimed_at.astimezone(tz).date()
            # The briefing's wait for the dashboard ends at the model deadline.
            _model_deadline.set(started + SCHEDULE_MODEL_SECONDS)
            for step, write in (
                ("briefing", write_daily_briefing),
                ("review", write_weekly_review),
            ):
                late = monotonic() - started >= SCHEDULE_MODEL_SECONDS
                if late:
                    status[step] = "deferred"
                elif utc_now().astimezone(tz).date() != claim_day:
                    # Past the athlete's midnight the step would date its text
                    # by the new day, from the claimed day's data; the new
                    # day's run writes its own.
                    logger.warning(
                        "Athlete %s: %s skipped, the claimed day has ended",
                        athlete_id,
                        step,
                    )
                    status[step] = "skipped: day ended"
                else:
                    status[step] = write()
            # Self-hosted status marker (``/sync/status``): server clock on purpose.
            record_run(datetime.now())
            if config.is_remote_db:
                mirror.flush()
            # Dated by the claim: a run that ends past midnight is the day's.
            with db_connection() as con:
                con.execute(
                    "UPDATE app.athletes SET last_sync_at=?,sync_lease_until=NULL WHERE id=?",
                    [_naive_utc(claimed_at), athlete_id],
                )
            # Stamped: an answer given from now on replans on its own.
            if (settled := settle_checkin()) is not None:
                status["checkin"] = settled
        except Exception:
            logger.exception(
                "Scheduled work failed for athlete %s; lease kept until tomorrow",
                athlete_id,
            )
            return {"status": "failed; next attempt tomorrow"}
    return status


#: The week's review goes out on Sunday evening on the athlete's clock (ARE-60),
#: by ``weekly_review.review_evening``: from 17:00 and not before 16:00 UTC,
#: the daily sync's last cron window (``vercel.json``; Hobby fires it within
#: its hour), outside quiet hours so the push is not dropped. On Vercel that
#: one window reaches, with the default quiet hours (21:30-07:00), UTC+1 to
#: UTC+4, and UTC+5 when it fires before 16:30: Paris at 18:00 in summer and
#: 17:00 in winter, but neither London nor Lisbon in winter, the Americas,
#: Dakar, Kolkata or Bangkok. Docker's five-minute ticks reach every zone from
#: UTC-12 to UTC+5. The others get it from their next daily run.


def review_evening(
    now: float, zone: str | None, quiet_hours: QuietHours | None
) -> bool:
    """Whether ``now`` (epoch seconds) is the athlete's Sunday review evening."""
    from arete.services.weekly_review import review_evening as evening

    return evening(datetime.fromtimestamp(now, zone_of(zone)), quiet_hours)


def run_sunday_reviews(started: float) -> dict:
    """Write the week's review for the athletes whose Sunday evening it is.

    Exactly once per week and athlete, whatever the overlapping dispatches:
    the review's row is claimed before its one model request
    (``weekly_review.write_review``), a week written, claimed or failed today
    is skipped with one read and no Garmin request, and a run that failed
    keeps its claim until the next day (the daily run's fallback,
    ``write_weekly_review``). No review starts past ``SCHEDULE_MODEL_SECONDS``
    of the dispatch nor beyond ``MAX_SCHEDULED_ATHLETES``: those left wait
    for the next daily run. A parked athlete gets none. Independent of the
    daily run's claim and markers.
    """
    with db_connection() as con:
        candidates = con.execute(_CANDIDATES, [MAX_SCANNED_ATHLETES]).fetchall()
    deferred = len(candidates) == MAX_SCANNED_ATHLETES
    outcomes: dict[str, str] = {}
    written = 0
    for row in candidates:
        athlete_id, lease, zone, preferences = row[0], row[4], row[5], row[6]
        now = utc_now().timestamp()
        if not review_evening(now, zone, _quiet_hours(preferences)):
            continue
        if _parked(lease, now, zone):
            continue
        if written >= MAX_SCHEDULED_ATHLETES:
            deferred = True
            break
        with athlete_scope(athlete_id):
            outcome = write_sunday_review(started)
        outcomes[str(athlete_id)] = outcome
        if outcome == "deferred":
            deferred = True
            break
        if outcome not in _HELD.values():
            written += 1
    return {"athletes": outcomes, "deferred": deferred}


def write_sunday_review(started: float) -> str:
    """One athlete's Sunday review, after their afternoon's Garmin sessions.

    The morning's run did not import the day's sessions: a refresh within
    ``SCHEDULE_DISPATCH_SECONDS`` of the dispatch brings them in first (their
    feedback follows in the next daily run), so the week counts them. Never
    raises.
    """
    from arete.dataio import mirror
    from arete.services import weekly_review

    try:
        held = _held(weekly_review.review_week(athlete_today()))
        if held is not None:
            return held
        if monotonic() - started >= SCHEDULE_DISPATCH_SECONDS:
            return "deferred"
        if config.is_remote_db:
            mirror.hydrate()
        from arete.services.garmin_sync import ensure_fresh

        try:
            ensure_fresh(deadline=started + SCHEDULE_DISPATCH_SECONDS)
        except Exception as e:  # noqa: BLE001 - the review reads what is there
            logger.warning("Sunday Garmin refresh failed: %s", e)
        if monotonic() - started >= SCHEDULE_MODEL_SECONDS:
            return "deferred"
        outcome = announce_review()
        if config.is_remote_db:
            mirror.flush()
    except Exception as e:  # noqa: BLE001 - background job must not die
        logger.warning("Sunday review failed: %s", e)
        return f"failed: {e}"
    return outcome


#: The morning check-in's push (ARE-59) has its own cron windows, 05:00 and
#: 06:00 UTC (``vercel.json``), before the daily sync's first at 07:00: the
#: answer then reaches the day's decision. It goes out in the first window
#: between ``CHECKIN_FROM_HOUR`` and ``CHECKIN_UNTIL_HOUR`` on the athlete's
#: clock and outside their quiet hours. The default quiet hours end at 07:00,
#: so in Paris 05:00 UTC serves summer time (07:00) and 06:00 UTC winter time
#: (07:00 too, when 05:00 UTC is still 06:00 and quiet).
CHECKIN_FROM_HOUR = 6
CHECKIN_UNTIL_HOUR = 12
#: No check-in push starts after this: each may wait on a device's timeout.
CHECKIN_DISPATCH_SECONDS = 150


def checkin_owed(now: float, zone: str | None, quiet_hours: QuietHours | None) -> bool:
    """Whether ``now`` (epoch seconds) is in the athlete's check-in morning."""
    local = datetime.fromtimestamp(now, zone_of(zone))
    if not CHECKIN_FROM_HOUR <= local.hour < CHECKIN_UNTIL_HOUR:
        return False
    return quiet_hours is None or not quiet_hours.covers(local.time())


def _parked(lease: float | None, now: float, zone: str | None) -> bool:
    """A lease that outlasts the athlete's day: an operator parked them."""
    if lease is None:
        return False
    tz = zone_of(zone)
    return (
        datetime.fromtimestamp(lease, tz).date()
        > datetime.fromtimestamp(now, tz).date()
    )


def run_checkin_prompts() -> dict:
    """Send the morning check-in push to the athletes in their morning.

    Each athlete gets it at most once a day, and not once the day is answered
    (``checkins.prompt`` claims it first); a parked athlete (lease set past
    today) gets none. Independent of the daily run's claim and markers: the
    daily sync's windows are unchanged by it.
    """
    from arete.services import checkins

    started = monotonic()
    with db_connection() as con:
        candidates = con.execute(_CANDIDATES, [MAX_SCANNED_ATHLETES]).fetchall()
    deferred = len(candidates) == MAX_SCANNED_ATHLETES
    outcomes: dict[str, str] = {}
    for row in candidates:
        athlete_id, lease, zone, preferences = row[0], row[4], row[5], row[6]
        now = utc_now().timestamp()
        if not checkin_owed(now, zone, _quiet_hours(preferences)):
            continue
        if _parked(lease, now, zone):
            continue
        if monotonic() - started >= CHECKIN_DISPATCH_SECONDS:
            deferred = True
            break
        with athlete_scope(athlete_id):
            outcomes[str(athlete_id)] = checkins.prompt()
    return {"athletes": outcomes, "deferred": deferred}


#: A missed session is replanned in the athlete's evening (ARE-61 Part 2),
#: outside quiet hours (the push would be dropped). On Vercel its own cron
#: window at 18:00 UTC (``vercel.json``) dispatches it from
#: ``EVENING_FROM_HOUR`` on the athlete's clock; Hobby fires it anywhere within
#: the hour, so with the default quiet hours (from 21:30) it lands in Paris
#: between about 20:00 and 21:00 in summer and 19:00 and 20:00 in winter, in
#: London an hour earlier, and in UTC+3 only when it fires before 18:30. Earlier
#: zones (the Americas) are not reached on Vercel and get no replanning, nor
#: does a day once it has ended: a proposal belongs to its own evening. Docker's
#: five-minute ticks, which run with the daily sync (``ARETE_AUTO_SYNC_HOUR``
#: set), start at ``DOCKER_EVENING_FROM_HOUR``, after the after-work runs.
EVENING_FROM_HOUR = 18
DOCKER_EVENING_FROM_HOUR = 20
#: No replanning starts after this: each may wait on Garmin's refresh.
EVENING_DISPATCH_SECONDS = 200


def evening_owed(
    now: float,
    zone: str | None,
    quiet_hours: QuietHours | None,
    from_hour: int = EVENING_FROM_HOUR,
) -> bool:
    """Whether ``now`` (epoch seconds) is in the athlete's replanning evening."""
    local = datetime.fromtimestamp(now, zone_of(zone))
    if local.hour < from_hour:
        return False
    return quiet_hours is None or not quiet_hours.covers(local.time())


def run_evening_replans(from_hour: int = EVENING_FROM_HOUR) -> dict:
    """Replan today's missed sessions for the athletes in their evening.

    Each athlete's day gets one proposal and one push at most, whatever the
    overlapping windows (``missed_sessions.replan``); a day with nothing
    missed costs one read and no Garmin request, and a parked athlete gets
    nothing. Independent of the daily run's claim and markers. The order
    rotates every day: Vercel's single window may run out of time
    (``EVENING_DISPATCH_SECONDS``, a Garmin refresh each), and those it
    defers get nothing that day, so the same athletes must not always be last.
    """
    started = monotonic()
    with db_connection() as con:
        candidates = con.execute(_CANDIDATES, [MAX_SCANNED_ATHLETES]).fetchall()
    deferred = len(candidates) == MAX_SCANNED_ATHLETES
    candidates.sort(key=lambda row: evening_rank(row[0], utc_now().date()))
    outcomes: dict[str, str] = {}
    replanned = 0
    for row in candidates:
        athlete_id, lease, zone, preferences = row[0], row[4], row[5], row[6]
        now = utc_now().timestamp()
        if not evening_owed(now, zone, _quiet_hours(preferences), from_hour):
            continue
        if _parked(lease, now, zone):
            continue
        if replanned >= MAX_SCHEDULED_ATHLETES:
            deferred = True
            break
        with athlete_scope(athlete_id):
            outcome = replan_missed_evening(started)
        outcomes[str(athlete_id)] = outcome
        if outcome == "deferred":
            deferred = True
            break
        if outcome != "nothing missed":
            replanned += 1
    return {"athletes": outcomes, "deferred": deferred}


def evening_rank(athlete_id: int, day: date) -> int:
    """The athlete's place in the day's evening pass: a stable shuffle that
    changes every day."""
    from hashlib import blake2b

    digest = blake2b(f"{day.isoformat()}:{athlete_id}".encode(), digest_size=8)
    return int.from_bytes(digest.digest(), "big")


def replan_missed_evening(started: float) -> str:
    """One athlete's evening: refresh Garmin when a session looks missed, then
    write the day's replanning proposal and push it once. Never raises."""
    from arete.dataio import mirror
    from arete.services import missed_sessions
    from arete.services.notifications import notify

    try:
        if not missed_sessions.candidates():
            return "nothing missed"
        if monotonic() - started >= EVENING_DISPATCH_SECONDS:
            return "deferred"
        if config.is_remote_db:
            mirror.hydrate()
        from arete.services.garmin_sync import ensure_fresh

        try:
            # The afternoon's activities: a session done is not missed.
            ensure_fresh(deadline=started + EVENING_DISPATCH_SECONDS)
        except Exception as e:  # noqa: BLE001 - the plan reads what is there
            logger.warning("Evening Garmin refresh failed: %s", e)
        written = missed_sessions.replan()
        if config.is_remote_db:
            mirror.flush()
        if not written:
            return "nothing missed"
        title, body = missed_sessions.announcement(written)
        result = notify(title, body, "/", kind="adapted_session")
        push = result.skipped_reason or f"{result.sent} sent"
        return f"{len(written)} proposed; push: {push}"
    except Exception as e:  # noqa: BLE001 - background job must not die
        logger.warning("Evening replanning failed: %s", e)
        return f"failed: {e}"


#: The coach's evening message (ARE-64), for the athletes who opted in, from
#: the hour each chose (``coach_evening_hour``, 18:00 to 21:00, 20:00 by
#: default) on their clock and outside quiet hours. On Vercel its own cron
#: windows, 18:00, 19:00 and 20:00 UTC (``vercel.json``), each fired within
#: its hour, reach Paris's 20:00 in summer and winter alike (21:00 when it is
#: chosen, unless the window fires past the quiet hours' 21:30); the
#: Americas are not reached. Docker's ticks reach every zone, to the tick.
#: Independent of the replanning's window: a replanning written first is in
#: the facts, one written later is not.
EVENING_MESSAGE_FROM_HOUR = 18
#: No evening message starts after this: each is one model request.
EVENING_MESSAGE_DISPATCH_SECONDS = 210


def run_evening_messages() -> dict:
    """Write tomorrow's evening message for the athletes in their evening.

    At most one per athlete and evening whatever the overlapping windows and
    ticks (``evening_message.write`` claims the evening before its request),
    pushed once by its writer. An athlete who has not opted in, whose push
    cannot leave or whose evening has nothing to say costs a few reads and no
    request; a parked athlete gets nothing. Independent of the daily run's
    claim and markers. The order rotates daily, like the replanning's.
    """
    started = monotonic()
    with db_connection() as con:
        candidates = con.execute(_CANDIDATES, [MAX_SCANNED_ATHLETES]).fetchall()
    deferred = len(candidates) == MAX_SCANNED_ATHLETES
    candidates.sort(key=lambda row: evening_rank(row[0], utc_now().date()))
    outcomes: dict[str, str] = {}
    written = 0
    for row in candidates:
        athlete_id, lease, zone, preferences = row[0], row[4], row[5], row[6]
        now = utc_now().timestamp()
        # From the earliest hour an athlete may choose; each one's in scope.
        quiet = _quiet_hours(preferences)
        if not evening_owed(now, zone, quiet, EVENING_MESSAGE_FROM_HOUR):
            continue
        if _parked(lease, now, zone):
            continue
        if written >= MAX_SCHEDULED_ATHLETES:
            deferred = True
            break
        with athlete_scope(athlete_id):
            outcome = write_evening_message(started)
        if outcome == "deferred":
            deferred = True
            break
        if outcome != "disabled":
            outcomes[str(athlete_id)] = outcome
        if outcome.startswith("written"):
            written += 1
    return {"athletes": outcomes, "deferred": deferred}


def write_evening_message(started: float) -> str:
    """One athlete's evening message: written once, pushed by its writer.

    Never raises. Reads only until the evening is claimed; the claim comes
    before the one model request, and a failure keeps it (never replayed).
    """
    from arete.dataio.settings import get_user_settings
    from arete.services import evening_message
    from arete.services.notifications import notify

    try:
        settings = get_user_settings() or {}
        if not evening_message.enabled(settings):
            return "disabled"
        local = utc_now().astimezone(zone_of(settings.get("timezone")))
        if local.hour < evening_message.start_hour(settings):
            return "not yet"
        if (reason := evening_message.unreachable(settings)) is not None:
            return f"skipped: {reason}"
        day = local.date()
        if (held := evening_message.get_for_day(day)) is not None:
            return f"already {held.status}"
        evening = evening_message.survey(day)
        if not evening.reasons:
            return "nothing to say"
        if monotonic() - started >= EVENING_MESSAGE_DISPATCH_SECONDS:
            return "deferred"
        from arete.coaching import write_evening_message as write

        message = write(evening)
    except Exception as e:  # noqa: BLE001 - background job must not die
        logger.warning("Evening message failed: %s", e)
        return f"failed: {e}"
    if message is None:
        return "already claimed"
    if message.status != "ok":
        return f"failed: {message.error}"
    result = notify(*evening_message.announcement(message), kind="evening")
    return f"written; push: {result.skipped_reason or f'{result.sent} sent'}"


async def run_forever(hour: int | None, tick_seconds: int = TICK_SECONDS) -> None:
    from anyio import to_thread

    logger.info("Background dispatch every %ds; daily sync hour=%s", tick_seconds, hour)
    # This task intentionally lives as long as the server; each dispatch is bounded.
    while True:
        # ARETE_AUTO_SYNC_HOUR is read on each athlete's clock, not the host's:
        # every tick dispatches, and the batch decides who is owed.
        if hour is not None:
            try:
                # Before the batch, in the same tick when both are due: an answer
                # given while the run goes on is read once it is stamped
                # (``settle_checkin``), one given after replans on its own.
                await to_thread.run_sync(run_checkin_prompts)
            except Exception:
                logger.exception("Check-in dispatch failed; next tick will retry")
            try:
                await to_thread.run_sync(run_scheduled_batch)
            except Exception:
                logger.exception(
                    "Scheduled dispatch failed; next tick will check unclaimed work"
                )
            try:
                await to_thread.run_sync(run_evening_replans, DOCKER_EVENING_FROM_HOUR)
            except Exception:
                logger.exception("Evening replanning failed; next tick will retry")
            try:
                await to_thread.run_sync(run_evening_messages)
            except Exception:
                logger.exception("Evening messages failed; next tick will retry")
        try:
            await to_thread.run_sync(run_automations)
        except Exception:
            logger.exception(
                "Automation dispatch failed; claimed work is never replayed"
            )
        await asyncio.sleep(tick_seconds)


def start() -> asyncio.Task[None] | None:
    """Start explicitly configured daily sync or the standalone Docker worker."""
    hour = config.auto_sync_hour
    if hour is None and not config.automation_worker:
        logger.info("Automatic sync disabled (ARETE_AUTO_SYNC_HOUR unset)")
        return None
    return asyncio.create_task(run_forever(hour), name="arete-daily-sync")


def release_sync_lease(athlete_id: int) -> bool:
    """Let the next dispatch claim an athlete whose run failed or was stopped.

    For an administrator who has checked what that run already did outside
    (Garmin, Strava, the calendar): the day's sync starts again from the top.
    A lease still within its nominal length belongs to a run in progress and
    stays, so two runs never overlap. False when nothing was released.
    """
    with db_connection() as con:
        row = con.execute(
            "UPDATE app.athletes SET sync_lease_until=NULL WHERE id=? "
            "AND sync_lease_until < (current_timestamp AT TIME ZONE 'UTC') RETURNING id",
            [athlete_id],
        ).fetchone()
    return row is not None


def run_automations() -> dict:
    from arete.services.automation_dispatch import dispatch

    def execute(run):
        # No agent stack is imported when the queue is empty.
        from arete.coaching import run_automation

        run_automation(run)

    return dispatch(execute)
