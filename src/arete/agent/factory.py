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
from arete.agent.middlewares.limits import execution_limits
from arete.agent.middlewares.observability import ModelTelemetryMiddleware
from arete.agent.middlewares.policy import ProfilePolicyMiddleware
from arete.agent.middlewares.provider_affinity import ProviderAffinityMiddleware
from arete.agent.middlewares.responses import ModelResponseMiddleware
from arete.agent.profiles.models import AgentProfile
from arete.agent.prompts.coach import SYSTEM_SKILL
from arete.agent.runtime.budget import (
    MAX_MODEL_FALLBACKS,
    MAX_READ_TOOL_RETRIES,
    READ_TOOL_RETRY_DELAY_SECONDS,
)
from arete.agent.runtime.context import AgentContext
from arete.agent.tools.journal import append_journal, remember_fact
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
    fallback_models: tuple[BaseChatModel, ...] = (),
    skills: AgentMiddleware[Any, Any, Any] | None = None,
):
    assert len(fallback_models) <= MAX_MODEL_FALLBACKS, "Too many fallback models"
    middleware = [
        ProfilePolicyMiddleware(profile.id, profile=profile, calendar=calendar),
        *execution_limits(),
    ]
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
            max_retries=MAX_READ_TOOL_RETRIES,
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
        middleware.append(filesystem)
        if skills is not None:
            middleware.append(skills)
    middleware.append(
        ContextBuilderMiddleware(
            context_tokens=context_tokens, output_tokens=output_tokens
        )
    )
    middleware.append(
        ContextBudgetMiddleware(
            context_tokens=context_tokens, output_tokens=output_tokens
        )
    )
    # Context/policy errors must not trigger fallback. Each provider attempt is
    # measured separately; model fallback never encloses tool execution.
    if fallback_models:
        middleware.append(ModelFallbackMiddleware(*fallback_models))
    middleware.append(ProviderAffinityMiddleware())
    middleware.append(ModelTelemetryMiddleware())
    middleware.append(ModelResponseMiddleware())
    return create_agent(
        model,
        tools=[
            *authorized_tools(profile),
            *([append_journal, remember_fact] if profile.journal_tools else []),
        ],
        middleware=middleware,
        system_prompt=SYSTEM_SKILL,
        context_schema=AgentContext,
        name=profile.name,
    )
