"""Thin conversational Garmin adapters; services own validation and writes."""

import json
from typing import Annotated, Any

from langchain.tools import ToolRuntime
from pydantic import Field

from arete.agent.tools.validation import typed_tool
from arete.services import garmin_export, garmin_sync


def _json(value) -> str:
    return json.dumps(value, ensure_ascii=False, default=str)


@typed_tool
def inspect_planned_session(session_id: Annotated[int, Field(gt=0)]) -> str:
    """Read a session's steps, revision, derived structure and Garmin export state."""
    try:
        return _json(garmin_export.inspect_session(session_id))
    except ValueError as exc:
        return _json({"error": str(exc)})


@typed_tool
def list_garmin_devices(runtime: ToolRuntime[Any]) -> str:
    """List Garmin devices only when the athlete explicitly requests watch transfer."""
    try:
        return _json(
            garmin_export.devices(
                exchange=garmin_export.Exchange(deadline=runtime.context.deadline)
            )
        )
    except (ValueError, PermissionError) as exc:
        return _json({"error": str(exc)})


@typed_tool
def export_garmin_sessions(
    session_ids: Annotated[
        list[Annotated[int, Field(gt=0)]], Field(min_length=1, max_length=5)
    ],
    runtime: ToolRuntime[Any],
    device_id: Annotated[int, Field(gt=0)] | None = None,
) -> str:
    """Send 1–5 distinct planned session ids TO Garmin on explicit request; default Garmin Connect.

    Only when the athlete asks to send, export or schedule named sessions:
    "synchroniser Garmin" is an import (sync_garmin_activities), never this.
    Stops at the first failure. Never replay an uncertain write or the entire batch.
    device_id is only for explicitly requested, verified watch transfer.
    """
    options = runtime.config.get("configurable", {})
    today = runtime.context.current_date
    try:
        # A model once read "synchronise Garmin" as an export of last week's plan.
        past = [
            session_id
            for session_id in session_ids
            if str(
                garmin_export.inspect_session(session_id, include_steps=False)[
                    "session"
                ]["date"]
            )[:10]
            < today.isoformat()
        ]
        if past:
            return _json(
                {"error": f"Séances passées, jamais exportées vers Garmin : {past}."}
            )
        return _json(
            garmin_export.export_batch(
                session_ids,
                device_id,
                deadline=runtime.context.deadline,
                on_progress=options.get("workout_progress"),
            )
        )
    except (ValueError, ConnectionError, TimeoutError, PermissionError) as exc:
        return _json({"error": str(exc)})


@typed_tool
def reconcile_garmin_session(
    session_id: Annotated[int, Field(gt=0)], runtime: ToolRuntime[Any]
) -> str:
    """Verify an uncertain Garmin outcome before considering another explicit export."""
    try:
        state = garmin_export.reconcile(session_id, deadline=runtime.context.deadline)
        view = garmin_export.inspect_session(session_id, include_steps=False)
        if state["state"] in {"uncertain", "conflict", "failed"}:
            view["error"] = state["error"] or "Vérification Garmin incomplète."
        return _json(view)
    except ValueError as exc:
        return _json({"error": str(exc)})


@typed_tool
def sync_garmin_activities(runtime: ToolRuntime[Any]) -> str:
    """Import the athlete's completed activities FROM Garmin Connect, like the sync button.

    This is what "synchronise Garmin" means; it never sends planned sessions.
    Once per turn, when asked to sync or when a recent session is missing.
    Returns the imported sessions; never call it again to retry.
    """
    try:
        return _json(garmin_sync.sync_recent(deadline=runtime.context.deadline))
    except (PermissionError, RuntimeError) as exc:
        return _json({"error": str(exc)})


GARMIN_TOOLS = [
    list_garmin_devices,
    export_garmin_sessions,
    reconcile_garmin_session,
    sync_garmin_activities,
]
