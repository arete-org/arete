"""Runtime configuration, read from environment variables.

Single place that knows the variable names and defaults. Values are read on
each access (no caching) so tests can patch ``os.environ`` freely.
"""

from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()


def _env(name: str, default: str | None = None) -> str | None:
    value = os.getenv(name)
    return value if value not in (None, "") else default


class Config:
    @property
    def gamification_available(self) -> bool:
        """Deployment kill switch; the athlete still has to opt in."""
        return (_env("GAMIFICATION_ENABLED", "true") or "").lower() == "true"

    @property
    def google_calendar_environment(self) -> str:
        return _env("VERCEL_ENV", "development") or "development"

    @property
    def google_calendar_configured(self) -> bool:
        """Calendar rides on Clerk: the signed-in Google account holds the grant."""
        return self.auth_provider == "clerk" and bool(self.clerk_secret_key)

    # --- storage -----------------------------------------------------------
    @property
    def db_target(self) -> str:
        """``ARETE_DB`` as given: a file path, or ``md:<database>`` for MotherDuck."""
        return _env("ARETE_DB", "data/arete.duckdb") or "data/arete.duckdb"

    @property
    def is_remote_db(self) -> bool:
        """True when the database lives in MotherDuck rather than in a local file."""
        return self.db_target.startswith("md:")

    @property
    def db_path(self) -> Path:
        """Local database file. Meaningless when the database is remote."""
        return Path(self.db_target)

    @property
    def storage_root(self) -> Path:
        """Where everything that is not the database is written.

        Beside the database file locally. On a remote database the process may
        run where only ``/tmp`` is writable (Vercel Functions), so files go
        there and ``dataio.mirror`` keeps them in the database.
        """
        explicit = _env("ARETE_DATA_DIR")
        if explicit:
            return Path(explicit)
        if self.is_remote_db:
            return Path("/tmp/arete-data")
        return self.db_path.parent

    @property
    def data_dir(self) -> Path:
        from arete.services.athlete_scope import current_athlete_id

        athlete_id = current_athlete_id()
        root = self.storage_root
        return root if athlete_id == 1 else root / "athletes" / str(athlete_id)

    @property
    def garmin_tokens_dir(self) -> Path:
        explicit = _env("ARETE_GARMIN_TOKENS_DIR")
        from arete.services.athlete_scope import current_athlete_id

        if explicit and current_athlete_id() == 1:
            return Path(explicit)
        return self.data_dir / "garmin_tokens"

    @property
    def fit_dir(self) -> Path:
        """Downloaded FIT files. Ephemeral on a remote database: the sync reads
        what it needs at download time, and recomputing zones falls back to
        lap averages when a file is gone."""
        return self.data_dir / "fit_files"

    # --- LLM (tips + coaching agent) ----------------------------------------
    @property
    def llm_provider(self) -> str:
        return (_env("LLM_PROVIDER", "ollama") or "ollama").lower().strip()

    @property
    def llm_model(self) -> str | None:
        return _env("LLM_MODEL")

    @property
    def llm_model_fallbacks(self) -> tuple[str, ...]:
        """Comma-separated OpenRouter model ids tried after LLM_MODEL."""
        raw = _env("LLM_MODEL_FALLBACKS", "") or ""
        return tuple(m.strip() for m in raw.split(",") if m.strip())

    @property
    def llm_context_tokens(self) -> int:
        # Deployment contract: especially for routers/local servers, the model
        # name alone does not establish the actual configured context window.
        value = int(_env("LLM_CONTEXT_TOKENS", "65536") or 65536)
        if value < 8192:
            raise ValueError("LLM_CONTEXT_TOKENS must be at least 8192")
        return value

    @property
    def ollama_base_url(self) -> str:
        return _env("OLLAMA_BASE_URL", "http://localhost:11434/v1") or ""

    @property
    def openrouter_api_key(self) -> str:
        return _env("OPENROUTER_API_KEY", "") or ""

    @property
    def memory_jev_enabled(self) -> bool:
        raw = (_env("MEMORY_JEV_ENABLED", "true") or "true").lower().strip()
        if raw not in ("true", "false"):
            raise ValueError("MEMORY_JEV_ENABLED must be true or false")
        return raw == "true"

    @property
    def github_token(self) -> str:
        return _env("GITHUB_TOKEN", "") or ""

    # --- Agent tracing (independent of inference credentials) --------------
    @property
    def langsmith_tracing(self) -> bool:
        raw = (_env("LANGSMITH_TRACING", "false") or "false").lower().strip()
        if raw not in ("true", "false"):
            raise ValueError("LANGSMITH_TRACING must be true or false")
        return raw == "true"

    @property
    def langsmith_api_key(self) -> str:
        return (_env("LANGSMITH_API_KEY", "") or "").strip()

    @property
    def langsmith_project(self) -> str:
        return _env("LANGSMITH_PROJECT", "Arete") or "Arete"

    @property
    def langsmith_endpoint(self) -> str:
        return (
            _env("LANGSMITH_ENDPOINT", "https://api.smith.langchain.com") or ""
        ).rstrip("/")

    @property
    def langsmith_workspace_id(self) -> str | None:
        return _env("LANGSMITH_WORKSPACE_ID")

    # --- Speech to text (dictated sessions) --------------------------------
    @property
    def stt_provider(self) -> str:
        """``openrouter`` or ``none``; ``none`` disables dictation entirely."""
        return (_env("STT_PROVIDER", "openrouter") or "none").lower().strip()

    @property
    def stt_model(self) -> str:
        return _env("STT_MODEL", "openai/whisper-large-v3-turbo") or ""

    @property
    def stt_base_url(self) -> str:
        """OpenAI-compatible base URL; point it at a local server to go offline."""
        return (_env("STT_BASE_URL", "https://openrouter.ai/api/v1") or "").rstrip("/")

    @property
    def stt_api_key(self) -> str:
        """Dedicated key, falling back to the OpenRouter one used for tips."""
        return _env("STT_API_KEY") or self.openrouter_api_key

    @property
    def stt_timeout_s(self) -> int:
        return int(_env("STT_TIMEOUT_S", "60") or 60)

    @property
    def stt_max_audio_mb(self) -> int:
        return int(_env("STT_MAX_AUDIO_MB", "10") or 10)

    # --- Strava ------------------------------------------------------------
    @property
    def strava_client_id(self) -> str:
        return _env("STRAVA_CLIENT_ID", "") or ""

    @property
    def strava_client_secret(self) -> str:
        return _env("STRAVA_CLIENT_SECRET", "") or ""

    @property
    def strava_redirect_uri(self) -> str:
        return (
            _env("STRAVA_REDIRECT_URI", "http://localhost:8000/strava/callback") or ""
        )

    @property
    def frontend_url(self) -> str:
        return _env("FRONTEND_URL", "http://localhost:3080") or ""

    # --- background jobs / logging -----------------------------------------
    @property
    def auto_sync_hour(self) -> int | None:
        """Local hour (0-23) of the daily Garmin/Strava sync; None disables it.

        Garmin publishes the night's HRV and sleep score at wake-up, so an hour
        before the athlete is up leaves the day without recovery data.
        """
        raw = _env("ARETE_AUTO_SYNC_HOUR")
        if raw is None:
            return None
        hour = int(raw)
        if not 0 <= hour <= 23:
            raise ValueError("ARETE_AUTO_SYNC_HOUR must be between 0 and 23")
        return hour

    @property
    def cron_secret(self) -> str:
        """Bearer token Vercel Cron sends; empty disables the cron endpoint."""
        return _env("CRON_SECRET", "") or ""

    @property
    def slack_signing_secret(self) -> str:
        return _env("SLACK_SIGNING_SECRET", "") or ""

    @property
    def slack_bot_token(self) -> str:
        return _env("SLACK_BOT_TOKEN", "") or ""

    @property
    def slack_team_id(self) -> str:
        return _env("SLACK_TEAM_ID", "") or ""

    @property
    def web_push_vapid_public_key(self) -> str:
        """VAPID public key (base64url) the browser subscribes with; empty = no push."""
        return _env("WEB_PUSH_VAPID_PUBLIC_KEY", "") or ""

    @property
    def web_push_vapid_private_key(self) -> str:
        """VAPID private key (base64url, or a PEM file path) that signs each push."""
        return _env("WEB_PUSH_VAPID_PRIVATE_KEY", "") or ""

    @property
    def web_push_subject(self) -> str:
        """Contact the push services can reach (``mailto:`` or https URL)."""
        return _env("WEB_PUSH_SUBJECT", "mailto:admin@localhost") or ""

    # --- authentication ----------------------------------------------------
    @property
    def auth_provider(self) -> str:
        """``clerk`` makes every API route require a signed-in user; empty
        (the default) leaves the API open, as a self-hosted instance behind
        its own network or Vercel Authentication runs it."""
        return (_env("ARETE_AUTH", "") or "").strip().lower()

    @property
    def clerk_secret_key(self) -> str:
        return _env("CLERK_SECRET_KEY", "") or ""

    @property
    def clerk_jwt_key(self) -> str:
        """The Clerk instance's PEM public key: session tokens are then verified
        offline instead of fetching Clerk's JWKS. Empty = fetch (5 min cache)."""
        return _env("CLERK_JWT_KEY", "") or ""

    @property
    def clerk_publishable_key(self) -> str:
        """The Marketplace provisions it under the Next.js name; both are read."""
        return (
            _env("CLERK_PUBLISHABLE_KEY")
            or _env("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "")
            or ""
        )

    @property
    def auth_origins(self) -> tuple[str, ...]:
        """Browser origins allowed to hold a session (the token's ``azp``);
        empty = not checked, which Vercel preview URLs need."""
        raw = _env("ARETE_AUTH_ORIGINS", "") or ""
        return tuple(o.strip().rstrip("/") for o in raw.split(",") if o.strip())

    @property
    def owner_emails(self) -> tuple[str, ...]:
        """Addresses that are the athlete, comma-separated; others get no data."""
        raw = _env("ARETE_OWNER_EMAIL", "") or ""
        return tuple(e.strip().lower() for e in raw.split(",") if e.strip())

    @property
    def api_key(self) -> str:
        """A long-lived key for scripts and the MCP server, acting as the owner."""
        return _env("ARETE_API_KEY", "") or ""

    @property
    def log_level(self) -> str:
        return (_env("ARETE_LOG_LEVEL", "INFO") or "INFO").upper()


config = Config()
