"""Typed scheduling in an athlete's clock; no arbitrary cron or model inference."""

from datetime import UTC, date, datetime, time, timedelta
from typing import Annotated, Literal
from zoneinfo import ZoneInfo

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

MAX_ACTIVE_AUTOMATIONS = 20
MAX_DAILY_RUNS = 5
MAX_MODEL_TURNS = 8
MAX_MODEL_REQUESTS = 24
MAX_TOOL_CALLS = 24
MAX_RESUMES = 4
SEGMENT_SECONDS = 120
MAX_ACTIVE_SECONDS = 240
WAIT_HOURS = 48
MAX_DISPATCH_SECONDS = 270
MAX_DISPATCH_RUNS = 2
MAX_SCAN = 500
MAX_SCHEDULE_DAYS = 366


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Once(StrictModel):
    kind: Literal["once"]
    at: datetime

    @field_validator("at")
    @classmethod
    def aware(cls, value: datetime) -> datetime:
        if value.tzinfo is None:
            raise ValueError("La date doit inclure son décalage UTC.")
        return value.astimezone(UTC)


class Recurring(StrictModel):
    kind: Literal["daily", "weekly"]
    time: str = Field(pattern=r"^([01][0-9]|2[0-3]):[0-5][0-9]$")
    weekdays: list[Annotated[int, Field(ge=0, le=6)]] = Field(
        default_factory=list, max_length=7
    )

    @model_validator(mode="after")
    def days(self):
        if (self.kind == "weekly") != bool(self.weekdays):
            raise ValueError(
                "Les jours (lundi=0) sont requis uniquement pour une récurrence hebdomadaire."
            )
        if len(set(self.weekdays)) != len(self.weekdays):
            raise ValueError("Jour répété")
        return self


class AfterSession(StrictModel):
    kind: Literal["session"]
    session_key: str | None = Field(
        default=None, pattern=r"^(actual|strength|planned):[1-9][0-9]*$"
    )
    sport: str | None = Field(default=None, max_length=40)
    session_type: str | None = Field(default=None, max_length=40)
    delay_minutes: int = Field(default=0, ge=0, le=7 * 24 * 60)


Trigger = Annotated[Once | Recurring | AfterSession, Field(discriminator="kind")]


class AutomationInput(StrictModel):
    title: str = Field(min_length=1, max_length=120)
    mission: str = Field(min_length=1, max_length=4000)
    trigger: Trigger
    timezone: str = Field(default="Europe/Paris", max_length=80)

    @field_validator("timezone")
    @classmethod
    def valid_zone(cls, value: str) -> str:
        try:
            ZoneInfo(value)
        except (KeyError, ValueError) as exc:
            raise ValueError("Fuseau inconnu") from exc
        return value

    @field_validator("title", "mission")
    @classmethod
    def nonempty(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Texte vide")
        return value.strip()


def local_instant(day: date, clock: str, zone: str) -> datetime:
    # Fall-back occurs once (fold=0). A nonexistent spring time shifts forward
    # by the clock gap; round-tripping makes that choice explicit and testable.
    local = datetime.combine(day, time.fromisoformat(clock), ZoneInfo(zone))
    return local.astimezone(UTC)


def next_due(definition: AutomationInput, after: datetime) -> datetime | None:
    trigger = definition.trigger
    if isinstance(trigger, AfterSession):
        return None
    if isinstance(trigger, Once):
        return trigger.at if trigger.at > after else None
    day = after.astimezone(ZoneInfo(definition.timezone)).date()
    for offset in range(8):
        candidate = day + timedelta(days=offset)
        if trigger.kind == "weekly" and candidate.weekday() not in trigger.weekdays:
            continue
        instant = local_instant(candidate, trigger.time, definition.timezone)
        if instant > after:
            return instant
    raise AssertionError("A weekly schedule must have an occurrence within eight days")
