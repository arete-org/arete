"""Measure the model boundary after context assembly."""

from time import monotonic

from langchain.agents.middleware import AgentMiddleware

from arete.agent.models.responses import InvalidModelResponseError
from arete.observability.agent import record_model_call, served_models


def run_stats(request):
    """The run's ``RunStats``, or None outside an Arete run (bare graphs in tests)."""
    context = getattr(getattr(request, "runtime", None), "context", None)
    return getattr(context, "stats", None)


class ModelTelemetryMiddleware(AgentMiddleware):
    def _record(self, request, started, response=None, error=None):
        elapsed_ms = round((monotonic() - started) * 1000)
        stats = run_stats(request)
        if stats is not None:
            stats.model_calls += 1
            stats.model_ms += elapsed_ms
            stats.served_models.extend(served_models(response))
        record_model_call(
            model=getattr(request.model, "model_name", "unknown"),
            elapsed_ms=elapsed_ms,
            response=response,
            error=error,
        )

    def wrap_model_call(self, request, handler):
        started = monotonic()
        try:
            response = handler(request)
        except Exception as exc:
            self._record(
                request,
                started,
                response=exc.response
                if isinstance(exc, InvalidModelResponseError)
                else None,
                error=type(exc).__name__,
            )
            raise
        self._record(request, started, response=response)
        return response

    async def awrap_model_call(self, request, handler):
        started = monotonic()
        try:
            response = await handler(request)
        except Exception as exc:
            self._record(
                request,
                started,
                response=exc.response
                if isinstance(exc, InvalidModelResponseError)
                else None,
                error=type(exc).__name__,
            )
            raise
        self._record(request, started, response=response)
        return response
