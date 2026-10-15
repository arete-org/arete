"""Stamp each new human turn once and render its immutable runtime context.

Run after native summarization and before the complete-request budget check:
compaction must not remove today's reference, and timestamps consume the same
budget as every other contribution. Cached middleware holds no per-run state.
"""

from datetime import datetime, timedelta

from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import HumanMessage, SystemMessage

from arete.agent.runtime.context import MESSAGE_SENT_AT_KEY, AgentContext

CHAT_CLOCK_INSTRUCTION = (
    "Résous les dates relatives avec le bloc server_datetime du dernier message "
    "humain : c’est l’heure du début du tour, pas une horloge en temps réel. "
    "Les horodatages des anciens messages restent ceux de leur envoi."
)


def _stamp_content(message: HumanMessage, moment: datetime) -> HumanMessage:
    # Use the saved offset so midnight, DST and timezone changes never rewrite
    # the bytes of an older turn. The original content/metadata remain intact.
    stamp = (
        "\n\n<server_datetime>\n"
        f"Envoi : {moment.isoformat(timespec='seconds')} (heure locale de l’athlète). "
        f"Demain : {(moment.date() + timedelta(days=1)).isoformat()}.\n"
        "</server_datetime>"
    )
    content = message.content
    return message.model_copy(
        update={
            "content": content + stamp
            if isinstance(content, str)
            else [*content, {"type": "text", "text": stamp}],
        }
    )


class RuntimeContextMiddleware(AgentMiddleware):
    def before_agent(self, state, runtime):
        context = runtime.context
        if not isinstance(context, AgentContext) or context.profile != "chat":
            return None
        current = next(
            (m for m in reversed(state["messages"]) if isinstance(m, HumanMessage)),
            None,
        )
        assert current is not None and current.id is not None, (
            "Chat requires an identified human message"
        )
        # A client may replay historical stamps but cannot set the current clock.
        stamped = current.model_copy(
            update={
                "additional_kwargs": {
                    **current.additional_kwargs,
                    MESSAGE_SENT_AT_KEY: context.current_datetime.isoformat(
                        timespec="seconds"
                    ),
                }
            }
        )
        return {"messages": [stamped]}

    async def abefore_agent(self, state, runtime):
        return self.before_agent(state, runtime)

    def _prepare(self, request):
        context = getattr(getattr(request, "runtime", None), "context", None)
        if not isinstance(context, AgentContext):
            return request
        if context.profile != "chat":
            today = context.current_date
            instruction = (
                f"Date actuelle : {today.isoformat()}. Demain : {(today + timedelta(days=1)).isoformat()}. "
                "Résous les dates relatives à partir de cette date, même si "
                "l’historique contient d’anciennes dates."
            )
            system = request.system_message.text if request.system_message else ""
            return request.override(
                system_message=SystemMessage(system + "\n\n" + instruction)
            )
        messages = list(request.messages)
        latest = next(
            (
                i
                for i in range(len(messages) - 1, -1, -1)
                if isinstance(messages[i], HumanMessage)
            ),
            None,
        )
        assert latest is not None, "Chat runtime context requires a human message"
        for index, message in enumerate(messages):
            if not isinstance(message, HumanMessage):
                continue
            if index == latest:
                # A compacted summary may have replaced the original question.
                moment = context.current_datetime
            elif sent_at := message.additional_kwargs.get(MESSAGE_SENT_AT_KEY):
                moment = datetime.fromisoformat(sent_at)
            else:
                # Legacy history has no known timestamp; do not invent one.
                continue
            messages[index] = _stamp_content(message, moment)
        system = request.system_message.text if request.system_message else ""
        return request.override(
            messages=messages,
            system_message=SystemMessage(system + "\n\n" + CHAT_CLOCK_INSTRUCTION),
        )

    def wrap_model_call(self, request, handler):
        return handler(self._prepare(request))

    async def awrap_model_call(self, request, handler):
        return await handler(self._prepare(request))
