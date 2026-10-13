"""Repository for strength training data.

CRUD operations for exercises, sets, and strength sessions.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Collection
from datetime import date, datetime

import duckdb

from arete.data.exercises_catalog import EXERCISES_CATALOG
from arete.dataio.db import configure_athlete, connect, get_db_path
from arete.dataio.ownership import require_owned
from arete.services.athlete_scope import resolve_athlete_id
from arete.strength.models import (
    Exercise,
    ExerciseCategory,
    ExerciseSet,
    MuscleGroup,
    SessionExercise,
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
        from arete.dataio.game_events import capture

        conn = self._get_connection()
        conn.execute("BEGIN TRANSACTION")
        try:
            result = conn.execute(
                """
                INSERT INTO app.strength_sessions (
                    user_id, date, name, program, duration_min,
                    overall_rpe, fatigue_level, sleep_quality, notes, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            conn.execute("COMMIT")
            return session_id
        except BaseException:
            conn.execute("ROLLBACK")
            raise
        finally:
            conn.close()

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
        conn = self._get_connection()
        try:
            rows = conn.execute(
                f"""
                WITH s AS (
                    SELECT id, date, name, program, duration_min, overall_rpe
                    FROM app.visible_strength_sessions WHERE 1=1{filters}
                    ORDER BY date DESC, id DESC LIMIT ?
                ), ex AS (
                    SELECT se.session_id, count(*) AS exercises,
                           list_sort(list_distinct(list(CASE WHEN e.id IS NOT NULL
                               THEN coalesce(nullif(e.primary_muscle, ''), 'full_body')
                           END))) AS muscles
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
                       coalesce(st.volume, 0), coalesce(ex.muscles, [])
                FROM s
                LEFT JOIN ex ON ex.session_id = s.id
                LEFT JOIN st ON st.session_id = s.id
                ORDER BY s.date DESC, s.id DESC
                """,
                [*params, limit],
            ).fetchall()
        finally:
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
            conn.execute(
                "UPDATE app.game_events SET processed=false WHERE athlete_id = getvariable('arete_athlete_id') AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM app.athletes scope_owner WHERE scope_owner.id=athlete_id AND scope_owner.deleted_at IS NULL) AND (source_key=? OR source_key=?) ",
                [f"strength:{session_id}", f"actual:{garmin_id}"],
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
        backfill). Idempotent: a linked pair is no longer a candidate. Returns
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
        # Pairs, links and reward invalidation are one commit, like a manual link.
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
                conn.execute(
                    "UPDATE app.game_events SET processed=false WHERE athlete_id = getvariable('arete_athlete_id') AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM app.athletes scope_owner WHERE scope_owner.id=athlete_id AND scope_owner.deleted_at IS NULL) AND (source_key=? OR source_key=?) ",
                    [f"strength:{session_id}", f"actual:{actual_id}"],
                )
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise
        finally:
            conn.close()
        return [(int(s), int(a), d) for s, a, d in pairs]


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
