"""Freshness is successful coverage, not the timestamp of the newest stored row."""

from datetime import date, timedelta
from time import monotonic
from unittest.mock import Mock

import pytest

from arete.dataio.db import db_connection
from arete.garmin.client import GarminClient
from arete.garmin.sync import GarminSyncClient
from arete.garmin.sync_budget import SyncBudget, SyncStopped
from arete.services import garmin_sync as service
from arete.services.athlete_scope import athlete_scope


@pytest.fixture(autouse=True)
def state():
    with db_connection() as con:
        con.execute("DELETE FROM app.garmin_sync_state")
    yield
    with db_connection() as con:
        con.execute("DELETE FROM app.garmin_sync_state")


@pytest.fixture
def provider(monkeypatch):
    monkeypatch.setattr("arete.garmin.token_store.session_status", lambda: (True, None))
    monkeypatch.setattr(service, "athlete_today", lambda: date(2026, 10, 13))
    monkeypatch.setattr(GarminSyncClient, "refresh_threshold", lambda self: {})
    monkeypatch.setattr(
        "arete.garmin.readiness.update_readiness_range", lambda *a: None
    )
    monkeypatch.setattr(
        "arete.garmin.health_sync.sync_day", lambda *a, **k: Mock(success=True)
    )
    monkeypatch.setattr(
        "arete.services.session_conditions.enrich_sessions", lambda *a, **k: {}
    )
    monkeypatch.setattr(service, "_sessions", lambda ids: [{"id": i} for i in ids])
    page = Mock(return_value=[])
    monkeypatch.setattr(GarminClient, "activity_page", page)
    return page


def activity(i, day="2026-10-12"):
    return {
        "activityId": i,
        "activityName": f"run {i}",
        "startTimeLocal": day + "T08:00:00",
        "duration": 600,
    }


def scripted_import(monkeypatch, *, fail=None):
    imported = set()
    monkeypatch.setattr(
        GarminSyncClient, "_is_already_synced", lambda self, sid: sid in imported
    )

    def work(self, *, activity_batch, sync_result, checkpoint, download_fit=True):
        for item in activity_batch:
            checkpoint()
            if item.activity_id in imported:
                sync_result.activities_skipped += 1
            elif item.activity_id == fail:
                sync_result.errors.append("failed activity")
            else:
                imported.add(item.activity_id)
                sync_result.session_ids.append(item.activity_id)
                sync_result.activities_synced += 1
        yield sync_result

    monkeypatch.setattr(GarminSyncClient, "iter_sync_activities", work)
    return imported


def test_empty_check_freshens_and_deduplicates(provider):
    result = service.ensure_fresh()
    assert result["complete"] and result["activities_checked_at"]
    assert service.ensure_fresh()["state"] == "fresh"
    assert provider.call_count == 1


def test_backlog_continues_and_exact_ids_are_returned(provider, monkeypatch):
    imported = scripted_import(monkeypatch)
    rows = [activity(i) for i in range(45, 0, -1)]
    provider.side_effect = lambda offset, limit: rows[offset : offset + limit]
    first = service.ensure_fresh()
    assert first["imported"] == 20 and not first["complete"]
    assert not first["activities_checked_at"]
    # Only the cap stopped it: the browser shows a catch-up, not a failure.
    assert first["more_pending"] and not first["errors"]
    second = service.ensure_fresh()
    assert second["imported"] == 20 and not second["complete"]
    third = service.ensure_fresh()
    assert third["complete"] and len(imported) == 45
    assert not third["more_pending"]
    assert third["sessions"] == [{"id": i} for i in range(5, 0, -1)]


def test_failed_older_activity_does_not_advance_coverage(provider, monkeypatch):
    scripted_import(monkeypatch, fail=2)
    provider.return_value = [activity(3), activity(2), activity(1)]
    result = service.ensure_fresh()
    assert result["session_ids"] == [3, 1]
    assert not result["activities_checked_at"]
    assert result.get("next_offset", 0) == 0


def test_shifted_anchor_restarts_scan_without_losing_lower_bound(provider, monkeypatch):
    scripted_import(monkeypatch)
    rows = [activity(i) for i in range(30, 0, -1)]
    provider.side_effect = lambda offset, limit: rows[offset : offset + limit]
    first = service.ensure_fresh()
    rows.insert(0, activity(31))
    second = service.ensure_fresh()
    assert not second["complete"] and second["next_offset"] == 0
    assert second["coverage_start"] == first["coverage_start"]


def test_claim_is_scoped_and_not_stolen_on_expiry():
    with db_connection() as con:
        # Respect the shared test database's sequence; a literal ID can collide
        # with a later account test under CI's loadfile worker ordering.
        second = con.execute(
            "INSERT INTO app.athletes (id) VALUES (nextval('app.athletes_seq')) RETURNING id"
        ).fetchone()[0]
    with service.claim(-1):
        assert service.status()["state"] == "needs_reconciliation"
        with pytest.raises(RuntimeError, match="déjà en cours"), service.claim():
            pytest.fail("overlapping owner")
        with athlete_scope(second), service.claim():
            assert service.status()["state"] == "running"
    assert service.status()["state"] == "interrupted"


def test_cancel_preserves_commits_and_releases_only_after_worker_exits():
    with pytest.raises(KeyboardInterrupt), service.claim() as (owner, state):
        state["session_ids"] = [42]
        service._store(owner, state)
        raise KeyboardInterrupt
    assert service.status()["session_ids"] == [42]
    assert service.status()["state"] == "interrupted"


def test_rate_limit_stops_and_persists_cooldown(provider, monkeypatch):
    from arete.garmin.sync_budget import SyncRateLimited

    def rate_limit(self, offset, limit):
        self.sync_budget.rate_limited = True
        self.sync_budget.stopped = "429"
        raise SyncRateLimited("429")

    monkeypatch.setattr(GarminClient, "activity_page", rate_limit)
    result = service.ensure_fresh()
    assert result["state"] == "cooldown"
    assert service.ensure_fresh()["state"] == "cooldown"


def test_http_transport_counts_refuses_replay_and_limits_timeout(monkeypatch):
    budget = SyncBudget(monotonic() + 60)
    client = GarminClient(sync_budget=budget)
    api = Mock()
    api.client._connectapi = "https://example.invalid"
    api.client.get_api_headers.return_value = {}
    api.client._api_session.request.return_value.status_code = 401
    client._api = api
    monkeypatch.setattr(client, "_record_refusal", lambda: None)
    with pytest.raises(SyncStopped):
        client._sync_request("GET", "/sessions")
    assert budget.calls == 1
    assert api.client._api_session.request.call_args.kwargs["timeout"] <= 15
    api.client._api_session.request.assert_called_once()
    with pytest.raises(SyncStopped):
        client._sync_request("GET", "/sessions")
    assert budget.calls == 1


def test_health_failure_preserves_values_and_not_fresh(provider, monkeypatch):
    monkeypatch.setattr(
        "arete.garmin.health_sync.sync_day",
        lambda *a, **k: Mock(success=False, error="sleep unavailable"),
    )
    result = service.ensure_fresh()
    assert result["activities_checked_at"] and result["health_checked_at"] is None
    assert not result["complete"]


def test_activity_only_refresh_preserves_recent_health_failure(provider, monkeypatch):
    import json

    assert service.ensure_fresh()["complete"]
    monkeypatch.setattr(
        "arete.garmin.health_sync.sync_day",
        lambda *a, **k: Mock(success=False, error="health failed"),
    )
    failed = service.ensure_fresh(force=True)
    assert not failed["complete"]
    state = service.status()
    state["activities_checked_at"] = (
        service._now() - timedelta(minutes=16)
    ).isoformat()
    with db_connection() as con:
        con.execute("UPDATE app.garmin_sync_state SET payload=?", [json.dumps(state)])
    result = service.ensure_fresh()
    assert result["state"] == "partial" and not result["health_complete"]
    assert result["health_checked_at"] == failed["health_checked_at"]


def test_old_sessions_are_in_seven_day_overlap(provider, monkeypatch):
    imported = scripted_import(monkeypatch)
    service.ensure_fresh()
    with db_connection() as con:
        state = service.status()
        state["activities_checked_at"] = (
            service._now() - timedelta(minutes=16)
        ).isoformat()
        import json

        con.execute("UPDATE app.garmin_sync_state SET payload=?", [json.dumps(state)])
    provider.return_value = [activity(7, "2026-10-07")]
    assert service.ensure_fresh()["complete"]
    assert imported == {7}


def test_expired_deadline_never_starts_provider_work(provider):
    result = service.ensure_fresh(deadline=monotonic() - 1)
    assert not result["complete"]
    provider.assert_not_called()


def test_signal_failure_does_not_erase_existing_measurement(monkeypatch):
    from arete.garmin.health_sync import sync_day

    day = date(2026, 10, 13)
    with db_connection() as con:
        con.execute(
            "INSERT INTO app.daily_metrics(user_id,date,sleep_duration_sec) VALUES (1,?,25000) ON CONFLICT(user_id,date) DO UPDATE SET sleep_duration_sec=25000",
            [day],
        )
    budget = SyncBudget(monotonic() + 60)
    client = Mock(sync_budget=budget)

    def failed_sleep(*args):
        budget.errors.append("timeout")
        raise TimeoutError("sleep")

    client.sleep.side_effect = failed_sleep
    client.hrv.return_value = {}
    client.stress.return_value = {}
    client.body_battery.return_value = []
    client.steps.return_value = []
    client.resting_hr.return_value = {}
    client.training_readiness.return_value = {}
    result = sync_day(day, client, performance=False)
    assert not result.success and "timeout" in result.error
    with db_connection() as con:
        assert (
            con.execute(
                "SELECT sleep_duration_sec FROM app.visible_daily_metrics WHERE date=?",
                [day],
            ).fetchone()[0]
            == 25000
        )


def test_abandoned_operation_requires_explicit_stopped_workers_and_matching_owner():
    import json

    state = {
        "coverage_start": "2026-09-01",
        "next_offset": 20,
        "anchor": 99,
        "session_ids": [42],
    }
    with db_connection() as con:
        con.execute(
            "INSERT INTO app.garmin_sync_state(athlete_id,owner,lease_until,payload) VALUES (1,'old',?,?)",
            [service._now() - timedelta(seconds=1), json.dumps(state)],
        )
    with pytest.raises(ValueError):
        service.reconcile_abandoned("old", workers_stopped=False)
    with pytest.raises(ValueError):
        service.reconcile_abandoned("wrong", workers_stopped=True)
    result = service.reconcile_abandoned("old", workers_stopped=True)
    assert result["coverage_start"] == "2026-09-01"
    assert result["session_ids"] == [42] and result["next_offset"] == 0
    with service.claim():
        assert service.status()["state"] == "running"


def test_daily_refresh_keeps_four_health_days_and_performance(provider, monkeypatch):
    calls = []

    def health(day, client, *, performance):
        calls.append((day, performance))
        return Mock(success=True)

    monkeypatch.setattr("arete.garmin.health_sync.sync_day", health)
    assert service.ensure_fresh(daily=True)["complete"]
    assert calls == [
        (date(2026, 10, 13), True),
        (date(2026, 10, 12), False),
        (date(2026, 10, 11), False),
        (date(2026, 10, 10), False),
    ]


def test_coaching_waits_for_refresh_and_background_missions_do_not_sync(monkeypatch):
    import asyncio

    from arete.agent.runtime.context import AgentContext
    from arete.agent.runtime.execution import refresh_personal_data

    calls = []

    def refresh(**kwargs):
        calls.append(kwargs)
        return {
            "state": "partial",
            "complete": False,
            "activities_checked_at": "2026-10-12",
        }

    monkeypatch.setattr(service, "ensure_fresh", refresh)
    context = AgentContext()
    context.deadline = monotonic() + 300
    context.page_section = "old page"
    asyncio.run(refresh_personal_data(context))
    assert (
        context.garmin_freshness["state"] == "partial" and context.page_section is None
    )
    assert context.stats.model_calls == 0
    asyncio.run(refresh_personal_data(context))
    for profile in ("briefing", "feedback", "review", "evening"):
        asyncio.run(refresh_personal_data(AgentContext(profile=profile)))
    assert len(calls) == 1
    assert calls[0]["deadline"] == context.deadline - 120


def test_undated_manual_import_resumes_the_same_capped_backlog(provider, monkeypatch):
    from arete.garmin.sync import SyncResult

    imported = scripted_import(monkeypatch)
    rows = [activity(i) for i in range(25, 0, -1)]
    provider.side_effect = lambda offset, limit: rows[offset : offset + limit]
    first = list(service.iter_manual(max_activities=50))[-1]
    # The capped batch succeeded; the rest is pending, not failed (ARE-177).
    assert isinstance(first, SyncResult) and first.success and first.more_pending
    assert len(first.session_ids) == 20 and not first.errors
    second = service.ensure_fresh()
    assert second["complete"] and len(imported) == 25


def test_capped_manual_import_with_a_failure_is_not_a_catch_up(provider, monkeypatch):
    from arete.garmin.sync import SyncResult

    scripted_import(monkeypatch, fail=25)
    rows = [activity(i) for i in range(25, 0, -1)]
    provider.side_effect = lambda offset, limit: rows[offset : offset + limit]
    result = list(service.iter_manual(max_activities=20))[-1]
    assert isinstance(result, SyncResult) and not result.success
    assert result.errors == ["failed activity"]


def test_token_refresh_counts_one_request_and_does_not_retry_429():
    from arete.garmin.sync_budget import SyncRateLimited

    client = GarminClient(sync_budget=SyncBudget(monotonic() + 60))
    api = Mock()
    api.client._di_token_url = "https://example.invalid/token"
    api.client._api_session.request.return_value.status_code = 429
    client._api = api
    with pytest.raises(SyncRateLimited):
        client._sync_refresh_token(api.client._di_token_url, data={})
    assert client.sync_budget.calls == 1 and client.sync_budget.rate_limited
    assert api.client._api_session.request.call_args.kwargs["timeout"] <= 15
    api.client._api_session.request.assert_called_once()


def test_overlapping_callers_share_one_operation(provider, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event

    entered, observed = Event(), Event()

    def page(*args):
        entered.set()
        assert observed.wait(5), "observer never joined the active operation"
        return []

    provider.side_effect = page

    def wait(_seconds):
        observed.set()
        # The real implementation polls every two seconds; a tiny bounded wait
        # lets the owner commit without making this behavior test slow.
        from time import sleep

        sleep(0.01)

    monkeypatch.setattr(service, "sleep", wait)
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(service.ensure_fresh)
        assert entered.wait(5)
        second = pool.submit(service.ensure_fresh, force=True)
        a, b = first.result(timeout=10), second.result(timeout=10)
    assert a["complete"] and b["complete"]
    assert a["started_at"] == b["started_at"]
    provider.assert_called_once()


def test_lazy_profile_lookup_has_no_hidden_sdk_retries():
    from garminconnect import Garmin

    client = GarminClient(sync_budget=SyncBudget(monotonic() + 60))
    api = Garmin(retry_attempts=0)
    client._api = api
    api.client._run_request = client._sync_request
    api._load_social_profile = client._sync_load_profile
    request = Mock()
    request.return_value.status_code = 503
    api.client._api_session.request = request
    api.client.get_api_headers = lambda: {}
    with pytest.raises(Exception, match="Could not load"):
        api._require_display_name()
    assert client.sync_budget.stopped
    assert client.sync_budget.calls == 1
    request.assert_called_once()


def test_state_metadata_retries_only_known_aborts_and_remains_bounded(monkeypatch):
    from unittest.mock import MagicMock

    import duckdb

    connection = MagicMock()
    execute = connection.return_value.__enter__.return_value.execute
    monkeypatch.setattr(service, "db_connection", connection)
    monkeypatch.setattr(service, "sleep", lambda _: None)
    execute.side_effect = duckdb.TransactionException("aborted")
    with pytest.raises(duckdb.TransactionException):
        service._store("owner", {})
    assert execute.call_count == service.MAX_STATE_WRITE_ATTEMPTS
    execute.reset_mock()
    execute.side_effect = ConnectionError("unknown commit outcome")
    with pytest.raises(ConnectionError):
        service._store("owner", {})
    execute.assert_called_once()


def test_explicit_history_observes_active_sync_without_claiming_its_coverage(
    monkeypatch,
):
    def busy(_options):
        raise service.SyncBusy("active")
        yield  # The owned importer is a generator.

    monkeypatch.setattr(service, "_iter_owned_manual", busy)
    observed = Mock(return_value={"complete": True, "imported": 1, "session_ids": [42]})
    monkeypatch.setattr(service, "ensure_fresh", observed)
    result = list(service.iter_manual(history_offset=0, max_activities=20))[-1]
    assert not result.success and result.session_ids == [42]
    assert "autre synchronisation" in result.errors[0]
    observed.assert_called_once()


def progressing_import(monkeypatch):
    """The importer's own event sequence, around scripted commits."""
    from arete.garmin.sync import SyncProgress

    imported = set()
    monkeypatch.setattr(
        GarminSyncClient, "_is_already_synced", lambda self, sid: sid in imported
    )

    def work(self, *, activity_batch, sync_result, checkpoint, download_fit=True):
        yield SyncProgress("preparing")
        yield SyncProgress("fetching")
        yield SyncProgress("processing", total=len(activity_batch))
        for index, item in enumerate(activity_batch):
            checkpoint()
            if item.activity_id in imported:
                sync_result.activities_skipped += 1
            else:
                imported.add(item.activity_id)
                sync_result.session_ids.append(item.activity_id)
                sync_result.activities_synced += 1
            yield SyncProgress("processing", index + 1, len(activity_batch))
        yield sync_result

    monkeypatch.setattr(GarminSyncClient, "iter_sync_activities", work)
    return imported


def test_undated_manual_import_streams_the_refresh_progress(provider, monkeypatch):
    from arete.garmin.sync import SyncResult

    progressing_import(monkeypatch)
    provider.return_value = [activity(2), activity(1)]
    events = list(service.iter_manual(max_activities=20, download_fit=False))
    # Onboarding stayed at "preparing" (0 %) while the whole refresh ran (ARE-149).
    assert [(e.stage, e.completed, e.total) for e in events[:-1]] == [
        ("preparing", 0, None),
        ("fetching", 0, None),
        ("processing", 0, 2),
        ("processing", 1, 2),
        ("processing", 2, 2),
        ("finalizing", 0, None),  # health
        ("finalizing", 0, None),  # enrichment
    ]
    result = events[-1]
    assert isinstance(result, SyncResult) and result.success
    assert result.activities_synced == 2 and result.session_ids == [2, 1]


def test_closing_the_manual_stream_keeps_commits_for_the_next_refresh(
    provider, monkeypatch
):
    imported = progressing_import(monkeypatch)
    provider.return_value = [activity(2), activity(1)]
    work = service.iter_manual(max_activities=20)
    for event in work:
        if event.stage == "processing" and event.completed == 1:
            assert service.status()["state"] == "running"
            break
    work.close()
    state = service.status()
    assert state["state"] == "interrupted" and "operation_id" not in state
    assert state["session_ids"] == [2] and not state["activities_checked_at"]
    resumed = service.ensure_fresh()
    assert resumed["complete"] and resumed["already_present"] == 1
    assert imported == {2, 1} and resumed["session_ids"] == [1]
