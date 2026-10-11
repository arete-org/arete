"""Repository for Garmin sessions database operations."""

import json
from datetime import date, datetime, timedelta
from typing import Any

import duckdb

from arete.dataio import plan_changes
from arete.dataio.db import connect
from arete.dataio.ownership import require_owned
from arete.garmin.models import (
    ActivitySource,
    ActualSession,
    PlannedSession,
    SessionStatus,
    SessionType,
)
from arete.garmin.streams import CHANNELS, ActivityStreams
from arete.services.athlete_scope import resolve_athlete_id

PLANNED_COLUMNS = (
    "id, user_id, date, sport, session_type, target_duration_min, "
    "target_distance_km, target_hr_zone, target_intensity, description, source, "
    "status, created_at, structure_json, garmin_workout_id, garmin_schedule_id, "
    "garmin_pushed_at, prescription, provenance, revision, goal_id"
)

#: What a plan edit (coach, daily adaptation, Garmin push) may overwrite.
PLANNED_EDITABLE = frozenset(
    {
        "date",
        "sport",
        "session_type",
        "target_duration_min",
        "target_distance_km",
        "target_hr_zone",
        "target_intensity",
        "description",
        "status",
        "structure_json",
        "garmin_workout_id",
        "garmin_schedule_id",
        "garmin_pushed_at",
        "goal_id",
    }
)


def _planned_from_row(row: tuple) -> PlannedSession:
    return PlannedSession(
        id=row[0],
        user_id=row[1],
        date=row[2],
        sport=row[3],
        session_type=SessionType(row[4]) if row[4] else SessionType.ENDURANCE,
        target_duration_min=row[5],
        target_distance_km=row[6],
        target_hr_zone=row[7],
        target_intensity=row[8],
        description=row[9],
        source=row[10],
        status=SessionStatus(row[11]) if row[11] else SessionStatus.PENDING,
        created_at=row[12],
        structure_json=row[13],
        garmin_workout_id=row[14],
        garmin_schedule_id=row[15],
        garmin_pushed_at=row[16],
        prescription=json.loads(row[17]) if row[17] else None,
        provenance=json.loads(row[18]) if row[18] else None,
        revision=row[19],
        goal_id=row[20],
    )


class GarminRepository:
    """Repository for planned and actual sessions CRUD operations."""

    def _get_connection(self) -> duckdb.DuckDBPyConnection:
        """Get database connection."""
        conn = connect()
        conn.execute("SET search_path = 'app'")
        return conn

    # ─────────────────────────────────────────────────────────────────────
    # Planned Sessions
    # ─────────────────────────────────────────────────────────────────────

    def create_planned_session(self, session: PlannedSession) -> int:
        """Create a new planned session.

        Args:
            session: PlannedSession to create

        Returns:
            ID of created session
        """
        conn = self._get_connection()
        try:
            require_owned(conn, "goals", session.goal_id)
        except BaseException:
            conn.close()
            raise

        result = conn.execute(
            """
            INSERT INTO planned_sessions (
                user_id, date, sport, session_type, target_duration_min,
                target_distance_km, target_hr_zone, target_intensity,
                description, source, status, created_at, prescription, provenance, goal_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            RETURNING id
            """,
            [
                resolve_athlete_id(session.user_id),
                session.date,
                session.sport,
                session.session_type.value
                if isinstance(session.session_type, SessionType)
                else session.session_type,
                session.target_duration_min,
                session.target_distance_km,
                session.target_hr_zone,
                session.target_intensity,
                session.description,
                session.source,
                session.status.value
                if isinstance(session.status, SessionStatus)
                else session.status,
                datetime.now(),
                json.dumps(session.prescription) if session.prescription else None,
                json.dumps(session.provenance) if session.provenance else None,
                session.goal_id,
            ],
        ).fetchone()
        conn.close()
        if result is None:
            raise RuntimeError("Failed to insert planned session")
        plan_changes.touch()
        return int(result[0])

    def get_planned_session(self, session_id: int) -> PlannedSession | None:
        """Get a planned session by ID."""
        conn = self._get_connection()
        result = conn.execute(
            f"""
            SELECT {PLANNED_COLUMNS}
            FROM visible_planned_sessions WHERE id = ?
            """,
            [session_id],
        ).fetchone()
        conn.close()

        if not result:
            return None

        return _planned_from_row(result)

    def list_planned_sessions(
        self,
        start_date: date | None = None,
        end_date: date | None = None,
        status: SessionStatus | None = None,
        limit: int = 50,
        ascending: bool = False,
    ) -> list[PlannedSession]:
        """List planned sessions with optional date filter.

        Newest first by default (the HTTP list); ``ascending`` returns the
        earliest first, so a limit keeps the sessions closest to the start.
        """
        conn = self._get_connection()

        query = f"""
            SELECT {PLANNED_COLUMNS}
            FROM visible_planned_sessions WHERE 1=1
        """
        params: list = []

        if start_date:
            query += " AND date >= ?"
            params.append(start_date)
        if end_date:
            query += " AND date <= ?"
            params.append(end_date)
        if status:
            query += " AND status = ?"
            params.append(status.value)

        order = "ASC" if ascending else "DESC"
        query += f" ORDER BY date {order}, id {order} LIMIT ?"
        params.append(limit)

        results = conn.execute(query, params).fetchall()
        conn.close()

        return [_planned_from_row(row) for row in results]

    def update_planned_session_status(
        self, session_id: int, status: SessionStatus
    ) -> bool:
        """Update the status of a planned session."""
        return self.update_planned_session_fields(session_id, status=status)

    def update_planned_session_fields(
        self,
        session_id: int,
        *,
        expected_revision: int | None = None,
        connection: duckdb.DuckDBPyConnection | None = None,
        prescription: dict | None = None,
        **fields: Any,
    ) -> bool:
        """Overwrite some fields of a planned session (whitelisted columns)."""
        unknown = set(fields) - PLANNED_EDITABLE
        if unknown:
            raise ValueError(f"Not editable on a planned session: {sorted(unknown)}")
        if not fields and prescription is None:
            return self.get_planned_session(session_id) is not None
        if prescription is not None:
            fields["prescription"] = json.dumps(prescription)
        values = [
            v.value if isinstance(v, SessionType | SessionStatus) else v
            for v in fields.values()
        ]
        conn = connection or self._get_connection()
        if connection is not None:
            conn.execute("SET search_path = 'app'")
        try:
            if connection is None:
                conn.execute("BEGIN TRANSACTION")
            require_owned(conn, "goals", fields.get("goal_id"))
            row = conn.execute(
                "SELECT prescription,garmin_workout_id,garmin_schedule_id FROM visible_planned_sessions WHERE id=?",
                [session_id],
            ).fetchone()
            active = conn.execute(
                "SELECT state FROM visible_garmin_exports WHERE session_id=?",
                [session_id],
            ).fetchone()
            if active and active[0] in {"working", "uncertain", "conflict"}:
                raise ValueError(
                    "Réconcilie l’export Garmin avant de modifier la séance."
                )
            if prescription is not None and row and (row[1] or row[2]) and not active:
                raise ValueError(
                    "Vérifie d’abord l’ancien export Garmin avant de modifier ses étapes."
                )
            if (
                row
                and (row[0] or prescription)
                and any(
                    value
                    for key, value in fields.items()
                    if key
                    in {
                        "target_duration_min",
                        "target_distance_km",
                        "target_hr_zone",
                        "target_intensity",
                        "sport",
                        "structure_json",
                    }
                )
            ):
                raise ValueError(
                    "Modifie les étapes de la prescription pour changer ses objectifs."
                )
            # Both planning editors share the version used to reserve exports.
            result = conn.execute(
                f"UPDATE planned_sessions SET {', '.join(f'{k} = ?' for k in fields)}, revision=revision+1 WHERE user_id = getvariable('arete_athlete_id') AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM app.athletes scope_owner WHERE scope_owner.id=user_id AND scope_owner.deleted_at IS NULL) AND (id = ?){' AND revision = ?' if expected_revision is not None else ''} RETURNING id",
                [
                    *values,
                    session_id,
                    *([expected_revision] if expected_revision is not None else []),
                ],
            ).fetchone()
            if result is None:
                if connection is None:
                    conn.execute("ROLLBACK")
                return False
            # Garmin holds no status: marking a session done or skipped leaves
            # its verified export as is instead of asking for a re-export.
            if set(fields) - {"status", "garmin_pushed_at"}:
                conn.execute(
                    "UPDATE garmin_exports SET state='dirty',updated_at=current_timestamp WHERE athlete_id = getvariable('arete_athlete_id') AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM app.athletes scope_owner WHERE scope_owner.id=athlete_id AND scope_owner.deleted_at IS NULL) AND (session_id=? AND state<>'removed') ",
                    [session_id],
                )
            if connection is None:
                conn.execute("COMMIT")
        except BaseException:
            if connection is None:
                conn.execute("ROLLBACK")
            raise
        finally:
            if connection is None:
                conn.close()
        if connection is None:
            plan_changes.touch()
        return result is not None

    def delete_planned_session(self, session_id: int) -> bool:
        """Delete a planned session by ID."""
        conn = self._get_connection()
        try:
            conn.execute("BEGIN TRANSACTION")
            active = conn.execute(
                "SELECT state FROM visible_garmin_exports WHERE session_id=?",
                [session_id],
            ).fetchone()
            if active and active[0] in {"working", "uncertain", "conflict"}:
                raise ValueError(
                    "Réconcilie l’export Garmin avant de supprimer la séance."
                )
            conn.execute(
                "UPDATE garmin_exports SET deleted=true,state='pending_removal',updated_at=current_timestamp WHERE athlete_id = getvariable('arete_athlete_id') AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM app.athletes scope_owner WHERE scope_owner.id=athlete_id AND scope_owner.deleted_at IS NULL) AND (session_id=? AND state<>'removed') ",
                [session_id],
            )
            result = conn.execute(
                "UPDATE planned_sessions SET deleted_at = current_timestamp WHERE user_id = getvariable('arete_athlete_id') AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM app.athletes scope_owner WHERE scope_owner.id=user_id AND scope_owner.deleted_at IS NULL) AND (id = ?) RETURNING id",
                [session_id],
            ).fetchone()
            conn.execute("COMMIT")
        except BaseException:
            conn.execute("ROLLBACK")
            raise
        finally:
            conn.close()
        plan_changes.touch()
        return result is not None

    # ─────────────────────────────────────────────────────────────────────
    # Actual Sessions
    # ─────────────────────────────────────────────────────────────────────

    def create_actual_session(self, session: ActualSession) -> int:
        """Create a new actual session from parsed FIT file.

        Args:
            session: ActualSession to create

        Returns:
            ID of created session
        """
        from arete.dataio.game_events import capture

        conn = self._get_connection()
        conn.execute("BEGIN TRANSACTION")
        try:
            require_owned(conn, "planned_sessions", session.planned_session_id)
            result = conn.execute(
                """
                INSERT INTO actual_sessions (
                    planned_session_id, user_id, date, sport, session_type,
                    duration_sec, distance_m, calories, avg_hr, max_hr,
                    hr_zones_json, avg_pace_sec_km, avg_speed_mps, max_speed_mps,
                    ascent_m, descent_m, start_lat, start_lon,
                    avg_cadence, max_cadence, avg_vertical_oscillation,
                    avg_ground_contact_time, avg_stride_length,
                    source, source_file, garmin_activity_id,
                    adherence_score, intensity_deviation, start_time, created_at,
                    name, notes, rpe, workout_type, moving_time_sec,
                    suffer_score, laps_json, splits_json, best_efforts_json,
                    avg_watts, weighted_avg_watts, device_name
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                RETURNING id
                """,
                [
                    session.planned_session_id,
                    resolve_athlete_id(session.user_id),
                    session.date,
                    session.sport,
                    session.session_type,
                    session.duration_sec,
                    session.distance_m,
                    session.calories,
                    session.avg_hr,
                    session.max_hr,
                    session.hr_zones_json,
                    session.avg_pace_sec_km,
                    session.avg_speed_mps,
                    session.max_speed_mps,
                    session.ascent_m,
                    session.descent_m,
                    session.start_lat,
                    session.start_lon,
                    session.avg_cadence,
                    session.max_cadence,
                    session.avg_vertical_oscillation,
                    session.avg_ground_contact_time,
                    session.avg_stride_length,
                    session.source.value
                    if isinstance(session.source, ActivitySource)
                    else session.source,
                    session.source_file,
                    session.garmin_activity_id,
                    session.adherence_score,
                    session.intensity_deviation,
                    session.start_time,
                    datetime.now(),
                    session.name,
                    session.notes,
                    session.rpe,
                    session.workout_type,
                    session.moving_time_sec,
                    session.suffer_score,
                    session.laps_json,
                    session.splits_json,
                    session.best_efforts_json,
                    session.avg_watts,
                    session.weighted_avg_watts,
                    session.device_name,
                ],
            ).fetchone()
            if result is None:
                raise RuntimeError("Failed to insert actual session")
            capture(
                conn,
                f"actual:{result[0]}",
                session.date,
                session.name or session.sport,
                session.duration_sec > 0,
                started=session.start_time,
                canonical=f"garmin:{session.garmin_activity_id}"
                if session.garmin_activity_id
                else (f"file:{session.source_file}" if session.source_file else None),
                manual=str(session.source) in {"manual", "ActivitySource.MANUAL"},
            )
            conn.execute("COMMIT")
            return int(result[0])
        except BaseException:
            conn.execute("ROLLBACK")
            raise
        finally:
            conn.close()

    def get_actual_session(self, session_id: int) -> ActualSession | None:
        """Get an actual session by ID."""
        conn = self._get_connection()
        result = conn.execute(
            """
            SELECT id, planned_session_id, user_id, date, sport, session_type,
                   duration_sec, distance_m, calories, avg_hr, max_hr,
                   hr_zones_json, avg_pace_sec_km, avg_speed_mps, max_speed_mps,
                   ascent_m, descent_m, start_lat, start_lon,
                   avg_cadence, max_cadence, avg_vertical_oscillation,
                   avg_ground_contact_time, avg_stride_length,
                   source, source_file, garmin_activity_id,
                   adherence_score, intensity_deviation, start_time, created_at,
                   name, notes, rpe, workout_type, moving_time_sec,
                   suffer_score, laps_json, splits_json, best_efforts_json,
                   avg_watts, weighted_avg_watts, device_name, strava_activity_id
            FROM visible_actual_sessions WHERE id = ?
            """,
            [session_id],
        ).fetchone()
        conn.close()

        if not result:
            return None

        return self._row_to_actual_session(result)

    def _row_to_actual_session(self, row: tuple) -> ActualSession:
        """Convert a database row to ActualSession."""
        return ActualSession(
            id=row[0],
            planned_session_id=row[1],
            user_id=row[2],
            date=row[3],
            sport=row[4],
            session_type=row[5],
            duration_sec=row[6] or 0,
            distance_m=row[7],
            calories=row[8],
            avg_hr=row[9],
            max_hr=row[10],
            hr_zones_json=row[11],
            avg_pace_sec_km=row[12],
            avg_speed_mps=row[13],
            max_speed_mps=row[14],
            ascent_m=row[15],
            descent_m=row[16],
            start_lat=row[17],
            start_lon=row[18],
            avg_cadence=row[19],
            max_cadence=row[20],
            avg_vertical_oscillation=row[21],
            avg_ground_contact_time=row[22],
            avg_stride_length=row[23],
            source=ActivitySource(row[24]) if row[24] else ActivitySource.FIT_FILE,
            source_file=row[25],
            garmin_activity_id=row[26],
            adherence_score=row[27],
            intensity_deviation=row[28],
            start_time=row[29],
            created_at=row[30],
            name=row[31] if len(row) > 31 else None,
            notes=row[32] if len(row) > 32 else None,
            rpe=row[33] if len(row) > 33 else None,
            workout_type=row[34] if len(row) > 34 else None,
            moving_time_sec=row[35] if len(row) > 35 else None,
            suffer_score=row[36] if len(row) > 36 else None,
            laps_json=row[37] if len(row) > 37 else None,
            splits_json=row[38] if len(row) > 38 else None,
            best_efforts_json=row[39] if len(row) > 39 else None,
            avg_watts=row[40] if len(row) > 40 else None,
            weighted_avg_watts=row[41] if len(row) > 41 else None,
            device_name=row[42] if len(row) > 42 else None,
            strava_activity_id=row[43] if len(row) > 43 else None,
        )

    def list_actual_sessions(
        self,
        start_date: date | None = None,
        end_date: date | None = None,
        unmatched_only: bool = False,
        limit: int = 50,
        include_blobs: bool = True,
    ) -> list[ActualSession]:
        """List actual sessions with optional filters.

        ``include_blobs=False`` leaves the laps, splits and best-efforts JSON
        as None: lists shown to the athlete never read them, and they are
        most of a row's bytes.
        """
        conn = self._get_connection()

        blobs = (
            "laps_json, splits_json, best_efforts_json"
            if include_blobs
            else "NULL, NULL, NULL"
        )
        query = f"""
            SELECT id, planned_session_id, user_id, date, sport, session_type,
                   duration_sec, distance_m, calories, avg_hr, max_hr,
                   hr_zones_json, avg_pace_sec_km, avg_speed_mps, max_speed_mps,
                   ascent_m, descent_m, start_lat, start_lon,
                   avg_cadence, max_cadence, avg_vertical_oscillation,
                   avg_ground_contact_time, avg_stride_length,
                   source, source_file, garmin_activity_id,
                   adherence_score, intensity_deviation, start_time, created_at,
                   name, notes, rpe, workout_type, moving_time_sec,
                   suffer_score, {blobs},
                   avg_watts, weighted_avg_watts, device_name, strava_activity_id
            FROM visible_actual_sessions WHERE 1=1
        """
        params: list = []

        if start_date:
            query += " AND date >= ?"
            params.append(start_date)
        if end_date:
            query += " AND date <= ?"
            params.append(end_date)
        if unmatched_only:
            query += " AND planned_session_id IS NULL"

        query += " ORDER BY date DESC LIMIT ?"
        params.append(limit)

        results = conn.execute(query, params).fetchall()
        conn.close()

        return [self._row_to_actual_session(row) for row in results]

    ENRICHMENT_COLUMNS = frozenset(
        {
            # analytics
            "name",
            "notes",
            "avg_pace_sec_km",
            "moving_time_sec",
            "laps_json",
            "splits_json",
            "best_efforts_json",
            "hr_zones_json",
            "avg_cadence",
            "max_cadence",
            "descent_m",
            "calories",
            # Strava extras
            "suffer_score",
            "workout_type",
            "device_name",
            "avg_watts",
            "weighted_avg_watts",
            "strava_activity_id",
            # provenance (when a Strava row is taken over by Garmin)
            "source",
            "source_file",
            "session_type",
            "garmin_activity_id",
        }
    )

    def find_overlapping_session(
        self,
        start_time: datetime | None,
        duration_sec: int,
        tolerance_sec: int = 120,
    ) -> ActualSession | None:
        """Session that is the same workout: starts within ``tolerance_sec``.

        Without a start time, falls back to same day and duration within
        max(tolerance, 5 %). Used to merge Garmin and Strava copies.
        """
        if start_time is None:
            return None
        conn = self._get_connection()
        try:
            row = conn.execute(
                """
                SELECT id FROM visible_actual_sessions
                WHERE date = ?
                  AND start_time IS NOT NULL
                  AND abs(epoch(start_time) - epoch(CAST(? AS TIMESTAMP))) <= ?
                ORDER BY abs(epoch(start_time) - epoch(CAST(? AS TIMESTAMP)))
                LIMIT 1
                """,
                [start_time.date(), start_time, tolerance_sec, start_time],
            ).fetchone()
            if row is None:
                tol = max(tolerance_sec, int(duration_sec * 0.05))
                row = conn.execute(
                    """
                    SELECT id FROM visible_actual_sessions
                    WHERE date = ? AND start_time IS NULL
                      AND abs(duration_sec - ?) <= ?
                    LIMIT 1
                    """,
                    [start_time.date(), duration_sec, tol],
                ).fetchone()
        finally:
            conn.close()
        return self.get_actual_session(int(row[0])) if row else None

    def known_strava_ids(self) -> set[str]:
        """Strava activity IDs already imported (own rows or merged into Garmin rows)."""
        conn = self._get_connection()
        try:
            rows = conn.execute(
                """
                SELECT garmin_activity_id FROM visible_actual_sessions WHERE source = 'strava'
                UNION
                SELECT strava_activity_id FROM visible_actual_sessions WHERE strava_activity_id IS NOT NULL
                """
            ).fetchall()
        finally:
            conn.close()
        return {str(r[0]) for r in rows if r[0] is not None}

    def update_actual_session_fields(self, session_id: int, **fields: Any) -> None:
        """Update enrichment columns of an actual session (whitelisted)."""
        unknown = set(fields) - self.ENRICHMENT_COLUMNS
        if unknown:
            raise ValueError(f"Not updatable: {sorted(unknown)}")
        if not fields:
            return
        assignments = ", ".join(f"{col} = ?" for col in fields)
        conn = self._get_connection()
        try:
            conn.execute(
                f"UPDATE actual_sessions SET {assignments} WHERE user_id = getvariable('arete_athlete_id') AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM app.athletes scope_owner WHERE scope_owner.id=user_id AND scope_owner.deleted_at IS NULL) AND (id = ?) ",
                [*fields.values(), session_id],
            )
        finally:
            conn.close()

    def update_actual_session_match(
        self,
        actual_id: int,
        planned_id: int | None,
        adherence_score: float | None = None,
    ) -> bool:
        """Update the planned_session_id for an actual session."""
        conn = self._get_connection()
        try:
            require_owned(conn, "planned_sessions", planned_id)
        except BaseException:
            conn.close()
            raise
        result = conn.execute(
            """
            UPDATE actual_sessions
            SET planned_session_id = ?, adherence_score = ?
            WHERE user_id = getvariable('arete_athlete_id') AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM app.athletes scope_owner WHERE scope_owner.id=user_id AND scope_owner.deleted_at IS NULL) AND (id = ?) RETURNING id
            """,
            [planned_id, adherence_score, actual_id],
        ).fetchone()
        conn.close()
        return result is not None

    def delete_actual_session(self, session_id: int) -> bool:
        """Delete an actual session by ID."""
        conn = self._get_connection()
        conn.execute("BEGIN TRANSACTION")
        try:
            result = conn.execute(
                "UPDATE actual_sessions SET deleted_at = current_timestamp WHERE user_id = getvariable('arete_athlete_id') AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM app.athletes scope_owner WHERE scope_owner.id=user_id AND scope_owner.deleted_at IS NULL) AND (id = ?) RETURNING id",
                [session_id],
            ).fetchone()
            conn.execute(
                "UPDATE app.game_events SET eligible=false,reason='removed',processed=false WHERE athlete_id = getvariable('arete_athlete_id') AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM app.athletes scope_owner WHERE scope_owner.id=athlete_id AND scope_owner.deleted_at IS NULL) AND (source_key=?) ",
                [f"actual:{session_id}"],
            )
            conn.execute("COMMIT")
            return result is not None
        except BaseException:
            conn.execute("ROLLBACK")
            raise
        finally:
            conn.close()

    # ─────────────────────────────────────────────────────────────────────
    # Activity streams (one row per session, see garmin/streams.py)
    # ─────────────────────────────────────────────────────────────────────

    def save_activity_streams(
        self, actual_session_id: int, streams: ActivityStreams
    ) -> None:
        """Store (or replace) a session's streams."""
        columns = streams.channels()
        placeholders = ", ".join(["?"] * (3 + len(CHANNELS)))
        conn = self._get_connection()
        conn.execute("BEGIN TRANSACTION")
        try:
            require_owned(conn, "actual_sessions", actual_session_id)
            conn.execute(
                "DELETE FROM activity_streams WHERE athlete_id = getvariable('arete_athlete_id') AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM app.athletes scope_owner WHERE scope_owner.id=athlete_id AND scope_owner.deleted_at IS NULL) AND (actual_session_id = ?) ",
                [actual_session_id],
            )
            conn.execute(
                "INSERT INTO activity_streams (actual_session_id, sample_count, "
                f"t_sec, {', '.join(CHANNELS)}) VALUES ({placeholders})",
                [
                    actual_session_id,
                    len(streams),
                    streams.t,
                    *(columns.get(name) for name in CHANNELS),
                ],
            )
            conn.execute("COMMIT")
        except BaseException:
            conn.execute("ROLLBACK")
            raise
        finally:
            conn.close()

    def get_activity_streams(self, actual_session_id: int) -> ActivityStreams | None:
        """A session's streams, None when none were kept."""
        conn = self._get_connection()
        try:
            row = conn.execute(
                f"SELECT t_sec, {', '.join(CHANNELS)} FROM visible_activity_streams WHERE actual_session_id = ?",
                [actual_session_id],
            ).fetchone()
        finally:
            conn.close()
        if row is None:
            return None
        channels = {
            name: None if values is None else list(values)
            for name, values in zip(CHANNELS, row[1:], strict=True)
        }
        return ActivityStreams(t=list(row[0]), **channels)

    def count_actual_sessions(self) -> int:
        """Return total count of actual sessions (efficient query)."""
        conn = self._get_connection()
        result = conn.execute("SELECT COUNT(*) FROM visible_actual_sessions").fetchone()
        conn.close()
        return int(result[0]) if result else 0

    def last_garmin_import(self) -> tuple[date | None, datetime | None]:
        """(date of the newest Garmin activity, when it was imported).

        Garmin rows only: a newer Strava or manual session must not move the
        next Garmin sync's start past activities it has not fetched yet.
        """
        conn = self._get_connection()
        try:
            row = conn.execute(
                "SELECT MAX(date), MAX(created_at) FROM visible_actual_sessions WHERE source = ?",
                [ActivitySource.GARMIN_CONNECT.value],
            ).fetchone()
        finally:
            conn.close()
        return (row[0], row[1]) if row else (None, None)

    # ─────────────────────────────────────────────────────────────────────
    # Matching Operations
    # ─────────────────────────────────────────────────────────────────────

    def get_potential_matches(
        self, actual_session: ActualSession, date_tolerance_days: int = 1
    ) -> list[PlannedSession]:
        """Get planned sessions that could match an actual session.

        Args:
            actual_session: The actual session to match
            date_tolerance_days: Number of days tolerance for matching

        Returns:
            List of potential matching planned sessions
        """
        start = actual_session.date - timedelta(days=date_tolerance_days)
        end = actual_session.date + timedelta(days=date_tolerance_days)
        return self.list_planned_sessions(start_date=start, end_date=end)

    def get_matches_summary(
        self, start: date | None = None, end: date | None = None
    ) -> dict:
        """Adherence statistics.

        ``adherence_rate`` only counts planned sessions that were *due*: dated
        within [start, end] and not after today. Without a window, everything
        planned up to today counts. Skipped = due, still pending, date before today.
        """
        today = date.today()
        end_due = min(end, today) if end else today
        due = "date <= ?" + (" AND date >= ?" if start else "")
        due_params: list = [end_due] + ([start] if start else [])
        conn = self._get_connection()
        try:
            planned_due, completed, skipped, total_planned = conn.execute(
                f"""
                SELECT COUNT(*) FILTER (WHERE {due}),
                       COUNT(*) FILTER (WHERE {due} AND status = 'completed'),
                       COUNT(*) FILTER (
                           WHERE {due} AND status = 'pending' AND date < ?
                       ),
                       COUNT(*)
                FROM visible_planned_sessions
                """,
                [*due_params, *due_params, *due_params, today],
            ).fetchone() or (0, 0, 0, 0)
            total_actual, total_matched, total_unmatched = conn.execute(
                f"""
                SELECT COUNT(*),
                       COUNT(*) FILTER (WHERE planned_session_id IS NOT NULL),
                       COUNT(*) FILTER (WHERE planned_session_id IS NULL AND {due})
                FROM visible_actual_sessions
                """,
                due_params,
            ).fetchone() or (0, 0, 0)
        finally:
            conn.close()

        if planned_due > 0:
            adherence = round(completed / planned_due * 100, 1)
        elif total_planned > 0:
            adherence = round(total_matched / total_planned * 100, 1)
        else:
            adherence = 0.0
        return {
            "total_planned": total_planned,
            "total_actual": total_actual,
            "total_matched": total_matched,
            "total_unmatched": total_unmatched,
            "adherence_rate": adherence,
            "planned_due": planned_due,
            "completed": completed,
            "skipped": skipped,
            "window_start": start.isoformat() if start else None,
            "window_end": end_due.isoformat(),
        }

    # ==================== Session Analysis ====================

    # ─────────────────────────────────────────────────────────────────────
    # RAG Context - Cardio Benchmarks
    # ─────────────────────────────────────────────────────────────────────
