"""Framework interception for durable automation budgets and approved effects."""

from functools import partial

from anyio import to_thread
from langchain.agents.middleware import AgentMiddleware, HumanInTheLoopMiddleware
from langchain_core.messages import ToolMessage

from arete.agent.capabilities.discovery import authorized_tools, tool_available
from arete.agent.capabilities.registry import CAPABILITIES
from arete.services import automation_execution as execution


def read_names():
    return frozenset(
        {name for tk in CAPABILITIES.values() for name in tk.read_tools}
        | {"ls", "read_file", "glob", "grep"}
    )


def hitl(profile):
    names = {tool.name for tool in authorized_tools(profile)} | {
        "edit_file",
        "delete",
        "append_journal",
        "respond_coach_followup",
    }
    return HumanInTheLoopMiddleware(
        interrupt_on={
            **{
                name: {"allowed_decisions": ["approve", "edit", "reject"]}
                for name in names - read_names()
            },
            "ask_athlete": {"allowed_decisions": ["respond", "reject"]},
        },
        interrupt_mode="per_call",
    )


class AutomationBudgetMiddleware(AgentMiddleware):
    async def awrap_model_call(self, request, handler):
        await to_thread.run_sync(
            execution.charge, request.runtime.context.thread_id, "model_turns"
        )
        return await handler(request)

    async def awrap_tool_call(self, request, handler):
        name = request.tool_call["name"]
        identifier = request.runtime.context.thread_id
        await to_thread.run_sync(execution.charge_tool, identifier, request.tool_call)
        if not tool_available("automation", name):
            raise PermissionError("Outil interdit pour une mission planifiée")
        if name not in read_names() and name != "ask_athlete":
            await to_thread.run_sync(execution.propose, identifier, request.tool_call)
        return await handler(request)


class AutomationRequestBudgetMiddleware(AgentMiddleware):
    async def awrap_model_call(self, request, handler):
        await to_thread.run_sync(
            execution.charge, request.runtime.context.thread_id, "model_requests"
        )
        return await handler(request)


class AutomationEffectsMiddleware(AgentMiddleware):
    async def awrap_tool_call(self, request, handler):
        identifier, call = request.runtime.context.thread_id, request.tool_call
        if call["name"] in read_names():
            return await handler(request)
        # HITL is outside this wrapper: no effect is started before approval.
        cached = await to_thread.run_sync(execution.begin_effect, identifier, call)
        if cached is not None:
            return ToolMessage.model_validate_json(cached)
        result = await handler(request)
        if not isinstance(result, ToolMessage):
            raise RuntimeError("Écriture sans reçu vérifiable ; mission arrêtée")
        if result.status == "error" or '"uncertain"' in str(result.content):
            raise RuntimeError("Écriture en erreur ou incertaine ; aucun rejeu")
        await to_thread.run_sync(
            partial(
                execution.end_effect, identifier, call["id"], result.model_dump_json()
            )
        )
        return result
