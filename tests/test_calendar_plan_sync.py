"""Training plan → Google Calendar: real repository, offline Google, no Clerk."""

import hashlib
import json
from datetime import date, datetime, time, timedelta
from types import SimpleNamespace
from urllib.parse import parse_qs
from zoneinfo import ZoneInfo

import httpx
import pytest

from arete.dataio import plan_changes
from arete.dataio.db import db_connection
from arete.dataio.init_duckdb import main as init_db
from arete.garmin.models import PlannedSession, SessionStatus, SessionType
from arete.garmin.repository import GarminRepository
from arete.services.calendar import CalendarService
from arete.services.calendar_models import SCOPES, CalendarError
from arete.services.calendar_plan import (
    DAILY,
    PARTIAL,
    Budget,
    PlanRow,
    PlanSync,
    event_body,
)
from arete.services.calendar_provider import ClerkProvider
from arete.services.calendar_repository import CalendarRepository
from arete.services.google_tokens import GoogleToken

CAL, OTHER = "plan@group.calendar.google.com", "athlete@example.com"
TODAY = date(2026, 10, 10)
KEY = hashlib.sha256(b"clerk:user_athlete:test").hexdigest()


class Google:
    """Google Calendar's event semantics the sync relies on.

    Client-chosen ids stay taken after a delete (the event turns cancelled
    and a get returns little more than its id), writes honour If-Match, and
    a list filters on the private extended property.
    """

    def __init__(self):
        self.events: dict[tuple[str, str], dict] = {}
        self.requests: list[httpx.Request] = []
        self.version = 0
        self.lose_response = False
        self.on_write = None

    @property
    def writes(self):
        return [
            r
            for r in self.requests
            if r.method != "GET" and r.url.host == "www.googleapis.com"
        ]

    def live(self, calendar=CAL):
        return {
            event_id: event
            for (cal, event_id), event in self.events.items()
            if cal == calendar and event.get("status") != "cancelled"
        }

    def put(self, calendar, event):
        self.version += 1
        self.events[calendar, event["id"]] = {
            **event,
            "etag": f"v{self.version}",
            "status": event.get("status", "confirmed"),
        }
        return self.events[calendar, event["id"]]

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if request.url.host == "oauth2.googleapis.com":
            return httpx.Response(200, json={})  # revocation
        parts = request.url.path.split("/")[3:]  # after /calendar/v3
        if parts[:3] == ["users", "me", "calendarList"]:
            return httpx.Response(200, json={"id": parts[3], "accessRole": "owner"})
        calendar, event_id = parts[1], parts[3] if len(parts) > 3 else None
        current = self.events.get((calendar, event_id or ""))
        if request.method == "GET" and event_id is None:
            query = parse_qs(request.url.query.decode())
            key, value = query["privateExtendedProperty"][0].split("=")
            since = query["timeMin"][0][:10]
            items = [
                e
                for (cal, _), e in self.events.items()
                if cal == calendar
                and e["status"] != "cancelled"
                and e.get("extendedProperties", {}).get("private", {}).get(key) == value
                and e["end"]["date"] > since
            ]
            return httpx.Response(200, json={"items": items})
        if request.method == "GET":
            if current is None:
                return httpx.Response(404, json={})
            if current["status"] == "cancelled":
                return httpx.Response(200, json={"id": event_id, "status": "cancelled"})
            return httpx.Response(200, json=current)
        if self.on_write:
            self.on_write()
        body = json.loads(request.content) if request.content else {}
        match = request.headers.get("If-Match")
        if request.method == "POST":
            if (calendar, body["id"]) in self.events:
                return httpx.Response(409, json={})
            result = self.put(calendar, body)
        elif current is None:
            return httpx.Response(404, json={})
        elif match and match != current["etag"]:
            return httpx.Response(412, json={})
        elif request.method == "PUT":
            result = self.put(calendar, {**body, "id": event_id})
        else:
            current["status"] = "cancelled"
            result = {}
        if self.lose_response:
            self.lose_response = False
            raise httpx.ReadTimeout("lost response", request=request)
        return httpx.Response(200, json=result)


def provider(google, accounts=None):
    def tokens(clerk_user_id):
        if accounts is not None:
            accounts.append(clerk_user_id)
        return GoogleToken("google-access-token", tuple(SCOPES), None)

    return ClerkProvider("user_athlete", tokens, transport=httpx.MockTransport(google))


@pytest.fixture
def plan(tmp_path, monkeypatch):
    monkeypatch.setenv("ARETE_DB", str(tmp_path / "plan.duckdb"))
    init_db()
    google = Google()
    repo = CalendarRepository(KEY)
    repo.configure(
        enabled=True, selection={"readable": [CAL, OTHER], "writable": [CAL, OTHER]}
    )
    service = CalendarService(provider(google), repo)
    return SimpleNamespace(
        google=google,
        repo=repo,
        service=service,
        sync=PlanSync(service, today=TODAY),
        sessions=GarminRepository(),
        prefix=repo.event_prefix(),
    )


def session(plan, days=1, **fields):
    return plan.sessions.create_planned_session(
        PlannedSession(
            date=TODAY + timedelta(days=days),
            session_type=SessionType.ENDURANCE,
            target_duration_min=45,
            description="Footing Z2",
            **fields,
        )
    )


def stored(session_id):
    with db_connection() as con:
        return con.execute(
            "SELECT google_calendar_id, google_event_id FROM app.planned_sessions WHERE id = ?",
            [session_id],
        ).fetchone()


def test_turning_it_on_creates_the_window_as_all_day_events(plan):
    soon, later = session(plan, 0), session(plan, 28)
    session(plan, 29)  # beyond the window
    session(plan, 3, status=SessionStatus.SKIPPED)
    status = plan.sync.configure(True, CAL)
    events = plan.google.live()
    assert set(events) == {plan.prefix + str(soon), plan.prefix + str(later)}
    event = events[plan.prefix + str(soon)]
    assert event["summary"] == "Course · Endurance · 45 min"
    assert event["start"] == {"date": "2026-10-10"}
    assert event["end"] == {"date": "2026-10-11"}
    assert event["extendedProperties"]["private"] == {
        "arete_tag": plan.prefix,
        "arete_session_id": str(soon),
    }
    assert stored(soon) == (CAL, plan.prefix + str(soon))
    assert status["plan"]["enabled"] is True
    assert status["plan"]["events"] == 2
    assert status["plan"]["error"] is None and status["plan"]["synced_at"]
    # The account the cron will act as was stored with the decision.
    with db_connection() as con:
        assert con.execute(
            "SELECT clerk_user_id FROM app.calendar_connections"
        ).fetchone() == ("user_athlete",)


def test_a_moved_session_updates_its_event_with_the_listed_etag(plan):
    moved = session(plan, 1)
    plan.sync.configure(True, CAL)
    etag = plan.google.live()[plan.prefix + str(moved)]["etag"]
    plan.google.requests.clear()
    plan.sessions.update_planned_session_fields(moved, date=TODAY + timedelta(days=5))
    assert plan.sync.run(DAILY) == "synced"
    (write,) = plan.google.writes
    assert write.method == "PUT" and write.headers["If-Match"] == etag
    (event,) = plan.google.live().values()
    assert event["start"] == {"date": "2026-10-15"}
    plan.google.requests.clear()
    assert plan.sync.run(DAILY) == "synced"
    assert not plan.google.writes  # nothing changed: nothing written


@pytest.mark.parametrize("change", ["delete", "skip", "out_of_window"])
def test_a_session_leaving_the_plan_takes_its_event(plan, change):
    gone, kept = session(plan, 2), session(plan, 3)
    plan.sync.configure(True, CAL)
    if change == "delete":
        plan.sessions.delete_planned_session(gone)
    elif change == "skip":
        plan.sessions.update_planned_session_status(gone, SessionStatus.SKIPPED)
    else:
        plan.sessions.update_planned_session_fields(gone, date=TODAY + timedelta(60))
    assert plan.sync.run(DAILY) == "synced"
    assert set(plan.google.live()) == {plan.prefix + str(kept)}
    if change != "delete":
        assert stored(gone) == (None, None)


def test_completed_sessions_keep_their_event(plan):
    done = session(plan, 0)
    plan.sync.configure(True, CAL)
    plan.sessions.update_planned_session_status(done, SessionStatus.COMPLETED)
    plan.google.requests.clear()
    later = PlanSync(plan.service, today=TODAY + timedelta(days=5))
    assert later.run(DAILY) == "synced"
    assert not plan.google.writes
    assert plan.prefix + str(done) in plan.google.live()


def test_a_lost_response_is_reconciled_without_a_duplicate(plan):
    first = session(plan, 1)
    plan.google.lose_response = True
    plan.sync.configure(True, CAL)
    assert plan.repo.plan_state()["error"]  # the write's outcome was unknown
    assert stored(first) == (None, None)
    assert plan.sync.run(DAILY) == "synced"
    assert list(plan.google.live()) == [plan.prefix + str(first)]
    assert stored(first) == (CAL, plan.prefix + str(first))


def test_an_event_deleted_earlier_comes_back_under_its_own_id(plan):
    back = session(plan, 1)
    plan.sync.configure(True, CAL)
    plan.sessions.update_planned_session_status(back, SessionStatus.SKIPPED)
    plan.sync.run(DAILY)
    assert not plan.google.live()
    plan.sessions.update_planned_session_status(back, SessionStatus.PENDING)
    assert plan.sync.run(DAILY) == "synced"
    # Google refuses the taken id (409); the sync restores its own event.
    assert [r.method for r in plan.google.writes[-2:]] == ["POST", "PUT"]
    assert list(plan.google.live()) == [plan.prefix + str(back)]


def test_disabled_sync_writes_nothing(plan):
    session(plan, 1)
    assert plan.sync.run(DAILY) == "synced"
    plan.sync.configure(True, CAL)
    plan.sync.configure(False, None)
    plan.google.requests.clear()
    session(plan, 2)
    assert plan.sync.run(DAILY) == "synced"
    assert not plan.google.requests
    assert plan.service.status()["plan"]["events"] == 1  # offered for removal


def test_foreign_events_are_never_touched(plan):
    mine = session(plan, 1)
    plan.google.put(CAL, {"id": "athletes0wn", "end": {"date": "2026-10-12"}})
    plan.google.put(
        CAL,
        {
            "id": "aretedeadbeef00007",
            "end": {"date": "2026-10-12"},
            "extendedProperties": {
                "private": {"arete_tag": "aretedeadbeef00", "arete_session_id": "7"}
            },
        },
    )
    # A stranger's event holding the id Arete would choose: left alone.
    squatted = session(plan, 2)
    plan.google.put(
        CAL, {"id": plan.prefix + str(squatted), "end": {"date": "2026-10-13"}}
    )
    plan.sync.configure(True, CAL)
    plan.sessions.delete_planned_session(mine)
    plan.sync.run(DAILY)
    touched = {r.url.path.rsplit("/", 1)[-1] for r in plan.google.writes}
    assert touched <= {"events", plan.prefix + str(mine)}
    assert {"athletes0wn", "aretedeadbeef00007", plan.prefix + str(squatted)} <= set(
        plan.google.live()
    )
    assert stored(squatted) == (None, None)


def test_writes_are_bounded_and_the_next_run_continues(plan):
    for days in range(3):
        session(plan, days)
    plan.repo.configure_plan(enabled=True, calendar_id=CAL, clerk_user_id="u")
    assert plan.sync.run(Budget(seconds=20, writes=1)) == "partial"
    assert len(plan.google.writes) == 1
    assert plan.repo.plan_state()["error"] == PARTIAL
    assert plan.sync.run(DAILY) == "synced"
    assert len(plan.google.live()) == 3


def test_a_change_during_a_run_gets_its_own_pass(plan):
    session(plan, 1)
    plan.repo.configure_plan(enabled=True, calendar_id=CAL, clerk_user_id="u")
    late = []

    def concurrent_request():
        plan.google.on_write = None
        late.append(session(plan, 2))
        # Another request finishing now: the lease is taken, a pass is owed.
        assert plan.repo.claim_plan_sync(60) is False

    plan.google.on_write = concurrent_request
    assert plan.sync.run(DAILY) == "synced"
    assert plan.prefix + str(late[0]) in plan.google.live()


def test_target_change_moves_the_events(plan):
    moving = session(plan, 1)
    plan.sync.configure(True, CAL)
    plan.sync.configure(True, OTHER)
    assert not plan.google.live(CAL)
    assert set(plan.google.live(OTHER)) == {plan.prefix + str(moving)}


def test_target_must_be_writable_and_one_follower_only(plan):
    plan.repo.configure(enabled=True, selection={"readable": [CAL], "writable": []})
    with pytest.raises(CalendarError, match="non autorisé"):
        plan.sync.configure(True, CAL)
    plan.repo.configure(enabled=True, selection={"readable": [CAL], "writable": [CAL]})
    other = CalendarRepository("f" * 64)
    other.configure_plan(enabled=True, calendar_id=CAL, clerk_user_id="user_b")
    with pytest.raises(CalendarError, match="autre compte"):
        plan.sync.configure(True, CAL)
    assert not plan.google.writes


def test_removal_after_turning_it_off_and_disconnect_stops_it(plan):
    session(plan, 1), session(plan, 2)
    plan.sync.configure(True, CAL)
    with pytest.raises(CalendarError, match="Désactive"):
        plan.sync.remove()
    plan.sync.configure(False, None)
    assert plan.sync.remove()["plan"]["events"] == 0
    assert not plan.google.live()
    plan.sync.configure(True, CAL)
    plan.service.disconnect()
    assert plan.repo.plan_state()["enabled"] is False


def test_timed_event_lasts_its_target_duration():
    row = PlanRow(
        *(3, date(2026, 10, 25), "running", "tempo", None, None, None, None),
        *("pending", None, None, None, None),
    )
    body = event_body(row, "Europe/Paris", "aretex", at=time(7, 30))
    assert body["start"] == {
        "dateTime": "2026-10-25T07:30:00+01:00",
        "timeZone": "Europe/Paris",
    }
    assert body["end"]["dateTime"] == "2026-10-25T08:30:00+01:00"
    assert body["transparency"] == "opaque"


def test_cron_builds_the_provider_from_the_stored_account(tmp_path, monkeypatch):
    import arete.calendar as composition

    monkeypatch.setenv("ARETE_DB", str(tmp_path / "cron.duckdb"))
    from arete.services.athlete_scope import athlete_scope

    with athlete_scope(1):
        monkeypatch.setenv("ARETE_AUTH", "clerk")
        monkeypatch.setenv("CLERK_SECRET_KEY", "sk_test_fake")
        init_db()
        google, accounts = Google(), []
        monkeypatch.setattr(
            composition, "ClerkProvider", lambda account: provider(google, accounts)
        )
        signed_in = composition.get_calendar_service("user_athlete")
        signed_in.repo.configure(
            enabled=True, selection={"readable": [CAL], "writable": [CAL]}
        )
        today = datetime.now(ZoneInfo("Europe/Paris")).date()
        GarminRepository().create_planned_session(
            PlannedSession(
                date=today + timedelta(days=1), session_type=SessionType.TEMPO
            )
        )
        PlanSync(signed_in).configure(True, CAL)
        google.events.clear()
        accounts.clear()
        assert composition.sync_training_plan(DAILY) == "synced"
        assert set(accounts) == {"user_athlete"}
        assert len(google.live()) == 1
        # A preview's connection in the same database is not this environment's.
        monkeypatch.setenv("VERCEL_ENV", "preview")
        assert composition.sync_training_plan(DAILY) == "disabled"


def test_a_request_that_changed_the_plan_syncs_after_its_response(monkeypatch):
    from fastapi import FastAPI
    from fastapi.responses import StreamingResponse
    from fastapi.testclient import TestClient

    import arete.api.google_calendar as api

    monkeypatch.setenv("ARETE_AUTH", "clerk")
    monkeypatch.setenv("CLERK_SECRET_KEY", "sk_test_fake")
    synced = []
    monkeypatch.setattr(api, "sync_training_plan", lambda budget: synced.append(1))
    app = FastAPI()

    @app.post("/edit")
    def edit():  # a worker thread, like every plan route
        plan_changes.touch()
        return {}

    @app.post("/stream")
    def stream():  # the coach writes the plan while it streams
        def body():
            yield "a"
            plan_changes.touch()
            yield "b"

        return StreamingResponse(body())

    @app.get("/read")
    def read():
        return {}

    app.add_middleware(api.PlanSyncMiddleware)
    client = TestClient(app)
    client.get("/read")
    assert not synced
    client.post("/edit")
    assert synced == [1]
    assert client.post("/stream").text == "ab"
    assert synced == [1, 1]
    plan_changes.touch()  # outside a request: nothing to follow


def test_a_request_landing_in_the_release_s_window_gets_its_own_pass(plan, monkeypatch):
    """ARE-150: another request commits inside the lease release's snapshot."""
    from write_race import race

    session(plan, 1)
    plan.repo.configure_plan(enabled=True, calendar_id=CAL, clerk_user_id="u")
    late = []

    def concurrent_request():
        late.append(session(plan, 2))
        assert plan.repo.claim_plan_sync(60) is False

    with race(monkeypatch, r"SET plan_lease = NULL", concurrent_request):
        assert plan.sync.run(DAILY) == "synced"
    assert plan.prefix + str(late[0]) in plan.google.live()
    assert plan.repo.plan_state()["error"] is None


def test_a_request_racing_another_write_of_the_connection_still_syncs(
    plan, monkeypatch
):
    """ARE-150: the connection's settings commit inside the request's snapshot."""
    from write_race import race

    session(plan, 1)
    plan.repo.configure_plan(enabled=True, calendar_id=CAL, clerk_user_id="u")
    with race(
        monkeypatch,
        r"SET plan_requested = TRUE",
        lambda: plan.repo.configure_plan(
            enabled=True, calendar_id=CAL, clerk_user_id="u"
        ),
    ):
        assert plan.sync.run(DAILY) == "synced"
    assert len(plan.google.live()) == 1
