"""One bounded dispatcher for Docker and Vercel; agent invocation is injected."""

import logging
from time import monotonic

import duckdb

from arete.dataio.db import db_connection
from arete.services import automations, consent
from arete.services.athlete_scope import athlete_scope
from arete.services.automation_schedule import (
    MAX_DISPATCH_RUNS,
    MAX_DISPATCH_SECONDS,
    MAX_SCAN,
    SEGMENT_SECONDS,
)

logger = logging.getLogger(__name__)

#: Why a run did not happen while its athlete's consent was missing.
NO_CONSENT_REASON = (
    "Non exécuté : consentement au traitement des données de santé absent."
)


def dispatch(execute) -> dict:
    started = monotonic()
    outcomes: list[str] = []
    allowed, params = consent.processing_sql("a.id")
    with db_connection() as con:
        # Scheduler authority enumerates ids only; every read afterwards is scoped.
        owners = con.execute(
            f"SELECT a.id, {allowed} FROM app.athletes a WHERE a.deleted_at IS NULL "
            "ORDER BY a.id LIMIT ?",
            [*params, MAX_SCAN],
        ).fetchall()
    deferred = len(owners) == MAX_SCAN
    for athlete, consented in owners:
        if (
            len(outcomes) >= MAX_DISPATCH_RUNS
            or monotonic() - started > MAX_DISPATCH_SECONDS - SEGMENT_SECONDS
        ):
            deferred = True
            break
        if not consented:
            # Nothing runs without consent, and nothing waits to fire late
            # either: what comes due meanwhile is recorded missed.
            with athlete_scope(athlete):
                try:
                    automations.skip_due(NO_CONSENT_REASON)
                except duckdb.TransactionException:
                    deferred = True
            continue
        with athlete_scope(athlete):
            try:
                automations.prepare()
            except duckdb.TransactionException:
                # A competing preparation won. No mission was started here.
                deferred = True
                continue
            with db_connection() as con:
                candidates = con.execute(
                    "SELECT id FROM app.visible_automation_runs WHERE state IN ('queued','ready') AND due_at<=now() ORDER BY CASE state WHEN 'ready' THEN 0 ELSE 1 END,due_at,id LIMIT ?",
                    [MAX_DISPATCH_RUNS + 1],
                ).fetchall()
            for (identifier,) in candidates:
                if (
                    len(outcomes) >= MAX_DISPATCH_RUNS
                    or monotonic() - started > MAX_DISPATCH_SECONDS - SEGMENT_SECONDS
                ):
                    deferred = True
                    break
                run = automations.claim(identifier)
                if run is not None:
                    execute(run)
                    outcomes.append(identifier)
                else:
                    deferred = True
    return {"runs": outcomes, "deferred": deferred}
