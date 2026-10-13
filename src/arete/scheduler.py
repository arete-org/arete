"""Daily background sync (Garmin activities + health, Strava) inside the API.

Enabled by ``ARETE_AUTO_SYNC_HOUR`` (local hour). No extra dependency: an
asyncio task wakes up every few minutes, compares the wall clock to the
scheduled hour and runs the blocking syncs in a worker thread when the day's
run is still owed. Short ticks on purpose: a laptop that sleeps freezes the
container's monotonic clock, and a single long sleep would silently skip a day.
The last run is written next to the database, so a restart does not re-run a
sync that already happened — and does run the one that was missed.
Failures are logged and never stop the loop.
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import date, datetime, timedelta
from pathlib import Path
from time import monotonic

import duckdb

from arete.config import config
from arete.dataio.db import db_connection
from arete.dataio.settings import get_user_settings
from arete.services.athlete_scope import athlete_scope, current_athlete_id
from arete.services.settings import athlete_today, zone_of

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
        from arete.garmin.health_sync import sync_range
        from arete.garmin.readiness import update_readiness_range
        from arete.garmin.sync import GarminSyncClient

        try:
            result = GarminSyncClient(client=garmin).sync_activities(download_fit=True)
            imported += result.activities_synced
            synced_ids = list(result.session_ids)
            status["garmin_activities"] = (
                f"{result.activities_synced} synced, {len(result.errors)} errors"
            )
        except Exception as e:  # noqa: BLE001 - background job must not die
            status["garmin_activities"] = f"failed: {e}"
        if synced_ids:  # before the feedback, which reads GAP and weather
            from arete.services.session_conditions import enrich_sessions

            conditions = enrich_sessions(synced_ids)
            status["conditions"] = (
                f"{conditions['terrain']} terrain, {conditions['weather']} weather"
            )
        try:
            end = athlete_today()  # Garmin's health days are the athlete's
            start = end - timedelta(days=HEALTH_LOOKBACK_DAYS)
            days = sync_range(start, end)
            update_readiness_range(start, end)
            status["garmin_health"] = f"{sum(1 for d in days if d.success)} days"
        except Exception as e:  # noqa: BLE001
            status["garmin_health"] = f"failed: {e}"
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

    # After every plan change of the run (adaptation, completed sessions).
    from arete.calendar import sync_training_plan
    from arete.services.calendar_plan import DAILY

    status["google_calendar"] = sync_training_plan(DAILY)

    from arete.services.coach_followup import prepare as prepare_followup

    prepare_followup()

    # Before the briefing that reads the journal the feedback files; after the
    # bounded calendar run, so a slow model cannot starve it.
    if synced_ids:
        status["feedback"], feedback = write_sync_feedback(synced_ids)

    # Garmin sessions are announced with their feedback, once; the rest (Strava,
    # or a failed feedback run) by the import count.
    unannounced = imported - (len(synced_ids) if feedback is not None else 0)
    if (announced := announce_sync(feedback or [], unannounced)) is not None:
        status["notification"] = announced
    logger.info("Daily sync: %s", status)
    _last_status[current_athlete_id()] = dict(status)
    return status


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


def write_daily_briefing() -> str:
    """Have the coach write the day's briefing, after the sync that feeds it.

    Kept out of ``daily_sync`` so the sync's status dict stays about sources.
    Log-and-continue: the briefing must never be able to break the loop, and
    it has its own rule floor, so a failure here is already handled downstream.
    """
    from arete.coaching import get_or_create_briefing
    from arete.services.briefing import briefing_enabled, written_before_new_data
    from arete.services.coaching_repository import BriefingRepository

    if not briefing_enabled():
        return "disabled"
    # A briefing the dashboard asked for is rewritten only when this sync
    # brought data it was written without (today's health, a session, a plan
    # decision); the dashboard then says it was updated after the sync. One
    # this job already wrote (a cron that fires twice) is kept.
    existing = BriefingRepository().get_for_day(athlete_today())
    try:
        if existing is not None and (
            existing.trigger == "scheduler" or not written_before_new_data(existing)
        ):
            return existing.source
        briefing = get_or_create_briefing(trigger="scheduler", replacing=existing)
    except Exception as e:  # noqa: BLE001 - background job must not die
        logger.warning("Daily briefing failed: %s", e)
        return f"failed: {e}"
    if briefing is None:
        return "in progress"  # the dashboard's request is writing it
    logger.info("Daily briefing: %s", briefing.source)
    from arete.services.notifications import first_sentence, notify

    notify("Briefing du coach", first_sentence(briefing.text), "/", kind="briefing")
    return briefing.source


def write_weekly_review(today: date | None = None) -> str:
    """On Mondays, review the week that just ended. Never raises."""
    today = today or athlete_today()
    if today.weekday() != 0:
        return "not monday"
    try:
        from arete.coaching import generate_weekly_review
        from arete.services.notifications import first_sentence, notify

        review = generate_weekly_review()
        notify(
            "Bilan de la semaine",
            first_sentence(review.text),
            "/planning",
            kind="weekly_review",
        )
    except Exception as e:  # noqa: BLE001 - background job must not die
        logger.warning("Weekly review failed: %s", e)
        return f"failed: {e}"
    return f"{review.source}, {len(review.proposals)} proposals"


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
#: Markers are naive TIMESTAMPs written by ``current_timestamp`` in the
#: session's timezone; casting back to TIMESTAMPTZ recovers the instant, which
#: each athlete's own timezone turns into a calendar day.
_CANDIDATES = (
    "SELECT id, last_sync_at, sync_lease_until, "
    "epoch(last_sync_at::TIMESTAMPTZ), epoch(sync_lease_until::TIMESTAMPTZ), "
    "epoch(current_timestamp) "
    "FROM app.athletes WHERE deleted_at IS NULL "
    "ORDER BY last_sync_at NULLS FIRST, id LIMIT ?"
)


def owed_today(
    last_sync: float | None, lease: float | None, now: float, zone: str | None
) -> bool:
    """Owed today and not held by a run started today, on the athlete's clock.

    Epoch seconds in, so the database's and the server's timezones never
    matter. A lease dated before today belongs to a run that failed or was
    stopped: the next day's dispatch starts a new day (every step is
    idempotent per day), the same day never retries.
    """
    tz = zone_of(zone)
    today = datetime.fromtimestamp(now, tz).date()

    def before_today(epoch: float | None) -> bool:
        return epoch is None or datetime.fromtimestamp(epoch, tz).date() < today

    return before_today(last_sync) and before_today(lease)


def _athlete_owed(
    athlete_id: int, last_sync: float | None, lease: float | None, now: float
) -> bool:
    if last_sync is None and lease is None:
        return True  # never ran: owed on any clock
    # The settings projection is private: read the zone in the athlete's scope.
    with athlete_scope(athlete_id):
        zone = (get_user_settings() or {}).get("timezone")
    return owed_today(last_sync, lease, now, zone)


def run_scheduled_batch() -> dict:
    """Claim the athletes owed today, one at a time, within the function's time.

    Each athlete has a durable daily marker (``last_sync_at``) and a lease. A
    failed or interrupted run keeps its lease until the next day: it is never
    replayed the same day. Several cron windows a day may overlap; a dispatch
    skips an athlete another one claimed first.
    """
    started = monotonic()
    with db_connection() as con:
        candidates = con.execute(_CANDIDATES, [MAX_SCANNED_ATHLETES]).fetchall()
    if len(candidates) == MAX_SCANNED_ATHLETES:
        logger.warning("Dispatch read %d athletes, the scan bound", len(candidates))
    rows = [
        row[:3] for row in candidates if _athlete_owed(row[0], row[3], row[4], row[5])
    ]
    outcomes: dict[str, dict] = {}
    deferred = len(rows) > MAX_SCHEDULED_ATHLETES
    for athlete_id, last_sync, stale_lease in rows[:MAX_SCHEDULED_ATHLETES]:
        if monotonic() - started >= SCHEDULE_DISPATCH_SECONDS:
            deferred = True
            break
        if not _claim(athlete_id, last_sync, stale_lease):
            continue
        if stale_lease is not None:
            logger.warning(
                "Athlete %s: lease of a failed or stopped run (%s) reclaimed",
                athlete_id,
                stale_lease,
            )
        outcomes[str(athlete_id)] = _run_athlete(athlete_id, started)
    return {"athletes": outcomes, "deferred": deferred}


def _claim(athlete_id: int, last_sync: datetime | None, lease: datetime | None) -> bool:
    """Take the athlete's lease, unless another dispatch took it first.

    Compare-and-set on the markers this dispatch read as owed: a concurrent
    dispatch that claimed or finished the athlete has changed one of them.
    """
    try:
        with db_connection() as con:
            row = con.execute(
                "UPDATE app.athletes "
                "SET sync_lease_until=current_timestamp + ? * INTERVAL '1 second' "
                "WHERE id=? AND deleted_at IS NULL "
                "AND last_sync_at IS NOT DISTINCT FROM ? "
                "AND sync_lease_until IS NOT DISTINCT FROM ? RETURNING id",
                [SCHEDULE_LEASE_SECONDS, athlete_id, last_sync, lease],
            ).fetchone()
    except duckdb.TransactionException:
        logger.info("Athlete %s claimed by a concurrent dispatch", athlete_id)
        return False
    return row is not None


def _run_athlete(athlete_id: int, started: float) -> dict:
    with athlete_scope(athlete_id):
        from arete.dataio import mirror

        try:
            if config.is_remote_db:
                mirror.hydrate()
            status = daily_sync()
            for step, write in (
                ("briefing", write_daily_briefing),
                ("review", write_weekly_review),
            ):
                late = monotonic() - started >= SCHEDULE_MODEL_SECONDS
                status[step] = "deferred" if late else write()
            # Self-hosted status marker (``/sync/status``): server clock on purpose.
            record_run(datetime.now())
            if config.is_remote_db:
                mirror.flush()
            with db_connection() as con:
                con.execute(
                    "UPDATE app.athletes SET last_sync_at=current_timestamp,sync_lease_until=NULL WHERE id=?",
                    [athlete_id],
                )
        except Exception:
            logger.exception(
                "Scheduled work failed for athlete %s; lease kept until tomorrow",
                athlete_id,
            )
            return {"status": "failed; next attempt tomorrow"}
    return status


async def run_forever(hour: int, tick_seconds: int = TICK_SECONDS) -> None:
    from anyio import to_thread

    logger.info(
        "Automatic sync armed for %02d:00, dispatch every %ds", hour, tick_seconds
    )
    # This task intentionally lives as long as the server; each dispatch is bounded.
    while True:
        # ARETE_AUTO_SYNC_HOUR is the server's wall clock (the Docker host);
        # which athletes are owed is decided per athlete's day by the batch.
        if datetime.now().hour >= hour:
            try:
                await to_thread.run_sync(run_scheduled_batch)
            except Exception:
                logger.exception(
                    "Scheduled dispatch failed; next tick will check unclaimed work"
                )
        await asyncio.sleep(tick_seconds)


def start() -> asyncio.Task[None] | None:
    """Start the loop if ARETE_AUTO_SYNC_HOUR is set; returns the task."""
    hour = config.auto_sync_hour
    if hour is None:
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
            "UPDATE app.athletes SET sync_lease_until=NULL "
            "WHERE id=? AND sync_lease_until < current_timestamp RETURNING id",
            [athlete_id],
        ).fetchone()
    return row is not None
