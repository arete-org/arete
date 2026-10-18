"""Instance-wide rollout switches, changed only through the admin API."""

from pydantic import BaseModel, ConfigDict, StrictBool

from arete.config import config
from arete.dataio.db import connect


class FeatureFlags(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    glm_flash: StrictBool = False
    coaching_attention: StrictBool = False


def glm_flash_available() -> bool:
    return config.llm_provider == "openrouter" and bool(config.openrouter_api_key)


def get_feature_flags() -> FeatureFlags:
    # Read once per invocation, not per model turn: other workers see a toggle
    # without a restart, while an in-flight run keeps its original route.
    con = connect()
    try:
        rows = dict(
            con.execute(
                "SELECT name,enabled FROM app.feature_flags WHERE name IN ('glm_flash','coaching_attention')"
            ).fetchall()
        )
        return FeatureFlags(**rows)
    finally:
        con.close()


def set_feature_flags(flags: FeatureFlags) -> FeatureFlags:
    if flags.glm_flash and not glm_flash_available():
        raise ValueError("Configure OpenRouter et sa clé API avant d'activer GLM.")
    con = connect()
    try:
        # Older clients update only GLM; they must not reset the independent rollout.
        for name in sorted(flags.model_fields_set or type(flags).model_fields):
            con.execute(
                "INSERT INTO app.feature_flags (name,enabled) VALUES (?,?) ON CONFLICT (name) DO UPDATE SET enabled=excluded.enabled",
                [name, getattr(flags, name)],
            )
    finally:
        con.close()
    return get_feature_flags()
