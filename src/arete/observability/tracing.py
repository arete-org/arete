"""Agent-scoped LangSmith tracing with one bounded background exporter."""

from __future__ import annotations

import atexit
import logging
from contextlib import contextmanager
from threading import Lock

from langchain_core.tracers.context import tracing_v2_enabled
from langsmith import Client, tracing_context
from urllib3.util import Retry

from arete.config import config

logger = logging.getLogger(__name__)

TRACE_TIMEOUT_MS = 5_000
TRACE_MAX_RETRIES = 2
TRACE_QUEUE_MAX_SIZE = 10_000
TRACE_MAX_BATCH_BYTES = 1_000_000
TRACE_SHUTDOWN_TIMEOUT_SEC = 5.0

_client: Client | None = None
_client_lock = Lock()


def _export_error(error: Exception) -> None:
    # SDK exceptions may contain request details; never log credentials/payloads.
    logger.warning("LangSmith trace export failed (%s)", type(error).__name__)


def get_tracing_client() -> Client | None:
    """Lazy for CLI scripts, also called at API startup to reject missing keys."""
    global _client
    if not config.langsmith_tracing:
        return None
    if not config.langsmith_api_key:
        raise ValueError("LANGSMITH_API_KEY is required when LANGSMITH_TRACING=true")
    with _client_lock:
        if _client is None:
            _client = Client(
                api_key=config.langsmith_api_key,
                api_url=config.langsmith_endpoint,
                workspace_id=config.langsmith_workspace_id,
                timeout_ms=TRACE_TIMEOUT_MS,
                retry_config=Retry(total=TRACE_MAX_RETRIES, backoff_factor=0.5),
                auto_batch_tracing=True,
                tracing_sampling_rate=1.0,
                max_batch_size_bytes=TRACE_MAX_BATCH_BYTES,
                tracing_error_callback=_export_error,
            )
            # The SDK exposes queue capacity via an env var, not a constructor
            # argument. Bound this client's queue without changing global env.
            assert _client.tracing_queue is not None
            with _client.tracing_queue.mutex:
                _client.tracing_queue.maxsize = TRACE_QUEUE_MAX_SIZE
            # Register after Client's own exit handler so our bounded close
            # drains first, including in short-lived scripts.
            atexit.register(close_tracing)
        return _client


@contextmanager
def agent_tracing():
    client = get_tracing_client()
    # Explicit False also suppresses legacy LANGCHAIN_TRACING_V2 settings.
    # Keep this context alive while iterating a stream, not just creating it.
    with tracing_context(
        enabled=client is not None,
        client=client,
        project_name=config.langsmith_project,
    ):
        if client is None:
            yield
            return
        # Own the native tracer per invocation so cancellation can finish any
        # model spans left open by LangChain's cancelled agenerate() gather.
        # The callback manager reuses this tracer; no second instrumentation.
        with tracing_v2_enabled(
            project_name=config.langsmith_project, client=client
        ) as tracer:
            try:
                yield
            except BaseException as error:
                # The harness closes the graph before leaving this context.
                # Completed callbacks have already removed their runs, so only
                # abandoned models get an error, never a fabricated success.
                for run in list(tracer.run_map.values()):
                    if run.run_type == "llm" and run.end_time is None:
                        try:
                            tracer.on_llm_error(error, run_id=run.id)
                        except Exception as export_error:
                            # Match the callback manager's failure isolation:
                            # export errors must not replace cancellation.
                            _export_error(export_error)
                raise


def close_tracing() -> None:
    global _client
    with _client_lock:
        client, _client = _client, None
    if client is None:
        return
    atexit.unregister(close_tracing)
    client.close(timeout=TRACE_SHUTDOWN_TIMEOUT_SEC)
    if client.tracing_queue is not None and client.tracing_queue.unfinished_tasks:
        logger.warning(
            "LangSmith shutdown deadline reached with pending trace operations"
        )
