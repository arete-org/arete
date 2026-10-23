"""One durable owner for Garmin imports, freshness and bounded continuation.

A lost worker's lease is never automatically stolen: expiry is evidence of an
unknown outcome, not evidence that its synchronous writes have stopped.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Generator
from contextlib import closing, contextmanager
from datetime import UTC, date, datetime, timedelta
from time import monotonic, sleep
from typing import TYPE_CHECKING, Any
from uuid import uuid4

import duckdb

from arete.dataio.db import db_connection, transaction
from arete.observability.steps import step_done
from arete.services.athlete_scope import current_athlete_id
from arete.services.settings import athlete_today

if TYPE_CHECKING:
    from arete.garmin.sync import SyncProgress

logger = logging.getLogger(__name__)
MAX_ACTIVITIES = 20
MAX_PAGES = 6
PAGE_SIZE = 20
MAX_SECONDS = 180.0
ACTIVITY_TTL = 15 * 60
HEALTH_TTL = 60 * 60
COOLDOWN_SECONDS = 15 * 60
MAX_WAIT_POLLS = 90
MAX_STATE_WRITE_ATTEMPTS = 3


class SyncBusy(RuntimeError):
    """Another worker owns this athlete; observe it without replaying it."""


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def status() -> dict[str, Any]:
    with db_connection() as con:
        row = con.execute(
            "SELECT owner, lease_until, payload FROM app.visible_garmin_sync_state WHERE athlete_id=?",
            [current_athlete_id()],
        ).fetchone()
    state = json.loads(row[2]) if row else {}
    state.setdefault("state", "never")
    state.setdefault("activities_checked_at", None)
    state.setdefault("health_checked_at", None)
    if row and row[0]:
        state["state"] = "running" if row[1] > _now() else "needs_reconciliation"
        state["operation_id"] = row[0]
    return state


def _store(owner: str, state: dict, *, release: bool = False) -> None:
    # DuckDB may abort an UPDATE/RETURNING at commit while another connection
    # holds an older snapshot of this primary key. Only TransactionException
    # proves rollback: retry this owner-guarded metadata assignment, never an
    # import, a provider request, or a write with an ambiguous outcome.
    for attempt in range(MAX_STATE_WRITE_ATTEMPTS):
        try:
            with db_connection() as con:
                row = con.execute(
                    "UPDATE app.garmin_sync_state SET payload=?, revision=revision+1, "
                    "owner=CASE WHEN ? THEN NULL ELSE owner END WHERE athlete_id=? AND owner=? RETURNING athlete_id",
                    [
                        json.dumps(state, default=str),
                        release,
                        current_athlete_id(),
                        owner,
                    ],
                ).fetchone()
            if row is None:
                raise RuntimeError("Garmin sync ownership lost")
            return
        except duckdb.TransactionException:
            if attempt + 1 == MAX_STATE_WRITE_ATTEMPTS:
                raise
            sleep(0.01)
    raise AssertionError("Unreachable state-write loop")


@contextmanager
def claim(seconds: float = MAX_SECONDS):
    """CAS acquisition; generator closure releases only after the worker unwinds."""
    owner = str(uuid4())
    now = _now()
    try:
        with transaction() as con:
            con.execute(
                "INSERT INTO app.garmin_sync_state (athlete_id) VALUES (?) ON CONFLICT DO NOTHING",
                [current_athlete_id()],
            )
            previous = con.execute(
                "SELECT payload FROM app.visible_garmin_sync_state WHERE athlete_id=?",
                [current_athlete_id()],
            ).fetchone()
            assert previous is not None
            cooldown = json.loads(previous[0]).get("cooldown_until")
            if cooldown and datetime.fromisoformat(cooldown) > now:
                raise SyncBusy("Garmin est en pause après une limitation de requêtes.")
            row = con.execute(
                "UPDATE app.garmin_sync_state SET owner=?, lease_until=?, revision=revision+1 "
                "WHERE athlete_id=? AND owner IS NULL RETURNING payload",
                [owner, now + timedelta(seconds=seconds), current_athlete_id()],
            ).fetchone()
    except duckdb.TransactionException:
        row = None
    if row is None:
        raise SyncBusy(
            "Une synchronisation Garmin est déjà en cours ou doit être réconciliée."
        )
    state = json.loads(row[0])
    state.setdefault("activities_checked_at", None)
    state.setdefault("health_checked_at", None)
    state.update(
        state="running",
        started_at=now.isoformat(),
        errors=[],
        session_ids=[],
        more_pending=False,
    )
    _store(owner, state)
    try:
        yield owner, state
    except BaseException:
        state.update(state="interrupted", complete=False)
        raise
    finally:
        if state["state"] == "running":
            state.update(state="interrupted", complete=False)
        _store(owner, state, release=True)


def _fresh(state: dict, key: str, ttl: int) -> bool:
    value = state.get(key)
    return bool(
        value and 0 <= (_now() - datetime.fromisoformat(value)).total_seconds() < ttl
    )


def _sessions(ids: list[int]) -> list[dict]:
    from arete.services.analytics import get_session

    # Exact IDs also work for older imports, unlike filtering the latest page.
    return [session for sid in ids if (session := get_session(sid)) is not None]


def ensure_fresh(
    *,
    deadline: float | None = None,
    force: bool = False,
    daily: bool = False,
    max_activities: int = MAX_ACTIVITIES,
    download_fit: bool = True,
) -> dict:
    with closing(
        _iter_fresh(
            deadline=deadline,
            force=force,
            daily=daily,
            max_activities=max_activities,
            download_fit=download_fit,
        )
    ) as work:
        while True:
            try:
                next(work)
            except StopIteration as done:
                result: dict = done.value
                return result


def _iter_fresh(
    *,
    deadline: float | None = None,
    force: bool = False,
    daily: bool = False,
    max_activities: int = MAX_ACTIVITIES,
    download_fit: bool = True,
    sessions: bool = True,
    read_health: bool = True,
) -> Generator[SyncProgress, None, dict]:
    """The bounded refresh, yielding its progress; returns ``ensure_fresh``'s result.

    ``sessions=False`` skips reading back the imported sessions for a caller
    that only reports counts. ``read_health=False`` leaves health to the next
    on-use refresh: an activity import does not wait for seven reads a day.
    """
    from arete.garmin import token_store

    if not 1 <= max_activities <= MAX_ACTIVITIES:
        raise ValueError("Interactive refresh imports between 1 and 20 activities")
    if not token_store.session_status()[0]:
        return {"state": "disconnected", "complete": False, "sessions": []}
    stop = min(
        deadline if deadline is not None else float("inf"), monotonic() + MAX_SECONDS
    )
    observed_owner = False
    for _ in range(MAX_WAIT_POLLS):
        state = status()
        if state["state"] == "running":
            observed_owner = True
            if monotonic() + 2 >= stop:
                return state
            sleep(2)
            continue
        if observed_owner or state["state"] == "needs_reconciliation":
            # Even explicit refreshes share the result of the run they observed.
            ids = state.get("session_ids", []) if sessions else []
            return {**state, "sessions": _sessions(ids)}
        if (
            state.get("cooldown_until")
            and datetime.fromisoformat(state["cooldown_until"]) > _now()
        ):
            return {**state, "state": "cooldown"}
        activities = force or not _fresh(state, "activities_checked_at", ACTIVITY_TTL)
        health = read_health and (
            force or not _fresh(state, "health_checked_at", HEALTH_TTL)
        )
        if not activities and not health:
            return {**state, "state": "fresh" if state.get("complete") else "partial"}
        try:
            with claim(max(0, stop - monotonic())) as (owner, state):
                activities = force or not _fresh(
                    state, "activities_checked_at", ACTIVITY_TTL
                )
                health = read_health and (
                    force or not _fresh(state, "health_checked_at", HEALTH_TTL)
                )
                return (
                    yield from _iter_refresh(
                        owner,
                        state,
                        stop,
                        activities=activities,
                        health=health,
                        daily=daily,
                        max_activities=max_activities,
                        download_fit=download_fit,
                        sessions=sessions,
                    )
                )
        except SyncBusy:
            observed_owner = True
    return status()


def _iter_refresh(
    owner: str,
    state: dict,
    stop: float,
    *,
    activities: bool,
    health: bool,
    daily: bool = False,
    max_activities: int = MAX_ACTIVITIES,
    download_fit: bool = True,
    sessions: bool = True,
) -> Generator[SyncProgress, None, dict]:
    """Yields only between steps: closing it stops before the next one."""
    from arete.garmin.client import GarminClient
    from arete.garmin.health_sync import sync_day
    from arete.garmin.readiness import update_readiness_range
    from arete.garmin.sync import (
        GarminActivity,
        GarminSyncClient,
        SyncProgress,
        SyncResult,
    )
    from arete.garmin.sync_budget import SyncBudget
    from arete.services.session_conditions import enrich_sessions

    started = monotonic()
    budget = SyncBudget(stop)
    client = GarminClient(sync_budget=budget)
    importer = GarminSyncClient(client=client)
    result = SyncResult(success=False)
    today = athlete_today()
    state.update(complete=False, imported=0, already_present=0, stage="preparing")

    def checkpoint():
        budget.check()
        # Persist before starting another write; never release a live worker's claim.
        state.update(
            session_ids=list(result.session_ids),
            imported=result.activities_synced,
            already_present=result.activities_skipped,
        )
        _store(owner, state)

    failure_category = None
    try:
        if activities:
            state["stage"] = "activities"
            lower = (
                date.fromisoformat(state["coverage_start"])
                if state.get("coverage_start")
                else (
                    today
                    - timedelta(days=7 if state.get("activities_checked_at") else 30)
                )
            )
            state["coverage_start"] = lower.isoformat()
            offset = state.get("next_offset", 0)
            anchor = state.get("anchor")
            # Garmin retests the threshold rarely: two paced reads once a day,
            # retried on the next refresh only when the transport failed.
            if state.get("threshold_checked_on") != today.isoformat():
                transport_errors = len(budget.errors)
                importer.refresh_threshold()
                if not budget.stopped and len(budget.errors) == transport_errors:
                    state["threshold_checked_on"] = today.isoformat()
            # ``more_pending`` (reset by claim) marks a stop at the activity cap:
            # the next refresh continues from the retained coverage.
            for _ in range(MAX_PAGES):
                yield SyncProgress("fetching")
                checkpoint()
                overlap = int(offset > 0)
                raw = client.activity_page(offset - overlap, PAGE_SIZE + overlap)
                if overlap and (not raw or raw[0].get("activityId") != anchor):
                    state.update(next_offset=0, anchor=None)
                    raise ValueError(
                        "Historique Garmin modifié ; couverture conservée, nouvelle lecture requise."
                    )
                raw = raw[overlap:]
                parsed = [GarminActivity.from_api_response(item) for item in raw]
                if any(not a.start_time_known for a in parsed):
                    raise ValueError("Date Garmin manquante ; couverture non vérifiée.")
                reached_end = len(raw) < PAGE_SIZE or any(
                    a.start_time.date() < lower for a in parsed
                )
                relevant = [a for a in parsed if lower <= a.start_time.date() <= today]
                remaining = max_activities - len(result.session_ids)
                batch = []
                importer.presence.clear()
                # One query for the page rather than one per activity.
                known = importer.already_synced([a.activity_id for a in relevant])
                for activity in relevant:
                    present = str(activity.activity_id) in known
                    if not present:
                        if remaining == 0:
                            reached_end = False
                            state["more_pending"] = True
                            break
                        remaining -= 1
                    # Proven under this lease: the import does not query it again.
                    importer.presence[activity.activity_id] = present
                    batch.append(activity)
                before_errors = len(result.errors)
                with closing(
                    importer.iter_sync_activities(
                        activity_batch=batch,
                        sync_result=result,
                        checkpoint=checkpoint,
                        download_fit=download_fit,
                    )
                ) as work:
                    for event in work:
                        if isinstance(event, SyncResult):
                            break
                        state["stage"] = event.stage
                        # Page-level stages are reported above, once per page.
                        if event.stage in ("processing", "fit", "saving"):
                            yield event
                if len(result.errors) > before_errors:
                    # Re-read this page next time; committed IDs deduplicate, failed IDs remain reachable.
                    break
                if len(batch) < len(relevant):
                    break
                offset += len(raw)
                anchor = parsed[-1].activity_id if parsed else anchor
                state.update(next_offset=offset, anchor=anchor)
                if reached_end:
                    state.update(
                        activities_checked_at=_now().isoformat(),
                        coverage_start=None,
                        next_offset=0,
                        anchor=None,
                    )
                    break
                if len(result.session_ids) >= max_activities:
                    state["more_pending"] = True
                    break
            else:
                result.errors.append(
                    "Limite de pages atteinte ; couverture incomplète."
                )
        step_done("garmin_activities")
        if health:
            yield SyncProgress("finalizing")
            state["stage"] = "health"
            state["health_complete"] = False
            failures = []
            previous = state.get("health_days") or {}
            yesterday = (today - timedelta(days=1)).isoformat()
            # The scheduled catch-up retains its four-day health window and
            # slow-moving Garmin metrics. Interactive refresh reads today, and
            # yesterday only until one read of it returned measurements (an
            # empty read just after midnight is still missing): seven paced
            # requests an hour, and the daily catch-up completes late values.
            reread = previous.get(yesterday, {}).get("state") != "available"
            if daily:
                days = [today - timedelta(days=offset) for offset in range(4)]
            else:
                days = [today, today - timedelta(days=1)] if reread else [today]
            # Yesterday's kept outcome stops the next refresh from rereading it.
            state["health_days"] = (
                {} if daily or reread else {yesterday: previous[yesterday]}
            )
            health_start = days[-1]
            for day in days:
                checkpoint()
                item = sync_day(day, client, performance=daily and day == today)
                fields = getattr(item, "fields_synced", 0)
                fields = fields if isinstance(fields, int) else 0
                state["health_days"][day.isoformat()] = {
                    "state": "failed"
                    if not item.success
                    else "available"
                    if fields
                    else "unavailable",
                    "fields_synced": fields,
                    "error": item.error if not item.success else None,
                }
                if not item.success:
                    failures.append(item.error or "Santé Garmin incomplète.")
            update_readiness_range(health_start, today)
            if failures:
                result.errors.extend(failures)
            else:
                state["health_checked_at"] = _now().isoformat()
                state["health_complete"] = True
            step_done("garmin_health")
        yield SyncProgress("finalizing")
        checkpoint()
        state["stage"] = "enrichment"
        conditions = enrich_sessions(
            result.session_ids,
            budget_sec=max(0, min(20, stop - monotonic())),
            deadline=stop,
        )
        state["conditions"] = conditions
        step_done("conditions")
        if conditions.get("incomplete"):
            result.errors.append("Enrichissement incomplet faute de temps.")
    except Exception as exc:
        failure_category = type(exc).__name__
        logger.warning("Garmin refresh stopped: %s", failure_category)
        result.errors.append(str(exc))
    except BaseException:
        state.update(
            session_ids=list(result.session_ids),
            imported=result.activities_synced,
            already_present=result.activities_skipped,
            complete=False,
        )
        raise
    result.errors.extend(budget.errors)
    # A later activity-only refresh must not erase a failed health check merely
    # because the preceding successful check is still inside its 60-minute TTL.
    complete = (
        not result.errors
        and not state.get("coverage_start")
        and state.get("health_complete", True)
    )
    state.update(
        state="complete" if complete else "partial",
        complete=complete,
        session_ids=result.session_ids,
        imported=result.activities_synced,
        merged_into_strava=result.activities_merged,
        matched_to_plan=result.activities_matched,
        already_present=result.activities_skipped,
        errors=result.errors,
        provider_calls=budget.calls,
        failure_category=failure_category or ("partial" if not complete else None),
        elapsed_ms=round((monotonic() - started) * 1000),
    )
    if budget.rate_limited:
        state.update(
            state="cooldown",
            cooldown_until=(_now() + timedelta(seconds=COOLDOWN_SECONDS)).isoformat(),
        )
    _store(owner, state)
    logger.info(
        "Garmin sync: state=%s calls=%d imported=%d skipped=%d elapsed_ms=%d coverage_complete=%s failure=%s",
        state["state"],
        budget.calls,
        result.activities_synced,
        result.activities_skipped,
        state["elapsed_ms"],
        not bool(state.get("coverage_start")),
        state["failure_category"],
    )
    return {**state, "sessions": _sessions(result.session_ids if sessions else [])}


def sync_recent(deadline: float | None = None) -> dict:
    result = ensure_fresh(deadline=deadline, force=True)
    if result.get("state") == "disconnected":
        raise PermissionError("Garmin n’est pas connecté : Réglages → Connexions.")
    if not result.get("complete"):
        result["error"] = (
            "; ".join(result.get("errors", []))
            or "Synchronisation incomplète ; consulte l’état des données."
        )
    return result


def iter_manual(**options):
    """Manual/history requests share durable ownership, retaining their SSE contract."""
    from arete.garmin.sync import SyncProgress, SyncResult

    if all(
        options.get(key) is None for key in ("start_date", "end_date", "history_offset")
    ):
        yield SyncProgress("preparing")
        # Stream the refresh's own progress: a blocking call left the browser
        # at "preparing" (0 %) for the whole import (ARE-149).
        refreshed = yield from _iter_fresh(
            force=True,
            max_activities=min(
                options.get("max_activities") or MAX_ACTIVITIES, MAX_ACTIVITIES
            ),
            download_fit=options.get("download_fit", True),
            sessions=False,
            # Health is not this import's subject; the next on-use refresh reads it.
            read_health=False,
        )
        errors = list(refreshed.get("errors", []))
        # The cap is not a failure: the batch was imported and the next refresh
        # continues from the retained coverage (ARE-177). An earlier health
        # failure, which this import did not retry, is not one either.
        more_pending = bool(refreshed.get("more_pending"))
        imported = (
            not errors
            and refreshed.get("state") in ("complete", "partial")
            and (more_pending or not refreshed.get("coverage_start"))
        )
        if not imported and not errors:
            errors.append(
                "Couverture Garmin incomplète ; les séances importées sont conservées."
            )
        yield SyncResult(
            success=imported,
            more_pending=more_pending,
            activities_synced=refreshed.get("imported", 0),
            activities_merged=refreshed.get("merged_into_strava", 0),
            activities_matched=refreshed.get("matched_to_plan", 0),
            activities_skipped=refreshed.get("already_present", 0),
            session_ids=refreshed.get("session_ids", []),
            errors=errors,
        )
        return

    try:
        yield from _iter_owned_manual(options)
    except SyncBusy:
        yield SyncProgress("preparing")
        observed = ensure_fresh()
        # This caller observed another operation, not its requested history
        # range. Return committed IDs without claiming that range was covered.
        yield SyncResult(
            success=False,
            activities_synced=observed.get("imported", 0),
            session_ids=observed.get("session_ids", []),
            errors=[
                "Une autre synchronisation a été observée ; relance cet import explicite pour vérifier sa couverture."
            ],
        )


def _iter_owned_manual(options):
    from arete.garmin.client import GarminClient
    from arete.garmin.sync import GarminSyncClient, SyncResult
    from arete.garmin.sync_budget import SyncBudget
    from arete.services.session_conditions import enrich_sessions

    with claim() as (owner, state):
        budget = SyncBudget(monotonic() + MAX_SECONDS)
        client = GarminSyncClient(client=GarminClient(sync_budget=budget))
        result = SyncResult(success=False)
        try:
            with closing(
                client.iter_sync_activities(
                    **options, checkpoint=budget.check, sync_result=result
                )
            ) as work:
                for event in work:
                    state.update(
                        session_ids=list(result.session_ids),
                        imported=result.activities_synced,
                    )
                    if isinstance(event, SyncResult):
                        state.update(
                            state="complete" if event.success else "partial",
                            complete=event.success,
                            session_ids=event.session_ids,
                            errors=event.errors,
                        )
                        enrich_sessions(
                            event.session_ids,
                            budget_sec=max(0, min(20, budget.deadline - monotonic())),
                            deadline=budget.deadline,
                        )
                    else:
                        state["stage"] = event.stage
                    if budget.rate_limited:
                        state["cooldown_until"] = (
                            _now() + timedelta(seconds=COOLDOWN_SECONDS)
                        ).isoformat()
                    _store(owner, state)
                    yield event
        finally:
            if result.session_ids:
                state.update(
                    session_ids=list(result.session_ids),
                    imported=result.activities_synced,
                )


def reconcile_abandoned(operation_id: str, *, workers_stopped: bool) -> dict:
    """Operator recovery after stopping old workers, never an automatic lease steal.

    A deadline cannot prove that a Python thread or a DB commit has stopped.
    Require the operator's explicit evidence and keep coverage incomplete so the
    next run re-reads the page and deduplicates every already committed Garmin ID.
    """
    if not workers_stopped:
        raise ValueError("Arrête les anciens workers avant de réconcilier leur import.")
    with transaction() as con:
        row = con.execute(
            "SELECT lease_until,payload FROM app.visible_garmin_sync_state WHERE athlete_id=? AND owner=?",
            [current_athlete_id(), operation_id],
        ).fetchone()
        if row is None or row[0] > _now():
            raise ValueError("Opération introuvable ou encore dans son délai normal.")
        state: dict = json.loads(row[1])
        state.update(
            state="reconciled",
            complete=False,
            next_offset=0,
            anchor=None,
            errors=["Import interrompu réconcilié ; couverture à revérifier."],
        )
        con.execute(
            "UPDATE app.garmin_sync_state SET owner=NULL,revision=revision+1,payload=? WHERE athlete_id=? AND owner=? RETURNING athlete_id",
            [json.dumps(state), current_athlete_id(), operation_id],
        )
    return state
