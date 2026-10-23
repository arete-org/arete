import asyncio
import hmac
import logging
import sys
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import duckdb
from fastapi import FastAPI, Header, HTTPException, Request, Response
from fastapi.responses import JSONResponse

from arete import scheduler
from arete.api.activities import router as activities_router
from arete.api.admin import router as admin_router
from arete.api.agent import router as agent_router
from arete.api.ai_tips import router as ai_tips_router
from arete.api.analytics import router as analytics_router
from arete.api.athlete_facts import router as athlete_facts_router
from arete.api.auth import AuthMiddleware, auth_misconfigured
from arete.api.auth import router as auth_router
from arete.api.automations import router as automations_router
from arete.api.body_log import router as body_log_router
from arete.api.checkins import router as checkins_router
from arete.api.coach import router as coach_router
from arete.api.dashboard import router as dashboard_router
from arete.api.data_export import router as data_export_router
from arete.api.documents import router as documents_router
from arete.api.gamification import router as gamification_router
from arete.api.garmin import router as garmin_router
from arete.api.garmin_export import router as garmin_export_router
from arete.api.garmin_health import router as garmin_health_router
from arete.api.garmin_sync import router as garmin_sync_router
from arete.api.goals import router as goals_router
from arete.api.google_calendar import PlanSyncMiddleware
from arete.api.google_calendar import router as google_calendar_router
from arete.api.metrics import router as metrics_router
from arete.api.notifications import router as notifications_router
from arete.api.onboarding import router as onboarding_router
from arete.api.plan import router as plan_router
from arete.api.settings import router as settings_router
from arete.api.slack import router as slack_router
from arete.api.strength import router as strength_router
from arete.api.year_review import router as year_review_router
from arete.config import config
from arete.dataio.db import db_connection, warn_production_database
from arete.dataio.init_duckdb import SchemaInitializationError, pending_migrations
from arete.dataio.init_duckdb import main as init_schema
from arete.dataio.mirror import MirrorMiddleware
from arete.dataio.ownership import OwnershipError
from arete.observability.http import (
    AUTHORIZED,
    HANDLER,
    HANDLER_END,
    MIRROR_END,
    PhaseMark,
    RequestTimingMiddleware,
)
from arete.services.documents import DocumentError

logger = logging.getLogger(__name__)
MAX_STARTUP_ERROR_CHARS = 16_384


def configure_logging() -> None:
    """Root logger to stderr; level from ARETE_LOG_LEVEL (default INFO)."""
    logging.basicConfig(
        level=config.log_level,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        force=False,
    )
    logging.getLogger("httpx").setLevel(logging.WARNING)


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    configure_logging()
    _app.state.schema_initialization = {"status": "not_started"}
    _app.state.schema_initialization_error = None
    if config.langsmith_tracing:
        # LangSmith loads only when tracing is on; this rejects a missing key.
        from arete.observability.tracing import get_tracing_client

        get_tracing_client()
    elif config.langsmith_tracing_requested:
        logger.info(
            "LangSmith tracing off: production data outside LANGSMITH_PRODUCTION_WINDOW"
        )
    warn_production_database()
    try:
        init_schema()
        _app.state.schema_initialization = {"status": "ready"}
        logger.info("Database schema initialized")
    except Exception as e:
        _app.state.schema_initialization = {
            "status": "failed",
            "stage": e.stage if isinstance(e, SchemaInitializationError) else "unknown",
            "error_type": (
                e.error_type
                if isinstance(e, SchemaInitializationError)
                else type(e).__name__
            ),
        }
        # Startup has no Vercel request context. Retain text, not traceback
        # frames, so a failed health probe can log the cause in its own context.
        error_text = str(e)
        if len(error_text) > MAX_STARTUP_ERROR_CHARS:
            error_text = (
                error_text[:MAX_STARTUP_ERROR_CHARS] + " [startup error truncated]"
            )
        _app.state.schema_initialization_error = error_text
        logger.warning("Database init failed (non-fatal): %s", e)
    problem = auth_misconfigured()
    if problem:
        # Fail closed, loudly: every request will answer 503 until fixed.
        logger.error("ARETE_AUTH=clerk but %s", problem)
    task = scheduler.start()
    try:
        yield
    finally:
        if task is not None:
            task.cancel()
        if "arete.observability.tracing" in sys.modules:
            from arete.observability.tracing import close_tracing

            await asyncio.to_thread(close_tracing)


app = FastAPI(title="Arete API", version="0.1.0", lifespan=lifespan)
# Innermost: follows the plan into Google Calendar once the response is sent.
app.add_middleware(PlanSyncMiddleware)
# Phase marks for the request timing: the handler runs between these two.
app.add_middleware(PhaseMark, enter=HANDLER, leave=HANDLER_END)
app.add_middleware(MirrorMiddleware)
app.add_middleware(PhaseMark, enter=AUTHORIZED, leave=MIRROR_END)
# Runs before the mirror: a refused request never reaches it.
app.add_middleware(AuthMiddleware)
# Added last, so it runs first: times every request, refused ones included.
app.add_middleware(RequestTimingMiddleware)


@app.exception_handler(duckdb.TransactionException)
async def transaction_conflict(_request, _exc):
    return JSONResponse(
        status_code=409,
        content={
            "detail": "Une autre opération a modifié ces données. Recharge l’état avant de réessayer."
        },
    )


@app.exception_handler(OwnershipError)
async def ownership_error(_request, exc: OwnershipError):
    return JSONResponse(status_code=404, content={"detail": str(exc)})


@app.exception_handler(DocumentError)
async def document_error(_request, exc: DocumentError):
    return JSONResponse(status_code=409, content={"detail": str(exc)})


@app.get("/health")
def health(response: Response, request: Request):
    """Health check endpoint with database status.

    Reads a real table rather than ``SELECT 1``, which DuckDB answers locally:
    the probe must reach (and so keep awake) the remote database. A database
    that is unreachable or behind this code's migrations (the boot swallows a
    failed migration) answers 503: the deploy workflows and the pinger stop
    on it rather than on a page that fails.
    """
    db_status = "connected"
    schema_version = None
    pending: list[int] = []
    try:
        with db_connection() as con:
            row = con.execute(
                "SELECT COALESCE(MAX(version), 0) FROM app.schema_version"
            ).fetchone()
            schema_version = row[0] if row else None
            pending = pending_migrations(con)
    except Exception as e:
        logger.warning("DuckDB health check failed: %s", e)
        db_status = "disconnected"
    healthy = db_status == "connected" and not pending
    if not healthy:
        response.status_code = 503
        startup_error = getattr(request.app.state, "schema_initialization_error", None)
        if startup_error is not None:
            logger.error(
                "Database startup failure behind unhealthy probe: %s", startup_error
            )
    return {
        "status": "ok" if healthy else "degraded",
        "database": db_status,
        "schema_version": schema_version,
        "pending_migrations": pending,
        # Never return the exception message: SQL errors may contain data or
        # credentials. These fields are application-owned operation identifiers.
        "initialization": getattr(
            request.app.state, "schema_initialization", {"status": "not_started"}
        ),
    }


@app.get("/sync/status")
def sync_status():
    """State of the daily background sync.

    ``last_run`` is the durable marker beside the database (so it survives a
    restart); ``sources`` is the per-source outcome of the last run THIS
    process did, empty when it has not run one yet. The coaching agent reads
    this before briefing on the day: a briefing written on data that never
    landed is worse than no briefing.
    """
    last_run = scheduler.last_run_date()
    return {
        "scheduled_hour": config.auto_sync_hour,
        "last_run": last_run.isoformat() if last_run else None,
        "sources": scheduler.last_status(),
    }


def _require_cron(authorization: str | None) -> None:
    """Vercel sends ``Authorization: Bearer $CRON_SECRET``; without a configured
    secret the cron endpoints stay closed rather than open to anyone."""
    secret = config.cron_secret
    expected = f"Bearer {secret}"
    if not secret or not hmac.compare_digest(authorization or "", expected):
        raise HTTPException(status_code=401, detail="Non autorisé")


@app.get("/cron/daily-sync")
def cron_daily_sync(authorization: str | None = Header(default=None)):
    """The daily sync, triggered by Vercel Cron where no process stays up."""
    _require_cron(authorization)
    return scheduler.run_scheduled_batch()


@app.get("/cron/checkin")
def cron_checkin(authorization: str | None = Header(default=None)):
    """The morning check-in's push, in its own windows before the daily sync's."""
    _require_cron(authorization)
    return scheduler.run_checkin_prompts()


@app.get("/cron/evening")
def cron_evening(authorization: str | None = Header(default=None)):
    """The evening's replanning of today's missed sessions (one window)."""
    _require_cron(authorization)
    return scheduler.run_evening_replans()


@app.get("/cron/evening-message")
def cron_evening_message(authorization: str | None = Header(default=None)):
    """The coach's evening message, for the athletes who opted in."""
    _require_cron(authorization)
    return scheduler.run_evening_messages()


for router in (
    onboarding_router,
    automations_router,
    checkins_router,
    body_log_router,
    coach_router,
    dashboard_router,
    gamification_router,
    auth_router,
    settings_router,
    metrics_router,
    garmin_router,
    activities_router,
    garmin_export_router,
    garmin_health_router,
    garmin_sync_router,
    strength_router,
    ai_tips_router,
    google_calendar_router,
    analytics_router,
    agent_router,
    documents_router,
    plan_router,
    notifications_router,
    goals_router,
    athlete_facts_router,
    data_export_router,
    year_review_router,
    slack_router,
    admin_router,
):
    app.include_router(router)


@app.get("/cron/automations")
def cron_automations(authorization: str | None = Header(default=None)):
    _require_cron(authorization)
    return scheduler.run_automations()
