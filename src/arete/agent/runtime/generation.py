"""Observe existing synchronous owners without starting a second generation."""

from collections.abc import Callable
from contextvars import ContextVar
from functools import wraps
from typing import Any, ParamSpec, TypeVar
from uuid import uuid4

from arete.agent.runtime.activity import RunRecorder

_current: ContextVar[RunRecorder | None] = ContextVar(
    "generation_observer", default=None
)


def current_generation():
    return _current.get()


P = ParamSpec("P")
R = TypeVar("R")


def observed(
    kind: str, key: Callable[..., Any] = lambda *args, **kwargs: "current"
) -> Callable[[Callable[P, R]], Callable[P, R]]:
    """Only publish when the owner actually invokes its model producer.

    A cache hit or a lost scheduler lease must not hide the current execution.
    The service's return is the persistence boundary; model completion isn't.
    """

    def decorate(operation: Callable[P, R]) -> Callable[P, R]:
        @wraps(operation)
        def wrapped(*args: P.args, **kwargs: P.kwargs) -> R:
            if _current.get() is not None:
                return operation(*args, **kwargs)
            recorder = RunRecorder(str(uuid4()), kind, str(key(*args, **kwargs)))
            token = _current.set(recorder)
            try:
                result = operation(*args, **kwargs)
                if recorder.sequence:
                    if getattr(result, "status", None) == "failed":
                        recorder.record_sync(
                            {
                                "type": "error",
                                "detail": "La génération ou son enregistrement a échoué.",
                            }
                        )
                        return result
                    text = getattr(result, "text", getattr(result, "feedback", None))
                    source = getattr(result, "source", None)
                    if isinstance(result, tuple) and len(result) == 2:
                        text, source = result
                    if isinstance(text, str):
                        # Replace speculative output, including a rules fallback.
                        recorder.events = [
                            e for e in recorder.events if e["type"] != "message"
                        ]
                        recorder.record_sync(
                            {"type": "message", "id": "result", "text": text}
                        )
                    label = (
                        "Résultat enregistré"
                        if result is not None
                        else "Aucun nouveau résultat enregistré"
                    )
                    if source == "rules":
                        label = (
                            "Résultat enregistré · calculé à partir de tes métriques"
                        )
                    recorder.record_sync(
                        {
                            "type": "activity",
                            "id": "persistence",
                            "state": "done",
                            "label": label,
                        }
                    )
                    recorder.record_sync({"type": "run_status", "state": "completed"})
                return result
            except BaseException:
                if recorder.sequence:
                    recorder.record_sync(
                        {
                            "type": "error",
                            "detail": "La génération ou son enregistrement a échoué.",
                        }
                    )
                raise
            finally:
                _current.reset(token)

        return wrapped

    return decorate
