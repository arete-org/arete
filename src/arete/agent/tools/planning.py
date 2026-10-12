"""Planning tool schemas; domain validation and persistence live in services."""

from datetime import date
from typing import Annotated, Any, Literal

from langchain.tools import ToolRuntime
from langchain_core.tools import BaseTool
from pydantic import Field, WithJsonSchema

from arete.agent.tools.garmin import (
    inspect_planned_session,
)
from arete.agent.tools.prescriptions import PrescriptionInput
from arete.agent.tools.validation import typed_tool
from arete.garmin.models import SessionType
from arete.services import planning as service
from arete.services.prescriptions import Provenance

# Google-backed OpenRouter routes reject empty enum members. Patterns expose the
# same allowed strings while Pydantic retains the explicit Literal validation.
ClearableIntensity = Annotated[
    Literal["", "easy", "moderate", "hard"],
    WithJsonSchema({"type": "string", "pattern": "^(easy|moderate|hard)?$"}),
]
ClearableZone = Annotated[
    Literal["", "Z1", "Z2", "Z3", "Z4", "Z5"],
    WithJsonSchema({"type": "string", "pattern": "^(Z[1-5])?$"}),
]


@typed_tool
def list_planned(
    start_date: date | None = None,
    end_date: date | None = None,
) -> str:
    """List upcoming planned training sessions.

    Args:
        start_date: Optional ISO date (YYYY-MM-DD) filter start, empty = today - 7.
        end_date: Optional ISO date (YYYY-MM-DD) filter end, empty = today + 120.
    """
    return service.list_planned(
        start_date=start_date.isoformat() if start_date else "",
        end_date=end_date.isoformat() if end_date else "",
    )


@typed_tool
def create_planned_session(
    date_str: date,
    session_type: SessionType,
    runtime: ToolRuntime[Any],
    description: Annotated[str, Field(max_length=500)] = "",
    sport: Literal[
        "running", "cycling", "swimming", "strength", "walking", "hiking", "other"
    ] = "running",
    target_duration_min: Annotated[int, Field(ge=0, le=1440)] = 0,
    target_distance_km: Annotated[
        float, Field(ge=0, le=1000, allow_inf_nan=False)
    ] = 0.0,
    target_intensity: ClearableIntensity = "",
    prescription: PrescriptionInput | None = None,
    strength_text: Annotated[str, Field(max_length=4000)] = "",
    provenance: Annotated[list[Provenance] | None, Field(max_length=20)] = None,
) -> str:
    """Create one session directly in Planning and return its real id.

    date_str is an ISO date. prescription is a structured object, never JSON text.
    Use prescription.steps for workout structure, not description alone.
    For strength, strength_text supplies exercises, sets and rests to the grammar;
    any supplied prescription must match those sets. Zero targets mean unspecified.
    Cite document cells/quotes in provenance when using an attachment.
    Read existing sessions first if absent from context; reuse their ids for export.
    """
    return service.create_planned_session(
        date_str=date_str.isoformat(),
        session_type=session_type.value,
        description=description,
        sport=sport,
        target_duration_min=target_duration_min,
        target_distance_km=target_distance_km,
        target_intensity=target_intensity,
        prescription=prescription,
        strength_text=strength_text,
        provenance=provenance,
        thread_id=runtime.context.thread_id,
    )


class SessionChangesInput(service.SessionChanges):
    # Finite schema preserves nested step types through provider conversion.
    prescription: PrescriptionInput | None = None
    target_intensity: ClearableIntensity | None = None
    target_hr_zone: ClearableZone | None = None


@typed_tool
def update_planned_session(
    session_id: Annotated[int, Field(gt=0)],
    revision: Annotated[int, Field(ge=1)],
    changes: SessionChangesInput,
) -> str:
    """Modify date, status, metadata or steps of one existing session, preserving its id.

    Use the revision from list_planned or inspect_planned_session. Omitted fields stay
    unchanged (omit them, never null); zero/empty clears a scalar target. To change
    workout steps, supply the complete prescription, not just description or scalar
    targets. Never delete/recreate or export implicitly.
    """
    return service.update_planned_session(session_id, revision, changes)


@typed_tool
def delete_planned_session(session_id: Annotated[int, Field(gt=0)]) -> str:
    """Delete a planned session by id. Prefer update_planned_session to mark it
    skipped — deletion loses the record.

    Args:
        session_id: Id of the planned session.
    """
    return service.delete_planned_session(session_id=session_id)


PLANNING_TOOLS: list[BaseTool] = [
    list_planned,
    inspect_planned_session,
    create_planned_session,
    update_planned_session,
    delete_planned_session,
]
