"""Schema initialisation and versioned migrations on legacy databases."""

from __future__ import annotations

import duckdb
import pytest

from arete.dataio import init_duckdb
from arete.dataio.db import configure_athlete


def migration_connection(*args, **kwargs):
    con = duckdb.connect(*args, **kwargs)
    configure_athlete(con)
    return con


def test_fresh_db_records_all_versions(tmp_path, monkeypatch):
    monkeypatch.setenv("ARETE_DB", str(tmp_path / "fresh.duckdb"))
    init_duckdb.main()
    con = migration_connection(str(tmp_path / "fresh.duckdb"), read_only=True)
    versions = [
        r[0]
        for r in con.execute(
            "SELECT version FROM app.schema_version ORDER BY 1"
        ).fetchall()
    ]
    con.close()
    assert versions == [v for v, _ in init_duckdb.MIGRATIONS]


def test_legacy_column_is_renamed_once(tmp_path, monkeypatch):
    path = tmp_path / "legacy.duckdb"
    monkeypatch.setenv("ARETE_DB", str(path))
    # Legacy shape: strength_sessions still has garmin_activity_id, no schema_version yet
    con = migration_connection(str(path))
    con.execute("CREATE SCHEMA app")
    con.execute(
        "CREATE TABLE app.strength_sessions (id INTEGER, garmin_activity_id INTEGER)"
    )
    con.execute("CREATE TABLE app.user_settings (user_id INTEGER)")
    con.execute("CREATE TABLE app.actual_sessions (id INTEGER)")
    con.close()

    init_duckdb.main()
    init_duckdb.main()  # second run must be a no-op

    con = migration_connection(str(path), read_only=True)
    cols = {r[0] for r in con.execute("DESCRIBE app.strength_sessions").fetchall()}
    versions = [
        r[0]
        for r in con.execute(
            "SELECT version FROM app.schema_version ORDER BY 1"
        ).fetchall()
    ]
    con.close()
    assert "actual_session_id" in cols and "garmin_activity_id" not in cols
    assert versions == [version for version, _ in init_duckdb.MIGRATIONS]


def test_a_current_database_skips_the_ddl(tmp_path, monkeypatch):
    # Boot runs one statement against a current schema, not the whole DDL.
    monkeypatch.setenv("ARETE_DB", str(tmp_path / "current.duckdb"))
    init_duckdb.main()
    monkeypatch.setattr(init_duckdb, "DDL", "SELECT * FROM no_such_table")
    init_duckdb.main()  # would raise if the DDL ran


@pytest.mark.parametrize("failure_stage", ["bootstrap", "backup", "migration"])
def test_failed_upgrade_preserves_its_stage_and_does_not_record_success(
    tmp_path, monkeypatch, failure_stage
):
    path = tmp_path / "failed-upgrade.duckdb"
    monkeypatch.setenv("ARETE_DB", str(path))
    init_duckdb.main()
    version = init_duckdb.MIGRATIONS[-1][0]
    with migration_connection(str(path)) as con:
        con.execute("DELETE FROM app.schema_version WHERE version = ?", [version])

    def fail(con):
        # A real SQL error, with its original exception retained for debugging.
        con.execute("SELECT * FROM missing_upgrade_relation")

    if failure_stage == "bootstrap":
        monkeypatch.setattr(
            init_duckdb, "DDL", "SELECT * FROM missing_upgrade_relation"
        )
        expected_stage = "bootstrap:1"
    elif failure_stage == "backup":
        monkeypatch.setattr(
            type(init_duckdb.config), "is_remote_db", property(lambda s: True)
        )
        monkeypatch.setattr(
            init_duckdb, "connect", lambda ro: migration_connection(str(path))
        )
        monkeypatch.setattr(init_duckdb, "_backup_remote", fail)
        expected_stage = "backup"
    else:
        monkeypatch.setattr(init_duckdb, "MIGRATIONS", [(version, fail)])
        expected_stage = f"migration:{version}"

    with pytest.raises(init_duckdb.SchemaInitializationError) as exc:
        init_duckdb.main()
    assert exc.value.stage == expected_stage
    assert exc.value.error_type == "CatalogException"
    assert isinstance(exc.value.__cause__, duckdb.CatalogException)
    with migration_connection(str(path)) as con:
        assert version in init_duckdb.pending_migrations(con)


def test_pending_migrations_lists_the_missing_versions(tmp_path, monkeypatch):
    path = tmp_path / "pending.duckdb"
    monkeypatch.setenv("ARETE_DB", str(path))
    con = migration_connection(str(path))
    assert init_duckdb.pending_migrations(con) == [v for v, _ in init_duckdb.MIGRATIONS]
    con.close()
    init_duckdb.main()
    con = migration_connection(str(path))
    assert init_duckdb.pending_migrations(con) == []
    con.execute("DELETE FROM app.schema_version WHERE version IN (17, 36)")
    assert init_duckdb.pending_migrations(con) == [17, 36]
    con.close()


def test_recording_a_version_twice_does_not_fail(tmp_path, monkeypatch):
    # Two cold instances can migrate at once; the second record is a no-op.
    path = tmp_path / "race.duckdb"
    monkeypatch.setenv("ARETE_DB", str(path))
    init_duckdb.main()
    con = migration_connection(str(path))
    con.execute(
        "INSERT INTO app.schema_version (version) VALUES (?) ON CONFLICT DO NOTHING",
        [init_duckdb.MIGRATIONS[-1][0]],
    )
    (count,) = con.execute("SELECT count(*) FROM app.schema_version").fetchone()
    con.close()
    assert count == len(init_duckdb.MIGRATIONS)


def test_backup_statements_clone_then_keep_two():
    from datetime import UTC, datetime

    now = datetime(2026, 10, 10, 12, 30, 5, tzinfo=UTC)
    existing = [
        "arete",
        "arete_preview",
        "arete_bak_20261001T080000",
        "arete_bak_20261005T080000",
        "arete_preview_bak_20261009T080000",
    ]
    assert init_duckdb.backup_statements("arete", existing, now) == [
        'CREATE DATABASE "arete_bak_20261010T123005" FROM "arete"',
        'DROP DATABASE "arete_bak_20261001T080000"',
    ]
    assert init_duckdb.backup_statements("arete", ["arete"], now) == [
        'CREATE DATABASE "arete_bak_20261010T123005" FROM "arete"'
    ]


def test_a_local_database_is_not_backed_up(tmp_path, monkeypatch):
    path = tmp_path / "local.duckdb"
    monkeypatch.setenv("ARETE_DB", str(path))
    init_duckdb.main()
    con = migration_connection(str(path))
    con.execute("DELETE FROM app.schema_version WHERE version = 36")
    con.close()
    calls = []
    monkeypatch.setattr(init_duckdb, "_backup_remote", lambda con: calls.append(con))
    init_duckdb.main()
    assert calls == []


def test_a_remote_database_is_backed_up_before_migrating(tmp_path, monkeypatch):
    path = tmp_path / "remote.duckdb"
    monkeypatch.setenv("ARETE_DB", str(path))
    init_duckdb.main()
    con = migration_connection(str(path))
    con.execute("DELETE FROM app.schema_version WHERE version = 36")
    con.close()
    monkeypatch.setattr(
        type(init_duckdb.config), "is_remote_db", property(lambda s: True)
    )
    monkeypatch.setattr(
        init_duckdb, "connect", lambda ro: migration_connection(str(path))
    )
    calls = []
    monkeypatch.setattr(init_duckdb, "_backup_remote", lambda con: calls.append(con))
    init_duckdb.main()
    assert len(calls) == 1
    init_duckdb.main()  # current now: no second backup
    assert len(calls) == 1


def test_a_database_behind_runs_its_migrations(tmp_path, monkeypatch):
    path = tmp_path / "behind.duckdb"
    monkeypatch.setenv("ARETE_DB", str(path))
    init_duckdb.main()
    con = migration_connection(str(path))
    con.execute(
        "DELETE FROM app.schema_version WHERE version = ?",
        [init_duckdb.MIGRATIONS[-1][0]],
    )
    con.close()
    init_duckdb.main()
    con = migration_connection(str(path), read_only=True)
    (latest,) = con.execute("SELECT MAX(version) FROM app.schema_version").fetchone()
    con.close()
    assert latest == init_duckdb.MIGRATIONS[-1][0]


def test_private_relations_rebuild_ignores_other_attached_databases():
    # MotherDuck attaches the whole account: a sibling already migrated must
    # not lend its DDL (with deleted_at) to the database being migrated.
    from arete.dataio import tenant_schema

    con = migration_connection()
    con.execute("CREATE SCHEMA app")
    con.execute(
        "CREATE TABLE app.goals (id INTEGER, user_id INTEGER, deleted_at TIMESTAMP)"
    )
    con.execute("ATTACH ':memory:' AS preview")
    con.execute("USE preview")
    con.execute("CREATE SCHEMA app")
    con.execute("CREATE TABLE app.goals (id INTEGER, user_id INTEGER)")
    con.execute("INSERT INTO app.goals VALUES (7, NULL)")

    tenant_schema._rebuild(con, "goals")

    assert con.execute("SELECT id, user_id, deleted_at FROM app.goals").fetchall() == [
        (7, 1, None)
    ]


def test_document_migration_preserves_version_twelve_planning(tmp_path, monkeypatch):
    path = tmp_path / "version-twelve.duckdb"
    monkeypatch.setenv("ARETE_DB", str(path))
    init_duckdb.main()
    with migration_connection(str(path)) as con:
        con.execute(
            "INSERT INTO app.planned_sessions (date,sport,session_type,description) VALUES ('2027-01-12','running','endurance','Existing session')"
        )
        for column in ("prescription", "provenance", "revision"):
            con.execute(f"ALTER TABLE app.planned_sessions DROP COLUMN {column}")
        for table in (
            "document_quota",
            "coach_documents",
            "coach_document_chunks",
            "coach_imports",
            "garmin_exports",
        ):
            con.execute(f"DROP TABLE app.{table}")
        con.execute("DELETE FROM app.schema_version WHERE version >= 13")
    init_duckdb.main()
    with migration_connection(str(path)) as con:
        row = con.execute(
            "SELECT description,prescription,provenance,revision FROM app.planned_sessions"
        ).fetchone()
        assert row == ("Existing session", None, None, 1)
        assert con.execute("SELECT used_bytes FROM app.document_quota").fetchone() == (
            0,
        )


def test_sport_names_are_canonicalised_once(tmp_path, monkeypatch):
    path = tmp_path / "sports.duckdb"
    monkeypatch.setenv("ARETE_DB", str(path))
    init_duckdb.main()
    con = migration_connection(str(path))
    con.execute("DELETE FROM app.schema_version WHERE version >= 9")
    for i, sport in enumerate(("run", "Ride", "walk", "running", "TrailRun"), 1):
        con.execute(
            "INSERT INTO app.actual_sessions (id, user_id, date, sport, duration_sec, source)"
            " VALUES (?, 1, DATE '2026-10-01', ?, 3600, 'manual')",
            [i, sport],
        )
    con.execute(
        "INSERT INTO app.planned_sessions (id, user_id, date, sport, session_type)"
        " VALUES (1, 1, DATE '2026-10-01', 'run', 'endurance')"
    )
    con.close()

    init_duckdb.main()
    init_duckdb.main()  # second run must be a no-op

    con = migration_connection(str(path), read_only=True)
    actual = [
        r[0]
        for r in con.execute(
            "SELECT sport FROM app.actual_sessions ORDER BY id"
        ).fetchall()
    ]
    (planned,) = con.execute("SELECT sport FROM app.planned_sessions").fetchone()
    (latest,) = con.execute("SELECT MAX(version) FROM app.schema_version").fetchone()
    con.close()
    assert actual == ["running", "cycling", "walking", "running", "running"]
    assert planned == "running"
    assert latest == init_duckdb.MIGRATIONS[-1][0]


def test_m10_adds_performance_columns_to_a_legacy_table(tmp_path, monkeypatch):
    path = tmp_path / "perf.duckdb"
    monkeypatch.setenv("ARETE_DB", str(path))
    init_duckdb.main()
    con = migration_connection(str(path))
    for name in init_duckdb.GARMIN_PERFORMANCE_COLUMNS:
        con.execute(f"ALTER TABLE app.daily_metrics DROP COLUMN {name}")
    con.execute("DELETE FROM app.schema_version WHERE version >= 10")
    con.close()

    init_duckdb.main()
    init_duckdb.main()

    con = migration_connection(str(path), read_only=True)
    cols = {r[0] for r in con.execute("DESCRIBE app.daily_metrics").fetchall()}
    con.close()
    assert set(init_duckdb.GARMIN_PERFORMANCE_COLUMNS) <= cols


def test_m18_creates_the_users_table_once(tmp_path, monkeypatch):
    path = tmp_path / "users.duckdb"
    monkeypatch.setenv("ARETE_DB", str(path))
    init_duckdb.main()
    con = migration_connection(str(path))
    con.execute("DROP TABLE app.users")
    con.execute("DELETE FROM app.schema_version WHERE version >= 18")
    con.close()
    init_duckdb.main()
    init_duckdb.main()
    con = migration_connection(str(path), read_only=True)
    cols = {r[0] for r in con.execute("DESCRIBE app.users").fetchall()}
    (latest,) = con.execute("SELECT MAX(version) FROM app.schema_version").fetchone()
    con.close()
    assert {"clerk_user_id", "email", "athlete_id"} <= cols
    assert latest == init_duckdb.MIGRATIONS[-1][0]


@pytest.mark.parametrize("version_19", ["gamification", "personal_memory"])
def test_memory_upgrade_accepts_both_version_19_histories(
    tmp_path, monkeypatch, version_19
):
    path = tmp_path / "version-nineteen.duckdb"
    monkeypatch.setenv("ARETE_DB", str(path))
    with monkeypatch.context() as old:
        old.setattr(
            init_duckdb,
            "MIGRATIONS",
            [(v, fn) for v, fn in init_duckdb.MIGRATIONS if v <= 18],
        )
        init_duckdb.main()
    with migration_connection(str(path)) as con:
        con.execute(
            "INSERT INTO app.athlete_facts(kind, text, since) VALUES ('constraint', 'Pas de mercredi', DATE '2026-10-01')"
        )
        if version_19 == "gamification":
            from arete.dataio.game_schema import migrate

            migrate(con)
            con.execute(
                "UPDATE app.game_profile SET enabled=true, version=3 WHERE id=1"
            )
            expected_evidence = "legacy"
        else:
            from arete.dataio.memory_schema import migrate

            migrate(con)
            con.execute(
                "UPDATE app.athlete_facts SET evidence='explicit', source_ref='Déclaration athlète'"
            )
            expected_evidence = "explicit"
        con.execute("INSERT INTO app.schema_version(version) VALUES (19)")
    init_duckdb.main()
    init_duckdb.main()
    with migration_connection(str(path), read_only=True) as con:
        assert con.execute(
            "SELECT text, evidence, revision FROM app.athlete_facts"
        ).fetchone() == ("Pas de mercredi", expected_evidence, 1)
        assert con.execute(
            "SELECT count(*) FROM app.athlete_fact_revisions"
        ).fetchone() == (0,)
        expected_game = (True, 3) if version_19 == "gamification" else (False, 0)
        assert (
            con.execute(
                "SELECT enabled, version FROM app.game_profile WHERE id=1"
            ).fetchone()
            == expected_game
        )
        assert con.execute(
            "SELECT count(*) FROM app.schema_version WHERE version = 20"
        ).fetchone() == (1,)


def test_a_missing_version_below_the_latest_still_runs(tmp_path, monkeypatch):
    # A preview database shared by parallel branches can record a higher
    # version before a lower one is merged: the lower one must still run.
    path = tmp_path / "gap.duckdb"
    monkeypatch.setenv("ARETE_DB", str(path))
    init_duckdb.main()
    con = migration_connection(str(path))
    con.execute("DROP TABLE app.calendar_actions")
    con.execute("DROP TABLE app.calendar_connections")
    con.execute("DELETE FROM app.schema_version WHERE version = 17")
    con.execute("INSERT INTO app.schema_version (version) VALUES (9999)")
    con.close()
    init_duckdb.main()
    init_duckdb.main()
    con = migration_connection(str(path), read_only=True)
    tables = {
        r[0]
        for r in con.execute(
            "SELECT table_name FROM duckdb_tables() WHERE schema_name = 'app'"
        ).fetchall()
    }
    versions = [
        r[0]
        for r in con.execute(
            "SELECT version FROM app.schema_version WHERE version = 17"
        ).fetchall()
    ]
    con.close()
    assert {"calendar_actions", "calendar_connections"} <= tables
    assert versions == [17]  # recorded once, and the unknown 9999 is ignored


def test_m38_creates_system_skills_even_below_a_recorded_future_version(
    tmp_path, monkeypatch
):
    path = tmp_path / "skills.duckdb"
    monkeypatch.setenv("ARETE_DB", str(path))
    init_duckdb.main()
    con = migration_connection(str(path))
    con.execute("DROP TABLE app.system_skills")
    con.execute("DELETE FROM app.schema_version WHERE version=38")
    con.execute("INSERT INTO app.schema_version (version) VALUES (9999)")
    con.close()
    init_duckdb.main()
    init_duckdb.main()
    con = migration_connection(str(path), read_only=True)
    try:
        assert con.execute("SELECT * FROM app.system_skills").fetchall() == []
        assert con.execute(
            "SELECT count(*) FROM app.schema_version WHERE version=38"
        ).fetchone() == (1,)
    finally:
        con.close()


def test_feature_flag_upgrade_is_idempotent_and_preserves_enabled_state(
    tmp_path, monkeypatch
):
    path = tmp_path / "feature-flags.duckdb"
    monkeypatch.setenv("ARETE_DB", str(path))
    init_duckdb.main()
    con = migration_connection(str(path))
    con.execute("DROP TABLE app.feature_flags")
    con.execute("DELETE FROM app.schema_version WHERE version=41")
    con.close()
    init_duckdb.main()
    con = migration_connection(str(path))
    assert con.execute("SELECT * FROM app.feature_flags").fetchall() == []
    con.execute("INSERT INTO app.feature_flags VALUES ('glm_flash', true)")
    con.close()
    init_duckdb.main()
    con = migration_connection(str(path))
    try:
        assert con.execute("SELECT enabled FROM app.feature_flags").fetchone() == (
            True,
        )
        assert con.execute(
            "SELECT count(*) FROM app.schema_version WHERE version=41"
        ).fetchone() == (1,)
    finally:
        con.close()


def test_m31_creates_the_stream_and_feedback_tables_once(tmp_path, monkeypatch):
    path = tmp_path / "streams.duckdb"
    monkeypatch.setenv("ARETE_DB", str(path))
    init_duckdb.main()
    con = migration_connection(str(path))
    con.execute("DROP TABLE app.activity_streams")
    con.execute("DROP TABLE app.session_feedback")
    con.execute("DELETE FROM app.schema_version WHERE version = 31")
    con.close()
    init_duckdb.main()
    init_duckdb.main()
    con = migration_connection(str(path), read_only=True)
    columns = dict(
        (r[0], r[1]) for r in con.execute("DESCRIBE app.activity_streams").fetchall()
    )
    feedback = {r[0] for r in con.execute("DESCRIBE app.session_feedback").fetchall()}
    (recorded,) = con.execute(
        "SELECT count(*) FROM app.schema_version WHERE version = 31"
    ).fetchone()
    con.close()
    assert columns["heart_rate"] == "SMALLINT[]" and columns["lat"] == "FLOAT[]"
    assert {"actual_session_id", "text", "source", "trigger"} <= feedback
    assert recorded == 1


def test_m32_creates_the_terrain_and_weather_tables_once(tmp_path, monkeypatch):
    path = tmp_path / "conditions.duckdb"
    monkeypatch.setenv("ARETE_DB", str(path))
    init_duckdb.main()
    with migration_connection(str(path)) as con:
        con.execute("DROP TABLE app.activity_terrain")
        con.execute("DROP TABLE app.activity_weather")
        con.execute(
            "INSERT INTO app.actual_sessions "
            "(user_id, date, sport, duration_sec, source) "
            "VALUES (1, '2026-10-01', 'running', 3600, 'garmin_connect')"
        )
        con.execute("DELETE FROM app.schema_version WHERE version = 32")
    init_duckdb.main()
    init_duckdb.main()  # recorded once, then skipped
    with migration_connection(str(path), read_only=True) as con:
        terrain = dict(
            (r[0], r[1])
            for r in con.execute("DESCRIBE app.activity_terrain").fetchall()
        )
        weather = {
            r[0] for r in con.execute("DESCRIBE app.activity_weather").fetchall()
        }
        assert terrain["gap_sec_km"] == "INTEGER" and terrain["vam_60min"] == "INTEGER"
        assert {
            "temperature_c",
            "humidity_pct",
            "wind_kmh",
            "start_altitude_m",
        } <= weather
        # Existing sessions keep working, with no terrain or weather yet
        assert con.execute(
            "SELECT count(*) FROM app.actual_sessions s "
            "LEFT JOIN app.activity_terrain t ON t.actual_session_id = s.id "
            "WHERE t.actual_session_id IS NULL"
        ).fetchone() == (1,)
        assert con.execute(
            "SELECT count(*) FROM app.schema_version WHERE version = 32"
        ).fetchone() == (1,)


def test_m34_adds_the_plan_sync_columns_once(tmp_path, monkeypatch):
    from arete.services.calendar_repository import PLAN_SYNC_DDL

    path = tmp_path / "plan-sync.duckdb"
    monkeypatch.setenv("ARETE_DB", str(path))
    init_duckdb.main()
    # "ALTER TABLE <table> ADD COLUMN IF NOT EXISTS <column> <type>;"
    added = [
        (line.split()[2], line.split()[8])
        for line in PLAN_SYNC_DDL.strip().splitlines()
    ]
    with migration_connection(str(path)) as con:
        for table, column in added:
            con.execute(f"ALTER TABLE {table} DROP COLUMN {column}")
        con.execute(
            "INSERT INTO app.calendar_connections (connection_key, enabled) VALUES ('k', TRUE)"
        )
        con.execute(
            "INSERT INTO app.planned_sessions (date, sport, session_type) VALUES ('2026-10-12', 'running', 'endurance')"
        )
        con.execute("DELETE FROM app.schema_version WHERE version = 34")
    init_duckdb.main()
    init_duckdb.main()  # recorded once, then skipped
    with migration_connection(str(path), read_only=True) as con:
        for table, column in added:
            columns = {r[0] for r in con.execute(f"DESCRIBE {table}").fetchall()}
            assert column in columns
        assert con.execute(
            "SELECT enabled, plan_sync, plan_calendar FROM app.calendar_connections"
        ).fetchone() == (True, False, None)
        assert con.execute(
            "SELECT session_type, google_event_id FROM app.planned_sessions"
        ).fetchone() == ("endurance", None)
        assert con.execute(
            "SELECT count(*) FROM app.schema_version WHERE version = 34"
        ).fetchone() == (1,)


def test_m39_adds_the_role_column_once(tmp_path, monkeypatch):
    from arete.services import users

    path = tmp_path / "roles.duckdb"
    monkeypatch.setenv("ARETE_DB", str(path))
    monkeypatch.delenv("ARETE_AUTH", raising=False)
    init_duckdb.main()
    with migration_connection(str(path)) as con:
        described = {r[0]: r for r in con.execute("DESCRIBE app.users").fetchall()}
        assert described["role"][4] == "'athlete'"
        con.execute("ALTER TABLE app.users DROP COLUMN role")
        con.execute(
            "INSERT INTO app.users (clerk_user_id, email, athlete_id) "
            "VALUES ('legacy', 'me@example.com', 1), ('guest', 'you@example.com', 2)"
        )
        con.execute("DELETE FROM app.schema_version WHERE version = 39")
    init_duckdb.main()
    init_duckdb.main()  # recorded once, then skipped
    with migration_connection(str(path), read_only=True) as con:
        assert con.execute("SELECT DISTINCT role FROM app.users").fetchall() == [
            ("athlete",)
        ]
        assert con.execute(
            "SELECT count(*) FROM app.schema_version WHERE version = 39"
        ).fetchone() == (1,)
    owner, guest = users.get_user("legacy"), users.get_user("guest")
    assert owner is not None and guest is not None
    # Existing accounts stay athletes; the owner administers by right.
    assert (owner.role, owner.is_admin) == ("athlete", True)
    assert (guest.role, guest.is_admin) == ("athlete", False)


def test_shared_schema_preserves_legacy_owners_children_and_next_identity(
    tmp_path, monkeypatch
):
    from arete.dataio.db import connect
    from arete.services.athlete_scope import athlete_scope
    from arete.services.users import upsert_user

    monkeypatch.setenv("ARETE_DB", str(tmp_path / "legacy-owners.duckdb"))
    migrations = init_duckdb.MIGRATIONS
    monkeypatch.setattr(
        init_duckdb, "MIGRATIONS", [(v, fn) for v, fn in migrations if v < 35]
    )
    init_duckdb.main()
    con = connect()
    con.execute(
        "INSERT INTO app.actual_sessions(id,user_id,date,duration_sec,source) VALUES(100,42,'2026-01-01',1000,'manual'),(101,NULL,'2026-01-02',1200,'manual')"
    )
    con.execute(
        "INSERT INTO app.session_feedback(actual_session_id,text,source,trigger) VALUES(100,'historical feedback','rules','sync')"
    )
    con.close()
    monkeypatch.setattr(init_duckdb, "MIGRATIONS", migrations)
    init_duckdb.main()
    init_duckdb.main()
    with athlete_scope(42):
        con = connect()
        assert con.execute("SELECT id FROM app.visible_actual_sessions").fetchall() == [
            (100,)
        ]
        assert con.execute(
            "SELECT text FROM app.visible_session_feedback"
        ).fetchall() == [("historical feedback",)]
        con.close()
    with athlete_scope(1):
        con = connect()
        assert con.execute("SELECT id FROM app.visible_actual_sessions").fetchall() == [
            (101,)
        ]
        assert (
            con.execute("SELECT * FROM app.visible_session_feedback").fetchall() == []
        )
        con.close()
    assert upsert_user("new-identity", "new@example.com").athlete_id > 42


def test_m54_creates_the_strength_drafts_once_and_atomically(tmp_path, monkeypatch):
    from arete.dataio import tenant_schema

    path = tmp_path / "drafts.duckdb"
    monkeypatch.setenv("ARETE_DB", str(path))
    init_duckdb.main()

    def to_schema_53() -> None:
        with migration_connection(str(path)) as con:
            con.execute("DROP VIEW app.visible_strength_drafts")
            con.execute("DROP TABLE app.strength_drafts")
            con.execute("DROP SEQUENCE app.strength_drafts_seq")
            con.execute("DELETE FROM app.schema_version WHERE version = 54")

    to_schema_53()
    with migration_connection(str(path)) as con:
        assert init_duckdb.pending_migrations(con) == [54]
        # The previous release (without 54) finds the database current; later
        # versions may follow 54 in the list.
        with monkeypatch.context() as previous:
            previous.setattr(
                init_duckdb,
                "MIGRATIONS",
                [m for m in init_duckdb.MIGRATIONS if m[0] != 54],
            )
            assert init_duckdb.pending_migrations(con) == []

        def broken_view(*_args):
            raise RuntimeError("view refresh failed")

        with monkeypatch.context() as broken:
            broken.setattr(tenant_schema, "_view", broken_view)
            with pytest.raises(RuntimeError):
                init_duckdb._m54_strength_drafts(con)
        # Rolled back together: never a table without its private view.
        assert con.execute(
            "SELECT count(*) FROM information_schema.tables"
            " WHERE table_schema = 'app' AND table_name = 'strength_drafts'"
        ).fetchone() == (0,)

    init_duckdb.main()
    init_duckdb.main()  # recorded once, then skipped
    with migration_connection(str(path), read_only=True) as con:
        assert con.execute(
            "SELECT count(*) FROM app.visible_strength_drafts"
        ).fetchone() == (0,)
        assert con.execute(
            "SELECT count(*) FROM app.schema_version WHERE version = 54"
        ).fetchone() == (1,)
