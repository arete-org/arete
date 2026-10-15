"""The day's decision for a planned session, read against the readiness bands."""

from __future__ import annotations

import pytest
from coach_text_checks import RAW_FIELDS

from arete.services.adaptation import (
    AdaptationInput,
    Decision,
    evaluate,
    one_recovery_per_day,
)


def _input(**overrides) -> AdaptationInput:
    values = {
        "session_type": "tempo",
        "sport": "running",
        "status": "pending",
        "target_duration_min": 45,
        "target_hr_zone": "Z4",
        "target_intensity": "hard",
        "description": "3x10' au seuil",
        "readiness": 85.0,
        "readiness_source": "garmin_training",
        "acwr": 1.0,
        "tsb": 0.0,
        "fitness_goal": "build",
    }
    values.update(overrides)
    return AdaptationInput(**values)


@pytest.mark.parametrize(
    ("score", "decision"),
    [
        (80, Decision.KEEP),
        (79, Decision.EASE),
        (60, Decision.EASE),
        (59, Decision.REPLACE_EASY),
        (40, Decision.REPLACE_EASY),
        (39, Decision.REST),
    ],
)
def test_bands_for_a_hard_session(score, decision):
    result = evaluate(_input(readiness=float(score)))
    assert result is not None and result.decision == decision


def test_an_eased_tempo_keeps_its_duration_in_z2():
    result = evaluate(_input(readiness=70.0))
    assert result is not None
    assert result.adapted == {
        "session_type": "endurance",
        "target_hr_zone": "Z2",
        "target_intensity": "easy",
        "description": "Endurance 45' Z2 (séance d'origine : 3x10' au seuil)",
    }


def test_a_replaced_session_is_30_minutes_of_z1():
    result = evaluate(_input(readiness=50.0))
    assert result is not None
    assert result.adapted["target_duration_min"] == 30
    assert result.adapted["target_hr_zone"] == "Z1"
    assert "3x10' au seuil" in result.adapted["description"]


def test_an_easy_session_is_kept_at_a_middling_readiness():
    result = evaluate(_input(session_type="endurance", readiness=70.0))
    assert result is not None and result.decision == Decision.KEEP


def test_acwr_overrides_a_high_readiness():
    result = evaluate(_input(readiness=90.0, acwr=1.6))
    assert result is not None and result.decision == Decision.REST
    assert "1.60" in result.reason


def test_deep_fatigue_or_a_recovery_goal_eases_a_tempo_at_90():
    for overrides in ({"tsb": -30.0}, {"fitness_goal": "recovery"}):
        result = evaluate(_input(readiness=90.0, **overrides))
        assert result is not None and result.decision == Decision.EASE


@pytest.mark.parametrize(
    "overrides",
    [
        {"session_type": "strength", "sport": "strength"},
        {"session_type": "hypertrophy"},
        {"status": "completed"},
        {"status": "skipped"},
        {"sport": "hiking"},
        {"readiness": None},
    ],
)
def test_out_of_scope_sessions_get_no_decision(overrides):
    assert evaluate(_input(**overrides)) is None


def test_race_day_is_kept():
    result = evaluate(_input(session_type="race", readiness=30.0, acwr=2.0))
    assert result is not None and result.decision == Decision.KEEP


def test_reasons_are_french_numbers_with_their_source():
    for score, source, said in [
        (70.0, "garmin_training", "Garmin 70/100"),
        (55.0, "garmin", "VFC, sommeil) 55/100"),
        (30.0, "model", "estimée par la charge 30/100"),
    ]:
        result = evaluate(_input(readiness=score, readiness_source=source))
        assert result is not None and said in result.reason
        assert not any(field in result.reason for field in RAW_FIELDS)


def _day(*sessions: dict, readiness: float = 49.0) -> list:
    inputs = [_input(readiness=readiness, **s) for s in sessions]
    return [(inp, evaluate(inp)) for inp in inputs]


def test_a_low_day_keeps_one_recovery_on_the_hardest_session():
    outcomes = one_recovery_per_day(
        _day(
            {"session_type": "endurance", "target_duration_min": 90},
            {"session_type": "intervals", "target_duration_min": 60},
            {"session_type": "tempo", "target_duration_min": 70},
        )
    )
    decisions = [o.decision for o in outcomes if o is not None]
    assert decisions == [Decision.REST, Decision.REPLACE_EASY, Decision.REST]
    assert "fractionné 60 min" in outcomes[0].reason  # names where it went
    assert outcomes[0].adapted == {}


def test_same_type_sessions_give_the_recovery_to_the_longest():
    outcomes = one_recovery_per_day(
        _day(
            {"session_type": "endurance", "target_duration_min": 45},
            {"session_type": "endurance", "target_duration_min": 60},
        )
    )
    assert [o.decision for o in outcomes if o is not None] == [
        Decision.REST,
        Decision.REPLACE_EASY,
    ]


@pytest.mark.parametrize(
    "sessions",
    [
        # Nothing to choose from, or no unambiguous key: per-session outcomes.
        ({"session_type": "tempo"},),
        ({"session_type": "tempo"}, {"session_type": "tempo"}),
        (
            {"session_type": "tempo"},
            {"session_type": "endurance"},
            {"session_type": "race"},
        ),
    ],
)
def test_without_an_unambiguous_key_the_outcomes_stand(sessions):
    day = _day(*sessions)
    assert one_recovery_per_day(day) == [outcome for _, outcome in day]


def test_a_rest_day_rests_every_session():
    outcomes = one_recovery_per_day(
        _day({"session_type": "intervals"}, {"session_type": "endurance"}, readiness=30)
    )
    assert {o.decision for o in outcomes if o is not None} == {Decision.REST}


# The morning check-in weighs one band, downwards only (ARE-59).
@pytest.mark.parametrize(
    ("score", "answers", "decision", "said"),
    [
        (85, {"legs": 2}, Decision.EASE, "jambes lourdes déclarées"),
        (65, {"sleep": 1}, Decision.REPLACE_EASY, "nuit difficile déclarée"),
        (45, {"legs": 2, "sleep": 3}, Decision.REST, "jambes lourdes déclarées"),
        # Two low answers are still one band: keep becomes ease, not recovery.
        (
            85,
            {"legs": 1, "sleep": 2},
            Decision.EASE,
            "nuit difficile et jambes lourdes déclarées",
        ),
        # Already the lowest band: rest stays rest.
        (30, {"legs": 1}, Decision.REST, "jambes lourdes déclarées"),
    ],
)
def test_a_low_check_in_lowers_the_readiness_by_one_band(
    score, answers, decision, said
):
    result = evaluate(_input(readiness=float(score), **answers))
    assert result is not None and result.decision == decision
    assert said in result.reason
    assert f"Garmin {score}/100, {said} :" in result.reason
    assert not any(field in result.reason for field in RAW_FIELDS)


@pytest.mark.parametrize("score", [85, 70, 50, 30])
@pytest.mark.parametrize(
    "answers", [{}, {"sleep": 5, "legs": 5}, {"sleep": 3, "legs": 3}]
)
def test_a_good_or_missing_check_in_changes_nothing(score, answers):
    alone = evaluate(_input(readiness=float(score)))
    assert evaluate(_input(readiness=float(score), **answers)) == alone


def test_a_check_in_without_a_readiness_decides_nothing():
    assert evaluate(_input(readiness=None, sleep=1, legs=1)) is None


def test_the_day_s_rest_names_the_declared_check_in():
    outcomes = one_recovery_per_day(
        _day(
            {"session_type": "intervals", "legs": 2},
            {"session_type": "endurance", "target_duration_min": 90, "legs": 2},
            readiness=65,
        )
    )
    assert [o.decision for o in outcomes if o is not None] == [
        Decision.REPLACE_EASY,
        Decision.REST,
    ]
    assert "jambes lourdes déclarées : repos" in outcomes[1].reason
