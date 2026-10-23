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

    def _prepare(self, context):
        assert isinstance(context, AgentContext), "Server invocation context required"
        assert context.profile == self.profile_id, (
            "Invocation profile differs from compiled policy"
        )
        if context.policy_prepared:
            return
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
        context.policy_prepared = True

    def before_agent(self, state, runtime):
        self._prepare(runtime.context)

    async def abefore_agent(self, state, runtime):
        return self.before_agent(state, runtime)

    # Resuming a checkpoint can start at ToolNode and skip before_agent entirely.
    # Dependencies remain invocation-local and must exist before that first tool.
    def wrap_tool_call(self, request, handler):
        self._prepare(request.runtime.context)
        return handler(request)

    async def awrap_tool_call(self, request, handler):
        self._prepare(request.runtime.context)
        return await handler(request)

    def wrap_model_call(self, request, handler):
        self._prepare(request.runtime.context)
        return handler(request)

    async def awrap_model_call(self, request, handler):
        self._prepare(request.runtime.context)
        return await handler(request)
