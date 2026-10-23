"""Invocation-local memory provenance, classifier budget, deadlines and telemetry."""

import asyncio
import hashlib
import json
from time import monotonic

from langchain_core.messages import HumanMessage, convert_to_messages
from langsmith import traceable

from arete.agent.models.jev import JevClient, JevError
from arete.agent.runtime.budget import MAX_MODEL_CALLS
from arete.agent.runtime.context import AgentContext
from arete.observability.agent import record_decision_call
from arete.services.athlete_facts import MAX_SOURCE_REF
from arete.services.athlete_scope import current_athlete_id
from arete.services.fact_memory import MemoryDecision

MAX_MEMORY_DECISIONS = 4


def grounded_source(quote: str, context: AgentContext) -> str:
    quote = quote.strip()
    message = context.memory_source_message
    if not quote or not message or quote not in message:
        raise ValueError(
            "source_ref doit citer exactement la dernière déclaration de l’athlète."
        )
    thread = hashlib.sha256(
        (context.thread_id or str(context.run_id)).encode()
    ).hexdigest()[:16]
    digest = hashlib.sha256(message.encode()).hexdigest()[:16]
    source = f"chat:{thread}:{digest}: {quote}"
    if len(source) > MAX_SOURCE_REF:
        raise ValueError("Citation source trop longue ; choisis un extrait plus court.")
    return source


@traceable(
    name="classify_memory",
    process_inputs=lambda inputs: {
        "state": inputs["state"],
        "choices": inputs["choices"],
    },
    process_outputs=lambda decision: decision.model_dump(),
)
async def classify_memory(
    state: dict, choices: dict[str, str], *, context: AgentContext, completed_calls: int
) -> MemoryDecision:
    model = context.memory_model
    assert model is not None, "Memory model must be composed by the server"
    pending = context.memory_calls - context.memory_charged_calls
    if (
        context.memory_calls >= MAX_MEMORY_DECISIONS
        or completed_calls + pending >= MAX_MODEL_CALLS - 1
    ):
        raise JevError(
            "Budget de vérification mémoire atteint ; aucun souvenir ajouté."
        )
    remaining = context.deadline - monotonic() if context.deadline else model.timeout
    if remaining <= 0:
        raise JevError("Délai de vérification mémoire dépassé.")
    # Reserve before awaiting: concurrent tool calls share the same hard limit.
    context.memory_calls += 1
    identity = json.dumps(
        [
            "arete-memory-v1",
            current_athlete_id(),
            context.profile,
            context.thread_id or str(context.run_id),
        ]
    )
    started = monotonic()
    payload = None
    error = None
    try:
        async with asyncio.timeout(min(remaining, model.timeout)):
            payload = await model.decide(
                state, choices, session_id=hashlib.sha256(identity.encode()).hexdigest()
            )
        return MemoryDecision.model_validate(payload["answers"]["memory"])
    except TimeoutError as exc:
        error = type(exc).__name__
        raise JevError("Délai Jev dépassé ; aucun souvenir ajouté.") from exc
    except BaseException as exc:
        error = type(exc).__name__
        raise
    finally:
        elapsed = round((monotonic() - started) * 1000)
        context.stats.model_calls += 1
        context.stats.model_ms += elapsed
        context.stats.memory_decision_calls += 1
        context.stats.memory_decision_ms += elapsed
        served = payload.get("model") if payload else None
        if isinstance(served, str):
            context.stats.served_models.append(served)
        record_decision_call(
            model=model.model, elapsed_ms=elapsed, payload=payload, error=error
        )


def prepare_fact_memory(
    messages: list, context: AgentContext, model: JevClient | None
) -> None:
    context.memory_model = model
    context.memory_source_message = next(
        (
            m.text
            for m in reversed(convert_to_messages(messages))
            if isinstance(m, HumanMessage)
        ),
        "",
    )


def charge_memory_calls(state: dict, context: AgentContext) -> dict | None:
    pending = context.memory_calls - context.memory_charged_calls
    assert pending >= 0
    if not pending:
        return None
    context.memory_charged_calls = context.memory_calls
    return {"run_model_call_count": state.get("run_model_call_count", 0) + pending}
