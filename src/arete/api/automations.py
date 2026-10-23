"""Read-only queries and durable automation commands; no agent imports at boot."""

from typing import Literal

import duckdb
from fastapi import APIRouter, HTTPException, Query, Response
from pydantic import Field

from arete.services import automations as service
from arete.services import inbox
from arete.services.automation_schedule import AutomationInput, StrictModel

router = APIRouter(tags=["automations"])


class Creation(AutomationInput):
    activate: bool = True


class Decision(StrictModel):
    revision: int = Field(ge=1)
    decision: dict


class InboxChange(StrictModel):
    read: bool | None = None
    archived: bool | None = None


def _call(operation):
    try:
        return operation()
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc
    except (service.Conflict, duckdb.TransactionException) as exc:
        raise HTTPException(
            409, "L’état a changé. Rechargez avant de poursuivre."
        ) from exc
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.get("/automations")
def listing(offset: int = Query(default=0, ge=0, le=10000)):
    return service.listing(offset=offset)


@router.post("/automations", status_code=201)
def create(body: Creation):
    return _call(
        lambda: service.create(
            AutomationInput.model_validate(body.model_dump(exclude={"activate"})),
            activate=body.activate,
        )
    )


@router.get("/automations/{identifier}")
def get(identifier: str):
    return _call(lambda: service.get(identifier))


@router.put("/automations/{identifier}")
def update(identifier: str, body: service.Update):
    return _call(lambda: service.update(identifier, body))


@router.patch("/automations/{identifier}")
def state(identifier: str, body: service.StateChange):
    return _call(lambda: service.set_state(identifier, body.revision, body.state))


@router.delete("/automations/{identifier}", status_code=204)
def delete(identifier: str, revision: int = Query(ge=1)):
    _call(lambda: service.delete(identifier, revision))
    return Response(status_code=204)


@router.get("/automations/{identifier}/runs")
def history(identifier: str, offset: int = Query(default=0, ge=0, le=10000)):
    return _call(lambda: service.runs(identifier, offset=offset))


@router.get("/automation-runs/{identifier}")
def run(identifier: str):
    return _call(lambda: service.run_detail(identifier))


@router.post("/automation-runs/{identifier}/interrupts/{interrupt_id}")
def decide(identifier: str, interrupt_id: str, body: Decision):
    return _call(
        lambda: service.decide(identifier, interrupt_id, body.revision, body.decision)
    )


@router.get("/notifications")
def notifications(
    filter: Literal["todo", "all", "archives"] = "todo",
    offset: int = Query(default=0, ge=0, le=10000),
):
    return inbox.listing(filter, offset)


@router.patch("/notifications/{identifier}")
def mark(identifier: str, body: InboxChange):
    if body.read is None and body.archived is None:
        raise HTTPException(422, "Choisissez lecture ou archivage")
    return _call(lambda: inbox.mark(identifier, **body.model_dump()))
