"""Server copy follows the same explicit game preference as the interface."""

from arete.config import config
from arete.dataio.db import db_connection


def subject() -> str:
    with db_connection() as con:
        row = con.execute(
            "SELECT enabled FROM app.visible_game_profile WHERE id=1"
        ).fetchone()
    return "Chiron" if row and row[0] and config.gamification_available else "Le coach"
