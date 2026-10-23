"""Versioned public projection. Graph state and prompts have no transport variant."""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter

from arete.services.charts import ChartCard


class Envelope(BaseModel):
    model_config = ConfigDict(extra="forbid")
    stream_version: Literal[2]
    run_id: str = Field(min_length=1, max_length=100)
    seq: int = Field(ge=1, le=12000)


class RunStatus(Envelope):
    type: Literal["run_status"]
    state: Literal[
        "running",
        "waiting",
        "ready",
        "completed",
        "failed",
        "cancelled",
        "expired",
        "interrupted",
    ]


class Activity(Envelope):
    type: Literal["activity"]
    id: str
    label: str
    state: Literal["running", "done", "error"]


class MemoryReceipt(Envelope):
    type: Literal["memory_receipt"]
    id: str
    action: Literal["created", "updated", "already_present", "needs_clarification"]


class HumanInterrupt(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str
    revision: int = Field(ge=1)
    payload: dict
    response_schema: dict = Field(alias="schema")
    decision: dict | None
    expires_at: str


class Interrupted(Envelope):
    type: Literal["interrupt"]
    interrupt: HumanInterrupt


class Text(Envelope):
    type: Literal["token", "message"]
    id: str
    text: str = Field(max_length=64000)


class Preview(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: str = Field(max_length=2000)
    truncated: bool


class ToolStarted(Envelope):
    type: Literal["tool_start"]
    id: str
    name: str
    args: Preview


class ToolFinished(Envelope):
    type: Literal["tool_end"]
    id: str
    name: str
    status: Literal["done", "error"]
    output: Preview
    elapsed_ms: int = Field(ge=0)


class ContextUsage(BaseModel):
    model_config = ConfigDict(extra="forbid")
    used_tokens: int = Field(ge=0)
    window_tokens: int = Field(ge=1)


class Values(Envelope):
    type: Literal["values"]
    context_window_usage: ContextUsage


class Compaction(Envelope):
    type: Literal["context_compaction"]
    phase: Literal["start", "done", "error"]


class SyncStatus(Envelope):
    type: Literal["sync_status"]
    state: str


class Title(Envelope):
    type: Literal["thread_title"]
    thread_id: str
    title: str


class CalendarAction(Envelope):
    type: Literal["calendar_action"]
    id: str


class CoachCard(Envelope):
    type: Literal["coach_card"]
    id: str
    ref_kind: Literal["fact", "followup"]
    ref_id: int = Field(ge=1)


class Chart(Envelope, ChartCard):
    type: Literal["chart_card"]


class Workout(Envelope):
    type: Literal["workout_update"]
    id: str
    thread_id: str | None
    sequence: int = Field(ge=0)
    session: dict
    export_state: dict | None = Field(alias="export")


class Answer(BaseModel):
    model_config = ConfigDict(extra="forbid")
    role: Literal["assistant"]
    content: str = Field(max_length=64000)


class Completed(Envelope):
    type: Literal["done"]
    message: Answer
    trace: dict | None = None


class Failed(Envelope):
    type: Literal["error"]
    detail: str


Event = Annotated[
    RunStatus
    | Activity
    | MemoryReceipt
    | Interrupted
    | Text
    | ToolStarted
    | ToolFinished
    | Values
    | Compaction
    | SyncStatus
    | Title
    | CalendarAction
    | CoachCard
    | Chart
    | Workout
    | Completed
    | Failed,
    Field(discriminator="type"),
]
EVENT: TypeAdapter[Event] = TypeAdapter(Event)
