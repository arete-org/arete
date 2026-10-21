---
type: concept
title: Configuration Management
description: Environment variables, configuration sources, and runtime settings for the Arete application.
tags: [configuration, environment variables, settings]
verified:
  - by: openwiki/0.7.1
    at: 2026-10-21T06:33:32.768Z
sources:
  - id: openwiki-source-b465357f807c83adb7d1fddf
    resource: repo://src/arete/config.py
generated: { by: "openwiki/0.7.1", at: "2026-10-21T06:33:32.768Z" }
---

# Configuration Management

The Arete application uses environment variables for configuration, managed by a central `Config` class in `src/arete/config.py`. Configuration values are read from the environment on each access (no caching) to allow tests to patch `os.environ` freely.

## Claims

### Claim 1: Environment variable primary source
**Statement**: The central `Config` class in `src/arete/config.py` reads all configuration from environment variables, using `os.getenv()` as the primary source, with `python-dotenv` loaded values as fallback, and explicit defaults for most properties.

**Evidence**: 
- `src/arete/config.py` line 14: `load_dotenv()` loads `.env` file values into the environment
- Line 17-19: `_env()` function uses `os.getenv(name)` with fallback to default
- Each `Config` property (e.g., lines 24-26, 45-47, 99-101, etc.) calls `_env(name, default)` to read environment variables

### Claim 2: No caching of configuration values
**Statement**: Configuration values are read on every property access (no caching), ensuring that tests can patch `os.environ` freely and see updated values without restarting the process.

**Evidence**: 
- `src/arete/config.py` line 3-5: "read on each access (no caching) so tests can patch ``os.environ`` freely"
- Each property is a `@property` that calls `_env()` on every access (e.g., lines 24-26, 45-47, 99-101, etc.)

### Claim 3: Most configuration properties have explicit default values
**Statement**: Most configuration properties in the `Config` class have an explicit default value that is used when the corresponding environment variable is not set or is empty. A few properties intentionally return `None` when unset (e.g., `auto_sync_hour`, `llm_model`, `stt_api_key`).

**Evidence**: 
- `src/arete/config.py` throughout: Most properties have a default in the `_env()` call (e.g., `"ollama"` at line 101, `"data/arete.duckdb"` at line 47, `65536` at line 117, `"http://localhost:11434/v1"` at line 124, `""` at lines 128/171/175/180, `"false"` at line 144, `"openrouter"` at line 171, `"openai/whisper-large-v3-turbo"` at line 175, `60` at line 189, `10` at line 193, `"http://localhost:3080"` at line 197, `"false"` at line 203, `""` at lines 224-237/242-252, `"INFO"` at line 301)
- Lines 214-216: `auto_sync_hour` returns `None` when env var is not set
- Line 105: `llm_model` returns `None` when env var is not set
- Line 185: `stt_api_key` falls back to `openrouter_api_key` when unset

### Claim 4: Validation of configuration values
**Statement**: Some configuration properties include runtime validation and raise `ValueError` when input is invalid (e.g., numeric range checks, allowed string values).

**Evidence**: 
- `src/arete/config.py` line 118-119: `LLM_CONTEXT_TOKENS` raises `ValueError` if value < 8192
- Line 218-219: `auto_sync_hour` raises `ValueError` if hour not in 0-23
- Line 133-134: `MEMORY_JEV_ENABLED` raises `ValueError` if not "true" or "false"
- Line 145-146: `LANGSMITH_TRACING` raises `ValueError` if not "true" or "false"

### Claim 5: Database configuration supports local and remote modes
**Statement**: The `Config` class distinguishes between local DuckDB databases and remote MotherDuck databases via the `is_remote_db` property, which checks if `ARETE_DB` starts with `md:`.

**Evidence**: 
- `src/arete/config.py` lines 45-52: `db_target` property returns the `ARETE_DB` value; `is_remote_db` checks `self.db_target.startswith("md:")`

### Claim 6: Storage root adapts to database mode
**Statement**: The `storage_root` property (which `data_dir` builds upon) adapts its base path depending on whether the database is local or remote: locally it uses the database file's parent directory, while remotely it defaults to `/tmp/arete-data`. The `data_dir` property further scopes this by athlete ID.

**Evidence**: 
- `src/arete/config.py` lines 60-72: `storage_root` property has conditional logic for `is_remote_db`
- Lines 75-80: `data_dir` adds athlete-specific subdirectory under `storage_root`

## Sources of Configuration

- **Environment variables**: Primary source, loaded via `python-dotenv` from a `.env` file (if present) and the process environment.
- **Defaults**: Most configuration properties define a fallback value if the environment variable is not set or is empty. Some properties intentionally return `None` when unset.
- **Validation**: Some properties include validation (e.g., numeric ranges, allowed strings) and raise `ValueError` on invalid input.

## Key Configuration Areas

The configuration is organized into logical sections:

### Database
- `ARETE_DB`: Path to the local DuckDB file or MotherDuck URI (e.g., `md:<database>`). Default: `data/arete.duckdb`.
- Derived properties:
  - `is_remote_db`: True when using MotherDuck.
  - `db_path`: Path object for the database (local only).
  - `storage_root`: Directory for non-database data (defaults to database's parent directory locally, or `/tmp/arete-data` for remote databases). Can be overridden with `ARETE_DATA_DIR`.
  - `data_dir`: Athlete-scoped directory under `storage_root` (root for athlete ID 1, `athletes/<id>/` for others).
  - `garmin_tokens_dir`: Directory for Garmin session tokens (default: `<data_dir>/garmin_tokens`).
  - `fit_dir`: Directory for downloaded FIT files (default: `<data_dir>/fit_files`).

### Backend and Services
- `ARETE_LOG_LEVEL`: Logging level (default: `INFO`).
- `ARETE_AUTO_SYNC_HOUR`: Local hour (0-23) for daily Garmin/Strava sync; `None` disables it (Vercel Cron handles sync instead).
- `ARETE_AUTOMATION_WORKER`: When true, runs background automation worker (Docker); when false, Vercel Cron handles scheduled work.
- `FRONTEND_URL`: Browser origin used for OAuth callbacks (default: `http://localhost:3080`).
- `CRON_SECRET`: Bearer token for Vercel Cron endpoint; empty disables the endpoint.
- `GAMIFICATION_ENABLED`: Deployment kill switch for gamification features (default: `true`).

### LLM Provider (for tips and coaching agent)
- `LLM_PROVIDER`: One of `ollama`, `openrouter`, `github` (default: `ollama`).
- `LLM_MODEL`: Optional model override; if unset, uses provider-specific defaults (ollama: `llama3.1:8b`, openrouter: `nvidia/nemotron-3-super-120b-a12b:free`, github: `Meta-Llama-3.1-8B-Instruct`).
- `LLM_MODEL_FALLBACKS`: Comma-separated list of OpenRouter model IDs to try after `LLM_MODEL`.
- `LLM_CONTEXT_TOKENS`: Configured context window size (minimum 8192, default 65536).
- `OLLAMA_BASE_URL`: Base URL for Ollama API (default: `http://localhost:11434/v1`).
- `OPENROUTER_API_KEY`: API key for OpenRouter.
- `GITHUB_TOKEN`: Personal access token for GitHub Models.
- `MEMORY_JEV_ENABLED`: Enable semantic memory via Jev (default: `true`).

### Agent Tracing (LangSmith)
- `LANGSMITH_TRACING`: Enable/disable tracing (`true`/`false`, default: `false`).
- `LANGSMITH_API_KEY`: API key for LangSmith.
- `LANGSMITH_PROJECT`: Project name (default: `Arete`).
- `LANGSMITH_ENDPOINT`: API endpoint (default: `https://api.smith.langchain.com`).
- `LANGSMITH_WORKSPACE_ID`: Optional workspace ID for multi-workspace keys.

### Speech-to-Text (Dictated Sessions)
- `STT_PROVIDER`: `openrouter` or `none` (default: `openrouter`; `none` disables dictation).
- `STT_MODEL`: Model identifier (default: `openai/whisper-large-v3-turbo`).
- `STT_BASE_URL`: Base URL for STT API (default: `https://openrouter.ai/api/v1`).
- `STT_API_KEY`: Dedicated API key; falls back to `OPENROUTER_API_KEY` if unset.
- `STT_TIMEOUT_S`: Request timeout in seconds (default: 60).
- `STT_MAX_AUDIO_MB`: Maximum audio file size in MB (default: 10).

### Authentication
- `ARETE_AUTH`: Authentication provider (`clerk` or empty for open API).
- `CLERK_SECRET_KEY`: Clerk secret key for server-side session verification.
- `CLERK_PUBLISHABLE_KEY`: Clerk publishable key (also reads `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`).
- `CLERK_JWT_KEY`: Clerk instance PEM public key for offline JWT verification.
- `ARETE_AUTH_ORIGINS`: Comma-separated browser origins allowed to hold a session (token `azp`); empty = not checked.
- `ARETE_OWNER_EMAIL`: Comma-separated email addresses that are the athlete; others get no data.
- `ARETE_API_KEY`: Long-lived key for scripts and MCP server, acting as the owner.

### Web Push Notifications
- `WEB_PUSH_VAPID_PUBLIC_KEY`: VAPID public key (base64url) for browser subscription.
- `WEB_PUSH_VAPID_PRIVATE_KEY`: VAPID private key (base64url or PEM file path) for signing pushes.
- `WEB_PUSH_SUBJECT`: Contact URL for push services (default: `mailto:admin@localhost`).

### Slack Integration
- `SLACK_SIGNING_SECRET`: Slack app signing secret.
- `SLACK_BOT_TOKEN`: Slack bot token.
- `SLACK_TEAM_ID`: Slack team ID.
- `SLACK_CHANNEL_ID`: Optional dedicated channel; unset = DMs only.

### Google Calendar
- `VERCEL_ENV`: Vercel environment name (default: `development`).
- Calendar integration requires Clerk authentication; the signed-in Google account holds the grant.

### Deployment Detection
- `VERCEL`: Set to `1` when running on Vercel Functions (used to adjust execution envelope).

## Usage in Code

Configuration is accessed via the global `config` instance imported from `src.arete.config`:

```python
from arete.config import config

# Example: get the database target
db_target = config.db_target

# Example: check if Google Calendar is configured
if config.google_calendar_configured:
    # ...

# Example: check if running on Vercel
if config.serverless:
    # ...
```

Each property is implemented as a `@property` that reads the environment variable on every access, ensuring up-to-date values and testability.

## Example Environment File

See [`.env.example`](../.env.example) for a commented template of all supported environment variables.
