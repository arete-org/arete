"""A Garmin strength activity and its Muscu log of the same day become one session."""

from collections.abc import Generator
from datetime import date
from unittest.mock import MagicMock, patch

import pytest

from arete.dataio.db import connect
from arete.strength.models import Exercise
from arete.strength.repository import StrengthRepository

DAY = date(2024, 3, 12)
OTHER_DAY = date(2024, 3, 13)


@pytest.fixture
def con() -> Generator:
    con = connect()
    yield con
    con.execute(
        "DELETE FROM app.session_exercises WHERE exercise_id IN"
        " (SELECT id FROM app.exercises WHERE name LIKE 'garmin-link-%')"
    )
    con.execute("DELETE FROM app.exercises WHERE name LIKE 'garmin-link-%'")
    con.execute("DELETE FROM app.strength_sessions WHERE name LIKE 'garmin-link-%'")
    con.execute("DELETE FROM app.actual_sessions WHERE source = 'garmin-link-test'")
    con.close()


def _activity(con, day: date = DAY) -> int:
    return con.execute(
        "INSERT INTO app.actual_sessions (user_id, date, sport, duration_sec, source)"
        " VALUES (1, ?, 'strength', 3600, 'garmin-link-test') RETURNING id",
        [day],
    ).fetchone()[0]


def _log(con, day: date = DAY) -> int:
    return con.execute(
        "INSERT INTO app.strength_sessions (user_id, date, name, duration_min)"
        " VALUES (1, ?, 'garmin-link-log', 60) RETURNING id",
        [day],
    ).fetchone()[0]


def _linked(con, session_id: int) -> int | None:
    return con.execute(
        "SELECT actual_session_id FROM app.strength_sessions WHERE id = ?",
        [session_id],
    ).fetchone()[0]


def test_a_lone_pair_is_linked_once(con):
    activity, log = _activity(con), _log(con)
    repo = StrengthRepository()

    assert repo.link_lone_garmin_pairs([DAY]) == [(log, activity, DAY)]
    assert _linked(con, log) == activity
    # Linked pairs are no longer candidates: a re-run changes nothing.
    assert repo.link_lone_garmin_pairs([DAY]) == []
    assert _linked(con, log) == activity


def test_two_strength_activities_leave_the_day_to_the_manual_link(con):
    _first, second, log = _activity(con), _activity(con), _log(con)
    repo = StrengthRepository()

    assert repo.link_lone_garmin_pairs([DAY]) == []
    assert _linked(con, log) is None

    assert repo.link_to_actual_session(log, second)
    assert _linked(con, log) == second
    # The other activity is still unlinked, but there is no log left to give it.
    assert repo.link_lone_garmin_pairs([DAY]) == []
    assert _linked(con, log) == second


def test_two_logs_leave_the_day_unlinked(con):
    _activity(con)
    logs = [_log(con), _log(con)]

    assert StrengthRepository().link_lone_garmin_pairs([DAY]) == []
    assert [_linked(con, log) for log in logs] == [None, None]


def test_only_the_requested_days_are_linked(con):
    _activity(con, OTHER_DAY)
    other_log = _log(con, OTHER_DAY)
    activity, log = _activity(con), _log(con)
    repo = StrengthRepository()

    assert repo.link_lone_garmin_pairs([DAY]) == [(log, activity, DAY)]
    assert _linked(con, other_log) is None
    assert repo.link_lone_garmin_pairs([]) == []


def test_the_backfill_links_every_lone_pair_and_is_idempotent(con):
    pairs = [(_log(con, day), _activity(con, day), day) for day in (DAY, OTHER_DAY)]
    repo = StrengthRepository()

    linked = repo.link_lone_garmin_pairs()
    assert set(pairs) <= set(linked)
    assert repo.link_lone_garmin_pairs() == []


def test_saving_a_log_links_the_day_activity(con, client):
    activity = _activity(con)
    exercise = StrengthRepository().create_exercise(Exercise(name="garmin-link-squat"))

    response = client.post(
        "/strength/sessions",
        json={
            "date": DAY.isoformat(),
            "name": "garmin-link-api",
            "exercises": [
                {
                    "exercise_id": exercise,
                    "order": 1,
                    "sets": [{"set_number": 1, "reps": 5, "weight_kg": 80}],
                }
            ],
        },
    )
    assert response.status_code == 200, response.text
    assert _linked(con, response.json()["id"]) == activity

    listed = client.get(
        "/strength/sessions",
        params={"start_date": DAY.isoformat(), "end_date": DAY.isoformat()},
    ).json()
    assert [s["garmin_activity_id"] for s in listed] == [activity]
    assert listed[0]["exercise_names"]


def test_deleting_a_log_lets_the_remaining_one_take_the_activity(con, client):
    activity = _activity(con)
    first, second = _log(con), _log(con)
    assert StrengthRepository().link_to_actual_session(first, activity)

    assert client.delete(f"/strength/sessions/{first}").status_code == 200
    assert _linked(con, second) == activity


def test_deleting_an_activity_frees_its_log_for_the_remaining_one(con):
    from arete.garmin.repository import GarminRepository

    first, second, log = _activity(con), _activity(con), _log(con)
    assert StrengthRepository().link_to_actual_session(log, first)

    assert GarminRepository().delete_actual_session(first)
    assert _linked(con, log) == second


def test_a_manual_strength_entry_is_linked_to_the_day_log(con, client):
    log = _log(con)
    response = client.post(
        "/garmin/actual",
        json={"date": DAY.isoformat(), "sport": "strength", "duration_min": 60},
    )
    assert response.status_code == 201, response.text
    activity = response.json()["id"]
    con.execute(
        "UPDATE app.actual_sessions SET source = 'garmin-link-test' WHERE id = ?",
        [activity],
    )
    assert _linked(con, log) == activity


def test_a_failed_link_never_fails_the_save():
    from arete.strength.logging_service import link_garmin_strength

    with patch(
        "arete.strength.logging_service.StrengthRepository",
        side_effect=RuntimeError("database busy"),
    ):
        link_garmin_strength([DAY])  # logged, not raised


def _sync(raw: list[dict]):
    from arete.features.hr_zones import ZoneModel
    from arete.garmin.sync import GarminSyncClient

    repo = MagicMock()
    repo.last_garmin_import.return_value = (None, None)
    repo.has_garmin_activity.return_value = False
    repo.find_overlapping_session.return_value = None
    repo.get_potential_matches.return_value = []
    repo.create_actual_session.side_effect = range(1, len(raw) + 1)
    client = GarminSyncClient(client=MagicMock(), zones=ZoneModel.from_reference())
    client._repository = repo
    client.client.activity_page.return_value = raw
    with (
        patch("arete.garmin.sync.time.sleep"),
        patch("arete.garmin.sync.refresh_threshold", return_value={}),
    ):
        from arete.garmin.sync import GarminActivity

        return list(
            client.iter_sync_activities(
                download_fit=False,
                activity_batch=[GarminActivity.from_api_response(item) for item in raw],
            )
        )[-1]


SYNCED = [
    {
        "activityId": 901,
        "activityName": "Musculation",
        "activityType": {"typeKey": "strength_training"},
        "startTimeLocal": "2024-03-12T18:00:00",
        "duration": 3600,
    },
    {
        "activityId": 902,
        "activityName": "Course",
        "activityType": {"typeKey": "running"},
        "startTimeLocal": "2024-03-13T08:00:00",
        "duration": 1800,
    },
    # No start time: the sync dates it today, too weak to pair a log.
    {
        "activityId": 903,
        "activityName": "Musculation",
        "activityType": {"typeKey": "strength_training"},
        "duration": 3600,
    },
]


def test_a_synced_strength_activity_with_a_start_time_is_linked_to_its_day():
    with patch("arete.garmin.sync.link_garmin_strength") as link:
        result = _sync(SYNCED)

    assert result.success
    assert [c.args[0] for c in link.call_args_list] == [[DAY]]


def test_a_failed_link_never_fails_the_synced_activity():
    with patch(
        "arete.strength.logging_service.StrengthRepository",
        side_effect=RuntimeError("database busy"),
    ):
        result = _sync(SYNCED[:1])

    assert (result.success, result.activities_synced, result.errors) == (True, 1, [])
