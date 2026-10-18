"""A Garmin strength activity becomes a session awaiting its loads (ARE-132)."""

from collections.abc import Generator
from datetime import date, timedelta
from unittest.mock import MagicMock, patch

import pytest

from arete.dataio.db import connect
from arete.services.athlete_scope import athlete_scope
from arete.services.settings import athlete_today
from arete.strength.drafts import (
    DraftBusy,
    DraftSettled,
    complete_draft,
    draft_exercises,
    draft_notation,
    open_garmin_draft,
    open_journal_draft,
)
from arete.strength.models import (
    DraftExercise,
    ExerciseSet,
    GarminExerciseSummary,
    SessionExercise,
    StrengthSession,
)
from arete.strength.repository import StrengthRepository

NAME = "draft-test séance"
GARMIN_ID = 7_132_001


@pytest.fixture
def con() -> Generator:
    con = connect()
    yield con
    con.execute(
        "DELETE FROM app.strength_drafts WHERE actual_session_id IN"
        " (SELECT id FROM app.actual_sessions WHERE name = ?"
        " OR garmin_activity_id = ?)",
        [NAME, str(GARMIN_ID)],
    )
    con.execute("DELETE FROM app.strength_sessions WHERE name LIKE 'draft-test%'")
    con.execute(
        "DELETE FROM app.actual_sessions WHERE name = ? OR garmin_activity_id = ?",
        [NAME, str(GARMIN_ID)],
    )
    con.close()


def _activity(con, day: date, sport: str = "strength") -> int:
    return con.execute(
        "INSERT INTO app.actual_sessions (user_id, date, sport, duration_sec, source, name)"
        " VALUES (1, ?, ?, 3000, 'manual', ?) RETURNING id",
        [day, sport, NAME],
    ).fetchone()[0]


def _drafts(con, activity: int) -> list[tuple]:
    return con.execute(
        "SELECT id, status, origin, strength_session_id FROM app.strength_drafts"
        " WHERE actual_session_id = ?",
        [activity],
    ).fetchall()


SUMMARIES = [
    GarminExerciseSummary("BENCH_PRESS", "BARBELL_BENCH_PRESS", sets=3, reps=30),
    GarminExerciseSummary("SHOULDER_PRESS", "OVERHEAD_BARBELL_PRESS", 4, 34),
    # A category alone, listed.
    GarminExerciseSummary("PLANK", None, 2, 2),
    # Not in the table: free text the athlete writes.
    GarminExerciseSummary("SHRUG", None, 3, None),
    GarminExerciseSummary("UNKNOWN", "UNKNOWN", 2, 20),
]


def test_garmin_names_go_through_the_table_and_open_as_notation():
    exercises = draft_exercises(SUMMARIES)

    assert [(e.name, e.exercise_id, e.sets, e.reps) for e in exercises] == [
        ("Développé couché", "bench_press", 3, 10),
        ("Développé militaire", "shoulder_press", 4, 8),
        ("Gainage", "plank", 2, 1),
        ("shrug", None, 3, None),
    ]
    # Free text is not written as notation the parser could read as a near exercise.
    assert draft_notation(exercises) == (
        "Développé couché 3x10\nDéveloppé militaire 4x8\nGainage 2x1"
    )


@pytest.mark.parametrize(
    ("category", "sub", "expected"),
    [
        # Near but wrong under fuzzy matching: now right, or free text.
        ("HYPEREXTENSION", "BACK_EXTENSION", None),
        ("SLED", "PUSH", None),
        ("INDOOR_ROW", None, None),
        ("ROW", "ONE_ARM_BENT_OVER_ROW", "dumbbell_row"),
        ("CURL", "DUMBBELL_BICEPS_CURL", None),
        ("CURL", "CABLE_BICEPS_CURL", None),
        ("DEADLIFT", "TRAP_BAR_DEADLIFT", None),
        ("SQUAT", "FRONT_SQUAT", None),
        ("SQUAT", "GOBLET_SQUAT", None),
        ("BENCH_PRESS", "DUMBBELL_BENCH_PRESS", None),
        ("BENCH_PRESS", "INCLINE_DUMBBELL_BENCH_PRESS", None),
        ("RUN", "RUN", None),
        # A known category with an unlisted finer name is not its category.
        ("PLANK", "45_DEGREE_PLANK", None),
        ("BENCH_PRESS", None, None),
    ],
)
def test_wrong_near_matches_stay_free_text(category, sub, expected):
    from arete.data.garmin_exercises import garmin_catalog_id

    assert garmin_catalog_id(category, sub) == expected


def test_every_mapped_garmin_name_reads_back_as_its_catalog_exercise():
    from arete.data.exercises_catalog import EXERCISES_BY_ID, EXERCISES_CATALOG
    from arete.data.garmin_exercises import GARMIN_CATEGORIES, GARMIN_EXERCISES
    from arete.llm.workout_parser import parse_workout_text

    french = [e["name_fr"].lower() for e in EXERCISES_CATALOG]
    assert len(french) == len(set(french)), "two catalog exercises share a French name"
    for catalog_id in {*GARMIN_EXERCISES.values(), *GARMIN_CATEGORIES.values()}:
        line = draft_notation(
            [DraftExercise(EXERCISES_BY_ID[catalog_id]["name_fr"], catalog_id, 3, 10)]
        )
        parsed = parse_workout_text(line + "@20", workout_date=date(2026, 10, 1))
        assert [e.exercise_id for e in parsed.exercises] == [catalog_id], line
        assert parsed.unparsed_lines == []


def test_garmin_summaries_are_read_from_the_activity_payload():
    from arete.garmin.sync import GarminActivity

    activity = GarminActivity.from_api_response(
        {
            "activityId": 1,
            "activityType": {"typeKey": "strength_training"},
            "startTimeLocal": "2026-10-12T18:00:00",
            "summarizedExerciseSets": [
                {
                    "category": "SQUAT",
                    "subCategory": "BACK_SQUAT",
                    "sets": 5,
                    "reps": 25,
                },
                {"category": "PLANK", "sets": 2, "reps": True},
                "junk",
                {"subCategory": "NO_CATEGORY"},
            ],
        }
    )
    assert activity.exercise_summaries == [
        GarminExerciseSummary("SQUAT", "BACK_SQUAT", 5, 25),
        GarminExerciseSummary("PLANK", None, 2, None),
    ]


def _sync(raw: list[dict]):
    from arete.features.hr_zones import ZoneModel
    from arete.garmin.repository import GarminRepository
    from arete.garmin.sync import GarminActivity, GarminSyncClient

    client = GarminSyncClient(client=MagicMock(), zones=ZoneModel.from_reference())
    client._repository = GarminRepository()
    with patch("arete.garmin.sync.time.sleep"):
        return list(
            client.iter_sync_activities(
                download_fit=False,
                activity_batch=[GarminActivity.from_api_response(r) for r in raw],
            )
        )[-1]


def test_importing_a_strength_activity_opens_one_draft_and_reimporting_none(con):
    today = athlete_today()
    raw = {
        "activityId": GARMIN_ID,
        "activityName": "draft-test Musculation",
        "activityType": {"typeKey": "strength_training"},
        "startTimeLocal": f"{today.isoformat()}T07:00:00",
        "duration": 3000,
        "summarizedExerciseSets": [
            {
                "category": "BENCH_PRESS",
                "subCategory": "BARBELL_BENCH_PRESS",
                "sets": 3,
                "reps": 30,
            },
        ],
    }
    first = _sync([raw])
    assert first.activities_synced == 1, first.errors
    [activity] = first.session_ids
    [(draft_id, status, origin, _)] = _drafts(con, activity)
    assert (status, origin) == ("pending", "import")
    [draft] = StrengthRepository().pending_drafts(draft_id)
    assert draft.date == today
    assert [e.exercise_id for e in draft.exercises] == ["bench_press"]

    again = _sync([raw])
    assert again.activities_skipped == 1
    # The import's own call is idempotent too.
    assert open_garmin_draft(activity, today, []) == draft_id
    assert len(_drafts(con, activity)) == 1


def test_only_recent_imports_open_a_draft(con):
    today = athlete_today()
    old = _activity(con, today - timedelta(days=7))
    recent = _activity(con, today - timedelta(days=6))

    assert open_garmin_draft(old, today - timedelta(days=7), []) is None
    assert open_garmin_draft(recent, today - timedelta(days=6), []) is not None
    assert _drafts(con, old) == []


def test_no_draft_for_a_logged_or_non_strength_activity(con):
    today = athlete_today()
    run = _activity(con, today, sport="running")
    logged = _activity(con, today)
    con.execute(
        "INSERT INTO app.strength_sessions (user_id, date, name, actual_session_id)"
        " VALUES (1, ?, 'draft-test log', ?)",
        [today, logged],
    )

    assert open_garmin_draft(run, today, []) is None
    assert open_garmin_draft(logged, today, []) is None
    assert open_journal_draft(logged) is None


def _previous_hip_thrust(day: date) -> None:
    repo = StrengthRepository()
    exercise = repo.get_or_create_exercise_from_catalog("hip_thrust")
    assert exercise is not None and exercise.id is not None
    repo.create_session(
        StrengthSession(
            date=day,
            name="draft-test previous",
            exercises=[
                SessionExercise(
                    exercise_id=exercise.id,
                    exercise=exercise,
                    sets=[ExerciseSet(set_number=1, reps=10, weight_kg=100)],
                )
            ],
        )
    )


def test_completing_a_draft_makes_one_linked_session_with_records(con, client):
    today = athlete_today()
    activity = _activity(con, today)
    _previous_hip_thrust(today - timedelta(days=20))
    draft_id = open_garmin_draft(
        activity,
        today,
        [GarminExerciseSummary("HIP_RAISE", "BARBELL_HIP_THRUST_WITH_BENCH", 3, 30)],
    )
    [listed] = [
        d for d in client.get("/strength/drafts").json()["items"] if d["id"] == draft_id
    ]
    assert listed["notation"] == "Hip thrust 3x10"

    muscles = {
        m["muscle"]: m["volume"]
        for m in client.get("/strength/stats/muscles", params={"days": 7}).json()[
            "muscles"
        ]
    }
    response = client.post(
        f"/strength/drafts/{draft_id}/complete",
        json={"text": listed["notation"] + "@250"},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert [r["kind"] for r in body["records"]] == ["weight", "e1rm"]

    [(_, status, _, session_id)] = _drafts(con, activity)
    assert (status, session_id) == ("completed", body["session_id"])
    [log] = client.get(
        "/strength/sessions",
        params={"start_date": today.isoformat(), "end_date": today.isoformat()},
    ).json()
    # One session: the log carries the activity, its date and name.
    assert (log["id"], log["garmin_activity_id"]) == (session_id, activity)
    assert (log["total_sets"], log["total_volume"]) == (3, 7500)
    assert log["name"] == "draft-test séance"
    assert draft_id not in [
        d["id"] for d in client.get("/strength/drafts").json()["items"]
    ]
    after = client.get("/strength/stats/muscles", params={"days": 7}).json()
    assert {m["muscle"]: m["volume"] for m in after["muscles"]}["glutes"] > muscles.get(
        "glutes", 0
    )

    # A stale tab: 409, never a second log.
    again = client.post(
        f"/strength/drafts/{draft_id}/complete", json={"text": "Hip thrust 3x10@260"}
    )
    assert again.status_code == 409
    count = con.execute(
        "SELECT count(*) FROM app.visible_strength_sessions WHERE actual_session_id = ?",
        [activity],
    ).fetchone()[0]
    assert count == 1


def test_a_log_saved_meanwhile_settles_the_draft(con, client):
    today = athlete_today()
    activity = _activity(con, today)
    draft_id = open_garmin_draft(activity, today, [])
    con.execute(
        "INSERT INTO app.strength_sessions (user_id, date, name, actual_session_id)"
        " VALUES (1, ?, 'draft-test other tab', ?)",
        [today, activity],
    )

    with pytest.raises(DraftSettled):
        complete_draft(draft_id, "Hip thrust 3x10@100")
    assert client.delete(f"/strength/drafts/{draft_id}").status_code == 409
    assert (
        client.post(
            f"/strength/drafts/{draft_id + 10_000}/complete",
            json={"text": "Hip thrust 3x10@100"},
        ).status_code
        == 404
    )


def test_an_old_activity_gets_its_draft_on_demand_and_dismissal_is_reversible(
    con, client
):
    old_day = athlete_today() - timedelta(days=200)
    activity = _activity(con, old_day)

    opened = client.post("/strength/drafts", json={"actual_session_id": activity})
    assert opened.status_code == 200, opened.text
    draft = opened.json()
    assert (draft["date"], draft["origin"], draft["notation"]) == (
        old_day.isoformat(),
        "journal",
        "",
    )
    # Twice is the same draft.
    again = client.post("/strength/drafts", json={"actual_session_id": activity})
    assert again.json()["id"] == draft["id"]

    assert client.delete(f"/strength/drafts/{draft['id']}").status_code == 200
    assert draft["id"] not in [
        d["id"] for d in client.get("/strength/drafts").json()["items"]
    ]
    reopened = client.post("/strength/drafts", json={"actual_session_id": activity})
    assert reopened.json()["id"] == draft["id"]
    assert _drafts(con, activity)[0][1] == "pending"

    run = _activity(con, old_day, sport="running")
    assert (
        client.post("/strength/drafts", json={"actual_session_id": run}).status_code
        == 409
    )


def test_another_athlete_neither_sees_nor_completes_the_draft(con):
    today = athlete_today()
    activity = _activity(con, today)
    draft_id = open_garmin_draft(activity, today, [])
    con.execute("INSERT INTO app.athletes (id) VALUES (7132) ON CONFLICT DO NOTHING")

    with athlete_scope(7132):
        repo = StrengthRepository()
        assert repo.pending_drafts() == []
        assert repo.open_draft(activity, [], "journal") is None
        assert repo.dismiss_draft(draft_id) is False
        assert not repo.draft_exists(draft_id)
    assert _drafts(con, activity)[0][1] == "pending"


def test_a_concurrent_completion_writes_nothing(con):
    """Another tab's completion in flight: ours conflicts and leaves no log."""
    today = athlete_today()
    activity = _activity(con, today)
    draft_id = open_garmin_draft(activity, today, [])
    repo = StrengthRepository()
    exercise = repo.get_or_create_exercise_from_catalog("hip_thrust")
    assert exercise is not None and exercise.id is not None
    session = StrengthSession(
        name="draft-test concurrent",
        exercises=[
            SessionExercise(
                exercise_id=exercise.id,
                exercise=exercise,
                sets=[ExerciseSet(set_number=1, reps=10, weight_kg=100)],
            )
        ],
    )
    other = connect()
    other.execute("BEGIN TRANSACTION")
    # The other tab's completion claims the draft row, not yet committed.
    other.execute("DELETE FROM app.strength_drafts WHERE id = ?", [draft_id])

    assert repo.complete_draft(draft_id, session) is None
    other.execute("COMMIT")
    other.close()
    assert (
        con.execute(
            "SELECT count(*) FROM app.strength_sessions WHERE name = 'draft-test concurrent'"
        ).fetchone()[0]
        == 0
    )


def test_a_day_with_an_unlinked_log_keeps_its_draft_out_of_the_list(con, client):
    """That log is probably this session: link it rather than log it twice."""
    today = athlete_today()
    first, second = _activity(con, today), _activity(con, today)
    draft = open_garmin_draft(first, today, [])
    open_garmin_draft(second, today, [])
    listed = lambda: [d["id"] for d in client.get("/strength/drafts").json()["items"]]  # noqa: E731
    assert draft in listed()

    con.execute(
        "INSERT INTO app.strength_sessions (user_id, date, name) VALUES (1, ?, 'draft-test typed')",
        [today],
    )
    assert draft not in listed()
    # Asked for by id, it is still there.
    assert StrengthRepository().pending_drafts(draft)


def test_the_list_counts_every_draft_and_dismisses_them_all(con, client):
    today = athlete_today()
    for _ in range(3):
        open_garmin_draft(_activity(con, today - timedelta(days=1)), today, [])
    with patch("arete.api.strength.DRAFT_PAGE", 2):
        body = client.get("/strength/drafts").json()
    assert len(body["items"]) == 2
    assert body["total"] == StrengthRepository().pending_draft_count() >= 3

    dismissed = client.post("/strength/drafts/dismiss-all").json()["dismissed"]
    assert dismissed >= 3
    assert client.get("/strength/drafts").json() == {"items": [], "total": 0}


def test_garmin_names_fill_a_draft_opened_empty(con):
    """Opened from the Journal before Garmin took over a Strava copy."""
    today = athlete_today()
    activity = _activity(con, today)
    draft = open_journal_draft(activity)
    assert draft is not None and draft.exercises == []

    assert open_garmin_draft(activity, today, SUMMARIES[:1]) == draft.id
    [filled] = StrengthRepository().pending_drafts(draft.id)
    assert [e.exercise_id for e in filled.exercises] == ["bench_press"]
    # Names already there are never overwritten.
    open_garmin_draft(activity, today, SUMMARIES[1:2])
    [kept] = StrengthRepository().pending_drafts(draft.id)
    assert [e.exercise_id for e in kept.exercises] == ["bench_press"]


def test_a_concurrent_open_returns_the_draft_the_other_tab_created(con, monkeypatch):
    today = athlete_today()
    activity = _activity(con, today)
    repo = StrengthRepository()
    opened = repo._get_connection

    class OtherTabFirst:
        """Commits the same draft from another connection just before ours."""

        def __init__(self, inner):
            self._inner = inner

        def execute(self, sql, *args):
            if sql == "COMMIT":
                other = connect()
                other.execute(
                    "INSERT INTO app.strength_drafts"
                    " (actual_session_id, origin, created_at) VALUES (?, 'journal', now())",
                    [activity],
                )
                other.close()
            return self._inner.execute(sql, *args)

        def __getattr__(self, name):
            return getattr(self._inner, name)

    monkeypatch.setattr(repo, "_get_connection", lambda: OtherTabFirst(opened()))
    draft_id = repo.open_draft(activity, [], "journal")
    monkeypatch.undo()
    assert draft_id == _drafts(con, activity)[0][0]
    assert len(_drafts(con, activity)) == 1


def test_an_interrupted_completion_asks_to_retry_not_already_done(con, client):
    today = athlete_today()
    activity = _activity(con, today)
    draft_id = open_garmin_draft(activity, today, [])
    other = connect()
    other.execute("BEGIN TRANSACTION")
    other.execute("DELETE FROM app.strength_drafts WHERE id = ?", [draft_id])
    try:
        with pytest.raises(DraftBusy):
            complete_draft(draft_id, "Hip thrust 3x10@100")
    finally:
        other.execute("ROLLBACK")
        other.close()
    response = client.post(
        f"/strength/drafts/{draft_id}/complete", json={"text": "pas un exercice"}
    )
    assert response.status_code == 422
    assert response.json()["detail"].startswith("Aucun exercice reconnu")
    assert _drafts(con, activity)[0][1] == "pending"


def test_the_session_page_knows_whether_a_strength_activity_has_its_log(con, client):
    today = athlete_today()
    activity = _activity(con, today)
    url = f"/analytics/sessions/{activity}/detail"
    assert client.get(url).json()["strength_log_id"] is None
    log = con.execute(
        "INSERT INTO app.strength_sessions (user_id, date, name, actual_session_id)"
        " VALUES (1, ?, 'draft-test linked', ?) RETURNING id",
        [today, activity],
    ).fetchone()[0]
    assert client.get(url).json()["strength_log_id"] == log


@pytest.fixture
def game_db(tmp_path, monkeypatch):
    from arete.dataio.init_duckdb import main

    monkeypatch.setenv("ARETE_DB", str(tmp_path / "game.duckdb"))
    monkeypatch.setenv("GAMIFICATION_ENABLED", "true")
    main()


@pytest.mark.parametrize("projected_first", [True, False])
def test_a_completed_draft_counts_once_in_the_game(game_db, projected_first):
    """The activity's reward is never doubled nor taken back by its log."""
    from arete.garmin.models import ActualSession
    from arete.garmin.repository import GarminRepository
    from arete.services import gamification as game

    preference = game.preference()
    game.set_preference(game.Preference(enabled=True, version=preference["version"]))
    today = athlete_today()
    activity = GarminRepository().create_actual_session(
        ActualSession(date=today, sport="strength", duration_sec=3600, source="manual")
    )
    if projected_first:
        assert game.sync()["shards"] == 10
    draft = open_garmin_draft(
        activity, today, [GarminExerciseSummary("SQUAT", "BARBELL_BACK_SQUAT", 3, 15)]
    )
    assert draft is not None
    assert complete_draft(draft, "Squat arrière 3x5@100").session_id
    for _ in range(2):
        state = game.sync()
        debits = [r for r in state["history"] if r["xp"] < 0 or r["shards"] < 0]
        assert (state["sessions"], state["shards"], debits) == (1, 10, [])
