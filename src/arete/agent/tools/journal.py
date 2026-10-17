"""Model adapter for server-dated notes and session journal entries."""

import json
from datetime import date
from typing import Annotated, Literal

from pydantic import Field

from arete.agent.tools.validation import typed_tool
from arete.services.memory import append_entry

MAX_TITLE_CHARS = 120
MAX_BODY_CHARS = 2_000


@typed_tool
def append_journal(
    file: Literal["sessions.md", "notes.md", "profile.md"],
    title: Annotated[str, Field(min_length=1, max_length=MAX_TITLE_CHARS)],
    body: Annotated[str, Field(min_length=1, max_length=MAX_BODY_CHARS)],
    day: str = "",
) -> str:
    """Ajoute une entrée datée à ton journal. `sessions.md`: une séance dont
    vous avez parlé (faits marquants, ressenti, décision). `notes.md`: une
    observation de coach qui n'est pas un fait sur l'athlète. `profile.md`:
    réponses personnelles confirmées par l’athlète. Le serveur écrit
    l'entête daté et ignore une entrée déjà présente. `day`: date ISO de la
    séance si ce n'est pas aujourd'hui, sinon vide."""
    if not title.strip() or not body.strip():
        return json.dumps({"error": "title et body sont obligatoires."})
    if len(title) > MAX_TITLE_CHARS or len(body) > MAX_BODY_CHARS:
        return json.dumps(
            {
                "error": f"Entrée trop longue (titre ≤ {MAX_TITLE_CHARS}, "
                f"corps ≤ {MAX_BODY_CHARS} caractères)."
            }
        )
    try:
        when = date.fromisoformat(day) if day else None
    except ValueError:
        return json.dumps({"error": f"day doit être une date ISO, reçu « {day} »."})
    written = append_entry(file, title, body, when=when)
    return json.dumps(
        {"written": written, "file": file}
        if written
        else {"written": False, "reason": "Cette entrée existe déjà."},
        ensure_ascii=False,
    )
