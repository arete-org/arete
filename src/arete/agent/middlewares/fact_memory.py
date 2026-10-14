"""Bind durable-fact tools and adapt invocation provenance/budget hooks."""

from langchain.agents.middleware import AgentMiddleware

from arete.agent.models.jev import JevClient
from arete.agent.runtime.context import AgentContext
from arete.agent.runtime.fact_memory import charge_memory_calls, prepare_fact_memory
from arete.agent.tools.fact_memory import forget_fact, remember_fact


class FactMemoryMiddleware(AgentMiddleware):
    tools = [remember_fact, forget_fact]

    def __init__(self, *, model: JevClient | None):
        self.model = model

    def before_agent(self, state, runtime):
        assert isinstance(runtime.context, AgentContext)
        prepare_fact_memory(state.get("messages", []), runtime.context, self.model)

    async def abefore_agent(self, state, runtime):
        return self.before_agent(state, runtime)

    def before_model(self, state, runtime):
        assert isinstance(runtime.context, AgentContext)
        return charge_memory_calls(state, runtime.context)

    async def abefore_model(self, state, runtime):
        return self.before_model(state, runtime)
