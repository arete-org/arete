"""Bounded intent classification; the result never authorizes a capability."""

import asyncio
import hashlib
import json
from time import monotonic
from typing import Literal

from langchain.agents.middleware.types import ModelResponse
from langchain_core.messages import SystemMessage, convert_to_messages
from langchain_core.messages.utils import count_tokens_approximately
from pydantic import BaseModel, ConfigDict, model_validator

from arete.agent.models.responses import validate_model_response
from arete.agent.prompts.product import ROUTER_PROMPT
from arete.agent.runtime.context import AgentContext
from arete.observability.agent import record_model_call, served_models
from arete.services.athlete_scope import current_athlete_id

CLASSIFIER_MAX_TOKENS = 1024
CLASSIFIER_TIMEOUT = 15


class SurfaceDecision(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    surface: Literal["coach", "product", "clarify"]
    private_data: bool
    outbound: bool

    @model_validator(mode="after")
    def coherent(self):
        if self.private_data and self.outbound:
            self.surface = "clarify"
        if self.surface == "coach" and (self.private_data or self.outbound):
            raise ValueError("Inconsistent coaching classification")
        return self


async def detect_surface(
    model, messages: list[dict[str, str]], context: AgentContext, context_tokens: int
) -> SurfaceDecision:
    request = [SystemMessage(ROUTER_PROMPT), *convert_to_messages(messages)]
    tokens = count_tokens_approximately(request)
    if (
        tokens + CLASSIFIER_MAX_TOKENS + max(1024, context_tokens // 10)
        > context_tokens
    ):
        raise ValueError(
            "Historique trop volumineux pour le classement ; ouvre un nouveau fil."
        )
    identity = json.dumps(
        [
            "arete-provider-affinity-v1",
            current_athlete_id(),
            "surface",
            context.thread_id or str(context.run_id),
        ],
        separators=(",", ":"),
    )
    extra = {
        **(model.extra_body or {}),
        "session_id": hashlib.sha256(identity.encode()).hexdigest(),
    }
    started = monotonic()
    response = None
    error = None
    try:
        async with asyncio.timeout(CLASSIFIER_TIMEOUT):
            message = await model.ainvoke(
                request,
                config={
                    "run_name": "slack_surface",
                    "metadata": {
                        "thread_id": context.thread_id,
                        "athlete_id": current_athlete_id(),
                    },
                },
                extra_body=extra,
            )
        response = ModelResponse(result=[message])
        validate_model_response(response)
        if message.tool_calls:
            raise ValueError("Le classifieur ne peut pas appeler d'outil.")
        return SurfaceDecision.model_validate_json(message.text)
    except BaseException as exc:
        error = type(exc).__name__
        raise
    finally:
        elapsed = round((monotonic() - started) * 1000)
        context.stats.model_calls += 1
        context.stats.model_ms += elapsed
        context.stats.served_models.extend(served_models(response))
        record_model_call(
            model=model.model_name, elapsed_ms=elapsed, response=response, error=error
        )
