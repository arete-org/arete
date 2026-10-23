"""Resolve explicit skills without preloading their bodies."""

import re

MAX_REQUESTED_SKILLS = 3


class SkillSelectionError(ValueError):
    """An explicit slash command cannot be honored; never silently ignore it."""


def requested_skill_paths(query: str, skills: list[dict]) -> tuple[str, ...]:
    """Resolve leading /name commands only against the trusted discovery list."""
    by_name = {skill["name"]: skill["path"] for skill in skills}
    paths = []
    remaining = query.lstrip()
    for _ in range(MAX_REQUESTED_SKILLS + 1):
        match = re.match(r"/([a-z0-9-]+)(?=\s|$)", remaining)
        if match is None:
            break
        name = match[1]
        if name not in by_name:
            raise SkillSelectionError(
                f"Skill inconnu : /{name}. Choisis un skill dans le menu /."
            )
        if by_name[name] not in paths:
            paths.append(by_name[name])
        remaining = remaining[match.end() :].lstrip()
    else:
        raise SkillSelectionError(
            f"Choisis au maximum {MAX_REQUESTED_SKILLS} skills par demande."
        )
    if remaining == "/":
        raise SkillSelectionError("Choisis un skill dans le menu / avant d’envoyer.")
    return tuple(paths)
