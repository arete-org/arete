"""Assert that invocation policy matches the server-selected compiled profile."""

from collections.abc import Callable

from langchain.agents.middleware import AgentMiddleware

from arete.agent.profiles.models import AgentProfile
from arete.agent.runtime.context import AgentContext
from arete.agent.runtime.policy import slack_policy
from arete.services.calendar import CalendarService


class ProfilePolicyMiddleware(AgentMiddleware):
    def __init__(
        self,
        profile_id: str,
        *,
        profile: AgentProfile | None = None,
        calendar: Callable[[str], CalendarService] | None = None,
    ):
        self.profile_id = profile_id
        self.profile = profile
        self.calendar = calendar

    def before_agent(self, state, runtime):
        context = runtime.context
        assert isinstance(context, AgentContext), "Server invocation context required"
        assert context.profile == self.profile_id, (
            "Invocation profile differs from compiled policy"
        )
        context.resolved_profile = (
            slack_policy(context) if self.profile_id == "slack" else self.profile
        )
        # The calendar is the caller's own: built per run from the verified
        # account, absent for the API key and for background missions.
        context.calendar = (
            self.calendar(context.account_id)
            if self.calendar and context.account_id
            else None
        )
        return None

    async def abefore_agent(self, state, runtime):
        return self.before_agent(state, runtime)
