"""Prompt hygiene: one date notation, no dead tool, missions name no tool."""

import pytest

from arete.agent.capabilities.registry import CAPABILITIES
from arete.agent.prompts.briefing import BRIEFING_PROMPT
from arete.agent.prompts.coach import CHAT_INSTRUCTIONS, SYSTEM_SKILL
from arete.agent.prompts.evening import EVENING_PROMPT
from arete.agent.prompts.session_feedback import FEEDBACK_PROMPT
from arete.agent.prompts.weekly_review import REVIEW_PROMPT

ALL = {
    "core": SYSTEM_SKILL,
    "chat": CHAT_INSTRUCTIONS,
    "briefing": BRIEFING_PROMPT,
    "feedback": FEEDBACK_PROMPT,
    "review": REVIEW_PROMPT,
    "evening": EVENING_PROMPT,
    **{f"toolkit:{tid}": tk.instructions for tid, tk in CAPABILITIES.items()},
}
REMOVED_TOOLS = (
    "prepare_import",
    "inspect_import",
    "get_page_context",
    "load_toolkit",
    "search_toolkits",
    "write_file",
    "`ls`",
)


@pytest.mark.parametrize("name", ALL)
def test_no_prompt_names_a_removed_tool_or_a_second_date_notation(name):
    text = ALL[name]
    assert "AAAA-MM-JJ" not in text
    assert not [tool for tool in REMOVED_TOOLS if tool in text]


@pytest.mark.parametrize(
    "prompt",
    [SYSTEM_SKILL, BRIEFING_PROMPT, FEEDBACK_PROMPT, REVIEW_PROMPT, EVENING_PROMPT],
)
def test_shared_and_mission_prompts_name_no_tool(prompt):
    # The core reaches tool-less missions; a tool named there is one they lack.
    for tool in (
        "get_page_context",
        "append_journal",
        "remember_fact",
        "read_file",
        "edit_file",
        "delete",
        "get_workload",
    ):
        assert tool not in prompt


def test_a_logged_strength_correction_is_one_rule_in_its_toolkit():
    holders = [name for name, text in ALL.items() if "update_workout" in text]
    assert holders == ["toolkit:strength"]
    rule = next(
        line
        for line in ALL["toolkit:strength"].splitlines()
        if "update_workout" in line
    )
    assert "jamais save_workout" in rule


def test_briefing_prompt_tells_the_model_not_to_contradict_the_decision():
    assert "ne la contredis pas" in BRIEFING_PROMPT
