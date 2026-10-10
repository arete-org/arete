"""Translate a resolved model route into the OpenAI-compatible adapter."""

from urllib.parse import urlsplit

from langchain_openai import ChatOpenAI

from arete.agent.models.registry import (
    AGENT_MAX_RETRIES,
    AGENT_MAX_TOKENS,
    AGENT_STREAM_CHUNK_TIMEOUT_SEC,
    AGENT_TEMPERATURE,
    AGENT_TIMEOUT_SEC,
    OPENROUTER_FREE_ONLY,
    ModelRoute,
)
from arete.agent.models.routing import resolve_route


def build_chat_model(
    *,
    route: ModelRoute | None = None,
    max_tokens: int = AGENT_MAX_TOKENS,
    timeout: float = AGENT_TIMEOUT_SEC,
    max_retries: int = AGENT_MAX_RETRIES,
    temperature: float = AGENT_TEMPERATURE,
    openrouter_reasoning: bool | None = None,
) -> ChatOpenAI:
    route = route or resolve_route()
    if not 0 < max_tokens < route.context_tokens:
        raise ValueError("Output reservation must fit the configured model context")
    models = list(dict.fromkeys((route.model, *route.fallbacks)))
    extra_body: dict = {}
    if len(models) > 1:
        # OpenRouter's model fallbacks: same request, next model on failure.
        extra_body["models"] = models
    if urlsplit(route.base_url).hostname == "openrouter.ai":
        extra_body["provider"] = OPENROUTER_FREE_ONLY
        if openrouter_reasoning is not None:
            extra_body["reasoning"] = {"enabled": openrouter_reasoning}
    return ChatOpenAI(
        model=route.model,
        base_url=route.base_url,
        api_key=route.api_key,
        temperature=temperature,
        max_completion_tokens=max_tokens,
        timeout=timeout,
        max_retries=max_retries,
        stream_chunk_timeout=min(timeout, AGENT_STREAM_CHUNK_TIMEOUT_SEC),
        extra_body=extra_body or None,
    )
