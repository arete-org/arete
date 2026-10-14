"""The experiment is isolated from production; compare independent numeric gold."""

import importlib.util
import sys
from pathlib import Path

import pytest

EVAL = Path(__file__).parents[1] / "scripts/retrieval_eval"
sys.path.insert(0, str(EVAL))
spec = importlib.util.spec_from_file_location("session_eval", EVAL / "run.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
from engine import connection, execute, validate_sql  # noqa: E402


def test_frozen_cases_independent_oracle_and_holdout():
    cases = module.cases()
    assert len(cases) == 60
    assert sum(c["split"] == "validation" for c in cases) == 20
    for case in cases:
        module.oracle_check(case)


@pytest.mark.parametrize(
    "sql",
    [
        "SELECT * FROM read_csv('/etc/passwd')",
        "SELECT * FROM other_athlete.sessions",
        "SELECT * FROM sessions; DELETE FROM sessions",
        "ATTACH secret",
        "SELECT current_setting('home_directory')",
        "SELECT * FROM range(10000000)",
        "SELECT * FROM duckdb_tables()",
        "INSTALL httpfs",
        "SELECT 1 INTO stolen",
    ],
)
def test_query_boundary_rejects_external_relations_and_effects(sql):
    with pytest.raises(ValueError):
        validate_sql(sql)


def test_daily_observations_are_not_multiplied_by_sessions():
    case = module.cases()[3]
    with connection(case["tables"]) as con:
        daily = execute(con, "SELECT avg(hrv) AS value FROM days")["rows"][0]["value"]
        per_session = execute(con, "SELECT avg(hrv) AS value FROM sessions")["rows"][0][
            "value"
        ]
    assert daily == case["expected"]["value"]
    assert daily != per_session


def test_schema_errors_are_not_empty_successes():
    case = module.cases()[0]
    with (
        connection(case["tables"]) as con,
        pytest.raises(Exception, match="missing_metric"),
    ):
        execute(con, "SELECT sum(missing_metric) FROM sessions")


def test_numeric_answer_requires_source_support_and_no_causal_claim():
    import json

    expected = {"value": 50, "sources": ["actual:1", "actual:2"]}
    assert module.grade(json.dumps(expected), expected)["correct"]
    assert not module.grade('{"value":50,"sources":[]}', expected)["correct"]
    assert not module.grade(
        '{"value":50,"sources":["actual:1","actual:2"],"causal_claim":true}', expected
    )["correct"]


def test_snapshot_cannot_expose_another_athlete_or_excluded_source():
    import copy

    tables = copy.deepcopy(module.cases()[0]["tables"])
    original = len(tables["sessions"])
    tables["sessions"] += [
        {**tables["sessions"][0], "id": "forbidden-other", "athlete_id": 2},
        {**tables["sessions"][0], "id": "forbidden-strava", "source": "strava"},
    ]
    with connection(tables) as con:
        assert (
            execute(con, "SELECT count(*) AS n FROM sessions")["rows"][0]["n"]
            == original
        )
        assert (
            execute(con, "SELECT id FROM sessions WHERE id='forbidden-other'")["rows"]
            == []
        )


def test_grouping_uses_declared_dimensions_and_retains_source_ids():
    from engine import typed_query

    case = module.cases()[0]
    with connection(case["tables"]) as con:
        result = typed_query(
            con,
            case["tables"],
            entity="sessions",
            metric="distance_m",
            aggregate="sum",
            group_by=["sport"],
        )
    assert {r["sport"] for r in result["rows"]} == {"running", "cycling"}
    assert sum(len(r["sources"]) for r in result["rows"]) == len(
        case["tables"]["sessions"]
    )


def test_relationships_follow_only_declared_links_and_are_bounded():
    from engine import relationships

    case = module.cases()[0]
    result = relationships(case["tables"], ["actual:3"])
    assert {r["id"] for r in result["rows"]} == {
        "actual:3",
        "day:2026-09-02",
        "planned:3",
    }
    with pytest.raises(ValueError):
        relationships(case["tables"], ["other-athlete:1"])
    with pytest.raises(ValueError):
        relationships(
            case["tables"], [r["id"] for r in case["tables"]["sessions"][:21]]
        )


def test_sql_rejects_join_multiplication_and_undeclared_relationships():
    for sql in (
        "SELECT avg(d.hrv) FROM days d JOIN sessions s ON s.day_id=d.id",
        "SELECT * FROM sessions s CROSS JOIN days d",
        "SELECT * FROM sessions s JOIN plans p ON s.date=p.date",
    ):
        with pytest.raises(ValueError):
            validate_sql(sql)
    assert validate_sql(
        "SELECT s.id,d.hrv FROM sessions s JOIN days d ON s.day_id=d.id"
    )


def test_grading_rejects_undeclared_claims_and_boolean_numbers():
    import json

    expected = {"value": 1, "sources": ["actual:1"]}
    assert not module.grade(
        json.dumps({"value": True, "sources": ["actual:1"]}), expected
    )["correct"]
    assert module.grade(
        json.dumps(
            {
                **expected,
                "causal_claim": False,
                "claim": "Le sommeil cause la performance",
            }
        ),
        expected,
    )["unsupported"]


def test_report_diagnostics_do_not_promote_format_only_answers():
    import copy
    import json

    import report as reporting

    case = module.cases()[40]
    row = {
        "id": case["id"],
        "variant": "baseline",
        "split": "validation",
        "answer": json.dumps(case["expected"]) + "\nExtra prose.",
        "correct": False,
        "query_failures": 0,
    }
    raw = {"runs": [row]}
    original = copy.deepcopy(raw)
    result = reporting.diagnostics(raw)
    heldout = result["splits"]["baseline"]["validation"]
    assert heldout["strict_correct"] == 0
    assert heldout["format_only_diagnostic"] == 1
    assert raw == original


def test_report_pairs_exclude_infrastructure_and_remain_inconclusive():
    import report as reporting

    rows = []
    for case in module.cases()[40:42]:
        for variant in ("baseline", "typed"):
            rows.append(
                {
                    "id": case["id"],
                    "variant": variant,
                    "split": "validation",
                    "answer": "",
                    "correct": variant == "typed",
                    "query_failures": 0,
                }
            )
    rows[-1]["infrastructure_error"] = "OpenAIRateLimitError"
    result = reporting.diagnostics({"runs": rows})
    paired = result["observed_holdout_pairs"]["typed"]
    assert paired["paired_cases"] == 1 and paired["missing_pairs"] == 19
    assert paired["paired_delta"] == 1
    assert paired["verdict"].startswith("inconclusive")
