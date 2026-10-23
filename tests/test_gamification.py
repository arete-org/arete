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


def purchase():
    return game.Purchase(key=str(uuid4()), skin="eclipse", expected_price=300)


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


@pytest.mark.parametrize(
    ("before", "buyer_wins"),
    [(r"SET version=version WHERE", False), (r"INSERT INTO app\.game_owned", True)],
    ids=["rival-commits-before-the-lock", "buyer-lock-rejects-the-rival"],
)
def test_a_racing_purchase_is_a_conflict_never_a_second_charge(
    game_db, monkeypatch, router_client, before, buyer_wins
):
    """ARE-82: a rival purchase runs inside the buyer's snapshot window.

    Raced before the buyer's lock, the rival commits and the buyer's lock
    conflicts with it. Raced before the buyer's insert, the buyer's uncommitted
    lock rejects the rival's lock, so the rival never commits the skin. That is
    the CI failure's interleaving: while the lock was an in-place update the
    rival committed and the buyer's insert hit a duplicate key.
    """
    from write_race import race

    from arete.api.gamification import router

    enable()
    fund()
    rival: list[object] = []

    def rival_buys():
        try:
            rival.append(game.purchase(purchase()))
        except duckdb.TransactionException as exc:
            rival.append(exc)

    with race(monkeypatch, before, rival_buys):
        response = router_client(router).post(
            "/gamification/purchases", json=purchase().model_dump()
        )
    assert response.status_code == (200 if buyer_wins else 409), response.text
    assert buyer_wins or "Une autre écriture" in response.json()["detail"]
    assert isinstance(rival[0], duckdb.TransactionException) == buyer_wins
    assert game.snapshot()["shards"] == 90
    with db_connection() as con:
        assert con.execute(
            "SELECT count(*) FROM app.game_owned WHERE skin='eclipse'"
        ).fetchone() == (1,)


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
            # The duplicate dated last week moves session 1 there: credited
            # there, reversed in the current week (ARE-93).
            ("activity:session:1", previous, 50, 10, "Course"),
            ("activity:session:1", week, -50, -10, fix + "Séance rapprochée"),
            ("week:" + week, week, 200, 40, "Objectif hebdomadaire respecté"),
            ("week:" + week, week, -200, -40, fix + "Objectif hebdomadaire respecté"),
        ]
    )


def test_duplicate_in_an_earlier_week_moves_the_credit_there(game_db):
    """A past week (not the current one) loses its credit to an earlier week."""
    enable()
    with transaction() as con:  # opted in for three weeks already
        con.execute(
            "UPDATE app.game_periods SET started_at=started_at - INTERVAL 20 DAY"
        )
    today = athlete_today()
    week_n, week_before = today - timedelta(days=7), today - timedelta(days=14)
    evidence("run", week_n)
    assert game.sync()["xp"] == 50
    with transaction() as con:
        capture(con, "dup", week_before, "Doublon", True, canonical="run")
    state = game.sync()
    n, before = (str(d - timedelta(days=d.weekday())) for d in (week_n, week_before))
    expected = sorted(
        [
            ("activity:run", n, 50, 10, "Course"),
            ("activity:run", before, 50, 10, "Course"),
            ("activity:run", n, -50, -10, "Correction de doublon · Séance rapprochée"),
        ]
    )
    assert _ledger() == expected
    assert (state["xp"], state["shards"]) == (50, 10)
    game.sync()  # idempotent: nothing left to settle
    assert _ledger() == expected


def test_a_ledger_credited_in_the_old_week_is_not_paid_twice(game_db):
    """Written before ARE-93: credited only where the activity no longer lives."""
    enable()
    with transaction() as con:
        con.execute(
            "UPDATE app.game_periods SET started_at=started_at - INTERVAL 30 DAY"
        )
    today = athlete_today()
    old_day, home_day = today - timedelta(days=7), today - timedelta(days=14)
    evidence("run", old_day)
    assert game.sync()["xp"] == 50
    # The former projection processed the earlier duplicate and wrote nothing.
    with transaction() as con:
        capture(con, "dup", home_day, "Doublon", True, canonical="run")
        con.execute("UPDATE app.game_events SET processed=true RETURNING source_key")
    # Later, another activity settles the home week only.
    evidence("other", home_day)
    state = game.sync()
    old, home = (str(d - timedelta(days=d.weekday())) for d in (old_day, home_day))
    assert (state["xp"], state["shards"]) == (100, 20)
    assert _ledger() == sorted(
        [
            ("activity:run", old, 50, 10, "Course"),
            ("activity:run", home, 50, 10, "Course"),
            (
                "activity:run",
                old,
                -50,
                -10,
                "Correction de doublon · Séance rapprochée",
            ),
            ("activity:other", home, 50, 10, "Course"),
        ]
    )


def test_a_duplicate_in_a_week_the_game_never_opened_keeps_the_credit(game_db):
    """An ineligible earlier duplicate cannot move the credit where none can go."""
    enable()
    with transaction() as con:
        con.execute(
            "UPDATE app.game_periods SET started_at=started_at - INTERVAL 20 DAY"
        )
    today = athlete_today()
    day = today - timedelta(days=7)
    evidence("run", day)
    assert game.sync()["xp"] == 50
    with transaction() as con:
        capture(
            con, "dup", today - timedelta(days=14), "Doublon", False, canonical="run"
        )
        assert not con.execute(
            "SELECT 1 FROM app.visible_game_weeks WHERE week_start=?",
            [day - timedelta(days=day.weekday() + 7)],
        ).fetchone()
    state = game.sync()
    week = str(day - timedelta(days=day.weekday()))
    assert (state["xp"], state["shards"]) == (50, 10)
    assert _ledger() == [("activity:run", week, 50, 10, "Course")]
    # An unrelated activity opens that earlier week later: the credit stays.
    evidence("other", today - timedelta(days=14))
    state = game.sync()
    earlier = str(day - timedelta(days=day.weekday() + 7))
    assert (state["xp"], state["shards"]) == (100, 20)
    assert _ledger() == sorted(
        [
            ("activity:run", week, 50, 10, "Course"),
            ("activity:other", earlier, 50, 10, "Course"),
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


def test_a_rest_the_athlete_chose_is_not_a_prescribed_rest(game_db):
    from arete.services.settings import UserSettingsUpdate, update_settings

    update_settings(UserSettingsUpdate(weekly_training_goal=2))
    enable()
    evidence("one")
    game.sync()
    with transaction() as con:
        con.execute(
            "INSERT INTO app.planned_sessions (date,sport,session_type,description) VALUES (?,'running','tempo','Seuil')",
            [athlete_today()],
        )
        planned = con.execute("SELECT max(id) FROM app.planned_sessions").fetchone()[0]
        # « Modifier » › « Douleur / gêne » › « Repos »: the athlete's own choice.
        con.execute(
            "INSERT INTO app.plan_decisions (user_id,date,planned_session_id,decision,reason,readiness_source,applied_at) VALUES (1,?,?,'rest','Douleur / gêne : repos','athlete',CURRENT_TIMESTAMP)",
            [athlete_today(), planned],
        )
    assert game.sync()["week"]["complete"] is False


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


def strength_log() -> int:
    from arete.strength.models import (
        Exercise,
        ExerciseSet,
        SessionExercise,
        StrengthSession,
    )
    from arete.strength.repository import StrengthRepository

    repo = StrengthRepository()
    exercise = repo.create_exercise(Exercise(name="Squat"))
    session = StrengthSession(date=athlete_today(), name="Muscu")
    session.exercises.append(
        SessionExercise(
            exercise_id=exercise, order=1, sets=[ExerciseSet(set_number=1, reps=5)]
        )
    )
    return repo.create_session(session)


def strength_activity() -> int:
    return GarminRepository().create_actual_session(
        ActualSession(
            date=athlete_today(), sport="strength", duration_sec=3600, source="manual"
        )
    )


def auto_link() -> None:
    from arete.strength.repository import StrengthRepository

    assert len(StrengthRepository().link_lone_garmin_pairs([athlete_today()])) == 1


def debits(state) -> list:
    return [row for row in state["history"] if row["xp"] < 0 or row["shards"] < 0]


def test_auto_link_keeps_a_pair_already_rewarded_twice(game_db):
    enable()
    strength_log()
    strength_activity()
    assert (game.sync()["xp"], game.snapshot()["shards"]) == (100, 20)
    auto_link()
    for _ in range(2):
        state = game.sync()
        assert (state["xp"], state["shards"], debits(state)) == (100, 20, [])
    # A kept pair is settled as it is: loading a page writes nothing more.
    with db_connection() as con:
        assert not game._due(con)


def test_auto_link_credits_a_pair_not_yet_rewarded_once(game_db):
    enable()
    strength_log()
    strength_activity()
    auto_link()
    state = game.sync()
    assert (state["sessions"], state["xp"], state["shards"]) == (1, 50, 10)


def test_auto_link_after_one_side_was_rewarded_neither_debits_nor_doubles(game_db):
    enable()
    strength_log()
    assert game.sync()["shards"] == 10
    strength_activity()
    auto_link()
    for _ in range(2):
        state = game.sync()
        assert (state["sessions"], state["shards"], debits(state)) == (1, 10, [])


def test_manual_link_still_merges_a_rewarded_pair(game_db):
    from arete.strength.repository import StrengthRepository

    enable()
    log, activity = strength_log(), strength_activity()
    assert game.sync()["shards"] == 20
    auto_link()
    assert game.sync()["shards"] == 20
    # Relinking by hand keeps the manual link's semantics: one session.
    assert StrengthRepository().link_to_actual_session(log, activity)
    state = game.sync()
    assert (state["sessions"], state["shards"]) == (1, 10)


def test_auto_link_never_moves_a_reward_out_of_its_week(game_db):
    enable()
    activity = strength_activity()
    assert game.sync()["shards"] == 10
    log = strength_log()
    # The log's evidence sits in the previous week: a merge would settle the
    # pair there and take back this week's reward.
    with transaction() as con:
        con.execute(
            "UPDATE app.game_events SET week_start=week_start - 7,"
            " activity_date=activity_date - 7 WHERE source_key=?",
            [f"strength:{log}"],
        )
        con.execute(
            "INSERT INTO app.game_weeks (week_start,goal,timezone)"
            " SELECT week_start,6,'Europe/Paris' FROM app.game_events"
            " WHERE source_key=? ON CONFLICT DO NOTHING",
            [f"strength:{log}"],
        )
    auto_link()
    for _ in range(2):
        state = game.sync()
        assert state["shards"] >= 10 and debits(state) == []
    with db_connection() as con:
        keys = con.execute(
            "SELECT count(DISTINCT canonical_key) FROM app.game_events"
            " WHERE source_key IN (?, ?)",
            [f"strength:{log}", f"actual:{activity}"],
        ).fetchone()[0]
    assert keys == 2


def test_an_ineligible_counted_log_is_not_a_past_reward(game_db):
    from arete.strength.models import StrengthSession
    from arete.strength.repository import StrengthRepository

    enable()
    # No set: the log is captured ineligible, processed without credit.
    log = StrengthRepository().create_session(
        StrengthSession(date=athlete_today(), name="Muscu")
    )
    activity = strength_activity()
    assert game.sync()["shards"] == 10
    auto_link()
    state = game.sync()
    assert (state["sessions"], state["shards"], debits(state)) == (1, 10, [])
    with db_connection() as con:
        rows = con.execute(
            "SELECT canonical_key, reason FROM app.game_events"
            " WHERE source_key IN (?, ?) ORDER BY source_key",
            [f"actual:{activity}", f"strength:{log}"],
        ).fetchall()
    # Re-keyed into the rewarded activity, not kept apart as a past reward.
    assert rows[0][0] == rows[1][0]
    assert not rows[1][1].endswith("+kept_at_link")
