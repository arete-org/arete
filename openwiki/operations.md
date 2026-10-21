---
type: operations
title: Operations & Deployment
description: Deployment pipeline, monitoring, scaling, and maintenance procedures for the Arete application.
tags: [operations, deployment, monitoring, scaling]
sources:
  - id: openwiki-source-b79fbbd921df689b4bbdc82f
    resource: repo://docker-compose.yml
  - id: openwiki-source-012f2c78e3b1446dfc35803f
    resource: repo://Makefile
  - id: openwiki-source-3ea4ae9b4b98a62545a81494
    resource: repo://src/arete/api/main.py
  - id: openwiki-source-b465357f807c83adb7d1fddf
    resource: repo://src/arete/config.py
  - id: openwiki-source-ee03fa6c6caf83a873632b50
    resource: repo://src/arete/scheduler.py
verified:
  - by: openwiki/0.7.1
    at: 2026-10-21T06:33:32.768Z
generated: { by: "openwiki/0.7.1", at: "2026-10-21T06:33:32.768Z" }
---
## Overview

The Arete application follows a modern deployment pipeline combining local development, containerized production stacks, and automated background jobs. The system is designed for reliability, scalability, and maintainability through clear separation of concerns between the API backend, frontend SPA, and background synchronization services.

## Deployment Pipeline

### Development Setup

Development is initiated with `make dev`, which starts both the API (auto-reload) and frontend (Vite HMR) simultaneously:

```bash
make dev
```

This launches:
- **Backend API** on port 8000 (uvicorn) with hot reload
- **Frontend** on port 5173 (Vite) with Hot Module Replacement

Both services are coordinated by the `make` utility which manages dependencies and environment setup. The Makefile ensures both processes are children of one shell so Ctrl-C stops both, and when either exits the other is stopped too.

### Containerized Production Deployment

The `make docker` target builds and deploys a production-like stack using Docker Compose:

```bash
make docker
```

This creates two containers:
- **Backend** (`arete-backend`) on port 8001, running the API via uvicorn with health checks
- **Frontend** (`arete-frontend`) on port 3080, serving the React SPA via nginx

Key configuration from `docker-compose.yml`:
- Backend exposes port 8000 internally, mapped to 8001 externally
- Frontend serves on port 3080, proxying API requests to the backend via nginx
- Shared data volume at `./data:/app/data` ensures consistency between containers
- Health checks ensure the backend is responsive before considering the stack healthy
- Backend environment includes: `ARETE_DB=md:arete_v2` (MotherDuck), `ARETE_AUTOMATION_WORKER=true`, `OLLAMA_BASE_URL=http://host.docker.internal:11434/v1`, `FRONTEND_URL=http://localhost:3080`, `TZ=Europe/Paris`

### Service Dependencies

- **Backend** (`arete-backend`): Handles HTTP API requests, Garmin sync orchestration, and daily scheduling
- **Frontend** (`arete-frontend`): Provides the React-based user interface with real-time workout data
- **Database**: DuckDB (local file or MotherDuck remote) stores session data, plans, and coaching artifacts
- **Observability**: Health endpoints, request timing middleware, and optional LangSmith tracing

## System Architecture

<!-- openwiki: broken internal link [../architecture.md] file "../architecture.md" does not exist. Fix the href or restore the target, then delete this comment. -->
See [Architecture](../architecture.md) for a high-level overview of the system design, including:
- Coaching stack with one owner per behavior
- Agent runtime with middleware pipeline
- Service layer reusing domain modules
- Daily sync entrypoints for Garmin data ingestion

Core components:
- **Coaching**: Responsible for profile assembly, briefing generation, and feedback
- **Agents**: Modular agent framework built with LangChain, supporting chat, briefing, feedback, and review profiles
- **Services**: Domain-specific services (garmin, strava, strength, features)
- **Observability**: Provider usage tracking and model-boundary timing

## Configuration Management

Configuration is centralized in `src/arete/config.py` and follows these principles:

### Source of Truth
- All configuration is read from environment variables via `os.getenv()`
- `.env` files are loaded via `python-dotenv` for local development
- Explicit defaults are provided for every configuration property
- Values are read on every access (no caching) so tests can patch `os.environ` freely

### Key Properties

| Property | Description | Default |
|----------|-------------|---------|
| `ARETE_DB` | Database target (local DuckDB or MotherDuck URI like `md:<db>`) | `data/arete.duckdb` |
| `ARETE_AUTO_SYNC_HOUR` | Local hour (0-23) for daily Garmin sync; `None` disables in-process loop | `None` (disabled) |
| `ARETE_AUTOMATION_WORKER` | Run background automation worker in Docker | `false` |
| `FRONTEND_URL` | Browser origin for OAuth callbacks | `http://localhost:3080` |
| `LLM_PROVIDER` | LLM provider (ollama, openrouter, github) | `ollama` |
| `LLM_CONTEXT_TOKENS` | Context window size (min 8192) | `65536` |
| `OLLAMA_BASE_URL` | Ollama API base URL | `http://localhost:11434/v1` |
| `OPENROUTER_API_KEY` | OpenRouter API key | (empty) |
| `CRON_SECRET` | Bearer token for Vercel Cron endpoints | (empty, disables) |
| `WEB_PUSH_VAPID_*` | VAPID keys for web push notifications | (empty) |
| `ARETE_LOG_LEVEL` | Logging level | `INFO` |
| `ARETE_AUTH` | Auth provider (`clerk` or empty for open) | (empty) |
| `CLERK_*` | Clerk authentication keys | (empty) |

### Validation
Some properties include runtime validation:
- `LLM_CONTEXT_TOKENS` must be ≥ 8192
- `ARETE_AUTO_SYNC_HOUR` must be 0–23
- `MEMORY_JEV_ENABLED` and `LANGSMITH_TRACING` must be "true" or "false"

### Database Adaptation
- Local DB: data resides in `data/` directory (parent of database file)
- Remote DB (MotherDuck): data lives in `/tmp/arete-data` on the server (Vercel Functions)
- `data_dir` adapts based on database mode and athlete ID

## Background Jobs & Scheduling

### Scheduler Overview

The `src/arete/scheduler.py` module orchestrates all background work through an asyncio task that wakes every 5 minutes (`TICK_SECONDS = 300`). When `ARETE_AUTO_SYNC_HOUR` is set or `ARETE_AUTOMATION_WORKER=true`, the scheduler starts at application startup via the FastAPI lifespan.

### Daily Sync (`run_scheduled_batch`)

Runs for athletes whose day's run is owed (scheduled hour has passed and today's run not yet done):
1. **Garmin Sync** (`daily_sync()`): Fetches activities via `GarminClient`, syncs fitness data, handles tokens
2. **Plan Adaptation** (`adapt_today`): Adapts today's plan based on fresh data
3. **Garmin Push** (`push_today`): Pushes adapted sessions to Garmin device
4. **Gamification Settlement** (`settle_game`): Settles RPG progression for opted-in athletes
5. **Google Calendar Sync** (`sync_training_plan`): Syncs plan to Google Calendar (DAILY)
6. **Session Feedback** (`write_sync_feedback`): Coach writes feedback on imported sessions
7. **Notification** (`announce_sync`): Sends push notification about sync results
8. **Daily Briefing** (`write_daily_briefing`): Generates coach briefing after sync
9. **Weekly Review Fallback** (`write_weekly_review`): Writes weekly review if missing (not on Sundays)

The last run date is recorded to a durable JSON marker file (`last_daily_sync.json`) beside the database so restarts don't re-run completed syncs.

### Check-in Prompts (`run_checkin_prompts`)

Sends morning check-in push to athletes in their morning window (06:00-12:00 local, outside quiet hours), before the daily sync runs. Each athlete gets it at most once per day.

### Evening Replanning (`run_evening_replans`)

Replans today's missed sessions for athletes in their evening (from 18:00 UTC on Vercel, 20:00 local in Docker). Each athlete's day gets one proposal and one push at most.

### Evening Messages (`run_evening_messages`)

Writes tomorrow's evening message for athletes who opted in, from their chosen hour (default 20:00) outside quiet hours. Replans missed sessions first if needed.

### Sunday Reviews (`run_sunday_reviews`)

On Sunday evening (17:00+ local, outside quiet hours), writes the week's review and pushes it. Runs independently of the daily sync claim/markers.

### Automations (`run_automations`)

Processes the automation queue (shared with Vercel Cron) for background agent tasks. Runs on every tick regardless of `ARETE_AUTO_SYNC_HOUR`.

### Concurrency & Safety

- Each athlete's daily work is protected by a lease (`sync_lease_until`) with compare-and-set to prevent overlapping runs
- A failed run keeps its lease until the next day (never replayed same day)
- Consent is checked at candidate selection and again before each athlete's work
- Dispatch time bounds (`SCHEDULE_DISPATCH_SECONDS=120`, `SCHEDULE_MODEL_SECONDS=210`, `SCHEDULE_RUN_SECONDS=280`) prevent function timeout on Vercel
- On Docker, the 5-minute tick cadence reaches all timezones; on Vercel, multiple cron windows cover the day

## Scaling & Performance

### Horizontal Scaling

- **API Layer**: Single-process FastAPI app with async I/O; suitable for moderate concurrent users
- **Frontend**: Stateless React SPA; scales horizontally behind a reverse proxy (nginx in Docker, Vercel edge for serverless)
- **Background Workers**: Scheduler runs as a single asyncio task per process; for higher throughput, consider sharding the sync workload across multiple workers

### Resource Considerations

- **Memory**: The agent runtime maintains conversation state and tool contexts; monitor memory usage in long-running processes
- **CPU**: Model inference dominates CPU load; consider GPU acceleration for larger models
- **Database**: DuckDB is optimized for analytical queries; ensure adequate disk I/O; MotherDuck handles scaling remotely

## Monitoring & Observability

### Health Checks

- **API Health** (`GET /health`): Confirms DuckDB connectivity, schema version, pending migrations, and initialization status. Returns 503 if database unreachable or migrations pending.
- **Sync Status** (`GET /sync/status`): Reports scheduled hour, last run date (from durable marker), and per-source outcomes of the last run this process executed
- **Request Timing**: Every HTTP response includes a `Server-Timing` header with phase durations (auth, hydration, DB, handler, total)
- **Structured Logging**: Per-request log line with method, path, status, and phase timings

### Logging

Logging is configured in `src/arete/api/main.py` with level from `ARETE_LOG_LEVEL` (default: INFO). All major operations are logged:
- Sync status transitions and per-source outcomes
- Agent invocations, tool calls, and model requests
- Error conditions and exceptions with context

### Tracing

LangSmith integration (enabled via `LANGSMITH_TRACING=true`) provides distributed tracing for the shared coaching agent, capturing:
- Model calls and their latency
- Tool executions and durations
- Cross-service request flows

## Maintenance Procedures

### Regular Tasks

1. **Database Backups**
   - Schedule periodic snapshots of the DuckDB database (local file or MotherDuck)
   - Verify backup integrity before deployments

2. **Container Hygiene**
   - Remove unused images and volumes periodically
   - Update base images (Python 3.12-slim, Node 22-alpine, nginx:alpine) to address security patches

3. **Configuration Rotation**
   - Rotate secrets (`CRON_SECRET`, `WEB_PUSH_VAPID_*` keys, `CLERK_SECRET_KEY`, `OPENROUTER_API_KEY`) regularly
   - Audit environment variables for unnecessary permissions

4. **Monitoring Alerts**
   - Alert on prolonged sync failures (check `/sync/status` last_run age)
   - Monitor API error rates and response times via request timing logs
   - Watch for memory leaks in long-running processes (Docker backend)

### Incident Response

- **Sync Failure**: Check Garmin API connectivity; verify tokens in `garmin_tokens/` directory; review scheduler logs for per-source error statuses
- **Performance Degradation**: Profile the scheduler; consider increasing `TICK_SECONDS` or reducing `MAX_SCHEDULED_ATHLETES`; check `Server-Timing` headers for slow phases
- **Data Loss**: Ensure `ARETE_AUTO_SYNC_HOUR` is correctly set for athlete timezones; verify database durability (MotherDuck or local file backups)
- **Stuck Lease**: Use `release_sync_lease(athlete_id)` admin function to clear a lease from a failed/stopped run (only releases if lease expired)

## Summary

<!-- openwiki: broken internal link [../architecture.md] file "../architecture.md" does not exist. Fix the href or restore the target, then delete this comment. -->
<!-- openwiki: broken internal link [../configuration.md] file "../configuration.md" does not exist. Fix the href or restore the target, then delete this comment. -->
The Arete platform combines a robust deployment pipeline with a well-defined operating model. Development leverages `make dev` for rapid iteration, while production uses Docker Compose for reproducible environments or Vercel for serverless deployment. The system's modular architecture ([Architecture](../architecture.md)) and centralized configuration ([Configuration](../configuration.md)) enable safe evolution and operational control.

Key operational touchpoints:
- **Deploy**: `make docker` for self-hosted production, `vercel deploy` for serverless, `make dev` for development
- **Monitor**: `/health`, `/sync/status`, request timing logs, and optional LangSmith tracing
- **Maintain**: Regular config audits, database backups, container hygiene, secret rotation
- **Scale**: Horizontal scaling of frontend; potential sharding for background sync workers
