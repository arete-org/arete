"""Framework adapters for runtime call and concurrency limits."""

from langchain.agents.middleware import (
    AgentMiddleware,
    ModelCallLimitMiddleware,
    ToolCallLimitMiddleware,
)

from arete.agent.runtime.budget import MAX_MODEL_CALLS, MAX_TOOL_CALLS
from arete.agent.runtime.context import AgentContext


def execution_limits() -> list:
    # Framework state is per invocation; a cached graph must not share counters.
    return [
        PreflightBudgetMiddleware(),
        ToolConcurrencyMiddleware(),
        ModelCallLimitMiddleware(run_limit=MAX_MODEL_CALLS, exit_behavior="error"),
        ToolCallLimitMiddleware(run_limit=MAX_TOOL_CALLS, exit_behavior="error"),
    ]


class ToolConcurrencyMiddleware(AgentMiddleware):
    async def awrap_tool_call(self, request, handler):
        context = request.runtime.context
        assert isinstance(context, AgentContext), (
            "AgentContext required for tool limits"
        )
        async with context.tool_slots:
            return await handler(request)

    def wrap_tool_call(self, request, handler):
        # The synchronous ToolNode honors run_config's max_concurrency.
        return handler(request)


class PreflightBudgetMiddleware(AgentMiddleware):
    """Charge preflight work through trusted context, never private graph inputs."""

    def before_agent(self, state, runtime):
        context = runtime.context
        if isinstance(context, AgentContext) and context.classifier_calls:
            assert context.classifier_calls == 1, "Only one classifier call is allowed"
            return {"run_model_call_count": context.classifier_calls}
        return None

    async def abefore_agent(self, state, runtime):
        return self.before_agent(state, runtime)
