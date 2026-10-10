"""Instance-wide rollout switches, changed only through the admin API."""

from pydantic import BaseModel, ConfigDict, StrictBool

from arete.config import config
from arete.dataio.db import connect


class FeatureFlags(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    glm_flash: StrictBool = False


def glm_flash_available() -> bool:
    return config.llm_provider == "openrouter" and bool(config.openrouter_api_key)


def get_feature_flags() -> FeatureFlags:
    # Read once per invocation, not per model turn: other workers see a toggle
    # without a restart, while an in-flight run keeps its original route.
    con = connect()
    try:
        row = con.execute(
            "SELECT enabled FROM app.feature_flags WHERE name = 'glm_flash'"
        ).fetchone()
        return FeatureFlags(glm_flash=row[0] if row else False)
    finally:
        con.close()


def set_feature_flags(flags: FeatureFlags) -> FeatureFlags:
    if flags.glm_flash and not glm_flash_available():
        raise ValueError("Configure OpenRouter et sa clé API avant d'activer GLM.")
    con = connect()
    try:
        con.execute(
            """INSERT INTO app.feature_flags (name, enabled) VALUES ('glm_flash', ?)
               ON CONFLICT (name) DO UPDATE SET enabled = excluded.enabled""",
            [flags.glm_flash],
        )
    finally:
        con.close()
    return flags
