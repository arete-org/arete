"""Repository for strength training data.

CRUD operations for exercises, sets, and strength sessions.
"""

from __future__ import annotations

import contextlib
import json
import logging
from collections.abc import Collection
from datetime import date, datetime

import duckdb

from arete.data.exercises_catalog import EXERCISES_CATALOG
from arete.dataio.db import configure_athlete, connect, get_db_path
from arete.dataio.game_events import KEPT_AT_LINK
from arete.dataio.ownership import require_owned
from arete.services.athlete_scope import resolve_athlete_id
from arete.strength.models import (
    DraftExercise,
    Exercise,
    ExerciseCategory,
    ExerciseSet,
    MuscleGroup,
    SessionExercise,
    StrengthDraft,
    StrengthSession,
    StrengthSessionSummary,
)
from arete.strength.progression import ExerciseSession, WorkSet


class StrengthRepository:
    """Repository for strength training data in DuckDB."""

    def __init__(self, db_path: str | None = None):
        self._explicit_path = db_path is not None
        self.db_path = db_path or str(get_db_path())

    def _get_connection(self) -> duckdb.DuckDBPyConnection:
        """Get a database connection: the configured one unless a path was given."""
        if not self._explicit_path:
            return connect()
        con = duckdb.connect(self.db_path)
        configure_athlete(con)
        return con

    # ─────────────────────────────────────────────────────────────────────
    # Exercises (Library)
    # ─────────────────────────────────────────────────────────────────────

    def create_exercise(self, exercise: Exercise) -> int:
        """Create a new exercise in the library."""
        conn = self._get_connection()
        result = conn.execute(
            """
            INSERT INTO app.exercises (
                name, category, primary_muscle, secondary_muscles_json,
                equipment, is_unilateral, notes, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            RETURNING id
            """,
            [
                exercise.name,
                exercise.category.value,
                exercise.primary_muscle.value,
                json.dumps([m.value for m in exercise.secondary_muscles]),
                exercise.equipment,
                exercise.is_unilateral,
                exercise.notes,
                datetime.now(),
            ],
        ).fetchone()
        conn.close()
        if result is None:
            raise RuntimeError("Failed to insert exercise")
        return int(result[0])

    def get_exercise(self, exercise_id: int) -> Exercise | None:
        """Get an exercise by ID."""
        conn = self._get_connection()
        result = conn.execute(
            """
            SELECT id, name, category, primary_muscle, secondary_muscles_json,
                   equipment, is_unilateral, notes
            FROM app.visible_exercises WHERE id = ?
            """,
            [exercise_id],
        ).fetchone()
        conn.close()

        if not result:
            return None

        return self._row_to_exercise(result)

    def get_exercise_by_name(self, name: str) -> Exercise | None:
        """Get an exercise by name (case-insensitive)."""
        conn = self._get_connection()
        result = conn.execute(
            """
            SELECT id, name, category, primary_muscle, secondary_muscles_json,
                   equipment, is_unilateral, notes
            FROM app.visible_exercises WHERE LOWER(name) = LOWER(?)
            """,
            [name],
        ).fetchone()
        conn.close()

        if not result:
            return None

        return self._row_to_exercise(result)

    def list_exercises(
        self,
        category: ExerciseCategory | None = None,
        muscle: MuscleGroup | None = None,
        search: str | None = None,
    ) -> list[Exercise]:
        """List exercises with optional filters."""
        conn = self._get_connection()

        query = """
            SELECT id, name, category, primary_muscle, secondary_muscles_json,
                   equipment, is_unilateral, notes
            FROM app.visible_exercises WHERE 1=1
        """
        params: list = []

        if category:
            query += " AND category = ?"
            params.append(category.value)

        if muscle:
            query += " AND (primary_muscle = ? OR secondary_muscles_json LIKE ?)"
            params.extend([muscle.value, f'%"{muscle.value}"%'])

        if search:
            query += " AND LOWER(name) LIKE LOWER(?)"
            params.append(f"%{search}%")

        query += " ORDER BY name"

        results = conn.execute(query, params).fetchall()
        conn.close()

        return [self._row_to_exercise(row) for row in results]

    def remove_duplicate_exercises(self) -> int:
        """Remove duplicate exercises, keeping the one with lowest ID.

        Returns the number of removed duplicates.
        """
        conn = self._get_connection()

        # Count duplicates first
        dup_row = conn.execute(
            """
            SELECT COUNT(*) FROM app.visible_exercises
            WHERE id NOT IN (
                SELECT MIN(id) FROM app.visible_exercises GROUP BY LOWER(name)
            )
            """
        ).fetchone()
        dup_count = int(dup_row[0]) if dup_row else 0

        # Delete duplicates
        conn.execute(
            """
            DELETE FROM app.exercises
            WHERE athlete_id = getvariable('arete_athlete_id') AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM app.athletes scope_owner WHERE scope_owner.id=athlete_id AND scope_owner.deleted_at IS NULL) AND (id NOT IN (
                SELECT MIN(id) FROM app.visible_exercises GROUP BY LOWER(name)
            ))
            """
        )

        conn.close()

        return dup_count

    def get_exercise_by_catalog_id(self, catalog_id: str) -> Exercise | None:
        """Get an exercise by its catalog ID (from exercises_catalog.py).

        First checks notes field for 'Auto-created from catalog: <catalog_id>',
        then tries name matching.
        """
        conn = self._get_connection()

        # First: check notes for exact catalog_id match (most reliable)
        result = conn.execute(
            """
            SELECT id, name, category, primary_muscle, secondary_muscles_json,
                   equipment, is_unilateral, notes
            FROM app.visible_exercises
            WHERE notes LIKE ?
            LIMIT 1
            """,
            [f"%Auto-created from catalog: {catalog_id}%"],
        ).fetchone()

        if not result:
            # Convert catalog_id to expected name format
            name_from_id = catalog_id.replace("_", " ").title()
            # Try exact name match
            result = conn.execute(
                """
                SELECT id, name, category, primary_muscle, secondary_muscles_json,
                       equipment, is_unilateral, notes
                FROM app.visible_exercises
                WHERE LOWER(name) = LOWER(?) OR LOWER(name) = LOWER(?)
                LIMIT 1
                """,
                [name_from_id, catalog_id],
            ).fetchone()

        conn.close()

        if not result:
            return None

        return self._row_to_exercise(result)

    def get_or_create_exercise_from_catalog(self, catalog_id: str) -> Exercise | None:
        """Get or create an exercise from the catalog by its ID.

        If the exercise doesn't exist in DB but is in the catalog,
        create it automatically.
        """
        logger = logging.getLogger(__name__)

        # First try to find in DB
        exercise = self.get_exercise_by_catalog_id(catalog_id)
        if exercise:
            return exercise

        # Not in DB - look up in catalog and create
        catalog_entry = None
        for ex in EXERCISES_CATALOG:
            if ex["id"] == catalog_id:
                catalog_entry = ex
                break

        if not catalog_entry:
            logger.warning(f"Exercise {catalog_id} not found in catalog")
            return None

        # Map catalog category to ExerciseCategory based on movement pattern
        movement = catalog_entry.get("movement_pattern", "")
        category_map = {
            "horizontal_push": ExerciseCategory.PUSH_HORIZONTAL,
            "vertical_push": ExerciseCategory.PUSH_VERTICAL,
            "horizontal_pull": ExerciseCategory.PULL_HORIZONTAL,
            "vertical_pull": ExerciseCategory.PULL_VERTICAL,
            "hip_hinge": ExerciseCategory.HINGE,
            "squat": ExerciseCategory.SQUAT,
            "isolation": ExerciseCategory.ISOLATION,
            "core": ExerciseCategory.CORE,
            "carry": ExerciseCategory.CARRY,
        }
        category = category_map.get(movement, ExerciseCategory.OTHER)

        # Catalog muscles are already the fine regions; keep them as they are.
        def to_group(name: str) -> MuscleGroup | None:
            try:
                return MuscleGroup(name)
            except ValueError:
                return None

        primary_muscles = catalog_entry.get("primary_muscles", [])
        primary_muscle = (
            to_group(primary_muscles[0]) or MuscleGroup.FULL_BODY
            if primary_muscles
            else MuscleGroup.FULL_BODY
        )

        secondary_muscles = [
            group
            for group in (
                to_group(m) for m in catalog_entry.get("secondary_muscles", [])
            )
            if group is not None
        ]

        equipment = catalog_entry.get("equipment", [])
        equipment_str = equipment[0] if equipment else None

        # Create the exercise
        new_exercise = Exercise(
            name=catalog_entry["name"],
            category=category,
            primary_muscle=primary_muscle,
            secondary_muscles=secondary_muscles,
            equipment=equipment_str,
            is_unilateral=False,
            notes=f"Auto-created from catalog: {catalog_id}",
        )

        try:
            exercise_id = self.create_exercise(new_exercise)
            new_exercise.id = exercise_id
            logger.info(
                f"Created exercise {catalog_entry['name']} (id={exercise_id}) from catalog"
            )
            return new_exercise
        except Exception as e:
            logger.error(f"Failed to create exercise from catalog: {e}")
            return None

    def _row_to_exercise(self, row: tuple) -> Exercise:
        """Convert a database row to an Exercise."""
        secondary = json.loads(row[4]) if row[4] else []
        return Exercise(
            id=row[0],
            name=row[1],
            category=ExerciseCategory(row[2]) if row[2] else ExerciseCategory.OTHER,
            primary_muscle=MuscleGroup(row[3]) if row[3] else MuscleGroup.FULL_BODY,
            secondary_muscles=[MuscleGroup(m) for m in secondary],
            equipment=row[5],
            is_unilateral=row[6],
            notes=row[7],
        )

    # ─────────────────────────────────────────────────────────────────────
    # Strength Sessions
    # ─────────────────────────────────────────────────────────────────────

    def create_session(self, session: StrengthSession) -> int:
        """Create a new strength session."""
        conn = self._get_connection()
        conn.execute("BEGIN TRANSACTION")
        try:
            session_id = self._insert_session(conn, session)
            conn.execute("COMMIT")
            return session_id
        except BaseException:
            conn.execute("ROLLBACK")
            raise
        finally:
            conn.close()

    def _insert_session(
        self, conn: duckdb.DuckDBPyConnection, session: StrengthSession
    ) -> int:
        """The session, its exercises, sets and game evidence, in the caller's transaction."""
        from arete.dataio.game_events import capture

        require_owned(conn, "actual_sessions", session.actual_session_id)
        result = conn.execute(
            """
            INSERT INTO app.strength_sessions (
                user_id, date, name, program, duration_min,
                overall_rpe, fatigue_level, sleep_quality, notes, created_at,
                actual_session_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            RETURNING id
            """,
            [
                resolve_athlete_id(session.user_id),
                session.date,
                session.name,
                session.program,
                session.duration_min,
                session.overall_rpe,
                session.fatigue_level,
                session.sleep_quality,
                session.notes,
                datetime.now(),
                session.actual_session_id,
            ],
        ).fetchone()
        if result is None:
            raise RuntimeError("Failed to insert session")
        session_id: int = result[0]

        # Create exercises and sets
        for ex in session.exercises:
            ex.session_id = session_id
            self._create_session_exercise(conn, ex)

        capture(
            conn,
            f"strength:{session_id}",
            session.date,
            session.name or "Force",
            any(s.reps > 0 for e in session.exercises for s in e.sets),
        )
        return session_id

    def _create_session_exercise(
        self, conn: duckdb.DuckDBPyConnection, exercise: SessionExercise
    ) -> int:
        """Create a session exercise with its sets."""
        require_owned(conn, "strength_sessions", exercise.session_id)
        require_owned(conn, "exercises", exercise.exercise_id)
        result = conn.execute(
            """
            INSERT INTO app.session_exercises (
                session_id, exercise_id, exercise_order,
                target_sets, target_reps, target_rpe, notes
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            RETURNING id
            """,
            [
                exercise.session_id,
                exercise.exercise_id,
                exercise.order,
                exercise.target_sets,
                exercise.target_reps,
                exercise.target_rpe,
                exercise.notes,
            ],
        ).fetchone()
        if result is None:
            raise RuntimeError("Failed to insert session exercise")
        session_exercise_id: int = result[0]

        # Create sets
        for s in exercise.sets:
            s.session_exercise_id = session_exercise_id
            self._create_set(conn, s)

        return session_exercise_id

    def _create_set(
        self, conn: duckdb.DuckDBPyConnection, exercise_set: ExerciseSet
    ) -> int:
        """Create an exercise set."""
        require_owned(conn, "session_exercises", exercise_set.session_exercise_id)
        result = conn.execute(
            """
            INSERT INTO app.exercise_sets (
                session_exercise_id, set_number, reps, weight_kg,
                rpe, rir, rest_sec, tempo, is_warmup, is_failure, notes
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            RETURNING id
            """,
            [
                exercise_set.session_exercise_id,
                exercise_set.set_number,
                exercise_set.reps,
                exercise_set.weight_kg,
                exercise_set.rpe,
                exercise_set.rir,
                exercise_set.rest_sec,
                exercise_set.tempo,
                exercise_set.is_warmup,
                exercise_set.is_failure,
                exercise_set.notes,
            ],
        ).fetchone()
        if result is None:
            raise RuntimeError("Failed to insert set")
        return int(result[0])

    def get_session(self, session_id: int) -> StrengthSession | None:
        """Get a strength session with all exercises and sets."""
        conn = self._get_connection()
        try:
            row = conn.execute(
                f"SELECT {_SESSION_COLUMNS} FROM app.visible_strength_sessions WHERE id = ?",
                [session_id],
            ).fetchone()
            if not row:
                return None
            session = _session_from_row(row)
            self._load_exercises(conn, [session])
            return session
        finally:
            conn.close()

    def list_sessions(
        self,
        start_date: date | None = None,
        end_date: date | None = None,
        program: str | None = None,
        limit: int = 50,
        include_details: bool = False,
    ) -> list[StrengthSession]:
        """List strength sessions, with exercises and sets if ``include_details``.

        Details cost two statements for the whole list, not two per session.
        """
        conn = self._get_connection()

        query = (
            f"SELECT {_SESSION_COLUMNS} FROM app.visible_strength_sessions WHERE 1=1"
        )
        params: list = []

        if start_date:
            query += " AND date >= ?"
            params.append(start_date)
        if end_date:
            query += " AND date <= ?"
            params.append(end_date)
        if program:
            query += " AND LOWER(program) = LOWER(?)"
            params.append(program)

        query += " ORDER BY date DESC LIMIT ?"
        params.append(limit)

        try:
            sessions = [
                _session_from_row(row) for row in conn.execute(query, params).fetchall()
            ]
            if include_details:
                self._load_exercises(conn, sessions)
        finally:
            conn.close()
        return sessions

    def list_session_summaries(
        self,
        start_date: date | None = None,
        end_date: date | None = None,
        program: str | None = None,
        limit: int = 50,
        connection: duckdb.DuckDBPyConnection | None = None,
    ) -> list[StrengthSessionSummary]:
        """The sessions' list rows and totals in one statement, no set loaded."""
        filters = ""
        params: list = []
        if start_date:
            filters += " AND date >= ?"
            params.append(start_date)
        if end_date:
            filters += " AND date <= ?"
            params.append(end_date)
        if program:
            filters += " AND LOWER(program) = LOWER(?)"
            params.append(program)
        conn = connection or self._get_connection()
        try:
            rows = conn.execute(
                f"""
                WITH s AS (
                    SELECT id, date, name, program, duration_min, overall_rpe,
                           actual_session_id
                    FROM app.visible_strength_sessions WHERE 1=1{filters}
                    ORDER BY date DESC, id DESC LIMIT ?
                ), ex AS (
                    SELECT se.session_id, count(*) AS exercises,
                           list_sort(list_distinct(list(CASE WHEN e.id IS NOT NULL
                               THEN coalesce(nullif(e.primary_muscle, ''), 'full_body')
                           END))) AS muscles,
                           list(e.name ORDER BY se.exercise_order, se.id)
                               FILTER (WHERE e.id IS NOT NULL) AS names
                    FROM app.visible_session_exercises se
                    LEFT JOIN app.visible_exercises e ON se.exercise_id = e.id
                    WHERE se.session_id IN (SELECT id FROM s)
                    GROUP BY se.session_id
                ), st AS (
                    SELECT se.session_id, count(*) AS sets,
                           sum(es.reps * coalesce(es.weight_kg, 0)) AS volume
                    FROM app.visible_exercise_sets es
                    JOIN app.visible_session_exercises se
                      ON es.session_exercise_id = se.id
                    WHERE se.session_id IN (SELECT id FROM s)
                      AND es.is_warmup IS NOT TRUE
                    GROUP BY se.session_id
                )
                SELECT s.id, s.date, s.name, s.program, s.duration_min, s.overall_rpe,
                       coalesce(ex.exercises, 0), coalesce(st.sets, 0),
                       coalesce(st.volume, 0), coalesce(ex.muscles, []),
                       coalesce(ex.names, []), s.actual_session_id
                FROM s
                LEFT JOIN ex ON ex.session_id = s.id
                LEFT JOIN st ON st.session_id = s.id
                ORDER BY s.date DESC, s.id DESC
                """,
                [*params, limit],
            ).fetchall()
        finally:
            if connection is None:
                conn.close()
        return [
            StrengthSessionSummary(
                id=row[0],
                date=row[1],
                name=row[2],
                program=row[3],
                duration_min=row[4],
                overall_rpe=row[5],
                exercises_count=int(row[6]),
                total_sets=int(row[7]),
                total_volume=float(row[8]),
                muscles_worked=list(row[9]),
                exercise_names=list(row[10]),
                actual_session_id=row[11],
            )
            for row in rows
        ]

    def _load_exercises(
        self, conn: duckdb.DuckDBPyConnection, sessions: list[StrengthSession]
    ) -> None:
        """Attach exercises and their sets to ``sessions``: two statements at most."""
        if not sessions:
            return
        by_id = {session.id: session for session in sessions}
        exercise_rows = conn.execute(
            f"""
            SELECT se.session_id, se.id, se.exercise_id, se.exercise_order,
                   se.target_sets, se.target_reps, se.target_rpe, se.notes,
                   e.id, e.name, e.category, e.primary_muscle, e.secondary_muscles_json,
                   e.equipment, e.is_unilateral, e.notes
            FROM app.visible_session_exercises se
            LEFT JOIN app.visible_exercises e ON se.exercise_id = e.id
            WHERE se.session_id IN ({", ".join("?" * len(by_id))})
            ORDER BY se.session_id, se.exercise_order
            """,
            list(by_id),
        ).fetchall()

        exercises: dict[int, SessionExercise] = {}
        for row in exercise_rows:
            session_exercise = _session_exercise_from_row(row[0], row[1:])
            exercises[row[1]] = session_exercise
            by_id[row[0]].exercises.append(session_exercise)
        if not exercises:
            return
        set_rows = conn.execute(
            f"""
            SELECT session_exercise_id, id, set_number, reps, weight_kg, rpe, rir,
                   rest_sec, tempo, is_warmup, is_failure, notes
            FROM app.visible_exercise_sets
            WHERE session_exercise_id IN ({", ".join("?" * len(exercises))})
            ORDER BY session_exercise_id, set_number
            """,
            list(exercises),
        ).fetchall()
        for row in set_rows:
            exercises[row[0]].sets.append(_set_from_row(row[0], row[1:]))

    def delete_session(self, session_id: int) -> bool:
        """Delete a strength session and all related data."""
        conn = self._get_connection()
        conn.execute("BEGIN TRANSACTION")
        try:
            # Retain children for recovery; their live views require this parent.
            # Delete session
            result = conn.execute(
                "UPDATE app.strength_sessions SET deleted_at = current_timestamp WHERE user_id = getvariable('arete_athlete_id') AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM app.athletes scope_owner WHERE scope_owner.id=user_id AND scope_owner.deleted_at IS NULL) AND (id = ?) RETURNING id",
                [session_id],
            ).fetchone()

            conn.execute(
                "UPDATE app.game_events SET eligible=false,reason='removed',processed=false WHERE athlete_id = getvariable('arete_athlete_id') AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM app.athletes scope_owner WHERE scope_owner.id=athlete_id AND scope_owner.deleted_at IS NULL) AND (source_key=?) ",
                [f"strength:{session_id}"],
            )
            conn.execute("COMMIT")
            return result is not None
        except BaseException:
            conn.execute("ROLLBACK")
            raise
        finally:
            conn.close()

    def update_session(self, session_id: int, exercises: list[SessionExercise]) -> bool:
        """Replace a live session's exercises and sets; False if it is not live.

        A correction, not a new session: the id, date, Garmin link and game
        event (or its absence) stay. Replaced rows are retained for recovery,
        like a deletion's.
        """
        conn = self._get_connection()
        conn.execute("BEGIN TRANSACTION")
        try:
            row = conn.execute(
                "SELECT id FROM app.visible_strength_sessions WHERE id = ?",
                [session_id],
            ).fetchone()
            if row is None:
                conn.execute("ROLLBACK")
                return False
            conn.execute(
                "UPDATE app.exercise_sets SET deleted_at = current_timestamp WHERE athlete_id = getvariable('arete_athlete_id') AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM app.athletes scope_owner WHERE scope_owner.id=athlete_id AND scope_owner.deleted_at IS NULL) AND (session_exercise_id IN (SELECT id FROM app.visible_session_exercises WHERE session_id = ?))",
                [session_id],
            )
            conn.execute(
                "UPDATE app.session_exercises SET deleted_at = current_timestamp WHERE athlete_id = getvariable('arete_athlete_id') AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM app.athletes scope_owner WHERE scope_owner.id=athlete_id AND scope_owner.deleted_at IS NULL) AND (session_id = ?)",
                [session_id],
            )
            for ex in exercises:
                ex.session_id = session_id
                self._create_session_exercise(conn, ex)
            # No capture: a correction never grants or revokes game credit, even
            # for a legacy session without an event or one whose sets are now empty.
            conn.execute("COMMIT")
            return True
        except BaseException:
            conn.execute("ROLLBACK")
            raise
        finally:
            conn.close()

    # ─────────────────────────────────────────────────────────────────────
    # Statistics
    # ─────────────────────────────────────────────────────────────────────

    def get_exercise_history(
        self,
        exercise_id: int,
        limit: int = 20,
    ) -> list[dict]:
        """Get performance history for an exercise."""
        conn = self._get_connection()

        results = conn.execute(
            """
            SELECT ss.date, se.id,
                   COUNT(es.id) as total_sets,
                   SUM(CASE WHEN NOT es.is_warmup THEN 1 ELSE 0 END) as working_sets,
                   MAX(CASE WHEN NOT es.is_warmup THEN es.weight_kg END) as max_weight,
                   SUM(CASE WHEN NOT es.is_warmup
                       THEN es.reps * COALESCE(es.weight_kg, 0) END) as volume,
                   AVG(CASE WHEN NOT es.is_warmup THEN es.rpe END) as avg_rpe
            FROM app.visible_session_exercises se
            JOIN app.visible_strength_sessions ss ON se.session_id = ss.id
            LEFT JOIN app.visible_exercise_sets es ON es.session_exercise_id = se.id
            WHERE se.exercise_id = ?
            GROUP BY ss.date, se.id
            ORDER BY ss.date DESC
            LIMIT ?
            """,
            [exercise_id, limit],
        ).fetchall()
        conn.close()

        return [
            {
                "date": str(row[0]),
                "session_exercise_id": row[1],
                "total_sets": row[2],
                "working_sets": row[3],
                "max_weight": row[4],
                "volume": round(row[5], 1) if row[5] else 0,
                "avg_rpe": round(row[6], 1) if row[6] else None,
            }
            for row in results
        ]

    def working_sessions(
        self,
        exercise_ids: list[int],
        *,
        exclude_session_id: int | None = None,
        before: date | None = None,
    ) -> dict[int, list[ExerciseSession]]:
        """Working sets (never warm-ups) per exercise, oldest session first.

        One statement for any number of exercises: the save path asks for
        every exercise of the session at once.
        """
        if not exercise_ids:
            return {}
        query = f"""
            SELECT se.exercise_id, ss.id, ss.date, se.id, se.target_reps,
                   es.reps, es.weight_kg, es.rpe, es.rir,
                   COALESCE(es.is_failure, FALSE)
            FROM app.visible_exercise_sets es
            JOIN app.visible_session_exercises se ON es.session_exercise_id = se.id
            JOIN app.visible_strength_sessions ss ON se.session_id = ss.id
            WHERE se.exercise_id IN ({", ".join("?" * len(exercise_ids))})
              AND NOT COALESCE(es.is_warmup, FALSE)
        """
        params: list = list(exercise_ids)
        if exclude_session_id is not None:
            query += " AND ss.id <> ?"
            params.append(exclude_session_id)
        if before is not None:
            query += " AND ss.date < ?"
            params.append(before)
        query += " ORDER BY ss.date, ss.id, se.id, es.set_number"
        conn = self._get_connection()
        try:
            rows = conn.execute(query, params).fetchall()
        finally:
            conn.close()

        grouped: dict[int, dict[int, ExerciseSession]] = {}
        for ex_id, session_id, day, se_id, target, reps, kg, rpe, rir, fail in rows:
            sessions = grouped.setdefault(ex_id, {})
            if se_id not in sessions:
                sessions[se_id] = ExerciseSession(
                    session_id=session_id,
                    date=day,
                    sets=[],
                    target_reps=target,
                    session_exercise_id=se_id,
                )
            sessions[se_id].sets.append(
                WorkSet(reps=reps or 0, weight_kg=kg, rpe=rpe, rir=rir, is_failure=fail)
            )
        return {ex_id: list(by_se.values()) for ex_id, by_se in grouped.items()}

    def muscle_set_rows(
        self, start_date: date | None = None, end_date: date | None = None
    ) -> list[tuple]:
        """(date, primary muscle, secondary JSON, reps, kg) per working set."""
        conn = self._get_connection()
        query = """
            SELECT ss.date, e.primary_muscle, e.secondary_muscles_json,
                   es.reps, COALESCE(es.weight_kg, 0) AS weight
            FROM app.visible_exercise_sets es
            JOIN app.visible_session_exercises se ON es.session_exercise_id = se.id
            JOIN app.visible_exercises e ON se.exercise_id = e.id
            JOIN app.visible_strength_sessions ss ON se.session_id = ss.id
            WHERE NOT es.is_warmup
        """
        params: list = []
        if start_date:
            query += " AND ss.date >= ?"
            params.append(start_date)
        if end_date:
            query += " AND ss.date <= ?"
            params.append(end_date)

        rows = conn.execute(query, params).fetchall()
        conn.close()
        return rows

    def get_volume_by_muscle(
        self,
        start_date: date | None = None,
        end_date: date | None = None,
        include_secondary: bool = True,
        secondary_weight: float = 0.5,
    ) -> dict[str, float]:
        """Get total volume grouped by muscle, including secondary muscles.

        Args:
            start_date: Filter sessions from this date
            end_date: Filter sessions until this date
            include_secondary: Whether to include secondary muscles (weighted)
            secondary_weight: Weight for secondary muscle volume (default 0.5)

        Returns:
            Dict mapping muscle name to volume in kg
        """
        conn = self._get_connection()

        # Get all sets with exercise info
        query = """
            SELECT e.id, e.name, e.primary_muscle, e.secondary_muscles_json,
                   es.reps, COALESCE(es.weight_kg, 0) as weight
            FROM app.visible_exercise_sets es
            JOIN app.visible_session_exercises se ON es.session_exercise_id = se.id
            JOIN app.visible_exercises e ON se.exercise_id = e.id
            JOIN app.visible_strength_sessions ss ON se.session_id = ss.id
            WHERE NOT es.is_warmup
        """
        params: list = []

        if start_date:
            query += " AND ss.date >= ?"
            params.append(start_date)
        if end_date:
            query += " AND ss.date <= ?"
            params.append(end_date)

        results = conn.execute(query, params).fetchall()
        conn.close()

        # Calculate volume per muscle
        muscle_volume: dict[str, float] = {}

        for row in results:
            primary_muscle = row[2]
            secondary_muscles_json = row[3]  # JSON string or None
            reps = row[4]
            weight = row[5]

            set_volume = reps * weight

            # Primary muscle gets full volume
            if primary_muscle:
                muscle_volume[primary_muscle] = (
                    muscle_volume.get(primary_muscle, 0) + set_volume
                )

            # Secondary muscles get weighted volume
            if include_secondary and secondary_muscles_json:
                import json

                try:
                    secondary_muscles = (
                        json.loads(secondary_muscles_json)
                        if isinstance(secondary_muscles_json, str)
                        else secondary_muscles_json
                    )
                    if isinstance(secondary_muscles, list):
                        for muscle in secondary_muscles:
                            muscle_volume[muscle] = (
                                muscle_volume.get(muscle, 0)
                                + set_volume * secondary_weight
                            )
                except (json.JSONDecodeError, TypeError):
                    pass

        return {
            k: round(v, 1)
            for k, v in sorted(muscle_volume.items(), key=lambda x: -x[1])
        }

    def get_personal_records(self, exercise_id: int) -> dict:
        """Get personal records for an exercise."""
        conn = self._get_connection()

        # Max weight (1RM or estimated)
        max_weight = conn.execute(
            """
            SELECT MAX(es.weight_kg), es.reps, ss.date
            FROM app.visible_exercise_sets es
            JOIN app.visible_session_exercises se ON es.session_exercise_id = se.id
            JOIN app.visible_strength_sessions ss ON se.session_id = ss.id
            WHERE se.exercise_id = ? AND NOT es.is_warmup
            GROUP BY es.weight_kg, es.reps, ss.date
            ORDER BY es.weight_kg DESC
            LIMIT 1
            """,
            [exercise_id],
        ).fetchone()

        # Max volume in single session
        max_volume = conn.execute(
            """
            SELECT SUM(es.reps * COALESCE(es.weight_kg, 0)) as vol, ss.date
            FROM app.visible_exercise_sets es
            JOIN app.visible_session_exercises se ON es.session_exercise_id = se.id
            JOIN app.visible_strength_sessions ss ON se.session_id = ss.id
            WHERE se.exercise_id = ? AND NOT es.is_warmup
            GROUP BY ss.id, ss.date
            ORDER BY vol DESC
            LIMIT 1
            """,
            [exercise_id],
        ).fetchall()

        conn.close()

        result: dict[str, str | float | int | None] = {
            "max_weight": None,
            "max_weight_reps": None,
            "max_weight_date": None,
            "estimated_1rm": None,
            "max_session_volume": None,
            "max_volume_date": None,
        }

        if max_weight:
            weight, reps, wdate = max_weight
            result["max_weight"] = weight
            result["max_weight_reps"] = reps
            result["max_weight_date"] = str(wdate)
            if weight and reps:
                # Epley formula
                result["estimated_1rm"] = round(weight * (1 + reps / 30), 1)

        if max_volume:
            vol, vdate = max_volume[0]
            result["max_session_volume"] = round(vol, 1) if vol else None
            result["max_volume_date"] = str(vdate) if vdate else None

        return result

    # ─────────────────────────────────────────────────────────────────────────
    # Garmin linking methods
    # ─────────────────────────────────────────────────────────────────────────

    def link_to_actual_session(self, session_id: int, garmin_id: int | None) -> bool:
        """Link a strength session to a Garmin activity."""
        conn = self._get_connection()

        # Link and invalidation are one commit so a crash cannot leave stale rewards.
        conn.execute("BEGIN TRANSACTION")
        try:
            require_owned(conn, "actual_sessions", garmin_id)
            result = conn.execute(
                "SELECT id FROM app.visible_strength_sessions WHERE id = ?",
                (session_id,),
            ).fetchone()
            if not result:
                conn.execute("ROLLBACK")
                return False
            conn.execute(
                "UPDATE app.strength_sessions SET actual_session_id = ? WHERE user_id = getvariable('arete_athlete_id') AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM app.athletes scope_owner WHERE scope_owner.id=user_id AND scope_owner.deleted_at IS NULL) AND (id = ?) ",
                (garmin_id, session_id),
            )
            # A manual link merges the rewards, even ones an automatic link kept.
            conn.execute(
                "UPDATE app.game_events SET processed=false, reason=replace(reason, ?, '') WHERE athlete_id = getvariable('arete_athlete_id') AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM app.athletes scope_owner WHERE scope_owner.id=athlete_id AND scope_owner.deleted_at IS NULL) AND (source_key=? OR source_key=?) ",
                [KEPT_AT_LINK, f"strength:{session_id}", f"actual:{garmin_id}"],
            )
            conn.execute("COMMIT")
            return True
        except Exception:
            conn.execute("ROLLBACK")
            raise
        finally:
            conn.close()

    def link_lone_garmin_pairs(
        self, days: Collection[date] | None = None
    ) -> list[tuple[int, int, date]]:
        """Link each day's lone unlinked log to its lone unlinked strength activity.

        A day with two unlinked logs or two unlinked strength activities stays
        as it is: the manual link decides those. ``None`` covers every day (the
        backfill). Idempotent: a linked pair is no longer a candidate. Unlike a
        manual link, it never takes back XP or shards already granted. Returns
        the (strength session, actual session, day) pairs it linked.
        """
        if days is not None and not days:
            return []
        day_filter = ""
        params: list[date] = []
        if days is not None:
            params = sorted(set(days))
            day_filter = f"AND date IN ({', '.join('?' for _ in params)})"
        conn = self._get_connection()
        # Pairs, links and their rewards are one commit, like a manual link.
        conn.execute("BEGIN TRANSACTION")
        try:
            pairs = conn.execute(
                f"""
                WITH logs AS (
                    SELECT date, min(id) AS id, count(*) AS n
                    FROM app.visible_strength_sessions
                    WHERE actual_session_id IS NULL {day_filter}
                    GROUP BY date
                ), activities AS (
                    SELECT date, min(id) AS id, count(*) AS n
                    FROM app.visible_actual_sessions a
                    WHERE sport = 'strength' {day_filter}
                      AND NOT EXISTS (
                          SELECT 1 FROM app.visible_strength_sessions s
                          WHERE s.actual_session_id = a.id
                      )
                    GROUP BY date
                )
                SELECT logs.id, activities.id, logs.date
                FROM logs JOIN activities USING (date)
                WHERE logs.n = 1 AND activities.n = 1
                ORDER BY logs.date
                """,
                params + params,
            ).fetchall()
            for session_id, actual_id, _day in pairs:
                conn.execute(
                    "UPDATE app.strength_sessions SET actual_session_id = ? WHERE user_id = getvariable('arete_athlete_id') AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM app.athletes scope_owner WHERE scope_owner.id=user_id AND scope_owner.deleted_at IS NULL) AND (id = ? AND actual_session_id IS NULL) ",
                    (actual_id, session_id),
                )
                _keep_settled_rewards(conn, session_id, actual_id)
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise
        finally:
            conn.close()
        return [(int(s), int(a), d) for s, a, d in pairs]

    # ─────────────────────────────────────────────────────────────────────
    # Drafts: Garmin strength activities awaiting their loads (ARE-132)
    # ─────────────────────────────────────────────────────────────────────

    def open_draft(
        self,
        actual_session_id: int,
        exercises: list[DraftExercise],
        origin: str,
        *,
        reopen: bool = False,
    ) -> int | None:
        """The activity's draft id, created at most once; None when it needs none.

        None when the activity is not this athlete's live strength activity or
        a Muscu log already completes it. An existing draft keeps its content;
        ``reopen`` (the athlete asking from the Journal) makes a dismissed or
        orphaned completed one pending again, never an import.
        """
        assert origin in ("import", "journal")
        conn = self._get_connection()
        conn.execute("BEGIN TRANSACTION")
        try:
            row = conn.execute(
                f"SELECT 1 FROM app.visible_actual_sessions a WHERE a.id = ? "
                f"AND a.sport = 'strength' AND {_UNLINKED_ACTIVITY.format(activity='a.id')}",
                [actual_session_id],
            ).fetchone()
            if row is None:
                conn.execute("ROLLBACK")
                return None
            conn.execute(
                "INSERT INTO app.strength_drafts"
                " (actual_session_id, exercises_json, origin, created_at)"
                " VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING",
                [
                    actual_session_id,
                    json.dumps([e.as_dict() for e in exercises], ensure_ascii=False),
                    origin,
                    datetime.now(),
                ],
            )
            if exercises:
                # A draft opened empty (from the Journal, or before Garmin took
                # over a Strava copy) gets Garmin's names when they arrive.
                conn.execute(
                    f"UPDATE app.strength_drafts SET exercises_json = ? WHERE {_DRAFT_SCOPE}"
                    " AND actual_session_id = ? AND exercises_json = '[]'"
                    " AND status = 'pending'",
                    [
                        json.dumps(
                            [e.as_dict() for e in exercises], ensure_ascii=False
                        ),
                        actual_session_id,
                    ],
                )
            if reopen:
                conn.execute(
                    f"UPDATE app.strength_drafts SET status = 'pending', settled_at = NULL,"
                    f" strength_session_id = NULL WHERE {_DRAFT_SCOPE}"
                    " AND actual_session_id = ? AND status <> 'pending'",
                    [actual_session_id],
                )
            found = conn.execute(
                "SELECT id FROM app.visible_strength_drafts WHERE actual_session_id = ?",
                [actual_session_id],
            ).fetchone()
            conn.execute("COMMIT")
        except duckdb.TransactionException:
            # Opened concurrently (a double tap, two tabs): the other one won.
            _rollback(conn)
            found = self._draft_of(actual_session_id)
        except BaseException:
            _rollback(conn)
            raise
        finally:
            conn.close()
        return int(found[0]) if found else None

    def _draft_of(self, actual_session_id: int) -> tuple | None:
        conn = self._get_connection()
        try:
            return conn.execute(
                "SELECT id FROM app.visible_strength_drafts WHERE actual_session_id = ?",
                [actual_session_id],
            ).fetchone()
        finally:
            conn.close()

    def pending_drafts(
        self, draft_id: int | None = None, limit: int = 20
    ) -> list[StrengthDraft]:
        """Pending drafts whose activity no Muscu log completes yet, newest first.

        The list (no ``draft_id``) leaves out a day that already has a log not
        linked to any activity: that log is probably this session, to link
        rather than log twice. A draft asked for by id is returned regardless.
        """
        where, params = _pending_drafts_where(draft_id)
        conn = self._get_connection()
        try:
            rows = conn.execute(
                f"""SELECT d.id, d.actual_session_id, a.date, a.name, a.duration_sec,
                       d.exercises_json, d.origin, d.created_at
                {where} ORDER BY a.date DESC, d.id DESC LIMIT ?""",
                [*params, limit],
            ).fetchall()
        finally:
            conn.close()
        return [
            StrengthDraft(
                id=row[0],
                actual_session_id=row[1],
                date=row[2],
                activity_name=row[3],
                duration_sec=row[4],
                exercises=[DraftExercise(**e) for e in json.loads(row[5] or "[]")],
                origin=row[6],
                created_at=row[7],
            )
            for row in rows
        ]

    def pending_draft_count(self) -> int:
        """How many drafts the list holds in all, beyond its first page."""
        where, params = _pending_drafts_where(None)
        conn = self._get_connection()
        try:
            row = conn.execute(f"SELECT count(*) {where}", params).fetchone()
        finally:
            conn.close()
        return int(row[0]) if row else 0

    def dismiss_pending_drafts(self, limit: int = 500) -> int | None:
        """Dismiss the listed drafts, at most ``limit`` per call; how many.

        None when a concurrent write (a completion) interrupted it: nothing
        was dismissed.
        """
        where, params = _pending_drafts_where(None)
        conn = self._get_connection()
        try:
            rows = conn.execute(
                "UPDATE app.strength_drafts SET status = 'dismissed', settled_at = ?"
                f" WHERE {_DRAFT_SCOPE} AND status = 'pending'"
                f" AND id IN (SELECT d.id {where} LIMIT ?) RETURNING id",
                [datetime.now(), *params, limit],
            ).fetchall()
        except duckdb.TransactionException:
            return None
        finally:
            conn.close()
        return len(rows)

    def complete_draft(self, draft_id: int, session: StrengthSession) -> int | None:
        """Save ``session`` as the draft's Muscu log, linked to its activity; once.

        The session takes the activity's date. One transaction for the log, its
        link, its game evidence and the draft's status: None (nothing written)
        when the draft is no longer pending, its activity got a log meanwhile,
        or another tab completes it concurrently. The draft row is deleted and
        written back completed: DuckDB reports a concurrent delete of the same
        row as a conflict, which it does not for an update of a keyed table.
        """
        conn = self._get_connection()
        conn.execute("BEGIN TRANSACTION")
        try:
            row = conn.execute(
                f"""SELECT d.actual_session_id, a.date, d.exercises_json, d.origin,
                       d.created_at
                FROM app.visible_strength_drafts d
                JOIN app.visible_actual_sessions a ON a.id = d.actual_session_id
                WHERE d.id = ? AND d.status = 'pending'
                  AND {_UNLINKED_ACTIVITY.format(activity="d.actual_session_id")}""",
                [draft_id],
            ).fetchone()
            if row is None:
                conn.execute("ROLLBACK")
                return None
            actual_id, day, exercises_json, origin, created_at = row
            session.actual_session_id, session.date = int(actual_id), day
            session_id = self._insert_session(conn, session)
            _keep_settled_rewards(conn, session_id, int(actual_id))
            claimed = conn.execute(
                f"DELETE FROM app.strength_drafts WHERE {_DRAFT_SCOPE}"
                " AND id = ? AND status = 'pending' RETURNING id",
                [draft_id],
            ).fetchone()
            if claimed is None:
                conn.execute("ROLLBACK")
                return None
            conn.execute(
                "INSERT INTO app.strength_drafts (id, actual_session_id, exercises_json,"
                " origin, status, strength_session_id, created_at, settled_at)"
                " VALUES (?, ?, ?, ?, 'completed', ?, ?, ?)",
                [
                    draft_id,
                    actual_id,
                    exercises_json,
                    origin,
                    session_id,
                    created_at,
                    datetime.now(),
                ],
            )
            conn.execute("COMMIT")
            return session_id
        except duckdb.TransactionException:
            # Another tab completed it first: nothing of ours was written.
            _rollback(conn)
            return None
        except BaseException:
            _rollback(conn)
            raise
        finally:
            conn.close()

    def log_for_activity(self, actual_session_id: int) -> int | None:
        """The live Muscu log linked to this activity, if any."""
        conn = self._get_connection()
        try:
            row = conn.execute(
                "SELECT min(id) FROM app.visible_strength_sessions"
                " WHERE actual_session_id = ?",
                [actual_session_id],
            ).fetchone()
        finally:
            conn.close()
        return int(row[0]) if row and row[0] is not None else None

    def unlinked_log_on(self, day: date) -> int | None:
        """A live Muscu log of ``day`` linked to no activity, if any."""
        conn = self._get_connection()
        try:
            row = conn.execute(
                "SELECT min(id) FROM app.visible_strength_sessions"
                " WHERE date = ? AND actual_session_id IS NULL",
                [day],
            ).fetchone()
        finally:
            conn.close()
        return int(row[0]) if row and row[0] is not None else None

    def draft_exists(self, draft_id: int) -> bool:
        """Whether this athlete has a draft with this id, whatever its status."""
        conn = self._get_connection()
        try:
            row = conn.execute(
                "SELECT 1 FROM app.visible_strength_drafts WHERE id = ?", [draft_id]
            ).fetchone()
        finally:
            conn.close()
        return row is not None

    def dismiss_draft(self, draft_id: int) -> bool:
        """Leave a pending draft without loads; False when it is not pending,
        or when a concurrent write (a completion) interrupted it."""
        unlinked = _UNLINKED_ACTIVITY.format(
            activity="app.strength_drafts.actual_session_id"
        )
        conn = self._get_connection()
        try:
            row = conn.execute(
                "UPDATE app.strength_drafts SET status = 'dismissed', settled_at = ?"
                f" WHERE {_DRAFT_SCOPE} AND id = ? AND status = 'pending'"
                f" AND {unlinked} RETURNING id",
                [datetime.now(), draft_id],
            ).fetchone()
        except duckdb.TransactionException:
            return False
        finally:
            conn.close()
        return row is not None


def _pending_drafts_where(draft_id: int | None) -> tuple[str, list]:
    """FROM and WHERE of pending drafts: one by id, or the Journal's list."""
    where = f"""FROM app.visible_strength_drafts d
        JOIN app.visible_actual_sessions a ON a.id = d.actual_session_id
        WHERE d.status = 'pending'
          AND {_UNLINKED_ACTIVITY.format(activity="d.actual_session_id")}"""
    if draft_id is not None:
        return where + " AND d.id = ?", [draft_id]
    return (
        where + " AND NOT EXISTS (SELECT 1 FROM app.visible_strength_sessions l"
        " WHERE l.date = a.date AND l.actual_session_id IS NULL)",
        [],
    )


#: A strength activity no live Muscu log is linked to; ``activity`` names its id.
_UNLINKED_ACTIVITY = (
    "NOT EXISTS (SELECT 1 FROM app.visible_strength_sessions s"
    " WHERE s.actual_session_id = {activity})"
)
#: The athlete's live draft rows, as every private write is scoped.
_DRAFT_SCOPE = (
    "athlete_id = getvariable('arete_athlete_id') AND deleted_at IS NULL"
    " AND EXISTS (SELECT 1 FROM app.athletes scope_owner"
    " WHERE scope_owner.id = athlete_id AND scope_owner.deleted_at IS NULL)"
)


def _rollback(conn: duckdb.DuckDBPyConnection) -> None:
    """Roll back, tolerating a transaction DuckDB already aborted."""
    with contextlib.suppress(duckdb.Error):
        conn.execute("ROLLBACK")


def _keep_settled_rewards(conn, session_id: int, actual_id: int) -> None:
    """Count an automatically linked pair once without debiting a past reward.

    The projection merges a linked log into its activity's canonical key and
    reverses the reward of the key that disappears. A key belongs to the past
    when it holds a net credit or an eligible event the projection already
    counted toward its week (a capped one included: merging it would lower
    the week's count and could take back the weekly bonus). Only a past-free
    pair is left to the projection; a pair with one past side in a single week
    re-keys the other side into it. Any other pair keeps both keys
    (``KEPT_AT_LINK``): it goes on counting as before, toward the cap and the
    weekly goal included. Reads go through the athlete-scoped visible views.
    """
    keys = [f"strength:{session_id}", f"actual:{actual_id}"]
    canonical = dict(
        conn.execute(
            "SELECT source_key, canonical_key FROM app.visible_game_events"
            " WHERE source_key IN (?, ?)",
            keys,
        ).fetchall()
    )
    if len(canonical) < 2:
        return  # One side was never captured: the projection has nothing to merge.
    log, activity = canonical[keys[0]], canonical[keys[1]]
    if log == activity:
        return
    past = {
        key
        for key in (log, activity)
        if conn.execute(
            """SELECT coalesce(bool_or(eligible AND processed), false) OR coalesce(
                bool_or(eligible) AND (SELECT sum(xp) > 0 OR sum(shards) > 0
                    FROM app.visible_game_ledger WHERE cause = ?), false)
            FROM app.visible_game_events WHERE canonical_key = ?""",
            ["activity:" + key, key],
        ).fetchone()[0]
    }
    weeks = conn.execute(
        "SELECT count(DISTINCT week_start) FROM app.visible_game_events"
        " WHERE canonical_key IN (?, ?)",
        [log, activity],
    ).fetchone()[0]
    if not past:
        # Nothing counted yet: the next projection merges them, as after a manual link.
        conn.execute(
            "UPDATE app.game_events SET processed=false WHERE athlete_id = getvariable('arete_athlete_id') AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM app.athletes scope_owner WHERE scope_owner.id=athlete_id AND scope_owner.deleted_at IS NULL) AND (source_key=? OR source_key=?) ",
            keys,
        )
    elif len(past) == 1 and weeks == 1:
        kept = past.pop()
        conn.execute(
            "UPDATE app.game_events SET canonical_key=? WHERE athlete_id = getvariable('arete_athlete_id') AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM app.athletes scope_owner WHERE scope_owner.id=athlete_id AND scope_owner.deleted_at IS NULL) AND (canonical_key=?) ",
            [kept, activity if kept == log else log],
        )
    else:
        # A merged group settles in its first week: a later week's credit would
        # be reversed. Both sides counted, or weeks apart: keep both keys.
        conn.execute(
            "UPDATE app.game_events SET reason=reason || ? WHERE athlete_id = getvariable('arete_athlete_id') AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM app.athletes scope_owner WHERE scope_owner.id=athlete_id AND scope_owner.deleted_at IS NULL) AND (source_key=? AND NOT ends_with(reason, ?)) ",
            [KEPT_AT_LINK, keys[0], KEPT_AT_LINK],
        )


_SESSION_COLUMNS = """id, user_id, date, name, program, duration_min,
    overall_rpe, fatigue_level, sleep_quality, notes, created_at,
    actual_session_id"""


def _session_from_row(row: tuple) -> StrengthSession:
    return StrengthSession(
        id=row[0],
        user_id=row[1],
        date=row[2],
        name=row[3],
        program=row[4],
        duration_min=row[5],
        overall_rpe=row[6],
        fatigue_level=row[7],
        sleep_quality=row[8],
        notes=row[9],
        created_at=row[10],
        actual_session_id=row[11],
    )


def _session_exercise_from_row(session_id: int, row: tuple) -> SessionExercise:
    exercise = None
    if row[7]:  # Has exercise data
        secondary = json.loads(row[11]) if row[11] else []
        exercise = Exercise(
            id=row[7],
            name=row[8],
            category=ExerciseCategory(row[9]) if row[9] else ExerciseCategory.OTHER,
            primary_muscle=MuscleGroup(row[10]) if row[10] else MuscleGroup.FULL_BODY,
            secondary_muscles=[MuscleGroup(m) for m in secondary],
            equipment=row[12],
            is_unilateral=row[13],
            notes=row[14],
        )
    return SessionExercise(
        id=row[0],
        session_id=session_id,
        exercise_id=row[1],
        exercise=exercise,
        order=row[2],
        target_sets=row[3],
        target_reps=row[4],
        target_rpe=row[5],
        notes=row[6],
    )


def _set_from_row(session_exercise_id: int, row: tuple) -> ExerciseSet:
    return ExerciseSet(
        id=row[0],
        session_exercise_id=session_exercise_id,
        set_number=row[1],
        reps=row[2],
        weight_kg=row[3],
        rpe=row[4],
        rir=row[5],
        rest_sec=row[6],
        tempo=row[7],
        is_warmup=row[8],
        is_failure=row[9],
        notes=row[10],
    )


def muscle_activity(
    rows: list[tuple],
    start_date: date,
    end_date: date,
    secondary_weight: float = 0.5,
) -> tuple[dict[str, float], dict[str, float], dict[str, date]]:
    """Volume, working sets and last training day per stored muscle id.

    ``rows`` come from ``muscle_set_rows``; only those dated within
    [start_date, end_date] count. Secondary muscles count for half the volume
    and half a set, the way the heat map has always weighted them.
    """
    volume: dict[str, float] = {}
    sets: dict[str, float] = {}
    last: dict[str, date] = {}

    def credit(muscle: str, day: date, kg: float, weight: float) -> None:
        if not muscle:
            return
        volume[muscle] = volume.get(muscle, 0.0) + kg * weight
        sets[muscle] = sets.get(muscle, 0.0) + weight
        seen = last.get(muscle)
        if seen is None or day > seen:
            last[muscle] = day

    for session_date, primary, secondary_json, reps, weight_kg in rows:
        day = (
            session_date
            if isinstance(session_date, date)
            else date.fromisoformat(str(session_date)[:10])
        )
        if not start_date <= day <= end_date:
            continue
        set_volume = (reps or 0) * (weight_kg or 0)
        credit(primary, day, set_volume, 1.0)
        for muscle in _parse_secondary(secondary_json):
            credit(muscle, day, set_volume, secondary_weight)

    return volume, sets, last


def _parse_secondary(raw) -> list[str]:
    """Secondary muscles stored as a JSON array, tolerant of nulls and junk."""
    if not raw:
        return []
    try:
        parsed = json.loads(raw) if isinstance(raw, str) else raw
    except (json.JSONDecodeError, TypeError):
        return []
    return [str(m) for m in parsed] if isinstance(parsed, list) else []
