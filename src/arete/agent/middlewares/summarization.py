"""Observe native Deep Agents compaction without changing its policy.

The pinned 0.7.4 hooks expose the exact decision count and summary lifecycle.
Keep capture local to each model call: compiled middleware serves concurrent runs.
"""

from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import replace
from typing import NotRequired, TypedDict

from deepagents.middleware.summarization import (
    SummarizationMiddleware,
    SummarizationState,
    compute_summarization_defaults,
)
from langchain.agents.middleware.types import ExtendedModelResponse
from langgraph.config import get_stream_writer
from langgraph.types import Command


class ContextWindowUsage(TypedDict):
    used_tokens: int
    window_tokens: int


class ContextState(SummarizationState):
    context_window_usage: NotRequired[ContextWindowUsage]


_usage: ContextVar[ContextWindowUsage | None] = ContextVar(
    "context_usage", default=None
)


@contextmanager
def _compaction_progress():
    writer = get_stream_writer()
    writer({"type": "context_compaction", "phase": "start"})
    try:
        yield
    except BaseException:
        writer({"type": "context_compaction", "phase": "error"})
        raise
    else:
        writer({"type": "context_compaction", "phase": "done"})


def _with_usage(response):
    usage = _usage.get()
    if usage is None:
        # Native token-based defaults still work without a model window;
        # there is no honest percentage to display in that case.
        return response
    update = {"context_window_usage": usage}
    if isinstance(response, ExtendedModelResponse):
        command = response.command or Command(update={})
        assert isinstance(command.update, dict)
        return replace(
            response, command=replace(command, update={**command.update, **update})
        )
    return ExtendedModelResponse(
        model_response=response, command=Command(update=update)
    )


class ContextSummarizationMiddleware(SummarizationMiddleware):
    """Only telemetry: thresholds, retention, retries and overflow stay upstream."""

    state_schema = ContextState

    def __init__(self, model, backend):
        super().__init__(
            model=model, backend=backend, **compute_summarization_defaults(model)
        )

    def _count_tokens(self, messages, system_message, tools):
        total = super()._count_tokens(messages, system_message, tools)
        window = self._get_profile_limits()
        if window is None:
            return total
        assert isinstance(window, int) and window > 0
        # Keep the first complete request measurement, before native compaction.
        if _usage.get() is None:
            _usage.set({"used_tokens": total, "window_tokens": window})
        return total

    def _create_summary(self, messages_to_summarize):
        with _compaction_progress():
            return super()._create_summary(messages_to_summarize)

    async def _acreate_summary(self, messages_to_summarize):
        with _compaction_progress():
            return await super()._acreate_summary(messages_to_summarize)

    def wrap_model_call(self, request, handler):
        token = _usage.set(None)
        try:
            return _with_usage(super().wrap_model_call(request, handler))
        finally:
            _usage.reset(token)

    async def awrap_model_call(self, request, handler):
        token = _usage.set(None)
        try:
            return _with_usage(await super().awrap_model_call(request, handler))
        finally:
            _usage.reset(token)
