"""Register the domain operation for dated, deduplicated journal entries."""

from langchain.agents.middleware import AgentMiddleware

from arete.agent.tools.journal import append_journal


class JournalMiddleware(AgentMiddleware):
    tools = [append_journal]
