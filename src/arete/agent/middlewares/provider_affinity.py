"""Attach OpenRouter's native stickiness key to each provider attempt."""

import hashlib
import json
from collections.abc import Awaitable, Callable

from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.types import ModelRequest, ModelResponse
from langchain_openai import ChatOpenAI

from arete.agent.runtime.context import AgentContext
from arete.services.athlete_scope import current_athlete_id


class ProviderAffinityMiddleware(AgentMiddleware):
    def _request(self, request: ModelRequest) -> ModelRequest:
        model = request.model
        if not isinstance(model, ChatOpenAI) or model.openai_api_base != (
            "https://openrouter.ai/api/v1"
        ):
            return request
        context = getattr(request.runtime, "context", None)
        if not isinstance(context, AgentContext):
            return request
        # The browser's thread id is not globally trusted: namespace it by the
        # server's athlete and mission. Jobs without a thread stick for one run.
        identity = json.dumps(
            [
                "arete-provider-affinity-v1",
                current_athlete_id(),
                context.profile,
                context.thread_id or str(context.run_id),
            ],
            separators=(",", ":"),
        )
        # Never mutate cached model clients or invocation-shared request dicts.
        # extra_body replaces SDK defaults, so preserve pricing and reasoning.
        extra_body = {
            **(model.extra_body or {}),
            **request.model_settings.get("extra_body", {}),
            "session_id": hashlib.sha256(identity.encode("utf-8")).hexdigest(),
        }
        return request.override(
            model_settings={**request.model_settings, "extra_body": extra_body}
        )

    def wrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], ModelResponse],
    ) -> ModelResponse:
        return handler(self._request(request))

    async def awrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], Awaitable[ModelResponse]],
    ) -> ModelResponse:
        return await handler(self._request(request))
