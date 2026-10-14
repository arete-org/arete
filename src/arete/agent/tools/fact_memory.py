"""Model adapters for durable athlete facts and their grounded evidence."""

import json
from datetime import date
from functools import partial
from typing import Annotated, Any, Literal

from anyio import to_thread
from langchain.tools import ToolRuntime
from pydantic import Field

from arete.agent.runtime.context import AgentContext
from arete.agent.runtime.fact_memory import classify_memory, grounded_source
from arete.agent.tools.validation import typed_tool
from arete.services import athlete_facts
from arete.services.fact_memory import FactDraft, remember


@typed_tool
async def remember_fact(
    kind: Literal["injury", "constraint", "preference", "goal", "other"],
    text: Annotated[str, Field(min_length=1, max_length=athlete_facts.MAX_TEXT)],
    runtime: ToolRuntime[Any],
    fact_id: Annotated[int, Field(ge=0)] = 0,
    status: Literal["active", "resolved"] = "active",
    evidence: Literal["explicit", "hypothesis"] = "hypothesis",
    expected_revision: Annotated[int, Field(ge=1)] | None = None,
    source_ref: Annotated[str, Field(max_length=athlete_facts.MAX_SOURCE_REF)] = "",
    since: str = "",
    valid_until: str = "",
) -> str:
    """Enregistre un fait durable sur l'athlète (blessure, contrainte,
    préférence, objectif), ou corrige celui dont tu donnes `fact_id` (son
    numéro #N et `expected_revision` dans la liste jointe). `evidence="explicit"`
    seulement pour une déclaration de l’athlète, sinon `hypothesis`. `source_ref`:
    citation exacte de la dernière déclaration de l’athlète pour evidence="explicit" ;
    le serveur ajoute la référence au fil. Pour une hypothèse, indique sa source connue.
    Le résultat distingue created, updated, already_present et needs_clarification.
    Ce dernier ne sauvegarde rien : clarifie avant de corriger avec id et révision.
    `since` et `valid_until`: dates ISO pour une exception temporaire, qui doit
    rester un fait séparé de la préférence durable. `status="resolved"` quand le fait ne tient
    plus (blessure guérie, contrainte levée). Un fait par appel, une phrase."""
    context = runtime.context
    assert isinstance(context, AgentContext), "Server memory context required"
    try:
        source = (
            grounded_source(source_ref, context)
            if evidence == "explicit"
            else source_ref
        )
        start = date.fromisoformat(since) if since else None
        end = date.fromisoformat(valid_until) if valid_until else None
        if fact_id:
            fact = await to_thread.run_sync(
                partial(
                    athlete_facts.update_fact,
                    fact_id,
                    kind=kind,
                    text=text,
                    status=status,
                    evidence=evidence,
                    expected_revision=expected_revision,
                    source_ref=source or None,
                    since=start,
                    valid_until=end,
                )
            )
            if fact is None:
                return json.dumps({"error": f"Fait #{fact_id} introuvable."})
            result = {"saved": True, "action": "updated", "fact": fact.to_dict()}
        else:
            if status != "active":
                return json.dumps(
                    {"error": "Un nouveau fait est actif ; pour clore, donne fact_id."}
                )
            result = await remember(
                FactDraft(
                    kind, text, evidence, source, start or context.current_date, end
                ),
                classify=partial(
                    classify_memory,
                    context=context,
                    completed_calls=runtime.state.get("run_model_call_count", 0),
                )
                if context.memory_model
                else None,
            )
    except ValueError as exc:
        return json.dumps({"error": str(exc)}, ensure_ascii=False)
    return json.dumps(result, ensure_ascii=False)


@typed_tool
def forget_fact(
    fact_id: Annotated[int, Field(gt=0)],
    expected_revision: Annotated[int, Field(ge=1)],
) -> str:
    """Oublie un fait et toutes ses versions à la demande explicite de l'athlète.
    Utilise l'id et la révision joints ; ne supprime ni séance ni journal.
    """
    try:
        removed = athlete_facts.delete_fact(
            fact_id, expected_revision=expected_revision
        )
    except ValueError as exc:
        return json.dumps({"error": str(exc)}, ensure_ascii=False)
    return json.dumps({"forgotten": removed, "fact_id": fact_id})
