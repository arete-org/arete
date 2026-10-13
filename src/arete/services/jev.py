"""OpenRouter Decisions adapter; one bounded, explicitly traced Jev request."""

import asyncio
import json
from copy import deepcopy
from dataclasses import dataclass, field
from time import monotonic
from typing import Annotated, Literal

import httpx
from langsmith import get_current_run_tree, traceable
from pydantic import BaseModel, ConfigDict, Field, SecretStr

from arete.observability.agent import record_decision_call

JEV_MODEL = "typesafe/jev-1.13"
JEV_TIMEOUT = 15
# The model card says 64K but the Decisions guide still says 32K. Keep the
# smaller envelope until the API contract agrees; never trim conversation data.
JEV_CONTEXT_TOKENS = 32_000
JEV_MAX_RESPONSE_BYTES = 65_536
JEV_MAX_REQUEST_BYTES = 262_144
JEV_MAX_QUESTIONS = 32
JEV_MAX_CRITERIA = 64
JEV_PROVIDER = {
    "sort": "latency",
    "allow_fallbacks": False,
    "max_price": {"prompt": 0.042, "completion": 0},
}
Probability = Annotated[float, Field(ge=0, le=1, allow_inf_nan=False)]


class ChoiceAnswer(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")
    type: Literal["choice"]
    choice: str
    confidence: Probability | None = None
    probabilities: dict[str, Probability] | None = None


class NoulAnswer(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")
    type: Literal["noul"]
    noul: Probability


class ScoreAnswer(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")
    type: Literal["score"]
    score: float = Field(ge=0, allow_inf_nan=False)
    confidence: Probability | None = None
    probabilities: dict[str, Probability] | None = None
    legend: dict[str, str | dict | list] | None = None


DecisionAnswer = Annotated[
    ChoiceAnswer | NoulAnswer | ScoreAnswer, Field(discriminator="type")
]


class DecisionUsage(BaseModel):
    model_config = ConfigDict(strict=True)
    input_tokens: int = Field(ge=0)
    output_tokens: int = Field(ge=0)
    cost: float | None = Field(default=None, ge=0, allow_inf_nan=False)


class JevResponse(BaseModel):
    model_config = ConfigDict(strict=True)
    model: str = Field(min_length=1)
    answers: dict[str, DecisionAnswer]
    usage: DecisionUsage


def trace_output(response: JevResponse) -> dict:
    usage = response.usage
    metadata: dict[str, int | float] = {
        "input_tokens": usage.input_tokens,
        "output_tokens": usage.output_tokens,
        "total_tokens": usage.input_tokens + usage.output_tokens,
    }
    if usage.cost is not None:
        metadata["total_cost"] = usage.cost
    return {**response.model_dump(exclude_none=True), "usage_metadata": metadata}


@dataclass(frozen=True)
class JevService:
    """Reusable Decisions client, independent of Slack, agents and authorization.

    Callers supply state/questions and own their token budget and decision policy.
    This service owns transport bounds, provider validation and the LLM trace.
    """

    api_key: SecretStr = field(repr=False)
    model: str
    timeout: float

    def build_request(
        self,
        *,
        state: str | dict | list,
        questions: dict,
        session_id: str | None = None,
    ) -> dict:
        """Snapshot the complete request so callers can budget exactly what is sent."""
        request = {
            "model": self.model,
            "state": state,
            "questions": questions,
            "provider": JEV_PROVIDER,
        }
        if session_id is not None:
            assert 0 < len(session_id) <= 256
            request["session_id"] = session_id
        # Callers and overlapping invocations must not share mutable payloads.
        return deepcopy(request)

    @traceable(
        name="jev_decision",
        run_type="llm",
        metadata={"ls_provider": "openrouter"},
        # Export the complete inference input, never the client or credentials.
        process_inputs=lambda inputs: inputs["request"],
        process_outputs=trace_output,
    )
    async def decide(self, request: dict) -> JevResponse:
        assert request["model"] == self.model
        assert request["provider"] == JEV_PROVIDER, (
            "Every Jev request needs its price cap"
        )
        assert 0 < self.timeout <= JEV_TIMEOUT
        questions = request["questions"]
        assert 0 < len(questions) <= JEV_MAX_QUESTIONS
        for question in questions.values():
            assert question["type"] in {"choice", "noul", "score"}
            assert 2 <= len(question["criteria"]) <= JEV_MAX_CRITERIA
        body_json = json.dumps(request, ensure_ascii=False, allow_nan=False).encode()
        if len(body_json) > JEV_MAX_REQUEST_BYTES:
            raise ValueError("Requête Jev trop volumineuse.")
        run = get_current_run_tree()
        if run is not None:
            run.metadata["ls_model_name"] = self.model
        started = monotonic()
        result = None
        error = None
        try:
            # Decisions has no temperature/max_tokens parameters: typed questions
            # bound the output instead. HTTP and whole-call deadlines include reads.
            async with asyncio.timeout(self.timeout):
                async with httpx.AsyncClient(
                    timeout=self.timeout,
                    transport=httpx.AsyncHTTPTransport(retries=0),
                    follow_redirects=False,
                ) as client:
                    async with client.stream(
                        "POST",
                        "https://openrouter.ai/api/alpha/decisions",
                        headers={
                            "Authorization": f"Bearer {self.api_key.get_secret_value()}",
                            "Content-Type": "application/json",
                        },
                        content=body_json,
                    ) as response:
                        response.raise_for_status()
                        body = bytearray()
                        async for chunk in response.aiter_bytes():
                            if len(body) + len(chunk) > JEV_MAX_RESPONSE_BYTES:
                                raise ValueError("Réponse Jev trop volumineuse.")
                            body.extend(chunk)
            result = JevResponse.model_validate_json(bytes(body))
            if result.answers.keys() != request["questions"].keys():
                raise ValueError("Réponse Jev incomplète ou inattendue.")
            for name, answer in result.answers.items():
                question = questions[name]
                if answer.type != question["type"]:
                    raise ValueError("Type de réponse Jev inattendu.")
                if (
                    isinstance(answer, ChoiceAnswer)
                    and answer.choice not in question["criteria"]
                ):
                    raise ValueError("Choix Jev inconnu.")
                if (
                    isinstance(answer, ScoreAnswer)
                    and answer.score > len(question["criteria"]) - 1
                ):
                    raise ValueError("Score Jev hors limites.")
            return result
        except BaseException as exc:
            error = type(exc).__name__
            raise
        finally:
            record_decision_call(
                model=self.model,
                elapsed_ms=round((monotonic() - started) * 1000),
                payload=result.model_dump(exclude_none=True)
                if result is not None
                else None,
                error=error,
            )
