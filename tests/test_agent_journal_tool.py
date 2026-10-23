"""append_journal: dated, deduplicated new journal entries."""

import json

import pytest

from arete.agent.tools.journal import MAX_BODY_CHARS, append_journal
from arete.services.memory import read_file as read_memory_file
from arete.services.settings import athlete_today


@pytest.fixture
def memory(tmp_path, monkeypatch):
    from arete.services import memory as fs

    root = tmp_path / "memory"
    root.mkdir()
    monkeypatch.setattr(fs, "memory_root", lambda: root)
    return root


def _call(**args):
    return json.loads(append_journal.invoke(args))


def test_an_entry_is_filed_under_a_server_dated_heading(memory):
    out = _call(file="notes.md", title="tendon", body="gêne à l'Achille droit")
    assert out["written"] is True
    today = athlete_today().isoformat()
    assert read_memory_file("notes.md").content.startswith(f"- {today} — tendon :")


def test_a_session_can_be_filed_on_its_own_day(memory):
    _call(file="sessions.md", title="trail", body="20 km", day="2026-10-05")
    assert read_memory_file("sessions.md").content.startswith("## 2026-10-05 — trail")


def test_the_same_entry_twice_writes_once(memory):
    _call(file="sessions.md", title="trail", body="20 km", day="2026-10-05")
    out = _call(file="sessions.md", title="trail", body="20 km", day="2026-10-05")
    assert out["written"] is False


def test_bad_input_is_an_error_for_the_model_not_an_exception(memory):
    assert "error" in _call(file="notes.md", title="x", body="y", day="hier")
    assert "error" in _call(file="notes.md", title="x", body="y" * (MAX_BODY_CHARS + 1))
    assert "error" in _call(file="notes.md", title=" ", body="y")
    assert read_memory_file("notes.md").forgotten


def test_the_schema_has_no_nullable_parameter():
    # anyOf-nullable params make some free providers reject every request.
    assert "anyOf" not in json.dumps(append_journal.args_schema.model_json_schema())
