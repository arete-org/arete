"""Start optional title work without putting a provider wait before chat tokens."""

import asyncio

from langchain.agents.middleware import AgentMiddleware

from arete.agent.runtime.context import AgentContext


class ConversationTitleMiddleware(AgentMiddleware):
    def __init__(self, generate):
        self.generate = generate

    def before_agent(self, state, runtime):
        # Diagnostic synchronous graph calls cannot own an async title task.
        # Production entrypoints invoke the graph on the server event loop.
        return None

    async def abefore_agent(self, state, runtime):
        context = runtime.context
        if (
            not isinstance(context, AgentContext)
            or context.profile != "chat"
            or not context.thread_id
            or context.title_task is not None
        ):
            return None
        first = next((m.text for m in state["messages"] if m.type == "human"), "")
        # The runtime owns task cleanup; a cached middleware owns no run state.
        context.title_task = asyncio.create_task(
            self.generate(context, first, runtime.stream_writer)
        )
        return None
