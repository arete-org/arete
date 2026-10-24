"""Adapt native interception to durable question and execution policies."""

import json
from functools import partial

from anyio import to_thread
from langchain.agents.middleware import AgentMiddleware, HumanInTheLoopMiddleware
from langchain_core.load import dumps, loads
from langchain_core.messages import ToolMessage
from langgraph.types import Command
from pydantic import Field, create_model

from arete.agent.capabilities.registry import READ_TOOL_NAMES, REVIEW_TOOLS
from arete.services import coaching_runs as runs
from arete.services.human_input import QuestionField


def reviewable(tool):
    if (
        tool.name not in REVIEW_TOOLS
        or "requires_review" in tool.get_input_schema().model_fields
    ):
        return tool
    # This is an interpretation hint, never an authorization grant. Profile and
    # backend policy still decide whether a tool is allowed at all.
    schema = create_model(
        "Reviewable" + tool.name,
        __base__=tool.get_input_schema(),
        requires_review=(
            bool,
            Field(
                default=False,
                description="True for a coach-initiated sensitive proposal; false only for an explicit athlete command. Ambiguous details require ask_athlete first.",
            ),
        ),
    )
    return tool.model_copy(update={"args_schema": schema})


def chat_hitl():
    return HumanInTheLoopMiddleware(
        interrupt_mode="per_call",
        interrupt_on={
            name: {
                "allowed_decisions": ["approve", "edit", "reject"],
                "when": lambda request: bool(
                    request.tool_call["args"].get("requires_review")
                ),
            }
            for name in REVIEW_TOOLS
        },
    )


class ChatRequestBudgetMiddleware(AgentMiddleware):
    """Charge every provider attempt, including fallback, across resumes."""

    async def awrap_model_call(self, request, handler):
        await to_thread.run_sync(
            runs.charge_model, request.runtime.context.execution_id
        )
        return await handler(request)


class ChatBudgetMiddleware(AgentMiddleware):
    async def awrap_tool_call(self, request, handler):
        context = request.runtime.context
        call = request.tool_call
        await to_thread.run_sync(
            partial(
                runs.prepare_call,
                context.execution_id,
                call,
                write=call["name"] not in READ_TOOL_NAMES
                and call["name"] != "ask_athlete",
            )
        )
        return await handler(request)


class HumanQuestionMiddleware(AgentMiddleware):
    async def awrap_tool_call(self, request, handler):
        if request.tool_call["name"] != "ask_athlete":
            return await handler(request)
        from arete.agent.runtime.human_input import ask
        from arete.agent.tools.automations import ask_athlete

        args = ask_athlete.get_input_schema().model_validate(request.tool_call["args"])
        fields = args.fields or [
            QuestionField(key="answer", label="Ta réponse", kind="text")
        ]
        result = ask(args.question, fields, request.tool_call["id"])
        return ToolMessage(
            content=result, tool_call_id=request.tool_call["id"], name="ask_athlete"
        )


class ChatEffectsMiddleware(AgentMiddleware):
    async def awrap_tool_call(self, request, handler):
        call = request.tool_call
        if "requires_review" in call["args"]:
            request = request.override(
                tool_call={
                    **call,
                    "args": {
                        k: v for k, v in call["args"].items() if k != "requires_review"
                    },
                }
            )
        if (
            request.tool
            and "requires_review" in request.tool.get_input_schema().model_fields
        ):
            request = request.override(
                tool=request.tool.model_copy(
                    update={"args_schema": request.tool.get_input_schema().__bases__[0]}
                )
            )
        if call["name"] in READ_TOOL_NAMES or call["name"] == "ask_athlete":
            return await handler(request)
        identifier = request.runtime.context.execution_id
        cached = await to_thread.run_sync(
            runs.begin_effect, identifier, request.tool_call
        )
        if cached is not None:
            receipt = json.loads(cached)
            if receipt.get("kind") == "command":
                return Command(
                    update=loads(receipt["update"], allowed_objects="messages")
                )
            return ToolMessage.model_validate_json(receipt["message"])
        result = await handler(request)
        if (
            isinstance(result, Command)
            and isinstance(result.update, dict)
            and result.goto == ()
            and result.resume is None
            and result.graph is None
        ):
            encoded = json.dumps({"kind": "command", "update": dumps(result.update)})
        elif isinstance(result, ToolMessage):
            encoded = json.dumps(
                {"kind": "message", "message": result.model_dump_json()}
            )
        else:
            raise RuntimeError("Écriture sans reçu vérifiable ; reprise interdite.")
        # Even a domain failure may have partially committed. Keep its exact
        # receipt; replaying the call can never be a retry mechanism.
        await to_thread.run_sync(runs.end_effect, identifier, call["id"], encoded)
        return result
