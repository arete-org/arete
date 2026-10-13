"""Exercise real shared storage with two unrelated authenticated athletes."""

from concurrent.futures import ThreadPoolExecutor
from datetime import date

import pytest

from arete.config import config
from arete.dataio.db import connect
from arete.dataio.init_duckdb import main as init_schema
from arete.garmin.models import PlannedSession, SessionType
from arete.garmin.repository import GarminRepository
from arete.services.athlete_scope import athlete_scope, current_athlete_id
from arete.services.users import upsert_user


@pytest.fixture
def athletes(tmp_path, monkeypatch):
    monkeypatch.setenv("ARETE_DB", str(tmp_path / "tenants.duckdb"))
    monkeypatch.setenv("ARETE_DATA_DIR", str(tmp_path / "files"))
    monkeypatch.setenv("ARETE_OWNER_EMAIL", "first@example.com")
    monkeypatch.delenv("ARETE_AUTH", raising=False)
    init_schema()
    first = upsert_user("first", "first@example.com", "First", verified=True)
    second = upsert_user("second", "second@example.com", "Second", verified=True)
    assert first.athlete_id == 1
    assert second.athlete_id != first.athlete_id
    return first, second


def planned(label):
    return PlannedSession(
        date=date(2026, 10, 10),
        sport="running",
        session_type=SessionType.ENDURANCE,
        description=label,
    )


def test_two_accounts_cannot_read_update_or_delete_each_others_sessions(athletes):
    first, second = athletes
    repo = GarminRepository()
    with athlete_scope(first.athlete_id):
        first_id = repo.create_planned_session(planned("private first"))
    with athlete_scope(second.athlete_id):
        second_id = repo.create_planned_session(planned("private second"))
        assert repo.get_planned_session(first_id) is None
        assert not repo.update_planned_session_fields(first_id, description="stolen")
        assert not repo.delete_planned_session(first_id)
        assert repo.get_planned_session(second_id).description == "private second"
    with athlete_scope(first.athlete_id):
        assert repo.get_planned_session(second_id) is None
        assert repo.get_planned_session(first_id).description == "private first"
        assert repo.delete_planned_session(first_id)
        assert repo.get_planned_session(first_id) is None
        con = connect()
        assert (
            con.execute(
                "SELECT description,deleted_at FROM app.planned_sessions WHERE id=?",
                [first_id],
            ).fetchone()[1]
            is not None
        )
        con.close()


def test_settings_and_files_follow_scope_and_reset(athletes):
    from arete.services.settings import get_settings

    first, second = athletes
    with athlete_scope(first.athlete_id):
        first_root = config.data_dir
        assert get_settings().display_name == "HUNTER"
    with athlete_scope(second.athlete_id):
        assert config.data_dir != first_root
        assert get_settings().display_name == "Second"
    assert current_athlete_id() == 1


def test_connection_identity_is_not_shared_between_workers(athletes):
    from arete.dataio.settings import get_user_settings

    first, second = athletes

    def read(athlete_id):
        with athlete_scope(athlete_id):
            return get_user_settings()["display_name"]

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(read, [first.athlete_id, second.athlete_id] * 10))
    assert results == ["HUNTER", "Second"] * 10


def test_unverified_owner_email_never_grants_legacy_data(athletes):
    user = upsert_user("impersonator", "first@example.com", verified=False)
    assert user.athlete_id != 1
    assert user.email == "first@example.com"
    assert user.email_verified_at is None


def test_authenticated_database_without_scope_is_closed(athletes, monkeypatch):
    monkeypatch.setenv("ARETE_AUTH", "clerk")
    with pytest.raises(RuntimeError, match="requires an athlete scope"):
        current_athlete_id()
    con = connect()
    assert con.execute("SELECT * FROM app.visible_user_settings").fetchall() == []
    with pytest.raises(Exception, match="NOT NULL"):
        con.execute(
            "INSERT INTO app.goals(name,race_date) VALUES('foreign','2026-12-01')"
        )
    con.close()


def test_documents_with_identical_thread_ids_are_private(athletes):
    from hashlib import sha256
    from uuid import uuid4

    from arete.services import documents

    first, second = athletes
    thread = str(uuid4())
    raw = b"private first document"
    with athlete_scope(first.athlete_id):
        doc = documents.begin_upload(
            thread, "private.txt", len(raw), sha256(raw).hexdigest()
        )
        documents.put_chunk(thread, doc["id"], 0, raw)
    with athlete_scope(second.athlete_id):
        assert documents.list_documents(thread) == []
        with pytest.raises(documents.DocumentError):
            documents.original(thread, doc["id"])
        with pytest.raises(documents.DocumentError):
            documents.put_chunk(thread, doc["id"], 0, raw)
        documents.delete_documents(thread, doc["id"])
        other = documents.begin_upload(
            thread, "private.txt", len(raw), sha256(raw).hexdigest()
        )
        assert other["id"] != doc["id"]
    with athlete_scope(first.athlete_id):
        assert documents.original(thread, doc["id"])[1] == raw


def test_strength_children_and_links_require_the_same_athlete(athletes):
    from arete.dataio.ownership import OwnershipError
    from arete.strength.models import (
        Exercise,
        ExerciseSet,
        SessionExercise,
        StrengthSession,
    )
    from arete.strength.repository import StrengthRepository

    first, second = athletes
    repo = StrengthRepository()
    with athlete_scope(first.athlete_id):
        exercise = repo.create_exercise(Exercise(name="private exercise"))
        session = repo.create_session(
            StrengthSession(
                exercises=[
                    SessionExercise(exercise_id=exercise, sets=[ExerciseSet(reps=10)])
                ]
            )
        )
    with athlete_scope(second.athlete_id):
        assert repo.get_session(session) is None
        assert repo.get_exercise(exercise) is None
        with pytest.raises(OwnershipError):
            repo.create_session(
                StrengthSession(exercises=[SessionExercise(exercise_id=exercise)])
            )
        assert repo.list_sessions() == []
    with athlete_scope(first.athlete_id):
        assert repo.delete_session(session)
        con = connect()
        assert con.execute("SELECT count(*) FROM app.exercise_sets").fetchone() == (1,)
        assert con.execute(
            "SELECT count(*) FROM app.visible_exercise_sets"
        ).fetchone() == (0,)
        con.close()


def test_game_and_notifications_are_per_athlete(athletes):
    from arete.services import gamification, notifications

    first, second = athletes
    with athlete_scope(first.athlete_id):
        gamification.set_preference(gamification.Preference(enabled=True, version=0))
        notifications.subscribe("https://push.example/first", "first-key", "first-auth")
    with athlete_scope(second.athlete_id):
        assert gamification.preference()["opted_in"] is False
        assert notifications._subscriptions() == []
        notifications.unsubscribe("https://push.example/first")
        notifications.subscribe(
            "https://push.example/second", "second-key", "second-auth"
        )
    with athlete_scope(first.athlete_id):
        assert gamification.preference()["opted_in"] is True
        assert [row[0] for row in notifications._subscriptions()] == [
            "https://push.example/first"
        ]


def test_account_deletion_retains_email_and_hides_private_data(athletes):
    from arete.services.users import athlete_is_active, deactivate_athlete, get_user

    first, second = athletes
    repo = GarminRepository()
    with athlete_scope(second.athlete_id):
        identifier = repo.create_planned_session(planned("deleted athlete"))
        deactivate_athlete(second.athlete_id, actor=first)
        assert repo.get_planned_session(identifier) is None
        assert not repo.update_planned_session_fields(
            identifier, description="resurrected"
        )
    stored = get_user(second.clerk_user_id)
    assert stored.email == second.email
    assert stored.deleted_at is not None
    assert not athlete_is_active(second.athlete_id)
    assert athlete_is_active(first.athlete_id)


def test_cached_coaches_never_share_memory_roots(athletes, monkeypatch):
    from arete import coaching
    from arete.services.memory import memory_root

    first, second = athletes
    coaching.get_agent.cache_clear()
    monkeypatch.setattr(coaching, "_assemble", lambda _profile, **kw: memory_root())
    try:
        with athlete_scope(first.athlete_id):
            first_graph = coaching.get_agent()
        with athlete_scope(second.athlete_id):
            second_graph = coaching.get_agent()
            assert second_graph != first_graph
        with athlete_scope(first.athlete_id):
            assert coaching.get_agent() == first_graph
    finally:
        coaching.get_agent.cache_clear()


def test_scheduler_dispatches_both_athletes_once_without_replaying(
    athletes, monkeypatch
):
    from arete import scheduler

    seen = []
    monkeypatch.setattr(
        scheduler,
        "daily_sync",
        lambda: seen.append(current_athlete_id()) or {"sync": "ok"},
    )
    monkeypatch.setattr(scheduler, "write_daily_briefing", lambda **_: "rules")
    monkeypatch.setattr(scheduler, "write_weekly_review", lambda: "rules")
    assert scheduler.run_scheduled_batch()["deferred"] is False
    assert seen == [user.athlete_id for user in athletes]
    scheduler.run_scheduled_batch()
    assert seen == [user.athlete_id for user in athletes]


def test_email_refresh_preserves_athlete_identity(athletes):
    second = athletes[1]
    updated = upsert_user(second.clerk_user_id, "new@example.com", verified=True)
    assert updated.athlete_id == second.athlete_id
    assert updated.email == "new@example.com"
    assert updated.email_verified_at is not None


def test_oauth_state_binds_the_callback_to_its_athlete():
    from arete.services import oauth_state

    secret = "test-only-secret"
    state = oauth_state.issue(secret, athlete_id=42)
    assert oauth_state.athlete_for_state(secret, state) == 42
    assert oauth_state.athlete_for_state(secret, state.replace("42~", "1~")) is None
    assert oauth_state.athlete_for_state(secret, oauth_state.issue(secret)) is None
    assert (
        oauth_state.athlete_for_state(
            secret, oauth_state.issue(secret, now=0, athlete_id=42)
        )
        is None
    )


def test_mirror_keeps_identical_paths_private(athletes):
    from arete.dataio import mirror

    mirror.reset()
    try:
        for user in athletes:
            with athlete_scope(user.athlete_id):
                assert mirror.hydrate() == 0
                path = config.data_dir / "garmin_tokens/test.json"
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(user.email)
                assert mirror.flush() == 1
                path.unlink()
        mirror.reset()
        for user in athletes:
            with athlete_scope(user.athlete_id):
                assert mirror.hydrate() == 1
                assert (
                    config.data_dir / "garmin_tokens/test.json"
                ).read_text() == user.email
    finally:
        mirror.reset()


def test_scheduler_failure_is_not_replayed_and_other_athletes_continue(
    athletes, monkeypatch
):
    from arete import scheduler

    seen = []

    def sync():
        identifier = current_athlete_id()
        seen.append(identifier)
        if identifier == athletes[0].athlete_id:
            raise RuntimeError("ambiguous write")
        return {"sync": "ok"}

    monkeypatch.setattr(scheduler, "daily_sync", sync)
    monkeypatch.setattr(scheduler, "write_daily_briefing", lambda **_: "rules")
    monkeypatch.setattr(scheduler, "write_weekly_review", lambda: "rules")
    result = scheduler.run_scheduled_batch()
    assert result["athletes"][str(athletes[0].athlete_id)] == {
        "status": "failed; next attempt tomorrow"
    }
    assert result["athletes"][str(athletes[1].athlete_id)]["sync"] == "ok"
    assert scheduler.run_scheduled_batch()["athletes"] == {}
    assert seen == [u.athlete_id for u in athletes]


def _stub_scheduled_work(monkeypatch, seen):
    from arete import scheduler

    monkeypatch.setattr(
        scheduler,
        "daily_sync",
        lambda: seen.append(current_athlete_id()) or {"sync": "ok"},
    )
    monkeypatch.setattr(scheduler, "write_daily_briefing", lambda **_: "rules")
    monkeypatch.setattr(scheduler, "write_weekly_review", lambda: "rules")


def _set_lease(athlete_id, expression):
    con = connect()
    con.execute(
        f"UPDATE app.athletes SET sync_lease_until = {expression} WHERE id=?",
        [athlete_id],
    )
    con.close()


def test_scheduler_reclaims_a_lease_from_a_previous_day_but_not_today(
    athletes, monkeypatch
):
    from arete import scheduler

    first, second = athletes
    _set_lease(first.athlete_id, "current_timestamp - INTERVAL 1 DAY")
    _set_lease(second.athlete_id, "current_timestamp + INTERVAL 15 MINUTE")
    seen: list[int] = []
    _stub_scheduled_work(monkeypatch, seen)
    result = scheduler.run_scheduled_batch()
    assert seen == [first.athlete_id]
    assert list(result["athletes"]) == [str(first.athlete_id)]
    con = connect()
    rows = dict(
        con.execute(
            "SELECT id, (sync_lease_until IS NULL "
            "AND CAST(last_sync_at AS DATE) = current_date) FROM app.athletes"
        ).fetchall()
    )
    con.close()
    assert rows[first.athlete_id] is True
    assert rows[second.athlete_id] is False


def test_a_failed_athlete_is_retried_by_the_next_day_s_dispatch(athletes, monkeypatch):
    from arete import scheduler

    first = athletes[0]
    failing = True
    seen: list[int] = []

    def sync():
        seen.append(current_athlete_id())
        if failing and current_athlete_id() == first.athlete_id:
            raise RuntimeError("stopped mid-run")
        return {"sync": "ok"}

    monkeypatch.setattr(scheduler, "daily_sync", sync)
    monkeypatch.setattr(scheduler, "write_daily_briefing", lambda **_: "rules")
    monkeypatch.setattr(scheduler, "write_weekly_review", lambda: "rules")
    scheduler.run_scheduled_batch()
    failing = False
    # The same day never replays it ...
    assert scheduler.run_scheduled_batch()["athletes"] == {}
    # ... the next day's dispatch does: its lease now dates from yesterday.
    _set_lease(first.athlete_id, "sync_lease_until - INTERVAL 1 DAY")
    result = scheduler.run_scheduled_batch()
    assert result["athletes"] == {
        str(first.athlete_id): {"sync": "ok", "briefing": "rules", "review": "rules"}
    }
    assert seen.count(first.athlete_id) == 2


def test_a_claim_lost_to_a_concurrent_dispatch_is_skipped_not_fatal(
    athletes, monkeypatch
):
    from contextlib import contextmanager

    import duckdb

    from arete import scheduler

    first, second = athletes
    real_connection = scheduler.db_connection

    class LosesTheFirstClaim:
        def __init__(self, con):
            self.con = con

        def execute(self, sql, params=None):
            if (
                "SET sync_lease_until=current_timestamp" in sql
                and params[1] == first.athlete_id
            ):
                raise duckdb.TransactionException("Conflict on update!")
            return self.con.execute(sql, params)

    @contextmanager
    def connection():
        with real_connection() as con:
            yield LosesTheFirstClaim(con)

    monkeypatch.setattr(scheduler, "db_connection", connection)
    seen: list[int] = []
    _stub_scheduled_work(monkeypatch, seen)
    result = scheduler.run_scheduled_batch()
    assert seen == [second.athlete_id]
    assert list(result["athletes"]) == [str(second.athlete_id)]


def test_model_steps_are_deferred_past_the_model_deadline(athletes, monkeypatch):
    from itertools import chain, repeat

    from arete import scheduler

    first = athletes[0]
    clock = chain([0, 0], repeat(scheduler.SCHEDULE_MODEL_SECONDS))
    monkeypatch.setattr(scheduler, "monotonic", lambda: next(clock))
    monkeypatch.setattr(scheduler, "daily_sync", lambda: {"sync": "ok"})

    def no_model_now():
        raise AssertionError("a model step started after the deadline")

    monkeypatch.setattr(scheduler, "write_daily_briefing", no_model_now)
    monkeypatch.setattr(scheduler, "write_weekly_review", no_model_now)
    result = scheduler.run_scheduled_batch()
    # The deadline also stops claiming: the second athlete waits for a window.
    assert result == {
        "athletes": {
            str(first.athlete_id): {
                "sync": "ok",
                "briefing": "deferred",
                "review": "deferred",
            }
        },
        "deferred": True,
    }
    con = connect()
    assert con.execute(
        "SELECT CAST(last_sync_at AS DATE) = current_date, sync_lease_until IS NULL "
        "FROM app.athletes WHERE id=?",
        [first.athlete_id],
    ).fetchone() == (True, True)
    con.close()


def test_scheduler_defers_unclaimed_work_at_the_dispatch_deadline(
    athletes, monkeypatch
):
    from arete import scheduler

    clock = iter([0, scheduler.SCHEDULE_DISPATCH_SECONDS])
    monkeypatch.setattr(scheduler, "monotonic", lambda: next(clock))
    assert scheduler.run_scheduled_batch() == {"athletes": {}, "deferred": True}
    con = connect()
    assert con.execute(
        "SELECT count(*) FROM app.athletes WHERE sync_lease_until IS NOT NULL"
    ).fetchone() == (0,)
    con.close()


def test_garmin_connection_mfa_sync_and_logout_are_private(
    athletes, client, monkeypatch
):
    """Real HTTP/storage with only Garmin's network boundary replaced."""
    import json
    from pathlib import Path

    import requests
    from garminconnect import Garmin
    from garminconnect.client import Client

    from arete.api import auth
    from arete.garmin.client import TOKEN_FILE, GarminClient
    from arete.garmin.models import ActivitySource, ActualSession
    from arete.garmin.sync import GarminSyncClient, SyncResult

    monkeypatch.setenv("ARETE_AUTH", "clerk")
    monkeypatch.setenv("CLERK_SECRET_KEY", "test")
    monkeypatch.setenv("CLERK_PUBLISHABLE_KEY", "test")
    monkeypatch.setenv("GARMIN_EMAIL", "global@example.com")
    monkeypatch.setenv("GARMIN_PASSWORD", "global-password")
    monkeypatch.setattr(auth, "_verify_session_token", lambda token: {"sub": token})

    def login(api, tokenstore=None):
        if tokenstore:
            api.full_name = json.loads((Path(tokenstore) / TOKEN_FILE).read_text())[
                "email"
            ]
            return None, None
        api.client._mfa_session = requests.Session()
        api.client._mfa_session.cookies.set("account", api.username)
        api.client._mfa_flow = "portal"
        api.client._mfa_login_params = {}
        api.client._mfa_post_headers = {}
        api.client._mfa_method = "email"
        return "needs_mfa", None

    def resume(api, _state, code):
        email = api.client._mfa_session.cookies.get("account")
        assert (
            code
            == {"first@garmin.test": "111111", "second@garmin.test": "222222"}[email]
        )
        api.full_name = email
        api.client.test_email = email

    def dump(sdk, directory):
        (Path(directory) / TOKEN_FILE).write_text(json.dumps({"email": sdk.test_email}))

    def sync(sync_client, **_kwargs):
        account = sync_client.client.profile()["full_name"]
        sync_client.repository.create_actual_session(
            ActualSession(
                date=date(2026, 10, 10),
                duration_sec=1200,
                name=account,
                sport="running",
                source=ActivitySource.GARMIN_CONNECT,
            )
        )
        return SyncResult(success=True, activities_synced=1)

    monkeypatch.setattr(Garmin, "login", login)
    monkeypatch.setattr(Garmin, "resume_login", resume)
    monkeypatch.setattr(Client, "dump", dump)
    monkeypatch.setattr(GarminSyncClient, "sync_activities", sync)
    monkeypatch.setattr(
        "arete.api.garmin_sync.write_sync_feedback", lambda *_: None, raising=False
    )
    headers = [{"Authorization": f"Bearer {u.clerk_user_id}"} for u in athletes]
    for index, who in enumerate(headers):
        assert (
            client.get("/garmin/sync/status", headers=who).json()[
                "garmin_authenticated"
            ]
            is False
        )
        assert (
            client.post("/garmin/sync/login", headers=who, json={}).status_code == 400
        )
        email = ["first@garmin.test", "second@garmin.test"][index]
        response = client.post(
            "/garmin/sync/login",
            headers=who,
            json={"email": email, "password": "not-retained"},
        )
        assert response.json()["needs_mfa"] is True
    # Discard all process-local state: another worker must be able to continue.
    GarminClient._pending_mfa.clear()
    for who, code in zip(headers, ["111111", "222222"], strict=True):
        response = client.post(
            "/garmin/sync/login", headers=who, json={"mfa_code": code}
        )
        assert response.status_code == 200, response.text
        assert response.json()["success"] is True
        assert (
            client.get("/garmin/sync/status", headers=who).json()[
                "garmin_authenticated"
            ]
            is True
        )
        response = client.post(
            "/garmin/sync/activities", headers=who, json={"download_fit": False}
        )
        assert response.status_code == 200, response.text
    for who, name in zip(
        headers, ["first@garmin.test", "second@garmin.test"], strict=True
    ):
        rows = client.get("/garmin/actual", headers=who).json()
        assert [row["name"] for row in rows] == [name]
    assert client.post("/garmin/sync/logout", headers=headers[1]).status_code == 200
    assert (
        client.get("/garmin/sync/status", headers=headers[1]).json()[
            "garmin_authenticated"
        ]
        is False
    )
    assert (
        client.get("/garmin/sync/status", headers=headers[0]).json()[
            "garmin_authenticated"
        ]
        is True
    )
    assert len(client.get("/garmin/actual", headers=headers[1]).json()) == 1
    with athlete_scope(athletes[1].athlete_id):
        con = connect()
        assert con.execute(
            "SELECT count(*) FROM app.visible_garmin_login_challenges"
        ).fetchone() == (0,)
        con.close()


def test_remote_token_store_revokes_stale_worker_files(athletes, tmp_path):
    from arete.garmin import token_store

    for user in athletes:
        with athlete_scope(user.athlete_id):
            source = tmp_path / f"token-{user.athlete_id}"
            source.write_text(user.email)
            token_store.save(source)
    stale = tmp_path / "other-worker-token"
    with athlete_scope(athletes[1].athlete_id):
        assert token_store.hydrate(stale)
        assert stale.read_text() == athletes[1].email
        token_store.delete()
        assert token_store.hydrate(stale) is False
        assert not stale.exists()
    with athlete_scope(athletes[0].athlete_id):
        assert token_store.hydrate(stale)
        assert stale.read_text() == athletes[0].email


@pytest.mark.parametrize("flow", ["portal", "ios", "widget"])
def test_mfa_sdk_state_round_trip_is_bounded_and_password_free(flow):
    import requests
    from garminconnect import Garmin

    from arete.garmin import auth_state

    api = Garmin("athlete@garmin.test", "never-store-this-password", retry_attempts=0)
    api.client._mfa_session = requests.Session()
    api.client._mfa_session.cookies.set(
        "session", "private-cookie", domain="garmin.com"
    )
    api.client._mfa_flow = flow
    api.client._mfa_post_headers = {"Referer": "https://sso.garmin.com"}
    api.client._mfa_login_params = {"clientId": "test"}
    api.client._mfa_method = "email"
    if flow == "widget":
        response = requests.Response()
        response.status_code = 200
        response._content = b'<input name="_csrf" value="challenge">'
        api.client._widget_last_resp = response
    payload = auth_state.serialize(api)
    assert "never-store-this-password" not in payload
    restored = auth_state.restore(payload)
    assert restored.client._mfa_flow == flow
    assert restored.client._mfa_session.cookies.get("session") == "private-cookie"
    assert restored.password is None
    if flow == "widget":
        assert "challenge" in restored.client._widget_last_resp.text
    api.client._mfa_post_headers = {"oversized": "x" * auth_state.MAX_MFA_BYTES}
    with pytest.raises(ValueError, match="state limit"):
        auth_state.serialize(api)


def test_garmin_failure_does_not_expire_the_arete_session(
    athletes, client, monkeypatch
):
    from arete.api import auth
    from arete.garmin.client import GarminClient

    monkeypatch.setenv("ARETE_AUTH", "clerk")
    monkeypatch.setenv("CLERK_SECRET_KEY", "test")
    monkeypatch.setenv("CLERK_PUBLISHABLE_KEY", "test")
    monkeypatch.setattr(auth, "_verify_session_token", lambda token: {"sub": token})
    who = {"Authorization": "Bearer second"}
    assert (
        client.post("/garmin/sync/activities", headers=who, json={}).status_code == 409
    )

    def refuse(*args):
        raise RuntimeError("provider-specific secret detail")

    monkeypatch.setattr(GarminClient, "login", refuse)
    response = client.post(
        "/garmin/sync/login",
        headers=who,
        json={"email": "test@example.com", "password": "bad"},
    )
    assert response.status_code == 400
    assert "secret detail" not in response.text
    assert client.get("/auth/me", headers=who).status_code == 200


def test_reactivation_restores_the_athlete_and_its_logins(athletes):
    from arete.services.users import (
        athlete_is_active,
        deactivate_athlete,
        get_user,
        reactivate_athlete,
    )

    first, second = athletes
    repo = GarminRepository()
    with athlete_scope(second.athlete_id):
        identifier = repo.create_planned_session(planned("paused athlete"))
    deactivate_athlete(second.athlete_id, actor=first)
    reactivate_athlete(second.athlete_id)
    assert athlete_is_active(second.athlete_id)
    assert get_user(second.clerk_user_id).deleted_at is None
    with athlete_scope(second.athlete_id):
        assert repo.get_planned_session(identifier).description == "paused athlete"


def test_a_released_lease_is_claimed_by_the_next_dispatch(athletes, monkeypatch):
    from arete import scheduler

    first, second = athletes
    con = connect()
    con.execute(
        "UPDATE app.athletes SET sync_lease_until = current_timestamp - INTERVAL 1 SECOND "
        "WHERE id=?",
        [second.athlete_id],
    )
    con.close()
    seen = []
    monkeypatch.setattr(
        scheduler,
        "daily_sync",
        lambda: seen.append(current_athlete_id()) or {"sync": "ok"},
    )
    monkeypatch.setattr(scheduler, "write_daily_briefing", lambda **_: "rules")
    monkeypatch.setattr(scheduler, "write_weekly_review", lambda: "rules")
    scheduler.run_scheduled_batch()
    assert seen == [first.athlete_id]
    assert scheduler.release_sync_lease(second.athlete_id) is True
    assert scheduler.release_sync_lease(second.athlete_id) is False
    scheduler.run_scheduled_batch()
    assert seen == [first.athlete_id, second.athlete_id]


def test_concurrent_memory_decisions_only_see_their_athletes(athletes):
    import asyncio

    from arete.services import athlete_facts as facts
    from arete.services.fact_memory import FactDraft, MemoryDecision, remember

    first, second = athletes
    for user in athletes:
        with athlete_scope(user.athlete_id):
            facts.add_fact(
                "preference", f"Private {user.athlete_id}", evidence="explicit"
            )

    async def task(user):
        with athlete_scope(user.athlete_id):

            async def decide(state, choices):
                assert list(state["candidates"].values()) == [
                    f"Private {user.athlete_id}"
                ]
                await asyncio.sleep(0)
                return MemoryDecision(
                    type="choice",
                    choice="create",
                    confidence=1.0,
                    probabilities={key: float(key == "create") for key in choices},
                )

            return await remember(
                FactDraft(
                    "preference",
                    f"New {user.athlete_id}",
                    "explicit",
                    "synthetic",
                    date(2026, 10, 12),
                    None,
                ),
                classify=decide,
            )

    async def run():
        return await asyncio.gather(task(first), task(second))

    results = asyncio.run(run())
    assert all(r["action"] == "created" for r in results)
    for user in athletes:
        with athlete_scope(user.athlete_id):
            assert {f.text for f in facts.list_facts()} == {
                f"Private {user.athlete_id}",
                f"New {user.athlete_id}",
            }
