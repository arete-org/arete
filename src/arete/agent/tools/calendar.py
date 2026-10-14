"""Calendar schemas: reads and proposals only. Approval is exclusively HTTP/UI."""

import json
from datetime import datetime
from typing import Any, Literal

from langchain.tools import ToolRuntime
from pydantic import ValidationError

from arete.agent.runtime.budget import MAX_TOOL_OUTPUT_CHARS
from arete.agent.tools.validation import typed_tool
from arete.services.calendar_models import CalendarError, CalendarProposal, EventDraft


def _run(runtime: ToolRuntime[Any], operation, *, proposal: bool = False) -> str:
    context = runtime.context
    if context is None or context.calendar is None or context.profile != "chat":
        return json.dumps({"error": "Google Calendar indisponible pour cette mission."})
    try:
        result = operation(context.calendar, context)
        rendered = json.dumps(result, ensure_ascii=False)
        if len(rendered) > MAX_TOOL_OUTPUT_CHARS:
            raise CalendarError(
                "Résultat trop volumineux. Réduis la période de lecture.", 413
            )
        if proposal:
            from langgraph.config import get_stream_writer

            get_stream_writer()({"type": "calendar_action", "id": result["id"]})
        return rendered
    except (CalendarError, ValidationError) as exc:
        return json.dumps({"error": str(exc)}, ensure_ascii=False)


@typed_tool
def list_calendar_events(
    start: datetime, end: datetime, runtime: ToolRuntime[Any]
) -> str:
    """Read events in selected calendars. ISO timestamps with UTC offsets; 31 days maximum."""
    return _run(
        runtime,
        lambda service, ctx: service.events(
            start.isoformat(), end.isoformat(), deadline=ctx.deadline
        ),
    )


@typed_tool
def get_calendar_availability(
    start: datetime, end: datetime, runtime: ToolRuntime[Any]
) -> str:
    """Read busy intervals in selected calendars. ISO timestamps with offsets; maximum 31 days."""
    return _run(
        runtime,
        lambda service, ctx: service.availability(
            start.isoformat(), end.isoformat(), deadline=ctx.deadline
        ),
    )


@typed_tool
def propose_calendar_event(
    operation: Literal["create", "update", "delete"],
    calendar_id: str,
    runtime: ToolRuntime[Any],
    event_id: str | None = None,
    event: EventDraft | None = None,
) -> str:
    """Propose create/update/delete, without writing Google. User validates a card.

    calendar_id: exact id of a calendar listed with writable=true by
    list_calendar_events, never a guess such as "primary".
    For update/delete, find event_id with list_calendar_events first (an
    approved creation is only visible there); never ask the athlete.
    Supply the complete desired simple event for create/update (preserve
    description/location). For delete omit event.
    All-day end is exclusive; timed dates require offsets matching timezone.
    Only individual occurrences, no recurring series or attendees.
    """
    return _run(
        runtime,
        lambda service, ctx: service.propose(
            CalendarProposal.model_validate(
                {
                    "operation": operation,
                    "calendar_id": calendar_id,
                    "event_id": event_id,
                    "event": event,
                }
            ),
            ctx.thread_id,
            deadline=ctx.deadline,
        ),
        proposal=True,
    )


CALENDAR_TOOLS = [
    list_calendar_events,
    get_calendar_availability,
    propose_calendar_event,
]
