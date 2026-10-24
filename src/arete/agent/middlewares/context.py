"""Adapt the central context builder to model interception."""

from contextlib import contextmanager
from functools import partial

from anyio import to_thread
from langchain.agents.middleware import AgentMiddleware
from langgraph.config import get_stream_writer
from langgraph.runtime import get_runtime

from arete.agent.context.builder import build_context, validate_context


@contextmanager
def _progress(request):
    # A direct middleware invocation can have a request context without a
    # LangGraph runtime. Only the framework runtime owns a stream writer.
    try:
        get_runtime()
    except RuntimeError:
        writer = None
    else:
        writer = get_stream_writer()
    if writer:
        writer(
            {
                "type": "activity",
                "id": "context",
                "state": "running",
                "label": "Préparation du contexte",
            }
        )
    try:
        yield
    except BaseException:
        if writer:
            writer(
                {
                    "type": "activity",
                    "id": "context",
                    "state": "error",
                    "label": "Contexte indisponible",
                }
            )
        raise
    else:
        if writer:
            writer(
                {
                    "type": "activity",
                    "id": "context",
                    "state": "done",
                    "label": "Contexte préparé",
                }
            )


class ContextBuilderMiddleware(AgentMiddleware):
    def __init__(self, *, context_tokens: int | None = None, output_tokens: int = 4096):
        self.context_tokens = context_tokens
        self.output_tokens = output_tokens

    def wrap_model_call(self, request, handler):
        with _progress(request):
            built = build_context(
                request,
                context_tokens=self.context_tokens,
                output_tokens=self.output_tokens,
            )
        return handler(built)

    async def awrap_model_call(self, request, handler):
        with _progress(request):
            built = await to_thread.run_sync(
                partial(
                    build_context,
                    request,
                    context_tokens=self.context_tokens,
                    output_tokens=self.output_tokens,
                )
            )
        return await handler(built)


class ContextBudgetMiddleware(AgentMiddleware):
    """Final preflight after all contributions."""

    def __init__(self, *, context_tokens: int, output_tokens: int):
        self.context_tokens = context_tokens
        self.output_tokens = output_tokens

    def _check(self, request):
        validate_context(
            request,
            context_tokens=self.context_tokens,
            output_tokens=self.output_tokens,
        )

    def wrap_model_call(self, request, handler):
        self._check(request)
        return handler(request)

    async def awrap_model_call(self, request, handler):
        self._check(request)
        return await handler(request)
