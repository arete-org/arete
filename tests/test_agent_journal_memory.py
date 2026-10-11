"""The journal goes into the prompt, bounded, so the agent stops fetching it.

Reading it by tools cost two or three model requests per question before any
real work, and the free tier allows 50 a day. Injected, it costs tokens
instead — so the injection has to stay bounded whatever the agent writes.
"""

from __future__ import annotations

import pytest
from langchain_core.messages import SystemMessage

from arete.agent.context.builder import build_context
from arete.services.journal import (
    MAX_NOTES_CHARS,
    MAX_SESSIONS_CHARS,
    RECENT_SESSION_ENTRIES,
    journal_block,
    recent_entries,
)


def _entries(count: int, body: str = "faits") -> str:
    return "\n".join(
        f"## 2026-09-{d:02d} — séance {d}\n- {body}\n" for d in range(1, count + 1)
    )


@pytest.fixture
def journal(tmp_path):
    root = tmp_path / "memory"
    root.mkdir()
    return root


# ---------------------------------------------------------------------------
# What gets picked
# ---------------------------------------------------------------------------


def test_the_latest_entries_come_in_order():
    out, older_left = recent_entries(_entries(20), 5, 10_000)
    headings = [line for line in out.splitlines() if line.startswith("## ")]
    assert headings[0].startswith("## 2026-09-16") and headings[-1].startswith(
        "## 2026-09-20"
    )
    assert older_left


def test_a_short_journal_comes_whole():
    out, older_left = recent_entries(_entries(3), 5, 10_000)
    assert out.count("## ") == 3
    assert not older_left


def test_entries_are_never_split():
    out, _ = recent_entries(_entries(20, "x" * 900), 5, 2_500)
    # Each kept entry is whole: heading and its body together.
    for block in out.split("\n\n"):
        assert block.startswith("## ") and "x" * 900 in block


# ---------------------------------------------------------------------------
# The bound holds whatever the agent wrote
# ---------------------------------------------------------------------------


def test_one_giant_entry_is_clipped_to_the_budget():
    giant = "## 2026-10-01 — énorme\n" + "x" * (MAX_SESSIONS_CHARS * 3)
    out, _ = recent_entries(giant, RECENT_SESSION_ENTRIES, MAX_SESSIONS_CHARS)
    assert len(out) <= MAX_SESSIONS_CHARS + 2


def test_the_whole_block_has_a_ceiling(journal):
    (journal / "notes.md").write_text("n" * (MAX_NOTES_CHARS * 5))
    (journal / "sessions.md").write_text(_entries(200, "y" * 500))
    block = journal_block(journal)
    # Both budgets plus the headings and pointers, and nothing like the files.
    assert len(block) < MAX_NOTES_CHARS + MAX_SESSIONS_CHARS + 1_000


def test_cut_notes_say_where_the_rest_is(journal):
    (journal / "notes.md").write_text("n" * (MAX_NOTES_CHARS + 50))
    assert "read_file" in journal_block(journal)


def test_the_newest_notes_survive_the_cut(journal):
    # Notes are appended: past the budget, the oldest go first, never the newest.
    old = "".join(f"- 2026-01-{i:02d} — ancienne : {'x' * 200}\n" for i in range(1, 30))
    (journal / "notes.md").write_text(old + "- 2026-10-09 — tendon : Achille droit\n")
    block = journal_block(journal)
    assert "2026-10-09 — tendon" in block
    assert "2026-01-01" not in block
    assert "début de notes.md" in block


def test_an_empty_journal_adds_nothing(journal):
    assert journal_block(journal) == ""


# ---------------------------------------------------------------------------
# Where it lands
# ---------------------------------------------------------------------------


class _Request:
    def __init__(self, system_message=None):
        self.system_message = system_message
        self.tools = []
        self.messages = []

    def override(self, **kw):
        return _Request(kw.get("system_message", self.system_message))


def test_it_ends_the_system_prompt_and_leaves_the_caller_alone(journal, monkeypatch):
    import arete.services.memory as module

    (journal / "notes.md").write_text("- Objectif: semi en 1h35")
    monkeypatch.setattr(module, "memory_root", lambda: journal)
    seen: list[str] = []
    request = _Request(SystemMessage("Tu es le coach."))

    seen.append(build_context(request).system_message.text)

    assert seen[0].startswith("Tu es le coach.")
    assert seen[0].rstrip().endswith("(vide)") or "semi en 1h35" in seen[0]
    assert request.system_message.text == "Tu es le coach."


def test_no_journal_means_an_untouched_request(journal, monkeypatch):
    import arete.services.memory as module

    monkeypatch.setattr(module, "memory_root", lambda: journal)
    request = _Request(SystemMessage("Tu es le coach."))
    result = build_context(request)
    assert "Ton journal" not in result.system_message.text
    assert request.system_message.text == "Tu es le coach."


# ---------------------------------------------------------------------------
# The prompts stopped asking for the ritual
# ---------------------------------------------------------------------------


def test_no_prompt_tells_the_agent_to_read_its_journal_first():
    from arete.agent.profiles.catalog import PROFILES
    from arete.agent.prompts.coach import SYSTEM_SKILL

    for prompt in (SYSTEM_SKILL, *(p.instructions for p in PROFILES.values())):
        assert "Lis le journal" not in prompt
        assert "Relis ton journal" not in prompt
        assert "Lis ton journal" not in prompt
