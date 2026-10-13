"""Model adapter for the athlete's response to a coach follow-up."""

import json
from typing import Annotated

from pydantic import Field

from arete.agent.tools.validation import typed_tool


@typed_tool
def respond_coach_followup(
    followup_id: Annotated[int, Field(gt=0)],
    revision: Annotated[int, Field(ge=1)],
    rpe: Annotated[int, Field(ge=1, le=10)],
    notes: Annotated[str, Field(max_length=2_000)] = "",
) -> str:
    """Consigne le ressenti explicitement déclaré pour le suivi joint au contexte.
    N'invente jamais un RPE. Une réponse déjà enregistrée n'est pas écrasée.
    """
    from arete.services.coach_followup import respond

    try:
        result = respond(followup_id, revision, "answer", rpe=rpe, notes=notes or None)
    except (ValueError, LookupError) as exc:
        return json.dumps({"error": str(exc)}, ensure_ascii=False)
    return json.dumps({"saved": True, "followup": result}, ensure_ascii=False)
