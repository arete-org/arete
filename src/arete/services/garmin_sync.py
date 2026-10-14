"""Garmin activity import on the coach's request: the sync button's workflow.

Same steps as ``POST /garmin/sync/activities``: incremental import from the
last Garmin activity, FIT parsing, plan matching, then terrain and weather.
Bounded by the run's deadline and by the activity count; a run stops between
activities, never inside a write, and is never replayed.
"""

from __future__ import annotations

import threading
from contextlib import closing
from time import monotonic

from arete.services.athlete_scope import current_athlete_id

#: Activities one conversational sync imports; older ones need the sync button.
MAX_ACTIVITIES = 20
#: Time kept after the last activity for terrain/weather (20 s) and the answer.
RESERVE_SECONDS = 60.0

_running: set[int] = set()
_lock = threading.Lock()


def sync_recent(deadline: float | None = None) -> dict:
    """Import new Garmin activities and return the sessions now visible to the coach.

    Raises PermissionError without a Garmin connection and RuntimeError when
    this athlete's sync is already running in this process.
    """
    from arete.garmin.sync import GarminSyncClient, SyncResult
    from arete.services.analytics import list_sessions
    from arete.services.session_conditions import enrich_sessions

    client = GarminSyncClient()
    if not client.is_authenticated():
        raise PermissionError(
            "Garmin n'est pas connecté : Réglages → Connexions avant de synchroniser."
        )
    athlete_id = current_athlete_id()
    with _lock:
        if athlete_id in _running:
            raise RuntimeError("Une synchronisation Garmin est déjà en cours.")
        _running.add(athlete_id)
    try:
        result: SyncResult | None = None
        with closing(
            client.iter_sync_activities(max_activities=MAX_ACTIVITIES)
        ) as work:
            for event in work:
                if isinstance(event, SyncResult):
                    result = event
                    break
                if deadline is not None and monotonic() > deadline - RESERVE_SECONDS:
                    break
    finally:
        with _lock:
            _running.discard(athlete_id)
    if result is None:
        return {
            "complete": False,
            "error": "Synchronisation arrêtée faute de temps. Des activités ont pu "
            "être importées : lis list_recent_sessions avant de relancer.",
        }
    enrich_sessions(result.session_ids)  # bounded, never raises
    imported = set(result.session_ids)
    recent = list_sessions(limit=MAX_ACTIVITIES, for_model=True)["sessions"]
    return {
        "complete": result.success,
        "imported": result.activities_synced,
        "merged_into_strava": result.activities_merged,
        "matched_to_plan": result.activities_matched,
        "already_present": result.activities_skipped,
        "errors": result.errors,
        "sessions": [s for s in recent if s["id"] in imported],
    }
