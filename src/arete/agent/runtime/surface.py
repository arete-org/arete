"""Bounded intent classification; the result never authorizes a capability."""

import asyncio
import hashlib
import json
from time import monotonic
from typing import Literal

from langchain_core.messages import HumanMessage
from langchain_core.messages.utils import count_tokens_approximately
from langsmith import traceable
from pydantic import BaseModel, ConfigDict, model_validator

from arete.agent.prompts.product import SURFACE_QUESTIONS
from arete.agent.runtime.context import AgentContext
from arete.services.athlete_scope import current_athlete_id
from arete.services.jev import (
    JEV_CONTEXT_TOKENS,
    ChoiceAnswer,
    JevService,
)

CLASSIFIER_OUTPUT_RESERVE = 1024


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


@traceable(
    name="classify_slack_intent",
    # Invocation context and provider clients contain execution dependencies,
    # not classifier inputs. Export only the conversation and typed decision.
    process_inputs=lambda inputs: {"messages": inputs["messages"]},
    process_outputs=lambda decision: decision.model_dump() if decision else {},
)
async def detect_surface(
    model: JevService,
    messages: list[dict[str, str]],
    context: AgentContext,
    context_tokens: int,
) -> SurfaceDecision:
    identity = json.dumps(
        [
            "arete-provider-affinity-v1",
            current_athlete_id(),
            "surface",
            context.thread_id or str(context.run_id),
        ],
        separators=(",", ":"),
    )
    request = model.build_request(
        state={"messages": messages},
        questions=SURFACE_QUESTIONS,
        session_id=hashlib.sha256(identity.encode()).hexdigest(),
    )
    # Account for every question and the whole history before sending anything.
    tokens = count_tokens_approximately(
        [HumanMessage(content=json.dumps(request, ensure_ascii=False))]
    )
    window = min(context_tokens, JEV_CONTEXT_TOKENS)
    if tokens + CLASSIFIER_OUTPUT_RESERVE + max(1024, window // 10) > window:
        raise ValueError(
            "Historique trop volumineux pour le classement ; ouvre un nouveau fil."
        )
    started = monotonic()
    response = None
    try:
        # The invocation deadline includes preparation, not just graph execution.
        remaining = (
            context.deadline - monotonic() if context.deadline else model.timeout
        )
        async with asyncio.timeout(min(model.timeout, remaining)):
            response = await model.decide(
                request,
                langsmith_extra={
                    "name": "slack_surface",
                    "metadata": {
                        "thread_id": context.thread_id,
                        "athlete_id": current_athlete_id(),
                    },
                },
            )
        answers = response.answers
        assert all(isinstance(answer, ChoiceAnswer) for answer in answers.values())
        choices = {
            name: answer.choice
            for name, answer in answers.items()
            if isinstance(answer, ChoiceAnswer)
        }
        return SurfaceDecision.model_validate(
            {
                "surface": choices["surface"],
                "private_data": choices["private_data"] == "yes",
                "outbound": choices["outbound"] == "yes",
            }
        )
    finally:
        elapsed = round((monotonic() - started) * 1000)
        context.stats.model_calls += 1
        context.stats.model_ms += elapsed
        if response is not None:
            context.stats.served_models.append(response.model)
