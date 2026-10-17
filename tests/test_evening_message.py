"""The coach's evening message (ARE-64): written once, answered once, opt-in."""

from __future__ import annotations

import asyncio
import json
import logging
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, time, timedelta
from threading import Barrier, Lock
from unittest.mock import MagicMock
from zoneinfo import ZoneInfo

import duckdb
import pytest

from arete.dataio.db import configure_athlete, connect
from arete.dataio.init_duckdb import main as init_schema
from arete.garmin.models import PlannedSession, SessionStatus, SessionType
from arete.garmin.repository import GarminRepository
from arete.services import evening_message
from arete.services.notifications import NotifyResult
from arete.services.settings import athlete_today

MESSAGE = "Demain, 50 min de tempo en Z4, 12 °C au départ. Comment sont tes jambes ?"


@pytest.fixture
def db(tmp_path, monkeypatch):
    """A database of its own: the evening's plan and rows are this test's."""
    monkeypatch.setenv("ARETE_DB", str(tmp_path / "evening.duckdb"))
    monkeypatch.setenv("ARETE_DATA_DIR", str(tmp_path / "files"))
    monkeypatch.delenv("ARETE_AUTH", raising=False)
    init_schema()
    con = connect()
    con.execute("INSERT INTO app.athletes (id) VALUES (1) ON CONFLICT DO NOTHING")
    con.close()
    # No request leaves: the forecast is the test's.
    monkeypatch.setattr("arete.services.weather.fetch_weather", lambda *a, **k: None)
    return tmp_path


def _plan(offset: int = 1, **fields) -> int:
    return GarminRepository().create_planned_session(
        PlannedSession(
            date=athlete_today() + timedelta(days=offset),
            sport="running",
            session_type=fields.pop("session_type", SessionType.TEMPO),
            target_duration_min=50,
            target_hr_zone="Z4",
            **fields,
        )
    )


def _written(produce=lambda facts: MESSAGE):
    evening = evening_message.survey()
    return evening_message.write(produce, evening)


def _rows() -> list[tuple]:
    con = connect()
    try:
        return con.execute(
            "SELECT status, text, answer FROM app.visible_coach_evening_messages"
        ).fetchall()
    finally:
        con.close()


def _notes() -> str:
    from arete.services.memory import NOTES_LEDGER, read_file

    return read_file(NOTES_LEDGER).content


# --------------------------------------------------------------------------- #
# Something to say, or no request
# --------------------------------------------------------------------------- #
def test_nothing_planned_nor_notable_means_nothing_to_say(db):
    _plan(2)  # the day after tomorrow is not tomorrow
    _plan(1, status=SessionStatus.SKIPPED)
    assert evening_message.survey().reasons == ()


def test_a_session_tomorrow_or_a_race_this_week_is_worth_a_message(db):
    from arete.services.goals import create_goal

    _plan(1)
    assert evening_message.survey().reasons == ("session",)
    create_goal(
        name="10 km du club",
        race_date=athlete_today() + timedelta(days=5),
        distance_km=10,
    )
    evening = evening_message.survey()
    assert evening.reasons == ("session", "race")
    assert evening.races[0][1] == "10 km du club"


def test_a_race_further_than_a_week_is_not(db):
    from arete.services.goals import create_goal

    create_goal(
        name="Semi", race_date=athlete_today() + timedelta(days=10), distance_km=21.1
    )
    assert evening_message.survey().reasons == ()


def test_a_low_readiness_or_check_in_is_worth_a_message_on_a_rest_day(db):
    from arete.services import checkins

    checkins.save(athlete_today(), sleep=2, legs=4)
    assert evening_message.survey().reasons == ("readiness",)


# --------------------------------------------------------------------------- #
# Written once, never replayed
# --------------------------------------------------------------------------- #
def test_the_facts_carry_tomorrow_and_the_message_its_one_question(db):
    _plan(1)
    seen = []
    message = _written(lambda facts: seen.append(facts) or MESSAGE)
    assert message is not None and message.status == "ok"
    assert message.question == "Comment sont tes jambes ?"
    (facts,) = seen
    assert "Séance(s) prévue(s) demain :\n- tempo — 50 min — Z4" in facts
    assert "Pourquoi ce message : une séance est prévue demain." in facts
    assert "Météo prévue demain" in facts and "Charge, forme" in facts


def test_a_second_write_finds_the_evening_held_and_pays_nothing(db):
    _plan(1)
    produce = MagicMock(return_value=MESSAGE)
    assert _written(produce).status == "ok"
    assert _written(produce) is None
    assert produce.call_count == 1


def test_overlapping_dispatches_pay_for_one_message(db):
    _plan(1)
    calls, lock = [], Lock()
    evening = evening_message.survey()
    start = Barrier(3)

    def produce(facts):
        with lock:
            calls.append(facts)
        return MESSAGE

    def run(_):
        start.wait(timeout=5)
        return evening_message.write(produce, evening)

    with ThreadPoolExecutor(max_workers=3) as pool:
        results = list(pool.map(run, range(3)))
    assert len(calls) == 1
    assert [r.status for r in results if r is not None] == ["ok"]
    assert len(_rows()) == 1


@pytest.mark.parametrize(
    "answer",
    [
        RuntimeError("provider down"),
        "Demain, tempo. Bonne séance.",  # no question
        "Prêt ? Comment sont tes jambes ?",  # two questions
    ],
)
def test_a_failed_run_keeps_the_evening_and_is_never_replayed(db, answer):
    _plan(1)

    def produce(_facts):
        if isinstance(answer, Exception):
            raise answer
        return answer

    failed = _written(produce)
    assert failed is not None and failed.status == "failed" and failed.error
    retry = MagicMock(return_value=MESSAGE)
    assert _written(retry) is None
    retry.assert_not_called()
    assert evening_message.get(failed.id) is None  # never served


# --------------------------------------------------------------------------- #
# The scheduler: opt-in, the chosen hour, one push from the writer
# --------------------------------------------------------------------------- #
@pytest.fixture
def evening(db, monkeypatch):
    """20:15 on the athlete's clock; opted in and reachable; nothing leaves."""
    from arete import coaching, scheduler

    now = datetime.combine(
        athlete_today(), time(20, 15), tzinfo=ZoneInfo("Europe/Paris")
    )
    monkeypatch.setattr(scheduler, "utc_now", lambda: now)
    settings = {
        "timezone": "Europe/Paris",
        "coach_evening_enabled": True,
        "coach_evening_hour": 20,
    }
    monkeypatch.setattr(
        "arete.dataio.settings.get_user_settings", lambda *a, **k: settings
    )
    monkeypatch.setattr(evening_message, "unreachable", lambda _settings: None)
    produce = MagicMock(return_value=MESSAGE)
    monkeypatch.setattr(coaching, "run_evening", produce)
    sent = MagicMock(return_value=NotifyResult(1, 0))
    monkeypatch.setattr("arete.services.notifications.notify", sent)
    return settings, produce, sent


def test_the_evening_is_written_and_pushed_once_whatever_the_windows(evening):
    from time import monotonic

    from arete import scheduler

    _settings, produce, sent = evening
    _plan(1)
    first = scheduler.write_evening_message(monotonic())
    assert first == "written; push: 1 sent"
    assert scheduler.write_evening_message(monotonic()) == "already ok"
    assert produce.call_count == sent.call_count == 1
    title, body, url = sent.call_args.args
    assert sent.call_args.kwargs == {"kind": "evening"}
    (row,) = _rows()
    message_id = evening_message.get_for_day(athlete_today()).id
    assert (title, body) == ("Chiron, pour demain", "Comment sont tes jambes ?")
    assert url == f"/follow-up?evening={message_id}" and row[0] == "ok"


def test_off_by_default_and_before_the_chosen_hour_nothing_is_read(evening):
    from time import monotonic

    from arete import scheduler

    settings, produce, sent = evening
    _plan(1)
    settings["coach_evening_hour"] = 21
    assert scheduler.write_evening_message(monotonic()) == "not yet"
    del settings["coach_evening_enabled"]
    assert scheduler.write_evening_message(monotonic()) == "disabled"
    produce.assert_not_called()
    sent.assert_not_called()
    assert _rows() == []


def test_an_evening_with_nothing_to_say_claims_nothing(evening):
    from time import monotonic

    from arete import scheduler

    _settings, produce, _sent = evening
    assert scheduler.write_evening_message(monotonic()) == "nothing to say"
    produce.assert_not_called()
    assert _rows() == []


def test_a_failed_scheduled_run_is_not_pushed_nor_replayed(evening):
    from time import monotonic

    from arete import scheduler

    _settings, produce, sent = evening
    _plan(1)
    produce.side_effect = RuntimeError("provider down")
    assert scheduler.write_evening_message(monotonic()).startswith("failed")
    produce.side_effect = None
    assert scheduler.write_evening_message(monotonic()) == "already failed"
    assert produce.call_count == 1
    sent.assert_not_called()


def test_an_unreachable_athlete_spends_no_request(db):
    settings = {"timezone": "Europe/Paris", "coach_evening_enabled": True}
    # No Web Push keys in tests: the push could not leave.
    assert evening_message.unreachable(settings) == "clés Web Push absentes du serveur"
    settings["notification_preferences"] = {"kinds": {"evening": False}}
    assert evening_message.unreachable(settings) == "type de notification désactivé"


def test_the_pass_skips_athletes_outside_their_evening(db, monkeypatch):
    from arete import scheduler
    from arete.services.settings import QuietHours

    paris = ZoneInfo("Europe/Paris")
    day = athlete_today()

    def at(hour: int, minute: int = 0) -> float:
        return datetime.combine(day, time(hour, minute), tzinfo=paris).timestamp()

    quiet = QuietHours()
    start = scheduler.EVENING_MESSAGE_FROM_HOUR
    assert not scheduler.evening_owed(at(17, 59), "Europe/Paris", quiet, start)
    assert scheduler.evening_owed(at(20, 5), "Europe/Paris", quiet, start)
    assert not scheduler.evening_owed(at(21, 45), "Europe/Paris", quiet, start)
    seen = []
    monkeypatch.setattr(
        scheduler, "write_evening_message", lambda started: seen.append(1) or "x"
    )
    monkeypatch.setattr(
        scheduler, "utc_now", lambda: datetime.combine(day, time(16), tzinfo=paris)
    )
    assert scheduler.run_evening_messages()["athletes"] == {}
    assert seen == []


def test_the_message_has_its_own_cron_windows():
    from pathlib import Path

    crons = json.loads((Path(__file__).parents[1] / "vercel.json").read_text())["crons"]
    hours = sorted(
        int(c["schedule"].split()[1])
        for c in crons
        if c["path"] == "/api/cron/evening-message"
    )
    # Paris's 20:00 in summer (18 UTC) and winter (19 UTC); 21:00 in winter.
    assert hours == [18, 19, 20]


# --------------------------------------------------------------------------- #
# The athlete's answer: kept once, filed once, read tomorrow
# --------------------------------------------------------------------------- #
def test_the_answer_is_kept_and_filed_in_the_journal_once(db):
    _plan(1)
    message = _written()
    saved = evening_message.answer(message.id, "  Jambes lourdes, nuit courte. ")
    assert saved["answer"] == "Jambes lourdes, nuit courte."
    assert saved["journal"] == "written"
    again = evening_message.answer(message.id, "Jambes lourdes, nuit courte.")
    assert again["journal"] == "already"
    notes = _notes()
    assert notes.count("Question du soir") == 1
    assert f"{athlete_today().isoformat()} — Question du soir" in notes
    assert "« Comment sont tes jambes ? »" in notes and "nuit courte" in notes
    with pytest.raises(evening_message.EveningConflict):
        evening_message.answer(message.id, "Finalement très bien.")


def test_concurrent_answers_file_one_journal_entry(db):
    _plan(1)
    message = _written()
    start = Barrier(3)

    def run(_):
        start.wait(timeout=5)
        try:
            return evening_message.answer(message.id, "Bien.")["journal"]
        except evening_message.EveningConflict:
            return "conflict"

    with ThreadPoolExecutor(max_workers=3) as pool:
        outcomes = list(pool.map(run, range(3)))
    assert outcomes.count("written") == 1
    assert _notes().count("Question du soir") == 1


def test_a_failed_filing_never_fails_the_saved_answer(db, monkeypatch):
    from arete.services import memory

    _plan(1)
    message = _written()
    original = memory.append_entry
    monkeypatch.setattr(
        memory, "append_entry", MagicMock(side_effect=OSError("ledger down"))
    )
    assert evening_message.answer(message.id, "Bien.")["journal"] == "failed"
    assert _rows()[0][2] == "Bien."
    monkeypatch.setattr(memory, "append_entry", original)
    # Sending the same answer again files what the failure left out.
    assert evening_message.answer(message.id, "Bien.")["journal"] == "written"
    assert _notes().count("Question du soir") == 1


def test_a_question_about_a_day_gone_by_takes_no_answer(db):
    _plan(1)
    message = _written()
    con = connect()
    con.execute(
        "UPDATE app.coach_evening_messages SET date = ? WHERE id = ?",
        [athlete_today() - timedelta(days=2), message.id],
    )
    con.close()
    with pytest.raises(evening_message.EveningConflict):
        evening_message.answer(message.id, "Bien.")


def test_the_next_briefing_reads_the_answer(db):
    from arete.services.briefing import briefing_facts

    _plan(1)
    message = _written()
    tomorrow = athlete_today() + timedelta(days=1)
    assert "Ta question d'hier soir" not in briefing_facts(tomorrow, "Règle.")
    evening_message.answer(message.id, "Jambes lourdes.")
    facts = briefing_facts(tomorrow, "Règle.")
    assert (
        "Ta question d'hier soir et sa réponse :\n"
        "- Ta question : Comment sont tes jambes ?\n- Réponse : Jambes lourdes."
    ) in facts


def test_the_coach_reads_the_referenced_message(db):
    from arete.services.coach_today import reference

    _plan(1)
    message = _written()
    ref = reference(f"evening:{message.id}")
    assert ref["kind"] == "evening"
    assert ref["record"]["question"] == "Comment sont tes jambes ?"
    assert "error" not in ref["record"] and "status" not in ref["record"]


def test_the_http_contract(db, router_client):
    from arete.api.coach import router

    _plan(1)
    message = _written()
    client = router_client(router)
    read = client.get(f"/coach/evening/{message.id}")
    assert read.status_code == 200 and read.json()["answer"] is None
    assert client.get(f"/coach/evening/{message.id + 1}").status_code == 404
    answered = client.post(f"/coach/evening/{message.id}/answer", json={"text": "Ok."})
    assert answered.status_code == 200 and answered.json()["journal"] == "written"
    conflict = client.post(
        f"/coach/evening/{message.id}/answer", json={"text": "Autre."}
    )
    assert conflict.status_code == 409
    empty = client.post(f"/coach/evening/{message.id}/answer", json={"text": ""})
    assert empty.status_code == 422


def test_written_messages_leave_with_the_export_claims_do_not(db):
    from arete.services import data_export

    _plan(1)
    message = _written()
    evening_message.answer(message.id, "Bien.")
    con = connect()
    con.execute(
        "INSERT INTO app.coach_evening_messages (date, created_at) VALUES (?, now())",
        [athlete_today() - timedelta(days=1)],
    )
    con.close()
    body = json.loads(data_export.build("json").content)
    [row] = body["tables"]["evening_messages"]
    assert row["answer"] == "Bien." and row["question"] == "Comment sont tes jambes ?"


# --------------------------------------------------------------------------- #
# Settings, migration and the request it costs
# --------------------------------------------------------------------------- #
def test_off_by_default_and_an_older_client_cannot_reset_it(db):
    from arete.services.settings import (
        UserSettingsUpdate,
        get_settings,
        update_settings,
    )

    assert get_settings().coach_evening_enabled is False
    assert get_settings().coach_evening_hour == 20
    update_settings(
        UserSettingsUpdate(coach_evening_enabled=True, coach_evening_hour=21)
    )
    update_settings(UserSettingsUpdate())  # a bundle that predates the setting
    out = get_settings()
    assert (out.coach_evening_enabled, out.coach_evening_hour) == (True, 21)
    with pytest.raises(ValueError):
        UserSettingsUpdate(coach_evening_hour=23)


def test_migration_52_runs_once_on_a_schema_51_database(db, monkeypatch):
    from arete.dataio import init_duckdb, tenant_schema

    path = db / "evening.duckdb"
    con = duckdb.connect(str(path))
    configure_athlete(con)
    con.execute("DROP VIEW app.visible_coach_evening_messages")
    con.execute("DROP TABLE app.coach_evening_messages")
    con.execute("DROP SEQUENCE app.coach_evening_messages_seq")
    con.execute("DROP VIEW app.visible_user_settings")
    for column in ("coach_evening_enabled", "coach_evening_hour"):
        con.execute(f"ALTER TABLE app.user_settings DROP COLUMN {column}")
    tenant_schema._view(con, "user_settings")
    con.execute("DELETE FROM app.schema_version WHERE version = 52")
    assert init_duckdb.pending_migrations(con) == [52]
    con.close()

    init_duckdb.main()
    init_duckdb.main()  # recorded once, then skipped
    _plan(1)
    assert _written().status == "ok"
    con = duckdb.connect(str(path))
    count = con.execute(
        "SELECT count(*) FROM app.schema_version WHERE version = 52"
    ).fetchone()
    monkeypatch.setattr(init_duckdb, "MIGRATIONS", init_duckdb.MIGRATIONS[:-1])
    assert init_duckdb.pending_migrations(con) == []
    con.close()
    assert count == (1,)


def test_one_evening_costs_one_model_request_and_no_tool(db, monkeypatch, caplog):
    """The real composition with a fake model: the ``Agent run:`` line counts."""
    from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
    from langchain_core.messages import AIMessage

    from arete import coaching
    from arete.agent.runtime.context import AgentContext
    from arete.agent.runtime.execution import invoke_agent

    class Fake(GenericFakeChatModel):
        def bind_tools(self, tools, **kwargs):
            assert not tools, "the evening binds no tool"
            return self

    monkeypatch.setenv("LLM_PROVIDER", "ollama")
    monkeypatch.setenv("LLM_MODEL", "test-coach")
    monkeypatch.setenv("LANGSMITH_TRACING", "false")
    monkeypatch.setattr(
        coaching,
        "build_chat_model",
        lambda **kw: Fake(messages=iter([AIMessage(content=MESSAGE)])),
    )
    coaching.build_evening_agent.cache_clear()
    caplog.set_level(logging.INFO, logger="arete.observability.agent")
    try:
        result = asyncio.run(
            invoke_agent(
                coaching.build_evening_agent(),
                {"messages": [{"role": "user", "content": "Faits du soir."}]},
                context=AgentContext(profile="evening"),
            )
        )
    finally:
        coaching.build_evening_agent.cache_clear()
    assert result["messages"][-1].text == MESSAGE
    (line,) = [r.getMessage() for r in caplog.records if "Agent run:" in r.getMessage()]
    assert "profile=evening calls=1 tools=0" in line
