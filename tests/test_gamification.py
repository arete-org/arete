"""Economy boundaries: opt-in, atomic evidence, caps, reconciliation and purchases."""

from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, date, datetime, timedelta
from uuid import uuid4
from zoneinfo import ZoneInfo

import duckdb
import pytest

from arete.dataio.db import db_connection, transaction
from arete.dataio.game_events import capture
from arete.dataio.init_duckdb import main
from arete.garmin.models import ActualSession
from arete.garmin.repository import GarminRepository
from arete.services import gamification as game


@pytest.fixture
def game_db(tmp_path, monkeypatch):
    monkeypatch.setenv("ARETE_DB", str(tmp_path / "game.duckdb"))
    monkeypatch.setenv("GAMIFICATION_ENABLED", "true")
    main()


def athlete_today() -> date:
    # Fixtures use the athlete's calendar, independently of the CI runner's zone.
    return datetime.now(ZoneInfo("Europe/Paris")).date()


def enable():
    p = game.preference()
    return game.set_preference(game.Preference(enabled=True, version=p["version"]))


def evidence(key, day=None, valid=True):
    with transaction() as con:
        capture(con, key, day or athlete_today(), "Course", valid)


def fund(shards=390):
    with transaction() as con:
        con.execute(
            "INSERT INTO app.game_ledger (id,cause,xp,shards,label) VALUES (?,'test',1770,?,'Fixture')",
            [str(uuid4()), shards],
        )


def test_all_level_boundaries():
    assert game.level_for(0) == 1
    for n in range(2, 21):
        threshold = 50 * n * (n - 1)
        assert game.level_for(threshold - 1) == n - 1
        assert game.level_for(threshold) == n
    assert game.level_for(10**9) == 20


def test_default_off_no_backfill_and_resume(game_db):
    assert not game.preference()["enabled"]
    evidence("before")
    enable()
    evidence("active")
    state = game.sync()
    assert (state["xp"], state["shards"]) == (50, 10)
    game.set_preference(game.Preference(enabled=False, version=state["version"]))
    evidence("paused")
    enable()
    state = game.sync()
    assert (state["xp"], state["shards"], state["sessions"]) == (50, 10, 1)
    main()
    assert game.snapshot()["shards"] == 10


def test_weekly_cap_and_replay(game_db):
    enable()
    for n in range(7):
        evidence(f"session:{n}")
    state = game.sync()
    assert (state["xp"], state["shards"], state["sessions"]) == (500, 100, 7)
    count = len(state["history"])
    evidence("session:0")
    assert len(game.sync()["history"]) == count
    assert game.sync()["shards"] == 100


def test_invalid_old_and_future_evidence_is_not_rewarded(game_db):
    enable()
    evidence("invalid", valid=False)
    evidence("past", athlete_today() - timedelta(days=15))
    evidence("future", athlete_today() + timedelta(days=1))
    assert game.sync()["xp"] == 0


def test_capture_rollback_is_atomic(game_db):
    enable()
    with pytest.raises(RuntimeError), transaction() as con:
        capture(con, "rollback", athlete_today(), "Course", True)
        raise RuntimeError("abort source transaction")
    assert game.sync()["xp"] == 0


def test_source_repository_captures_evidence(game_db):
    enable()
    session = ActualSession(
        date=athlete_today(), sport="running", duration_sec=1800, source="manual"
    )
    ident = GarminRepository().create_actual_session(session)
    with db_connection() as con:
        assert (
            con.execute("SELECT source_key FROM app.game_events").fetchone()[0]
            == f"actual:{ident}"
        )
    assert game.sync()["xp"] == 50


def test_purchase_replay_equip_and_opt_out(game_db):
    enable()
    fund()
    cmd = game.Purchase(key=str(uuid4()), skin="eclipse", expected_price=300)
    assert game.purchase(cmd)["charged"] == 300
    assert game.purchase(cmd)["charged"] == 300  # receipt of the original command
    assert game.snapshot()["shards"] == 90
    assert game.snapshot()["equipped"] == "base"
    game.equip(game.Equip(skin="eclipse", version=game.snapshot()["version"]))
    state = game.snapshot()
    game.set_preference(game.Preference(enabled=False, version=state["version"]))
    with pytest.raises(game.GameError, match="désactivée"):
        game.purchase(cmd)
    enable()
    assert game.snapshot()["equipped"] == "eclipse"
    assert game.snapshot()["shards"] == 90


def test_insufficient_unowned_and_stale_commands(game_db):
    enable()
    with pytest.raises(game.GameError, match="insuffisant"):
        game.purchase(
            game.Purchase(key=str(uuid4()), skin="eclipse", expected_price=300)
        )
    with pytest.raises(game.GameError, match="possédée"):
        game.equip(game.Equip(skin="eclipse", version=game.snapshot()["version"]))
    with pytest.raises(game.GameError, match="changé"):
        game.set_preference(game.Preference(enabled=False, version=0))
    assert game.snapshot()["shards"] == 0


def test_concurrent_purchase_never_double_debits(game_db):
    enable()
    fund()

    def buy():
        try:
            return game.purchase(
                game.Purchase(key=str(uuid4()), skin="eclipse", expected_price=300)
            )
        except duckdb.TransactionException:
            return "conflict"

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(lambda _: buy(), range(2)))
    assert any(isinstance(r, dict) for r in results)
    assert game.snapshot()["shards"] == 90


def test_kill_switch_preserves_queue(game_db, monkeypatch):
    enable()
    evidence("queued")
    monkeypatch.setenv("GAMIFICATION_ENABLED", "false")
    with pytest.raises(game.GameError):
        game.sync()
    assert game.snapshot()["pending"] == 1
    monkeypatch.setenv("GAMIFICATION_ENABLED", "true")
    assert game.sync()["shards"] == 10


def test_import_on_activation_day_without_time_is_ambiguous(game_db):
    enable()
    with transaction() as con:
        capture(con, "import", athlete_today(), "Import", True, manual=False)
        capture(
            con,
            "timed",
            athlete_today(),
            "Import",
            True,
            manual=False,
            started=datetime.now(UTC),
        )
    assert game.sync()["sessions"] == 1


def test_alias_consolidation_creates_compensation(game_db):
    enable()
    evidence("a")
    evidence("b")
    assert game.sync()["shards"] == 20
    with transaction() as con:
        con.execute(
            "UPDATE app.game_events SET canonical_key='a',processed=false WHERE source_key='b'"
        )
    state = game.sync()
    assert (state["shards"], state["sessions"]) == (10, 1)
    assert any(row["shards"] < 0 for row in state["history"])


def test_deletion_preserves_auditable_correction(game_db):
    enable()
    repo = GarminRepository()
    ident = repo.create_actual_session(
        ActualSession(
            date=athlete_today(), sport="running", duration_sec=100, source="manual"
        )
    )
    assert game.sync()["shards"] == 10
    repo.delete_actual_session(ident)
    state = game.sync()
    assert state["shards"] == 0
    assert len(state["history"]) == 2


def test_general_settings_update_preserves_opt_in(game_db):
    from arete.services.settings import UserSettingsUpdate, update_settings

    enable()
    update_settings(UserSettingsUpdate(display_name="Test"))
    assert game.preference()["enabled"]


def test_week_goal_is_frozen_and_rest_is_not_an_activity(game_db):
    from arete.services.settings import UserSettingsUpdate, update_settings

    update_settings(UserSettingsUpdate(weekly_training_goal=2))
    enable()
    evidence("one")
    update_settings(UserSettingsUpdate(weekly_training_goal=1))
    assert game.sync()["shards"] == 10
    with transaction() as con:
        con.execute(
            "INSERT INTO app.planned_sessions (date,sport,session_type,description) VALUES (?,'running','endurance','Rest adapted')",
            [athlete_today()],
        )
        planned = con.execute("SELECT max(id) FROM app.planned_sessions").fetchone()[0]
        con.execute(
            "INSERT INTO app.plan_decisions (user_id,date,planned_session_id,decision,reason,applied_at) VALUES (1,?,?,'rest','Prescribed',CURRENT_TIMESTAMP)",
            [athlete_today(), planned],
        )
    previous_version = game.snapshot()["version"]
    state = game.sync()
    assert state["version"] > previous_version
    assert (state["sessions"], state["xp"], state["shards"]) == (1, 250, 50)
    assert game.sync()["shards"] == 50


def test_canonical_source_identity_is_rewarded_once(game_db):
    enable()
    with transaction() as con:
        capture(con, "actual:1", athlete_today(), "Run", True, canonical="garmin:42")
        capture(con, "actual:2", athlete_today(), "Run", True, canonical="garmin:42")
    state = game.sync()
    assert (state["sessions"], state["xp"], state["shards"]) == (1, 50, 10)


def test_unknown_timezone_is_rejected():
    from pydantic import ValidationError

    from arete.services.settings import UserSettingsUpdate

    with pytest.raises(ValidationError, match="Fuseau horaire inconnu"):
        UserSettingsUpdate(timezone="Nowhere/Test")


def test_duplicate_during_opt_out_does_not_erase_earned_reward(game_db):
    enable()
    with transaction() as con:
        capture(con, "actual:1", athlete_today(), "Run", True, canonical="garmin:42")
    state = game.sync()
    game.set_preference(game.Preference(enabled=False, version=state["version"]))
    with transaction() as con:
        capture(
            con, "actual:2", athlete_today(), "Duplicate", True, canonical="garmin:42"
        )
    state = game.sync()
    assert (state["sessions"], state["xp"], state["shards"]) == (1, 50, 10)


def _ledger() -> list[tuple]:
    with db_connection() as con:
        return sorted(
            con.execute(
                "SELECT cause,CAST(week_start AS VARCHAR),xp,shards,label FROM app.game_ledger"
            ).fetchall()
        )


def test_receipts_of_caps_aliases_and_moved_duplicates_are_unchanged(game_db):
    """Characterizes every receipt a multi-week projection writes."""
    enable()
    with transaction() as con:  # opted in for three weeks already
        con.execute(
            "UPDATE app.game_periods SET started_at=started_at - INTERVAL 20 DAY"
        )
    today = athlete_today()
    last_week = today - timedelta(days=7)
    for n in range(7):
        evidence(f"session:{n}")
    evidence("earlier", last_week)
    game.sync()
    with transaction() as con:
        con.execute(
            "UPDATE app.game_events SET canonical_key='session:0',processed=false WHERE source_key='session:6'"
        )
        capture(con, "dup", last_week, "Doublon", True, canonical="session:1")
    game.sync()
    game.sync()
    week, previous = (str(d - timedelta(days=d.weekday())) for d in (today, last_week))
    fix = "Correction de doublon · "
    assert _ledger() == sorted(
        [
            ("activity:earlier", previous, 50, 10, "Course"),
            *[(f"activity:session:{n}", week, 50, 10, "Course") for n in range(6)],
            # Known bug, tracked in Linear ARE-93: the duplicate dated last
            # week moves session 1 there, but its sum per cause is already
            # credited, so only the current week's reversal is written and the
            # session ends uncredited. Pinned here until ARE-93 fixes it.
            ("activity:session:1", week, -50, -10, fix + "Séance rapprochée"),
            ("week:" + week, week, 200, 40, "Objectif hebdomadaire respecté"),
            ("week:" + week, week, -200, -40, fix + "Objectif hebdomadaire respecté"),
        ]
    )


WRITES = ("INSERT", "UPDATE", "DELETE", "BEGIN")


def _statements(monkeypatch, statement_log, run) -> list[str]:
    """The statements ``run`` sends, on the raw connections it opens."""
    real = duckdb.connect
    monkeypatch.setattr(
        duckdb, "connect", lambda *a, **k: statement_log.wrap(real(*a, **k))
    )
    run()
    monkeypatch.setattr(duckdb, "connect", real)
    return [" ".join(sql.split()).upper() for sql in statement_log]


def test_a_sync_with_nothing_to_settle_writes_nothing(
    game_db, monkeypatch, statement_log
):
    enable()
    for n in range(7):
        evidence(f"session:{n}")
    settled = game.sync()
    statements = _statements(monkeypatch, statement_log, game.sync)
    assert [s for s in statements if s.startswith(WRITES)] == []
    assert game.sync() == settled  # same snapshot, same version


def test_settling_more_activities_costs_no_more_reads(
    game_db, monkeypatch, statement_log
):
    enable()

    def selects(keys: list[str]) -> int:
        for key in keys:
            evidence(key)
        statement_log.clear()
        statements = _statements(monkeypatch, statement_log, game.sync)
        return sum(s.startswith(("SELECT", "WITH")) for s in statements)

    assert selects(["a", "b"]) == selects([f"k:{n}" for n in range(6)])


def test_a_rest_applied_since_the_last_sync_is_still_due(game_db):
    from arete.services.settings import UserSettingsUpdate, update_settings

    update_settings(UserSettingsUpdate(weekly_training_goal=2))
    enable()
    evidence("one")
    game.sync()
    with db_connection() as con:
        assert not game._due(con)
    with transaction() as con:
        con.execute(
            "INSERT INTO app.planned_sessions (date,sport,session_type,description) VALUES (?,'running','endurance','Repos')",
            [athlete_today()],
        )
        planned = con.execute("SELECT max(id) FROM app.planned_sessions").fetchone()[0]
        con.execute(
            "INSERT INTO app.plan_decisions (user_id,date,planned_session_id,decision,reason,applied_at) VALUES (1,?,?,'rest','Prescribed',CURRENT_TIMESTAMP)",
            [athlete_today(), planned],
        )
    with db_connection() as con:
        assert game._due(con)
    assert game.sync()["week"]["complete"] is True


def test_concurrent_syncs_with_nothing_to_settle_never_conflict(game_db):
    enable()
    evidence("one")
    game.sync()
    with ThreadPoolExecutor(max_workers=4) as executor:
        results = list(executor.map(lambda _: game.sync()["xp"], range(4)))
    assert results == [50] * 4


def test_the_daily_sync_settles_what_it_imported(game_db):
    from arete.scheduler import settle_game

    evidence("before opt-in")
    assert settle_game() is None  # opted out: nothing to report
    enable()
    evidence("imported")
    assert settle_game() == "0 pending"
    assert game.snapshot()["xp"] == 50
