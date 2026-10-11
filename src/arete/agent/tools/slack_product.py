"""Typed adapters; Slack authorization and external writes belong to services."""

import json
from typing import Annotated, Any

import httpx
from anyio import to_thread
from langchain.tools import ToolRuntime
from pydantic import Field

from arete.agent.runtime.budget import MAX_TOOL_OUTPUT_CHARS
from arete.agent.tools.validation import typed_tool
from arete.services import admin_athlete_data
from arete.services.slack import SlackError
from arete.services.slack_product import SlackProduct


def _service(runtime: ToolRuntime[Any], *, private: bool = False) -> SlackProduct:
    context = runtime.context
    service = getattr(context, "slack_product", None)
    if not isinstance(service, SlackProduct) or context.profile not in (
        "product",
        "admin_data",
    ):
        raise PermissionError("Outils administrateur indisponibles pour cette mission.")
    if private and (
        context.profile != "admin_data"
        or context.slack_visibility != "private"
        or not service.private
    ):
        raise PermissionError("Lecture privée uniquement en DM administrateur.")
    return service


async def _result(operation) -> str:
    try:
        payload = await operation()
        rendered = json.dumps(payload, ensure_ascii=False, default=str)
        if len(rendered) > MAX_TOOL_OUTPUT_CHARS:
            raise ValueError(
                "Résultat trop volumineux : réduis la lecture ou utilise l'offset."
            )
        return rendered
    except (ValueError, PermissionError, SlackError, httpx.HTTPError) as exc:
        # Never retry here: even an HTTP timeout may follow a committed send.
        return json.dumps({"error": str(exc), "replay": False}, ensure_ascii=False)


@typed_tool
async def find_slack_member(
    query: Annotated[str, Field(min_length=1, max_length=200)],
    runtime: ToolRuntime[Any],
) -> str:
    """Recherche un membre actif par nom ou mention. Plusieurs résultats exigent une précision."""
    return await _result(lambda: _service(runtime).search(query))


@typed_tool
async def ping_slack_member(
    target: str,
    text: Annotated[str, Field(min_length=1, max_length=2000)],
    runtime: ToolRuntime[Any],
    dm: bool = False,
) -> str:
    """Mentionne un membre dans le fil courant. DM uniquement sur demande explicite."""
    return await _result(lambda: _service(runtime).send(target, text, dm=dm))


@typed_tool
async def schedule_slack_reminder(
    target: str,
    text: Annotated[str, Field(min_length=1, max_length=2000)],
    at: str,
    runtime: ToolRuntime[Any],
    dm: bool = False,
) -> str:
    """Programme un rappel ponctuel. at: date/heure ISO dans le fuseau annoncé ; demander toute heure manquante."""
    return await _result(lambda: _service(runtime).send(target, text, at=at, dm=dm))


@typed_tool
async def list_slack_reminders(runtime: ToolRuntime[Any]) -> str:
    """Liste les rappels créés par cet administrateur, avec leur état confirmé ou incertain."""
    return await _result(lambda: _service(runtime).reminders())


@typed_tool
async def cancel_slack_reminder(operation_id: str, runtime: ToolRuntime[Any]) -> str:
    """Annule un rappel confirmé, au moins 60 secondes avant son échéance."""
    return await _result(lambda: _service(runtime).cancel(operation_id))


@typed_tool
async def list_athlete_accounts(runtime: ToolRuntime[Any]) -> str:
    """Liste les comptes Arete actifs pour une consultation administrateur privée."""

    async def run():
        s = _service(runtime, private=True)
        return await to_thread.run_sync(
            admin_athlete_data.accounts, s.message.team, s.message.user, s.account_id
        )

    return await _result(run)


@typed_tool
async def read_athlete_data(
    athlete_id: Annotated[int, Field(ge=1)],
    section: admin_athlete_data.Section,
    runtime: ToolRuntime[Any],
    days: Annotated[int, Field(ge=1, le=120)] = 30,
    offset: Annotated[int, Field(ge=0, le=admin_athlete_data.MAX_OFFSET)] = 0,
    resource: str = "",
    thread_id: str = "",
    start_date: str = "",
) -> str:
    """Lecture privée d'un athlète. resource: ID séance/document ou chemin mémoire ; thread_id pour un document. Pagination explicite (caractères pour mémoire/document, lignes sinon). start_date: début ISO facultatif de la période santé/planning/musculation."""

    async def run():
        s = _service(runtime, private=True)
        return await to_thread.run_sync(
            lambda: admin_athlete_data.read(
                s.message.team,
                s.message.user,
                s.account_id,
                athlete_id,
                section,
                days=days,
                offset=offset,
                resource=resource,
                thread_id=thread_id,
                start_date=start_date,
            )
        )

    return await _result(run)


SLACK_TOOLS = [
    find_slack_member,
    ping_slack_member,
    schedule_slack_reminder,
    list_slack_reminders,
    cancel_slack_reminder,
]
ADMIN_DATA_TOOLS = [list_athlete_accounts, read_athlete_data]
