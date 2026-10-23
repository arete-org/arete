"""Resolve server configuration before constructing a provider client."""

from pydantic import SecretStr

from arete.agent.models.registry import (
    DEFAULT_GITHUB_MODEL,
    DEFAULT_OPENROUTER_FALLBACKS,
    DEFAULT_OPENROUTER_MODEL,
    GLM_FLASH_MODEL,
    MAX_OPENROUTER_MODELS,
    ModelRoute,
)
from arete.config import config


def configured_model_name() -> str:
    defaults = {
        "ollama": "llama3.1:8b",
        "openrouter": DEFAULT_OPENROUTER_MODEL,
        "github": DEFAULT_GITHUB_MODEL,
    }
    return config.llm_model or defaults.get(config.llm_provider, "unknown")


def resolve_route(*, glm_flash: bool = False) -> ModelRoute:
    provider = config.llm_provider
    if provider == "ollama":
        url, key = config.ollama_base_url, "ollama"
    elif provider == "openrouter":
        url, key = (
            "https://openrouter.ai/api/v1",
            config.openrouter_api_key,
        )
        if not key:
            raise ValueError(
                "OPENROUTER_API_KEY env var required for openrouter provider"
            )
    elif provider == "github":
        url, key = (
            "https://models.inference.ai.azure.com",
            config.github_token,
        )
        if not key:
            raise ValueError("GITHUB_TOKEN env var required for github provider")
    else:
        raise ValueError(
            f"Unknown LLM_PROVIDER '{provider}' for the agent. Supported: ollama, openrouter, github"
        )
    if glm_flash and provider == "openrouter":
        return ModelRoute(
            GLM_FLASH_MODEL,
            url,
            SecretStr(key),
            config.llm_context_tokens,
            openrouter_policy="glm_flash",
        )
    return ModelRoute(
        configured_model_name(),
        url,
        SecretStr(key),
        config.llm_context_tokens,
        _openrouter_fallbacks() if provider == "openrouter" else (),
    )


def _openrouter_fallbacks() -> tuple[str, ...]:
    """The default list only backs the default model: a pinned LLM_MODEL is
    never rerouted unless LLM_MODEL_FALLBACKS asks for it."""
    fallbacks = config.llm_model_fallbacks
    if len({configured_model_name(), *fallbacks}) > MAX_OPENROUTER_MODELS:
        raise ValueError(
            f"LLM_MODEL plus LLM_MODEL_FALLBACKS: {MAX_OPENROUTER_MODELS} models "
            "at most, OpenRouter rejects longer lists"
        )
    if fallbacks:
        return fallbacks
    return () if config.llm_model else DEFAULT_OPENROUTER_FALLBACKS
