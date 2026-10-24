"""Assemble a graph from explicit dependencies; no business work or model routing."""

from collections.abc import Callable
from typing import Any

from langchain.agents import create_agent
from langchain.agents.middleware import (
    AgentMiddleware,
    ModelFallbackMiddleware,
    ToolRetryMiddleware,
)
from langchain_core.language_models import BaseChatModel
from langchain_core.tools import BaseTool
from requests.exceptions import ConnectionError as RequestsConnectionError
from requests.exceptions import Timeout as RequestsTimeout

from arete.agent.capabilities.discovery import authorized_tools
from arete.agent.capabilities.registry import CAPABILITIES
from arete.agent.middlewares.capabilities import ToolkitMiddleware
from arete.agent.middlewares.context import (
    ContextBudgetMiddleware,
    ContextBuilderMiddleware,
)
from arete.agent.middlewares.events import ToolEventMiddleware
from arete.agent.middlewares.fact_memory import FactMemoryMiddleware
from arete.agent.middlewares.journal import JournalMiddleware
from arete.agent.middlewares.limits import execution_limits
from arete.agent.middlewares.observability import ModelTelemetryMiddleware
from arete.agent.middlewares.policy import ProfilePolicyMiddleware
from arete.agent.middlewares.provider_affinity import ProviderAffinityMiddleware
from arete.agent.middlewares.responses import ModelResponseMiddleware
from arete.agent.middlewares.runtime_context import RuntimeContextMiddleware
from arete.agent.models.jev import JevClient
from arete.agent.profiles.models import AgentProfile
from arete.agent.prompts.coach import SYSTEM_SKILL
from arete.agent.runtime.budget import (
    MAX_MODEL_FALLBACKS,
    MAX_READ_TOOL_RETRIES,
    READ_TOOL_RETRY_DELAY_SECONDS,
)
from arete.agent.runtime.context import AgentContext
from arete.agent.tools.coach_followup import respond_coach_followup
from arete.services.calendar import CalendarService

#: Builds the calendar of one signed-in account (its Clerk user id).
CalendarFactory = Callable[[str], CalendarService]


def build_agent(
    profile: AgentProfile,
    *,
    model: BaseChatModel,
    context_tokens: int,
    output_tokens: int,
    filesystem: AgentMiddleware[Any, Any, Any],
    calendar: CalendarFactory | None = None,
    memory_model: JevClient | None = None,
    fallback_models: tuple[BaseChatModel, ...] = (),
    skills: AgentMiddleware[Any, Any, Any] | None = None,
    summarization: AgentMiddleware[Any, Any, Any] | None = None,
    title_generator=None,
    checkpointer=None,
):
    assert len(fallback_models) <= MAX_MODEL_FALLBACKS, "Too many fallback models"
    interactive = profile.id == "chat" and checkpointer is not None
    if interactive:
        from arete.agent.middlewares.human_input import (
            ChatBudgetMiddleware,
            ChatEffectsMiddleware,
            ChatRequestBudgetMiddleware,
            HumanQuestionMiddleware,
            chat_hitl,
            reviewable,
        )

        filesystem.tools = [reviewable(tool) for tool in filesystem.tools]
    middleware = [
        ProfilePolicyMiddleware(profile.id, profile=profile, calendar=calendar),
        *(
            [FactMemoryMiddleware(model=memory_model)]
            if profile.fact_memory_tools
            else []
        ),
        *execution_limits(),
    ]
    if profile.id == "chat" and title_generator is not None:
        from arete.agent.middlewares.conversation_title import (
            ConversationTitleMiddleware,
        )

        middleware.append(ConversationTitleMiddleware(title_generator))
    if interactive:
        middleware.extend(
            [
                ChatBudgetMiddleware(),
                chat_hitl(),
                HumanQuestionMiddleware(),
                ChatEffectsMiddleware(),
            ]
        )
    if profile.id == "automation":
        from arete.agent.middlewares.automation import (
            AutomationBudgetMiddleware,
            AutomationEffectsMiddleware,
            hitl,
        )
        from arete.agent.middlewares.human_input import HumanQuestionMiddleware

        middleware.extend(
            [
                AutomationBudgetMiddleware(),
                hitl(profile),
                HumanQuestionMiddleware(),
                AutomationEffectsMiddleware(),
            ]
        )
    if profile.filesystem_tools:
        # Offload only after inner hooks classify domain errors and extract UI
        # cards from the complete result. Storage failure must not replay a tool.
        middleware.append(filesystem)
    if profile.page_context:
        middleware.append(ToolEventMiddleware())
    # Wrap native execution, but never replay writes or infer retryability
    # from error strings. Each attempt still traverses ToolkitMiddleware's budget.
    retry_tools: list[BaseTool | str] = [
        name
        for name in sorted(
            {name for tk in CAPABILITIES.values() for name in tk.read_tools}
        )
    ]
    middleware.append(
        ToolRetryMiddleware(
            tools=retry_tools,
            max_retries=0 if profile.id == "automation" else MAX_READ_TOOL_RETRIES,
            retry_on=(
                ConnectionError,
                TimeoutError,
                RequestsConnectionError,
                RequestsTimeout,
            ),
            on_failure=lambda exc: (
                f"Lecture impossible après nouvelle tentative : {type(exc).__name__}: {exc}. "
                "Signale les données indisponibles ; ne les invente pas."
            ),
            initial_delay=READ_TOOL_RETRY_DELAY_SECONDS,
            max_delay=READ_TOOL_RETRY_DELAY_SECONDS,
            backoff_factor=1.0,
            jitter=False,
        )
    )
    middleware.append(ToolkitMiddleware())
    if profile.journal_tools:
        middleware.append(JournalMiddleware())
    if profile.filesystem_tools and skills is not None:
        middleware.append(skills)
    middleware.append(
        ContextBuilderMiddleware(
            # Native summarization must see the complete assembled request
            # before the final envelope guard rejects an oversized history.
            context_tokens=None if summarization is not None else context_tokens,
            output_tokens=output_tokens,
        )
    )
    if summarization is not None:
        middleware.append(summarization)
    middleware.append(RuntimeContextMiddleware())
    middleware.append(
        ContextBudgetMiddleware(
            context_tokens=context_tokens, output_tokens=output_tokens
        )
    )
    # Context/policy errors must not trigger fallback. Each provider attempt is
    # measured separately; model fallback never encloses tool execution.
    if fallback_models:
        middleware.append(ModelFallbackMiddleware(*fallback_models))
    if profile.id == "automation":
        from arete.agent.middlewares.automation import AutomationRequestBudgetMiddleware

        middleware.append(AutomationRequestBudgetMiddleware())
    if interactive:
        middleware.append(ChatRequestBudgetMiddleware())
    middleware.append(ProviderAffinityMiddleware())
    middleware.append(ModelTelemetryMiddleware())
    middleware.append(ModelResponseMiddleware())
    from arete.agent.tools.automations import ask_athlete

    if interactive:
        for adapter in middleware:
            # `AgentMiddleware.tools` is an annotation without a default:
            # read it the way create_agent does, or tool-less adapters crash.
            if getattr(adapter, "tools", None):
                adapter.tools = [reviewable(tool) for tool in adapter.tools]
    return create_agent(
        model,
        tools=[
            *(
                reviewable(tool) if interactive else tool
                for tool in authorized_tools(profile)
            ),
            *([ask_athlete] if profile.id == "automation" or interactive else []),
            *([respond_coach_followup] if profile.journal_tools else []),
        ],
        middleware=middleware,
        system_prompt=profile.system_prompt or SYSTEM_SKILL,
        context_schema=AgentContext,
        checkpointer=checkpointer,
        name=profile.name,
    )
