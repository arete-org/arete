"""Production typed retrieval: real scoped storage, no model/provider I/O."""

import json
from datetime import date

import pytest
from pydantic import ValidationError

from arete.dataio.db import db_connection
from arete.dataio.init_duckdb import main as init_schema
from arete.services.athlete_scope import athlete_scope
from arete.services.training_query import TrainingQuery, query_training
from arete.services.users import upsert_user


@pytest.fixture(autouse=True)
def evidence(tmp_path, monkeypatch):
    monkeypatch.setenv("ARETE_DB", str(tmp_path / "query.duckdb"))
    monkeypatch.setenv("ARETE_OWNER_EMAIL", "first@example.com")
    init_schema()
    upsert_user("first", "first@example.com", "First", verified=True)
    second = upsert_user("second", "second@example.com", "Second", verified=True)
    with db_connection() as con:
        con.execute("""
            INSERT INTO app.actual_sessions
                (id,user_id,date,sport,name,duration_sec,distance_m,avg_hr,source,start_time)
            VALUES
                (101,1,'2026-09-01','running','Matin',1800,5000,140,'garmin_connect','2026-08-31 22:30:00'),
                (102,1,'2026-09-01','trail_running','Soir',3600,10000,160,'garmin_connect',NULL),
                (103,1,'2026-09-02','running','Inconnu',1800,NULL,NULL,'manual',NULL),
                (104,1,'2026-09-02','running','Exclu',99999,99999,199,'strava',NULL);
            INSERT INTO app.daily_metrics (user_id,date,sleep_duration_sec,hrv_last_night)
                VALUES (1,'2026-09-01',18000,30), (1,'2026-09-02',36000,NULL);
            INSERT INTO app.activity_terrain (actual_session_id,model_version,gap_sec_km)
                VALUES (101,1,300);
            INSERT INTO app.activity_weather (actual_session_id,observed_at,temperature_c,source)
                VALUES (101,'2026-09-01',25,'open-meteo-archive');
            INSERT INTO app.session_feedback (actual_session_id,text,source,trigger)
                VALUES (101,'Interprétation','agent','sync');
            INSERT INTO app.planned_sessions (id,user_id,date,sport,session_type,status)
                VALUES (201,1,'2026-09-01','running','endurance','completed'),
                       (202,1,'2026-09-02','running','endurance','completed'),
                       (203,1,'2026-09-03','running','endurance','pending');
            UPDATE app.actual_sessions SET planned_session_id=201 WHERE id IN (101,102);
            UPDATE app.actual_sessions SET planned_session_id=202 WHERE id=104;
            INSERT INTO app.strength_sessions (id,user_id,date,name)
                VALUES (301,1,'2026-09-01','Force'),(302,1,'2026-09-02','Charge inconnue');
            INSERT INTO app.session_exercises (id,session_id,exercise_id)
                VALUES (401,301,1),(402,302,1);
            INSERT INTO app.exercise_sets
                (id,session_exercise_id,set_number,reps,weight_kg,is_warmup)
                VALUES (501,401,1,10,20,false), (502,401,2,5,40,false),
                       (503,401,3,10,100,true), (504,402,1,10,NULL,false);
        """)
    with athlete_scope(second.athlete_id), db_connection() as con:
        con.execute("""
            INSERT INTO app.actual_sessions (id,user_id,date,duration_sec,distance_m,source)
                VALUES (105,getvariable('arete_athlete_id'),'2026-09-01',99999,99999,'garmin_connect');
            INSERT INTO app.daily_metrics (user_id,date,sleep_duration_sec)
                VALUES (getvariable('arete_athlete_id'),'2026-09-01',99999);
        """)
    return second


def query(entity="sessions", **kwargs):
    return query_training(
        TrainingQuery.model_validate(
            {
                "entity": entity,
                "start_date": "2026-09-01",
                "end_date": "2026-09-30",
                **kwargs,
            }
        )
    )


def test_daily_grain_and_missing_values():
    sleep = query("days", metric="sleep_duration_sec")["rows"][0]
    assert sleep["value"] == 27000  # Two nights, not three sessions.
    assert sleep["source_ids"] == ["day:2026-09-01", "day:2026-09-02"]
    hrv = query("days", metric="hrv_last_night")["rows"][0]
    assert (hrv["value"], hrv["known"], hrv["missing"]) == (30, 1, 1)
    with pytest.raises(ValueError, match="once per day"):
        query(metric="sleep_duration_sec")


def test_session_filters_use_local_date_and_day_context_without_multiplication():
    result = query(
        metric="distance_m",
        aggregate="sum",
        filters=[
            {"field": "sport", "value": "running"},
            {"field": "sleep_duration_sec", "op": "lt", "value": 21600},
        ],
    )
    assert result["rows"][0]["value"] == 15000
    assert result["rows"][0]["source_ids"] == ["actual:101", "actual:102"]
    assert result["coverage"]["first_date"] == "2026-09-01"
    assert result["units"]["value"] == "m"
    assert result["coverage"]["days_with_data"] == 1


def test_source_exclusion_and_cross_athlete_isolation(evidence):
    assert query(metric="id", aggregate="count")["rows"][0]["value"] == 3
    with athlete_scope(evidence.athlete_id):
        result = query(metric="distance_m", aggregate="sum")["rows"][0]
        assert result["source_ids"] == ["actual:105"]
        assert result["value"] == 99999
    with db_connection() as con:
        con.execute("UPDATE app.actual_sessions SET deleted_at=now() WHERE id=101")
    assert query(metric="id", aggregate="count")["rows"][0]["value"] == 2


def test_daily_source_exclusions_also_apply_to_session_context():
    with db_connection() as con:
        con.execute(
            "UPDATE app.daily_metrics SET source='strava' WHERE user_id=1 AND date='2026-09-01'"
        )
    result = query(fields=["sleep_duration_sec"])
    assert result["rows"][0]["sleep_duration_sec"] is None
    assert query("days", metric="sleep_duration_sec")["rows"][0]["value"] == 36000


def test_enrichment_and_feedback_stay_at_session_grain():
    result = query(fields=["gap_sec_km", "temperature_c", "has_feedback"])
    assert result["rows"][0] == {
        "id": 101,
        "date": date(2026, 9, 1),
        "gap_sec_km": 300,
        "temperature_c": 25,
        "has_feedback": 1,
        "source_id": "actual:101",
    }
    assert query(metric="has_feedback", aggregate="sum")["rows"][0]["value"] == 1
    assert "interpretation" in result["semantics"]


def test_adherence_uses_links_once_and_excludes_strava_links():
    result = query("plans", metric="completed")["rows"][0]
    assert result["value"] == pytest.approx(1 / 3)
    assert result["source_ids"] == ["planned:201", "planned:202", "planned:203"]


def test_strength_working_volume_and_missing_weight():
    result = query("strength", metric="volume_kg", aggregate="sum")["rows"][0]
    assert (result["value"], result["known"], result["missing"]) == (400, 1, 1)
    result = query(
        "strength", filters=[{"field": "volume_kg", "op": "gte", "value": 400}]
    )
    assert [r["source_id"] for r in result["rows"]] == ["strength:301"]


def test_strength_link_to_excluded_activity_does_not_leak():
    with db_connection() as con:
        con.execute(
            "UPDATE app.strength_sessions SET actual_session_id=104 WHERE id=301"
        )
    assert [r["id"] for r in query("strength")["rows"]] == [302]


def test_period_comparison_and_weekly_trend():
    first = query(metric="duration_sec", aggregate="sum", end_date="2026-09-01")
    second = query(metric="duration_sec", aggregate="sum", start_date="2026-09-02")
    assert first["rows"][0]["value"] == 5400
    assert second["rows"][0]["value"] == 1800
    trend = query(metric="duration_sec", aggregate="sum", group_by="week")
    assert trend["rows"][0]["group"] == "2026-08-31"
    assert trend["rows"][0]["value"] == 7200


def test_empty_and_all_unknown_are_not_zero_measurements():
    assert (
        query(metric="distance_m", aggregate="sum", start_date="2026-09-02")["rows"][0][
            "value"
        ]
        is None
    )
    assert (
        query(metric="distance_m", aggregate="sum", start_date="2026-09-03")["rows"][0][
            "value"
        ]
        is None
    )
    assert (
        query(metric="id", aggregate="count", start_date="2026-09-03")["rows"][0][
            "value"
        ]
        == 0
    )


def test_paging_and_hard_bounds_are_explicit(monkeypatch):
    result = query(limit=2)
    assert result["limits"]["has_more"] is True
    assert result["limits"]["next_offset"] == 2
    assert [r["id"] for r in query(limit=2, offset=2)["rows"]] == [103]
    with pytest.raises(ValueError, match="Group limit"):
        query(metric="duration_sec", group_by="day", limit=1)
    monkeypatch.setattr("arete.services.training_query.MAX_OBSERVATIONS", 2)
    with pytest.raises(ValueError, match="Observation limit"):
        query(metric="distance_m", aggregate="sum")


def test_set_bound_is_not_silently_truncated(monkeypatch):
    monkeypatch.setattr("arete.services.training_query.MAX_SETS", 1)
    with pytest.raises(ValueError, match="Set limit"):
        query("strength", metric="volume_kg")


@pytest.mark.parametrize(
    "kwargs",
    [
        {"start_date": "2025-01-01"},
        {"start_date": "2026-10-01"},
        {"metric": "distance_m; DROP TABLE app.actual_sessions"},
        {"entity": "days", "metric": "distance_m"},
        {"metric": "sport", "aggregate": "sum"},
        {"metric": "distance_m", "offset": 1},
        {"filters": [{"field": "distance_m", "value": "NaN"}]},
        {"filters": [{"field": "distance_m", "value": float("nan")}]},
        {"filters": [{"field": "distance_m", "op": "contains", "value": 3}]},
        {"filters": [{"field": "name", "op": "missing", "value": "x"}]},
    ],
)
def test_invalid_queries_are_rejected(kwargs):
    with pytest.raises((ValueError, ValidationError)):
        query(**kwargs)


def test_text_is_bound_as_data_not_sql():
    result = query(filters=[{"field": "name", "value": "' OR 1=1 --"}])
    assert result["rows"] == []
    assert query(metric="id", aggregate="count")["rows"][0]["value"] == 3


def test_native_tool_validation_and_registration():
    from arete.agent.capabilities.registry import CAPABILITIES
    from arete.agent.tools.analytics import query_training as tool

    request = {
        "entity": "sessions",
        "start_date": "2026-09-01",
        "end_date": "2026-09-30",
        "metric": "distance_m",
        "aggregate": "sum",
    }
    result = json.loads(tool.invoke({"request": request}))
    assert result["rows"][0]["value"] == 15000
    assert "query_training" in CAPABILITIES["analytics"].read_tools
    request["sql"] = "SELECT * FROM app.actual_sessions"
    assert "error" in json.loads(tool.invoke({"request": request}))


def test_pending_feedback_catches_old_activity_imports_without_cross_athlete_leaks(
    evidence,
):
    from arete.services.coaching_repository import SessionFeedbackRepository

    repo = SessionFeedbackRepository()
    # 101 already has feedback; 103 is manual; 104 is model-excluded.
    assert repo.pending_garmin() == ([102], 1)
    with db_connection() as con:
        con.execute("UPDATE app.actual_sessions SET date='2020-01-01' WHERE id=102")
    assert repo.pending_garmin() == ([102], 1)
    with athlete_scope(evidence.athlete_id):
        assert repo.pending_garmin() == ([105], 1)
    repo.save(102, text="Fait", source="rules", trigger="sync")
    assert repo.pending_garmin() == ([], 0)


def test_pending_feedback_reports_backlog_beyond_its_bound():
    from arete.services.coaching_repository import SessionFeedbackRepository

    with db_connection() as con:
        con.execute("""
            INSERT INTO app.actual_sessions (id,user_id,date,duration_sec,source)
            SELECT 1000+i,1,'2020-01-01',3600,'garmin_connect' FROM range(25) t(i)
        """)
    ids, count = SessionFeedbackRepository().pending_garmin()
    assert len(ids) == 20
    assert count == 26
    with db_connection() as con:
        con.execute(
            "UPDATE app.actual_sessions SET created_at=current_timestamp - INTERVAL '31 days' WHERE id>=1000"
        )
    assert SessionFeedbackRepository().pending_garmin() == ([102], 1)
