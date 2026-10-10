"""Calendar boundary tests: real repository, offline provider, no live athlete data."""

import json
from concurrent.futures import ThreadPoolExecutor
from threading import Event
from types import SimpleNamespace
from urllib.parse import parse_qsl

import httpx
import pytest
from pydantic import ValidationError

from arete.dataio.db import db_connection
from arete.dataio.init_duckdb import main as init_db
from arete.services.calendar import CalendarService
from arete.services.calendar_models import (
    SCOPES,
    CalendarError,
    CalendarProposal,
    CalendarSelection,
    EventDraft,
)
from arete.services.calendar_provider import SCOPES_MISSING, ClerkProvider
from arete.services.calendar_repository import CalendarRepository
from arete.services.google_tokens import GoogleToken, GoogleTokenUnavailable

CAL = "athlete@example.com"
START, END = "2026-10-09T10:00:00+02:00", "2026-10-09T11:00:00+02:00"


class GoogleFake:
    def __init__(self):
        self.requests = []
        self.events = {}
        self.role = "owner"
        self.error = None
        self.write_error = None
        self.after_write_timeout = False
        self.next_page = False
        self.busy_error = False
        self.write_entered = None
        self.write_release = None

    @property
    def writes(self):
        return [
            r
            for r in self.requests
            if r.url.host == "www.googleapis.com"
            and r.method != "GET"
            and not r.url.path.endswith("/freeBusy")
        ]

    def __call__(self, request):
        self.requests.append(request)
        is_json = request.headers.get("content-type") == "application/json"
        body = json.loads(request.content) if request.content and is_json else {}
        path = request.url.path
        if request.url.host == "oauth2.googleapis.com":
            assert path == "/revoke"
            if self.error:
                return httpx.Response(self.error, json={})
            return httpx.Response(200, json={})
        if self.error:
            return httpx.Response(self.error, json={})
        if "/calendarList/" in path:
            return httpx.Response(
                200,
                json={
                    "id": CAL,
                    "summary": "Personnel",
                    "accessRole": self.role,
                    "timeZone": "Europe/Paris",
                },
            )
        if path.endswith("/calendarList"):
            return httpx.Response(
                200,
                json={
                    "items": [
                        {
                            "id": CAL,
                            "summary": "Personnel",
                            "accessRole": self.role,
                            "timeZone": "Europe/Paris",
                        }
                    ]
                },
            )
        if path.endswith("/freeBusy"):
            return httpx.Response(
                200,
                json={
                    "calendars": {
                        CAL: {"errors": [{"reason": "internalError"}]}
                        if self.busy_error
                        else {"busy": []}
                    }
                },
            )
        if request.method == "GET":
            if path.endswith("/events"):
                return httpx.Response(
                    200,
                    json={
                        "items": list(self.events.values()),
                        **({"nextPageToken": "next"} if self.next_page else {}),
                    },
                )
            event_id = path.rsplit("/", 1)[-1]
            return (
                httpx.Response(200, json=self.events[event_id])
                if event_id in self.events
                else httpx.Response(404)
            )
        if self.write_entered:
            self.write_entered.set()
            assert self.write_release.wait(5)
        if self.write_error:
            return httpx.Response(self.write_error, json={})
        event_id = body.get("id") or path.rsplit("/", 1)[-1]
        if request.method == "DELETE":
            del self.events[event_id]
            result = {}
        else:
            result = {
                **self.events.get(event_id, {}),
                **body,
                "id": event_id,
                "etag": "v2",
            }
            self.events[event_id] = result
        if self.after_write_timeout:
            raise httpx.ReadTimeout("lost response", request=request)
        return httpx.Response(200, json=result)


@pytest.fixture
def calendar(tmp_path, monkeypatch):
    monkeypatch.setenv("ARETE_DB", str(tmp_path / "calendar.duckdb"))
    init_db()
    fake = GoogleFake()
    repo = CalendarRepository("test")
    repo.configure(enabled=True, selection={"readable": [CAL], "writable": [CAL]})
    # What Clerk hands out for the signed-in account; tests swap the scopes.
    clerk = SimpleNamespace(scopes=tuple(SCOPES), unavailable=False)

    def tokens(clerk_user_id):
        assert clerk_user_id == "user_athlete"
        if clerk.unavailable:
            raise GoogleTokenUnavailable("provider detail with a token in it")
        return GoogleToken("google-access-token", clerk.scopes, None)

    provider = ClerkProvider(
        "user_athlete", tokens, transport=httpx.MockTransport(fake)
    )
    return SimpleNamespace(
        service=CalendarService(provider, repo), fake=fake, repo=repo, clerk=clerk
    )


def proposal(operation="create", event_id=None):
    return CalendarProposal(
        operation=operation,
        calendar_id=CAL,
        event_id=event_id,
        event=None
        if operation == "delete"
        else EventDraft(summary="Course", start=START, end=END),
    )


def existing(calendar, **extra):
    calendar.fake.events["existing"] = {
        "id": "existing",
        "etag": "v1",
        **EventDraft(summary="Ancien", start=START, end=END).google_body(),
        **extra,
    }


def test_propose_then_approve_exactly_once(calendar):
    action = calendar.service.propose(proposal(), "thread-1")
    assert action["status"] == "pending"
    assert not calendar.fake.writes
    approved = calendar.service.decide(action["id"], "approve")
    assert approved["status"] == "succeeded"
    assert calendar.service.decide(action["id"], "approve")["status"] == "succeeded"
    assert len(calendar.fake.writes) == 1
    assert json.loads(calendar.fake.writes[0].content) == {
        "id": action["event_id"],
        **action["after"],
    }
    assert all(
        r.headers["authorization"] == "Bearer google-access-token"
        for r in calendar.fake.requests
    )
    with db_connection() as con:
        assert "google-access-token" not in str(
            con.execute("SELECT * FROM app.calendar_actions").fetchall()
        )


def test_read_empty_calendars_still_returns_ids(calendar):
    result = calendar.service.events(START, END)
    assert result["events"] == []
    assert result["calendars"][0]["id"] == CAL
    assert calendar.service.availability(START, END)["calendars"][CAL]["busy"] == []


@pytest.mark.parametrize("operation", ["update", "delete"])
def test_existing_writes_use_etag(calendar, operation):
    existing(calendar)
    action = calendar.service.propose(proposal(operation, "existing"), "thread-1")
    result = calendar.service.decide(action["id"], "approve")
    assert result["status"] == "succeeded"
    assert calendar.fake.writes[0].headers["If-Match"] == "v1"


@pytest.mark.parametrize("operation", ["create", "update", "delete"])
def test_uncertain_write_is_never_replayed_and_can_be_verified(calendar, operation):
    existing(calendar)
    action = calendar.service.propose(
        proposal(operation, None if operation == "create" else "existing"), "thread-1"
    )
    calendar.fake.after_write_timeout = True
    assert calendar.service.decide(action["id"], "approve")["status"] == "uncertain"
    assert calendar.service.decide(action["id"], "approve")["status"] == "uncertain"
    assert len(calendar.fake.writes) == 1
    assert calendar.service.verify(action["id"])["status"] == "succeeded"
    assert len(calendar.fake.writes) == 1


def test_two_approvals_cannot_execute_twice(calendar):
    action = calendar.service.propose(proposal(), "thread-1")
    calendar.fake.write_entered, calendar.fake.write_release = Event(), Event()
    with ThreadPoolExecutor(max_workers=1) as pool:
        first = pool.submit(calendar.service.decide, action["id"], "approve")
        try:
            assert calendar.fake.write_entered.wait(5)
            assert (
                calendar.service.decide(action["id"], "approve")["status"]
                == "executing"
            )
        finally:
            calendar.fake.write_release.set()
        assert first.result(timeout=5)["status"] == "succeeded"
    assert len(calendar.fake.writes) == 1


def test_reject_expiry_and_settings_invalidation(calendar):
    rejected = calendar.service.propose(proposal(), "a")
    assert calendar.service.decide(rejected["id"], "reject")["status"] == "rejected"
    assert calendar.service.decide(rejected["id"], "approve")["status"] == "rejected"
    expired = calendar.service.propose(proposal(), "b")
    with db_connection() as con:
        con.execute(
            "UPDATE app.calendar_actions SET expires = 0 WHERE id = ?", [expired["id"]]
        )
    assert calendar.service.decide(expired["id"], "approve")["status"] == "expired"
    invalid = calendar.service.propose(proposal(), "c")
    calendar.service.select(CalendarSelection(readable=[CAL]))
    assert calendar.service.decide(invalid["id"], "approve")["status"] == "invalidated"
    assert not calendar.fake.writes


def test_event_changed_after_preview_rejects_write(calendar):
    existing(calendar)
    action = calendar.service.propose(proposal("update", "existing"), "thread")
    calendar.fake.events["existing"]["etag"] = "changed"
    assert calendar.service.decide(action["id"], "approve")["status"] == "failed"
    assert not calendar.fake.writes


@pytest.mark.parametrize(
    "attributes",
    [
        {"attendees": [{"email": "other@example.com"}]},
        {"recurrence": ["RRULE:FREQ=WEEKLY"]},
        {"eventType": "outOfOffice"},
    ],
)
def test_unsupported_events_cannot_be_proposed(calendar, attributes):
    existing(calendar, **attributes)
    with pytest.raises(CalendarError):
        calendar.service.propose(proposal("delete", "existing"), "thread")


def test_individual_recurring_instance_is_supported(calendar):
    existing(calendar, recurringEventId="series")
    action = calendar.service.propose(proposal("delete", "existing"), "thread")
    assert calendar.service.decide(action["id"], "approve")["status"] == "succeeded"


def test_permissions_checked_locally_and_again_at_google(calendar):
    calendar.repo.configure(enabled=True, selection={"readable": [CAL], "writable": []})
    with pytest.raises(CalendarError, match="non autorisé"):
        calendar.service.propose(proposal(), "thread")
    calendar.repo.configure(
        enabled=True, selection={"readable": [CAL], "writable": [CAL]}
    )
    action = calendar.service.propose(proposal(), "thread")
    calendar.fake.role = "reader"
    assert calendar.service.decide(action["id"], "approve")["status"] == "failed"
    assert not calendar.fake.writes


def test_unknown_calendar_id_names_the_allowed_ones(calendar):
    # The model tends to guess "primary"; the error must let it correct itself.
    guessed = proposal().model_copy(update={"calendar_id": "primary"})
    with pytest.raises(CalendarError, match=f"autorisés : {CAL}"):
        calendar.service.propose(guessed, "thread")
    (listed,) = calendar.service.events(START, END)["calendars"]
    assert listed["writable"] is True


def test_disconnect_blocks_even_when_revocation_fails(calendar):
    action = calendar.service.propose(proposal(), "thread")
    calendar.fake.error = 503
    assert calendar.service.disconnect()["revoked"] is False
    assert calendar.service.status()["connected"] is False
    assert calendar.repo.get(action["id"])["status"] == "invalidated"
    with pytest.raises(CalendarError, match="Connecte"):
        calendar.service.events(START, END)


def test_disconnect_revokes_the_google_grant(calendar):
    assert calendar.service.disconnect() == {"connected": False, "revoked": True}
    (revoke,) = [
        r for r in calendar.fake.requests if r.url.host == "oauth2.googleapis.com"
    ]
    assert dict(parse_qsl(revoke.content.decode())) == {"token": "google-access-token"}
    assert calendar.service.status()["connected"] is False


def test_missing_scopes_or_account_never_reach_google(calendar):
    calendar.clerk.scopes = ("openid", "email")
    with pytest.raises(CalendarError, match=SCOPES_MISSING):
        calendar.service.events(START, END)
    calendar.clerk.unavailable = True
    with pytest.raises(CalendarError) as caught:
        calendar.service.events(START, END)
    assert caught.value.status == 409 and "token" not in str(caught.value)
    assert not calendar.fake.requests


@pytest.mark.parametrize("code", [401, 403, 429, 503])
def test_external_errors_are_not_empty_context(calendar, code):
    calendar.fake.error = code
    with pytest.raises(CalendarError):
        calendar.service.events(START, END)


def test_pagination_and_event_limits_fail_explicitly(calendar):
    calendar.fake.next_page = True
    with pytest.raises(CalendarError, match="pagination"):
        calendar.service.events(START, END)
    calendar.fake.next_page = False
    calendar.fake.events = {str(i): {"id": str(i)} for i in range(501)}
    with pytest.raises(CalendarError, match="500"):
        calendar.service.events(START, END)


def test_partial_availability_is_an_error(calendar):
    calendar.fake.busy_error = True
    with pytest.raises(CalendarError, match="partiellement"):
        calendar.service.availability(START, END)


def test_window_errors_say_how_to_fix_the_dates(calendar):
    # A bare message made the model retry the same naive dates five times.
    with pytest.raises(CalendarError, match=r"décalage UTC.*\+02:00.*reçu"):
        calendar.service.events("2026-10-10", "2026-10-11")
    with pytest.raises(CalendarError, match="31 jours"):
        calendar.service.events(END, START)
    assert not calendar.fake.requests


def test_virtual_calendars_are_skipped_by_availability(calendar):
    # Google answers notFound for week numbers, holidays and birthdays.
    week_numbers = "e_2_fr#weeknum@group.v.calendar.google.com"
    calendar.repo.configure(
        enabled=True, selection={"readable": [CAL, week_numbers], "writable": []}
    )
    result = calendar.service.availability(START, END)
    (busy_request,) = [
        r for r in calendar.fake.requests if r.url.path.endswith("/freeBusy")
    ]
    assert json.loads(busy_request.content)["items"] == [{"id": CAL}]
    assert result["skipped"] == [week_numbers]


def test_dates_dst_and_exclusive_all_day():
    draft = EventDraft(
        summary="Repos", start="2026-10-09", end="2026-10-10", all_day=True
    )
    assert draft.google_body()["end"] == {"date": "2026-10-10"}
    for start, end in [
        ("2026-03-29T02:30:00+01:00", "2026-03-29T04:00:00+02:00"),
        ("2026-10-09T10:00:00", "2026-10-09T11:00:00"),
        (END, START),
    ]:
        with pytest.raises(ValidationError):
            EventDraft(summary="Course", start=start, end=end)
    EventDraft(
        summary="Course",
        start="2026-10-25T02:30:00+02:00",
        end="2026-10-25T02:45:00+01:00",
    )


def test_budget_expired_before_provider_call(calendar):
    with pytest.raises(CalendarError, match="Délai"):
        calendar.service.events(START, END, deadline=1)
    assert not calendar.fake.requests


def test_connect_needs_the_scopes_and_a_same_origin_request(
    calendar, monkeypatch, router_client
):
    import arete.api.google_calendar as api

    calendar.repo.configure(enabled=False, selection={"readable": [], "writable": []})
    accounts = []

    def service_for(account):
        accounts.append(account)
        return calendar.service

    monkeypatch.setattr(api, "get_calendar_service", service_for)
    client = router_client(api.router)
    headers = {"X-Arete-Calendar": "1"}
    assert client.post("/google-calendar/connect").status_code == 403
    calendar.clerk.scopes = ("openid", "email")
    refused = client.post("/google-calendar/connect", headers=headers)
    assert refused.status_code == 409
    assert refused.json()["detail"] == SCOPES_MISSING
    assert calendar.service.status()["connected"] is False
    calendar.clerk.scopes = tuple(SCOPES)
    connected = client.post("/google-calendar/connect", headers=headers).json()
    assert connected["connected"] is True
    assert connected["selection"] == {"readable": [], "writable": []}
    # Sign-in is off in this client: no Clerk account to act as.
    assert set(accounts) == {""}


def test_api_rejects_forged_decisions(calendar, monkeypatch, router_client):
    import arete.api.google_calendar as api

    monkeypatch.setattr(api, "get_calendar_service", lambda _account: calendar.service)
    client = router_client(api.router)
    action = calendar.service.propose(proposal(), "thread")
    url = f"/google-calendar/actions/{action['id']}/decision"
    assert client.post(url, json={"decision": "approve"}).status_code == 403
    headers = {"X-Arete-Calendar": "1"}
    assert (
        client.post(
            url, json={"decision": "approve", "event": {}}, headers=headers
        ).status_code
        == 422
    )
    assert (
        client.post(
            url,
            json={"decision": "approve"},
            headers={**headers, "Origin": "https://attacker.example"},
        ).status_code
        == 403
    )
    assert not calendar.fake.writes


def test_disconnect_race_rejects_a_stale_revision(calendar):
    revision = calendar.repo.state()["revision"]
    calendar.service.disconnect()
    with pytest.raises(CalendarError, match="modifiée"):
        calendar.repo.configure(
            enabled=True,
            selection={"readable": [], "writable": []},
            expected_revision=revision,
        )


def test_each_signed_in_account_has_its_own_calendar(monkeypatch, tmp_path):
    from arete.calendar import get_calendar_service

    monkeypatch.delenv("ARETE_AUTH", raising=False)
    with pytest.raises(CalendarError) as off:
        get_calendar_service("user_a")
    assert off.value.status == 503
    monkeypatch.setenv("ARETE_AUTH", "clerk")
    monkeypatch.setenv("CLERK_SECRET_KEY", "sk_test_fake")
    with pytest.raises(CalendarError) as nobody:
        get_calendar_service("")
    assert nobody.value.status == 403
    first, second = get_calendar_service("user_a"), get_calendar_service("user_b")
    assert first.repo.key != second.repo.key
    assert first.provider.clerk_user_id == "user_a"


def test_the_calendar_is_built_for_the_runs_account_only():
    from types import SimpleNamespace as Runtime

    from arete.agent.middlewares.policy import ProfilePolicyMiddleware
    from arete.agent.runtime.context import AgentContext

    built = []
    policy = ProfilePolicyMiddleware("chat", calendar=lambda a: built.append(a) or a)
    signed_in = AgentContext(account_id="user_a")
    policy.before_agent({}, Runtime(context=signed_in))
    anonymous = AgentContext()
    policy.before_agent({}, Runtime(context=anonymous))
    assert (signed_in.calendar, anonymous.calendar, built) == (
        "user_a",
        None,
        ["user_a"],
    )


def test_configured_calendar_is_preloaded_only_for_chat(calendar, monkeypatch):
    from unittest.mock import patch

    from arete import coaching
    from arete.services.athlete_scope import athlete_scope

    monkeypatch.setenv("ARETE_AUTH", "clerk")
    monkeypatch.setenv("CLERK_SECRET_KEY", "sk_test_fake")
    with (
        athlete_scope(1),
        patch.object(coaching, "get_calendar_service") as factory,
        patch.object(coaching, "build_chat_model"),
        patch.object(coaching, "build_agent") as build,
    ):
        for mission in ("chat", "briefing", "feedback"):
            coaching._assemble(mission)
            args = build.call_args.kwargs
            profile = build.call_args.args[0]
            if mission == "chat":
                assert "calendar" in profile.capabilities
                assert args["calendar"] is factory
            else:
                assert not profile.capabilities
                assert args["calendar"] is None


def test_calendar_tools_stream_proposal_without_writing(calendar):
    import asyncio
    from dataclasses import replace

    from langchain.agents import create_agent
    from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
    from langchain_core.messages import AIMessage, HumanMessage

    from arete.agent.capabilities.registry import CAPABILITIES
    from arete.agent.middlewares.capabilities import ToolkitMiddleware
    from arete.agent.middlewares.context import ContextBuilderMiddleware
    from arete.agent.middlewares.events import ToolEventMiddleware
    from arete.agent.middlewares.policy import ProfilePolicyMiddleware
    from arete.agent.profiles.catalog import get_profile
    from arete.agent.runtime.context import AgentContext
    from arete.agent.runtime.execution import stream_agent
    from arete.agent.runtime.streaming import StreamProjection

    seen = []

    class Model(GenericFakeChatModel):
        def bind_tools(self, tools, **kwargs):
            seen.append({t.name for t in tools})
            return self

    profile = replace(get_profile("chat"), capabilities=("calendar",))
    args = proposal().model_dump()
    graph = create_agent(
        Model(
            disable_streaming=True,
            messages=iter(
                [
                    AIMessage(
                        content="",
                        tool_calls=[
                            {"name": "propose_calendar_event", "args": args, "id": "c1"}
                        ],
                    ),
                    AIMessage(content="Valide la proposition."),
                ]
            ),
        ),
        tools=CAPABILITIES["calendar"].tools,
        middleware=[
            ProfilePolicyMiddleware(
                "chat", profile=profile, calendar=lambda _account: calendar.service
            ),
            ToolEventMiddleware(),
            ToolkitMiddleware(),
            ContextBuilderMiddleware(),
        ],
        context_schema=AgentContext,
    )

    async def collect():
        projection = StreamProjection()
        events = []
        async for part in stream_agent(
            graph,
            {"messages": [HumanMessage("Planifie ma course")]},
            context=AgentContext(thread_id="thread", account_id="user_athlete"),
        ):
            events.extend(projection.events(part))
        return events

    events = asyncio.run(collect())
    actions = [e for e in events if e["type"] == "calendar_action"]
    assert len(actions) == 1
    assert calendar.repo.get(actions[0]["id"])["thread_id"] == "thread"
    assert not calendar.fake.writes
    assert "propose_calendar_event" in seen[0]
    assert not any("approve" in name or "decide" in name for name in seen[0])


def test_new_calendar_tables_are_migrated_on_existing_database(tmp_path, monkeypatch):
    monkeypatch.setenv("ARETE_DB", str(tmp_path / "migration.duckdb"))
    init_db()
    with db_connection() as con:
        con.execute("DROP TABLE app.calendar_actions")
        con.execute("DROP TABLE app.calendar_connections")
        con.execute("DELETE FROM app.schema_version WHERE version >= 17")
    init_db()
    repo = CalendarRepository("migrated")
    repo.configure(enabled=False, selection={"readable": [], "writable": []})
    assert repo.state()["enabled"] is False


def test_same_host_origin_is_trusted_without_frontend_url(
    calendar, monkeypatch, router_client
):
    # A preview answers on its own URL while FRONTEND_URL names production.
    import arete.api.google_calendar as api

    monkeypatch.setattr(api, "get_calendar_service", lambda _account: calendar.service)
    monkeypatch.setenv("FRONTEND_URL", "https://arete.example")
    client = router_client(api.router)
    headers = {"X-Arete-Calendar": "1"}
    own = client.post(
        "/google-calendar/connect", headers={**headers, "Origin": "http://testserver"}
    )
    assert own.status_code == 200
    configured = client.post(
        "/google-calendar/connect",
        headers={**headers, "Origin": "https://arete.example"},
    )
    assert configured.status_code == 200
    foreign = client.post(
        "/google-calendar/connect",
        headers={**headers, "Origin": "https://attacker.example"},
    )
    assert foreign.status_code == 403
