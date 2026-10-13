"""Server-selected profiles sharing one coaching runtime."""

from dataclasses import replace

from arete.agent.profiles.models import AgentProfile, ProfileId
from arete.agent.prompts.briefing import BRIEFING_PROMPT
from arete.agent.prompts.coach import CHAT_INSTRUCTIONS
from arete.agent.prompts.product import SLACK_SYSTEM
from arete.agent.prompts.session_feedback import FEEDBACK_PROMPT
from arete.agent.prompts.weekly_review import REVIEW_PROMPT

CHAT_PROFILE = AgentProfile(
    "chat",
    "arete_coach",
    CHAT_INSTRUCTIONS,
    ("analytics", "planning", "strength", "garmin"),
    # Native binding avoids discovery round trips. Permissions are still
    # checked independently at execution, including cached graphs.
    training_writes=True,
    page_context=True,
    filesystem_tools=True,
    journal_tools=True,
    fact_memory_tools=True,
)

PROFILES: dict[ProfileId, AgentProfile] = {
    "chat": CHAT_PROFILE,
    "slack": replace(
        CHAT_PROFILE,
        id="slack",
        instructions="",
        # Compilation includes every possible tool. Invocation policy narrows
        # this envelope before context reads, model binding and execution.
        capabilities=(*CHAT_PROFILE.capabilities, "slack_product", "admin_data"),
        system_prompt=SLACK_SYSTEM,
        personal_context=False,
        external_write_tools=frozenset(
            {"ping_slack_member", "schedule_slack_reminder", "cancel_slack_reminder"}
        ),
    ),
    # Missions get their facts in the message and answer in one request:
    # no tool is bound, the server reads the data and files the journal.
    "briefing": AgentProfile("briefing", "arete_briefing", BRIEFING_PROMPT, ()),
    "feedback": AgentProfile("feedback", "arete_session_feedback", FEEDBACK_PROMPT, ()),
    "review": AgentProfile("review", "arete_weekly_review", REVIEW_PROMPT, ()),
}


def get_profile(profile_id: str) -> AgentProfile:
    if profile_id not in PROFILES:
        raise ValueError(f"Unknown agent profile: {profile_id}")
    return PROFILES[profile_id]  # type: ignore[index]
