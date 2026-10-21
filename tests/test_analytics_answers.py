"""The four answers of the Analyses page, and the records read from Garmin data."""

from __future__ import annotations

from datetime import date, datetime, timedelta

import pytest

from arete.dataio.db import db_connection
from arete.dataio.queries import LiftSetRow, LiftSets, OverviewRow
from arete.features import answers, records
from arete.features.periods import resolve_period
from arete.garmin.models import ActivitySource, ActualSession
from arete.garmin.repository import GarminRepository
from arete.garmin.streams import ActivityStreams
from arete.services import analytics
from arete.services.athlete_scope import athlete_scope
from arete.strength.models import (
    Exercise,
    ExerciseCategory,
    ExerciseSet,
    MuscleGroup,
    SessionExercise,
    StrengthSession,
)
from arete.strength.repository import StrengthRepository

TODAY = date(2031, 3, 31)
MONTH = resolve_period("30d", TODAY)


def names_period_and_source(answer: answers.Answer) -> None:
    """The sentence itself says what it reads and where its numbers come from."""
    text = answer["text"].casefold()
    assert answer["period"] and answer["period"].casefold() in text, answer
    assert answer["source"] and f"d’après {answer['source']}".casefold() in text, answer
    assert answer["question"] == answers.QUESTIONS[answer["id"]]


# --------------------------------------------------------------------------- #
# Suis-je prêt ?
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    "score, source, measured_on, tsb, tone",
    [
        (82, "garmin_training", TODAY, 4.0, "good"),
        (58, "garmin", TODAY - timedelta(days=1), -3.0, "warn"),
        (30, "garmin", TODAY, 12.0, "bad"),
        (None, None, None, -28.0, "bad"),
        (None, None, None, 15.0, "good"),
        (61, "model", None, 0.0, "neutral"),  # the model readiness is not quoted
        (None, None, None, None, "neutral"),
    ],
)
def test_ready_names_today_and_its_source(score, source, measured_on, tsb, tone):
    answer = answers.ready_answer(TODAY, score, source, measured_on, tsb)
    names_period_and_source(answer)
    assert answer["period"] == "aujourd’hui"
    assert answer["tone"] == tone


def test_ready_quotes_a_garmin_readiness_and_its_night():
    answer = answers.ready_answer(TODAY, 58, "garmin", TODAY - timedelta(days=1), -3.0)
    assert "préparation à 58/100 (nuit d’hier)" in answer["text"]
    assert "fraîcheur à -3 (neutre)" in answer["text"]
    assert answer["source"] == "tes nuits Garmin et tes séances"
    model = answers.ready_answer(TODAY, 61, "model", None, 0.0)
    assert "préparation" not in model["text"] and model["source"] == "tes séances"


# --------------------------------------------------------------------------- #
# Est-ce que je progresse ?
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    "ctl_start, ctl_end, slope, lift, tone, source",
    [
        (38.0, 44.0, -4.0, None, "good", "tes séances et tes courses"),
        (44.0, 38.0, 5.0, None, "warn", "tes séances et tes courses"),
        (40.0, 40.5, 1.0, None, "neutral", "tes séances et tes courses"),
        (
            20.0,
            21.0,
            None,
            ("Squat", 100.0, 105.0),
            "good",
            "tes séances et ton journal de force",
        ),
        (30.0, 36.0, None, None, "good", "tes séances"),
        (None, None, None, None, "neutral", "tes séances"),
    ],
)
def test_progress_names_the_window_and_its_source(
    ctl_start, ctl_end, slope, lift, tone, source
):
    answer = answers.progress_answer(MONTH, ctl_start, ctl_end, slope, lift)
    names_period_and_source(answer)
    assert answer["period"] == "sur les 30 derniers jours"
    assert (answer["tone"], answer["source"]) == (tone, source)


def test_progress_never_prints_a_signed_zero():
    text = answers.progress_answer(MONTH, 40.2, 39.9, 1.0)["text"]
    assert "ta forme de fond reste à 40" in text and "(+0)" not in text
    assert answers.fr(-0.04, 1, sign=True) == "0,0"
    assert answers.fr(-0.4) == "0" and answers.fr(0.6, sign=True) == "+1"


def test_progress_needs_more_than_rounding_on_a_lift():
    flat = answers.progress_answer(MONTH, 20.0, 20.5, None, ("Squat", 100.0, 100.05))
    assert flat["tone"] == "neutral"


def test_progress_reads_the_forme_de_fond_and_the_trend():
    text = answers.progress_answer(MONTH, 38.0, 44.0, -4.0)["text"]
    assert text == (
        "Sur les 30 derniers jours, ta forme de fond passe de 38 à 44 (+6) et ton "
        "allure gagne 4 s/km par mois : tu progresses, d’après tes séances et tes courses."
    )


@pytest.mark.parametrize(
    "period, phrase",
    [
        ("7d", "sur les 7 derniers jours"),
        ("90d", "sur les 90 derniers jours"),
        ("6m", "sur les 6 derniers mois"),
        ("1y", "sur les 12 derniers mois"),
        ("all", "depuis ta première séance"),
    ],
)
def test_every_period_is_named(period, phrase):
    window = resolve_period(period, TODAY, TODAY - timedelta(days=900))
    answer = answers.progress_answer(window, 10.0, 12.0, None)
    assert answer["period"] == phrase
    names_period_and_source(answer)


# --------------------------------------------------------------------------- #
# Où est le risque ?
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    "acwr, monotony, ramp, tone, words",
    [
        (1.62, 1.2, 3.0, "bad", "risque de blessure"),
        (1.1, 1.2, 9.5, "warn", "monte trop vite"),
        (1.38, 1.2, 3.0, "warn", "ta charge monte vite : n’en rajoute pas"),
        (1.0, 2.4, 1.0, "warn", "trop monotone"),
        (1.05, 1.2, 2.0, "good", "aucun signal"),
        (None, None, None, "neutral", "aucune charge"),
    ],
)
def test_risk_names_the_week_and_its_source(acwr, monotony, ramp, tone, words):
    answer = answers.risk_answer(acwr, monotony, ramp)
    names_period_and_source(answer)
    assert answer["period"] == "sur les 7 derniers jours"
    assert answer["tone"] == tone and words in answer["text"]


def test_risk_quotes_its_three_numbers_in_french():
    text = answers.risk_answer(1.05, 1.2, 2.0)["text"]
    assert "(ACWR 1,05, monotonie 1,2, forme de fond +2,0 en 7 jours)" in text


def test_the_risk_card_carries_the_three_numbers():
    card = answers.risk_card(1.38, 2.4, 4.25)
    assert card["headline"]["display"] == "1,38"
    assert [h["display"] for h in card["secondary"]] == ["2,4", "+4,2 pts"]
    assert "monotonie au-delà de 2,0" in card["insight"]["text"]
    empty = answers.risk_card(None, None, None)
    assert empty["headline"]["display"] == "—"


# --------------------------------------------------------------------------- #
# Qu'est-ce qui marche ?
# --------------------------------------------------------------------------- #
def _weeks(pattern: list[tuple[int, float]]) -> list[answers.Week]:
    return [
        {"end": TODAY - timedelta(days=7 * i), "active_days": d, "ctl_gain": g}
        for i, (d, g) in enumerate(reversed(pattern))
    ]


def test_works_describes_the_weeks_that_went_with_a_gain():
    weeks = _weeks([(5, 3.0), (2, -1.0), (4, 2.0), (1, -2.0), (5, 2.5), (2, 0.0)])
    answer = answers.works_answer("sur les 12 dernières semaines", weeks)
    names_period_and_source(answer)
    # A description, not a verdict: the forme de fond follows the load.
    assert answer["tone"] == "neutral"
    assert "paie" not in answer["text"]
    assert (
        "tes 3 semaines à 4 jours d’entraînement ou plus ont vu ta forme de fond "
        "monter de +2,5 en moyenne, contre -1,0 pour tes 3 semaines à moins de 4 jours"
    ) in answer["text"]


def test_works_says_when_the_weeks_moved_alike():
    weeks = _weeks([(5, 0.5), (2, 1.0), (4, 0.2), (1, 1.2)])
    answer = answers.works_answer("sur les 12 dernières semaines", weeks)
    names_period_and_source(answer)
    assert answer["tone"] == "neutral" and "de la même façon" in answer["text"]


def test_works_leaves_out_the_weeks_without_a_session():
    # Two weeks off (illness, holiday) would form the "fewer days" group alone.
    weeks = _weeks([(4, 1.0), (0, -6.0), (4, 1.2), (0, -5.0), (4, 0.8)])
    answer = answers.works_answer("sur les 12 dernières semaines", weeks)
    assert "pas encore assez de semaines" in answer["text"]
    card = answers.weeks_card("sur les 12 dernières semaines", weeks)
    assert card["headline"]["display"] == "3 semaines"
    assert card["series"] == [{"bucket": "4", "days": 4, "weeks": 3, "ctl_gain": 1.0}]
    assert "ne prouve pas" in card["insight"]["text"]


def test_works_needs_comparable_weeks():
    answer = answers.works_answer(
        "sur les 12 dernières semaines", _weeks([(3, 1.0)] * 6)
    )
    names_period_and_source(answer)
    assert "pas encore assez de semaines" in answer["text"]


@pytest.mark.parametrize(
    "period, phrase, count",
    [
        ("30d", "sur les 12 dernières semaines", 12),
        ("90d", "sur les 12 dernières semaines", 12),  # 84 days, not 90
        ("6m", "sur les 25 dernières semaines", 25),
        ("1y", "sur les 52 dernières semaines", 52),
    ],
)
def test_weeks_name_the_weeks_they_read(period, phrase, count):
    ctl = {TODAY - timedelta(days=i): 40.0 - i * 0.1 for i in range(400)}
    active = {TODAY - timedelta(days=i) for i in range(0, 400, 2)}
    found, weeks = answers.weeks_of(resolve_period(period, TODAY), active, ctl)
    assert found == phrase and len(weeks) == count
    assert weeks[-1]["end"] == TODAY and weeks[-1]["ctl_gain"] == pytest.approx(0.7)
    assert {w["active_days"] for w in weeks} <= {3, 4}


# --------------------------------------------------------------------------- #
# The overview carries the four answers first
# --------------------------------------------------------------------------- #
def _overview(router_client, period: str, rows: list, **stubs) -> dict:
    from unittest.mock import patch

    from arete.api.analytics import router

    today = analytics.athlete_today()
    targets = {
        "overview_rows": rows,
        "drift_rows": [],
        "daily_metrics_range": [],
        "earliest_session_date": today - timedelta(days=120) if rows else None,
        "terrain_rows": [],
        "fetch_window": [],
        "stream_effort_rows": [],
        "lift_set_rows": LiftSets([], 0, None),
    } | stubs
    patches = [
        patch(f"arete.services.analytics.{name}", return_value=value)
        for name, value in targets.items()
    ]
    for p in patches:
        p.start()
    try:
        with patch("arete.services.analytics.db_connection"):
            return (
                router_client(router).get(f"/analytics/overview?period={period}").json()
            )
    finally:
        for p in patches:
            p.stop()


def _every_other_day_runs(days: int = 120) -> list[OverviewRow]:
    today = analytics.athlete_today()
    return [
        OverviewRow(
            today - timedelta(days=i),
            "running",
            3600,
            10000.0,
            None,
            300,
            150,
            6,
            None,
            None,
            60.0,
        )
        for i in range(0, days, 2)
    ]


def test_the_overview_opens_on_the_four_answers(router_client):
    data = _overview(router_client, "30d", _every_other_day_runs())
    assert [a["id"] for a in data["answers"]] == ["ready", "progress", "risk", "works"]
    for answer in data["answers"]:
        names_period_and_source(answer)
    assert data["records"] == {
        "runs": [],
        "lifts": [],
        "runs_scanned": 0,
        "runs_limit": records.RECORD_RUNS,
        "sessions_scanned": 0,
        "sessions_limit": records.RECORD_STRENGTH_SESSIONS,
    }
    # The cards behind the risk and week-pattern answers carry their numbers.
    risk = data["cards"]["risk"]
    assert risk["headline"]["value"] is not None
    assert [h["value"] is not None for h in risk["secondary"]] == [True, True]
    assert data["cards"]["weeks"]["series"]


def test_a_new_athlete_is_not_told_they_are_neutral(router_client):
    ready = _overview(router_client, "30d", [])["answers"][0]
    names_period_and_source(ready)
    assert "ni séance ni nuit mesurée" in ready["text"]
    assert "fraîcheur" not in ready["text"] and ready["tone"] == "neutral"


def test_progress_is_not_judged_on_one_week(router_client):
    data = _overview(router_client, "7d", _every_other_day_runs())
    progress = data["answers"][1]
    names_period_and_source(progress)
    assert progress["period"] == "sur les 30 derniers jours"
    # The other answers keep their own periods.
    assert data["answers"][2]["period"] == "sur les 7 derniers jours"


def test_a_lift_trend_is_not_read_from_a_cut_previous_window():
    year = resolve_period("1y", TODAY)
    rows = [
        LiftSetRow(1, "Squat", 1, year.prev_start + timedelta(days=200), 5, 100.0),
        LiftSetRow(1, "Squat", 2, year.end - timedelta(days=10), 5, 110.0),
    ]
    assert records.lift_trend(LiftSets(rows, 2, None), year) == (
        "Squat",
        116.7,
        128.3,
    )
    cut = LiftSets(rows, 100, year.prev_start + timedelta(days=150))
    assert records.lift_trend(cut, year) is None


# --------------------------------------------------------------------------- #
# Records from a Garmin-only database
# --------------------------------------------------------------------------- #
ATHLETE = 8139


def _steady(seconds: int, mps: float, jump_at: int | None = None) -> ActivityStreams:
    distance, total = [], 0.0
    for i in range(seconds):
        total += mps if i else 0.0
        if i == jump_at:
            total += 1500.0  # a GPS jump: never a record
        distance.append(round(total, 1))
    return ActivityStreams(t=list(range(seconds)), distance_m=distance)


@pytest.fixture
def garmin_athlete():
    """An athlete whose only data is Garmin runs with streams and logged lifts."""
    with db_connection() as con:
        con.execute(
            "INSERT INTO app.athletes(id) VALUES (?) ON CONFLICT DO NOTHING", [ATHLETE]
        )
    with athlete_scope(ATHLETE):
        with db_connection() as con:
            con.execute(
                "INSERT INTO app.game_profile(id, athlete_id) VALUES (1, ?) "
                "ON CONFLICT DO NOTHING",
                [ATHLETE],
            )
        yield
    with db_connection() as con:
        for table in (
            "exercise_sets",
            "session_exercises",
            "exercises",
            "activity_streams",
            "game_events",
            "game_profile",
        ):
            con.execute(f"DELETE FROM app.{table} WHERE athlete_id = ?", [ATHLETE])
        for table in ("strength_sessions", "actual_sessions"):
            con.execute(f"DELETE FROM app.{table} WHERE user_id = ?", [ATHLETE])


def _run(
    day: date, streams: ActivityStreams, sport: str = "running", name: str = "Footing"
) -> int:
    repo = GarminRepository()
    distance = streams.distance_m[-1] if streams.distance_m else 0.0
    session_id = repo.create_actual_session(
        ActualSession(
            date=day,
            sport=sport,
            name=name,
            duration_sec=len(streams),
            distance_m=distance,
            source=ActivitySource.GARMIN_CONNECT,
            start_time=datetime(day.year, day.month, day.day, 7, 0),
        )
    )
    repo.save_activity_streams(session_id, streams)
    return session_id


def _lift(day: date, exercise_id: int, sets: list[tuple[int, float]]) -> int:
    return StrengthRepository().create_session(
        StrengthSession(
            date=day,
            name="Force",
            exercises=[
                SessionExercise(
                    exercise_id=exercise_id,
                    sets=[
                        ExerciseSet(set_number=i + 1, reps=reps, weight_kg=kg)
                        for i, (reps, kg) in enumerate(sets)
                    ]
                    + [
                        ExerciseSet(
                            set_number=9, reps=10, weight_kg=200.0, is_warmup=True
                        )
                    ],
                )
            ],
        )
    )


def test_records_populate_from_garmin_streams_and_lifts(garmin_athlete):
    today = analytics.athlete_today()
    slow = _run(today - timedelta(days=20), _steady(1900, 3.0), name="Footing lent")
    fast = _run(today - timedelta(days=10), _steady(3100, 3.5), name="Tempo")
    _run(today - timedelta(days=5), _steady(1200, 3.0, jump_at=300), name="GPS fou")
    _run(today - timedelta(days=3), _steady(3600, 8.0), sport="cycling", name="Vélo")
    squat = StrengthRepository().create_exercise(
        Exercise(
            name="Squat",
            category=ExerciseCategory.SQUAT,
            primary_muscle=MuscleGroup.QUADS,
        )
    )
    first = _lift(today - timedelta(days=12), squat, [(5, 100.0), (5, 100.0)])
    _lift(today - timedelta(days=4), squat, [(3, 100.0)])  # a lower e1RM

    overview = analytics.get_overview("30d")

    found = overview["records"]
    assert found["runs_scanned"] == 3  # the ride is not a run
    by_name = {r["name"]: r for r in found["runs"]}
    assert list(by_name) == ["1 km", "5 km", "10 km"]
    # 1000 m at 3.5 m/s needs 286 samples; the GPS jump counts for nothing.
    assert by_name["1 km"]["time_sec"] == 286
    assert by_name["1 km"]["session_id"] == fast
    assert by_name["1 km"]["session_name"] == "Tempo"
    assert by_name["5 km"]["time_display"] == "23:49"
    assert by_name["10 km"]["pace_display"] == "4:46 /km"
    assert slow not in {r["session_id"] for r in found["runs"]}
    (lift,) = found["lifts"]
    assert lift["exercise"] == "Squat" and lift["sessions"] == 2
    assert (lift["e1rm_kg"], lift["weight_kg"], lift["reps"]) == (116.7, 100.0, 5)
    assert lift["session_id"] == first


def test_records_read_only_the_latest_runs(garmin_athlete, monkeypatch):
    today = analytics.athlete_today()
    _run(today - timedelta(days=30), _steady(1200, 5.0), name="Vieille piste")
    recent = _run(today - timedelta(days=2), _steady(1200, 3.0), name="Récente")
    monkeypatch.setattr(records, "RECORD_RUNS", 1)
    found = analytics.get_overview("7d")["records"]
    assert found["runs_scanned"] == 1 and found["runs_limit"] == 1
    assert [r["session_id"] for r in found["runs"]] == [recent]


def _segments(*parts: tuple[int, float]) -> ActivityStreams:
    """Consecutive (seconds, metres per second) segments of one recording."""
    distance, total = [0.0], 0.0
    for seconds, mps in parts:
        for _ in range(seconds):
            total += mps
            distance.append(round(total, 1))
    return ActivityStreams(t=list(range(len(distance))), distance_m=distance)


def test_a_car_ride_with_the_watch_on_holds_no_record(garmin_athlete):
    # 30 min of running at 3 m/s, then 15 min in a car at 12 m/s: capping the
    # car at 6.5 m/s would give 1 km in 2:34 and 5 km in 12:50.
    _run(analytics.athlete_today(), _segments((1800, 3.0), (900, 12.0)))
    with db_connection() as con:
        from arete.dataio.queries import stream_effort_rows

        (row,) = stream_effort_rows(con, 10)
    assert row.best_sec == (334, 1667, None, None, None)


def test_a_burst_of_gps_jumps_holds_no_record(garmin_athlete):
    # Twenty samples 30 m apart in the middle of an easy run.
    _run(analytics.athlete_today(), _segments((300, 3.0), (20, 30.0), (900, 3.0)))
    with db_connection() as con:
        from arete.dataio.queries import stream_effort_rows

        (row,) = stream_effort_rows(con, 10)
    # 1 km at 3 m/s, plus the 20 s of the burst inside the best window at most.
    assert row.best_sec[0] == 334


def test_a_shorter_run_holds_no_longer_record(garmin_athlete):
    with db_connection() as con:
        from arete.dataio.queries import stream_effort_rows

        _run(analytics.athlete_today(), _steady(400, 3.0))
        (row,) = stream_effort_rows(con, 10)
    assert row.best_sec == (334, None, None, None, None)
