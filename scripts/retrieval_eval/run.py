"""Frozen session experiment. Offline oracle checks by default; --live is opt-in.

SQL runs only in a disposable network-disabled container. Production has no new
query tools. Baseline calls the existing analytics tools against a synthetic DB.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import random
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from statistics import mean, median
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).parent))
from engine import (  # noqa: E402
    connection,
    relationships,
    scoped_tables,
    typed_query,
    validate_sql,
)

CASES = ROOT / "tests/data/session_retrieval_cases.jsonl"
VARIANTS = ("baseline", "typed", "relationships", "sql")
MAX_CALLS, MAX_TOOLS, MAX_SECONDS, MAX_COST = 960, 6, 7200, 2.0
INPUT_PRICE, OUTPUT_PRICE = 0.15 / 1_000_000, 0.50 / 1_000_000
MAX_INPUT, MAX_OUTPUT = 32_000, 2048
CATALOG = json.loads((Path(__file__).parent / "catalog.json").read_text())


def cases():
    raw = CASES.read_bytes()
    assert (
        hashlib.sha256(raw).hexdigest()
        == CASES.with_suffix(".sha256").read_text().strip()
    ), "Frozen corpus changed"
    rows = [json.loads(line) for line in raw.splitlines()]
    assert len(rows) == 60 and sum(c["split"] == "validation" for c in rows) == 20
    for row in rows:
        row["tables"] = scoped_tables(row["tables"])
    return rows


def sandbox(tables, sql):
    sql = validate_sql(sql)
    payload = json.dumps(dict(tables=tables, sql=sql))
    if len(payload.encode()) > 2_000_000:
        raise ValueError("Snapshot exceeds 2MB")
    name = "arete-retrieval-" + uuid4().hex
    try:
        result = subprocess.run(
            [
                "docker",
                "run",
                "--rm",
                "--name",
                name,
                "-i",
                "--network=none",
                "--read-only",
                "--memory=512m",
                "--memory-swap=512m",
                "--cpus=1",
                "--pids-limit=64",
                "--cap-drop=ALL",
                "--security-opt=no-new-privileges",
                "arete-retrieval-eval:1",
            ],
            input=payload,
            text=True,
            capture_output=True,
            timeout=15,
            check=True,
        )
        payload = json.loads(result.stdout)
        if "error" in payload:
            raise ValueError(payload["error"])
        return payload
    finally:
        # Killing only the Docker CLI on timeout would leave the worker alive.
        subprocess.run(
            ["docker", "rm", "-f", name], capture_output=True, timeout=10, check=False
        )


def oracle_check(case):
    spec = dict(case["oracle"])
    difference = spec.pop("difference")
    with connection(case["tables"]) as con:
        if difference:
            left = typed_query(
                con,
                case["tables"],
                **{**spec, "filters": {**spec["filters"], "date__lte": "2026-09-15"}},
            )["rows"][0]
            right = typed_query(
                con,
                case["tables"],
                **{**spec, "filters": {**spec["filters"], "date__gt": "2026-09-15"}},
            )["rows"][0]
            result = dict(
                value=right["value"] - left["value"],
                sources=left["sources"] + right["sources"],
            )
        else:
            result = typed_query(con, case["tables"], **spec)["rows"][0]
    assert math.isclose(result["value"], case["expected"]["value"], abs_tol=1e-8)
    assert set(result["sources"]) == set(case["expected"]["sources"])
    return result


def sql_oracle_check(case):
    spec = case["oracle"]

    def query(extra):
        conditions = []
        for key, value in {**spec["filters"], **extra}.items():
            column, _, op = key.partition("__")
            operator = {"": "=", "lt": "<", "gt": ">", "lte": "<=", "gte": ">="}[op]
            literal = (
                str(value)
                if isinstance(value, (int, float))
                else "'" + value.replace("'", "''") + "'"
            )
            conditions.append(f'"{column}" {operator} {literal}')
        conditions.append(f'"{spec["metric"]}" IS NOT NULL')
        sql = (
            f'SELECT {spec["aggregate"]}("{spec["metric"]}") AS value, list(id) AS sources FROM {spec["entity"]} WHERE '
            + " AND ".join(conditions)
        )
        return sandbox(case["tables"], sql)["rows"][0]

    if spec["difference"]:
        first = query({"date__lte": "2026-09-15"})
        second = query({"date__gt": "2026-09-15"})
        result = {
            "value": second["value"] - first["value"],
            "sources": first["sources"] + second["sources"],
        }
    else:
        result = query({})
    assert math.isclose(result["value"], case["expected"]["value"], abs_tol=1e-8)
    assert set(result["sources"]) == set(case["expected"]["sources"])
    return result


def snapshot(case, directory):
    """Real application schema in a new disposable local file, never real data."""
    os.environ["ARETE_DB"] = str(Path(directory) / "synthetic.duckdb")
    os.environ["ARETE_AUTH"] = "none"
    from arete.dataio.db import db_connection
    from arete.dataio.init_duckdb import main

    main()
    with db_connection() as con:
        for table in (
            "session_feedback",
            "activity_weather",
            "activity_terrain",
            "exercise_sets",
            "session_exercises",
            "strength_sessions",
            "exercises",
            "planned_sessions",
        ):
            con.execute(f"DELETE FROM app.{table}")
        con.execute("DELETE FROM app.activity_terrain")
        con.execute("DELETE FROM app.activity_weather")
        con.execute("DELETE FROM app.actual_sessions")
        con.execute("DELETE FROM app.daily_metrics")
        for r in case["tables"]["sessions"]:
            con.execute(
                "INSERT INTO app.actual_sessions (id,user_id,date,sport,name,duration_sec,distance_m,avg_hr,avg_pace_sec_km,ascent_m,source) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                [
                    r["session_id"],
                    1,
                    r["date"],
                    r["sport"],
                    r["name"],
                    r["duration_sec"],
                    r["distance_m"],
                    r["avg_hr"],
                    r["pace_sec_km"],
                    r["ascent_m"],
                    "garmin_connect",
                ],
            )
            con.execute(
                "INSERT INTO app.activity_terrain(actual_session_id,athlete_id,model_version,gap_sec_km) VALUES (?,?,?,?)",
                [r["session_id"], 1, 1, r["gap_sec_km"]],
            )
            con.execute(
                "INSERT INTO app.activity_weather(actual_session_id,athlete_id,observed_at,temperature_c,source) VALUES (?,?,?,?,?)",
                [
                    r["session_id"],
                    1,
                    r["date"] + " 08:00:00",
                    r["temperature_c"],
                    "synthetic",
                ],
            )
            if r["feedback"]:
                con.execute(
                    "INSERT INTO app.session_feedback(actual_session_id,athlete_id,text,source,trigger) VALUES (?,?,?,?,?)",
                    [r["session_id"], 1, r["feedback"], "rules", "sync"],
                )
        for r in case["tables"]["plans"]:
            sid = int(r["id"].split(":")[1])
            con.execute(
                "INSERT INTO app.planned_sessions(id,user_id,date,sport,session_type,status) VALUES (?,?,?,?,?,?)",
                [
                    sid,
                    1,
                    r["date"],
                    "running",
                    "endurance",
                    "completed" if r["completed"] else "pending",
                ],
            )
            if r["actual_id"]:
                con.execute(
                    "UPDATE app.actual_sessions SET planned_session_id=? WHERE id=?",
                    [sid, int(r["actual_id"].split(":")[1])],
                )
        con.execute(
            "INSERT INTO app.exercises(id,name,category,primary_muscle) VALUES (1,'Squat','squat','quads')"
        )
        for r in case["tables"]["strength"]:
            sid = int(r["id"].split(":")[1])
            con.execute(
                "INSERT INTO app.strength_sessions(id,user_id,date,name) VALUES (?,?,?,?)",
                [sid, 1, r["date"], "Force"],
            )
            con.execute(
                "INSERT INTO app.session_exercises(id,session_id,exercise_id,athlete_id) VALUES (?,?,1,1)",
                [sid, sid],
            )
            con.execute(
                "INSERT INTO app.exercise_sets(session_exercise_id,set_number,reps,weight_kg,athlete_id) VALUES (?,1,10,?,1)",
                [sid, r["volume_kg"] / 10],
            )
        for r in case["tables"]["days"]:
            con.execute(
                "INSERT INTO app.daily_metrics(user_id,date,hrv_last_night,sleep_duration_sec) VALUES (?,?,?,?)",
                [1, r["date"], r["hrv"], r["sleep_duration_sec"]],
            )


def lexical(case, query, graph=False):
    from arete.services.personal_context import Passage, SearchLimits, retrieve

    passages = []
    for entity, rows in case["tables"].items():
        for r in rows:
            # Match production lexical content: names/notes, not numerical metric dumps.
            text = f"{entity} {r['date']} {r.get('sport', '')} {r.get('name', '')} {r.get('feedback') or ''}"
            links = tuple(
                r[k] for k in ("planned_id", "day_id", "actual_id") if r.get(k)
            )
            passages.append(Passage(r["id"], r["id"], r["date"], text, links))
    return [
        h.to_dict()
        for h in retrieve(passages, query, limits=SearchLimits(graph=graph)).hits
    ]


def offline_comparison(case):
    result = {"id": case["id"], "split": case["split"], "oracle": oracle_check(case)}
    gold = set(case["expected"]["sources"])
    for variant, graph in (("bm25", False), ("bm25_relationships", True)):
        started = time.perf_counter()
        hits = lexical(case, case["question"], graph)
        sources = {hit["source"] for hit in hits}
        result[variant] = {
            "source_recall": len(sources & gold) / len(gold),
            "selected": len(hits),
            "elapsed_ms": (time.perf_counter() - started) * 1000,
        }
    return result


def toolset(case, variant, con):
    from langchain_core.tools import tool

    from arete.agent.tools.analytics import (
        get_activity_detail,
        get_fitness,
        get_training_advice,
        get_workload,
        list_recent_sessions,
    )
    from arete.agent.tools.planning import list_planned
    from arete.agent.tools.strength import get_strength_progress, list_strength_sessions

    @tool
    def search_text(query: str) -> str:
        """Search session names, descriptions and sourced feedback; returns explicit IDs."""
        return json.dumps(
            lexical(case, query, variant == "relationships"), ensure_ascii=False
        )

    @tool
    def query_training(
        entity: str,
        metric: str,
        aggregate: str,
        filters: dict | None = None,
        group_by: list[str] | None = None,
    ) -> str:
        """Aggregate declared metrics. entity: sessions/days/plans/strength. aggregate: sum/avg/min/max/count.
        filters: field=value; suffix __lt/__gt/__lte/__gte for comparisons. Missing metrics excluded.
        Returns value and ALL contributing source IDs. Use separate queries for period differences.
        """
        return json.dumps(
            typed_query(
                con,
                case["tables"],
                entity=entity,
                metric=metric,
                aggregate=aggregate,
                filters=filters,
                group_by=group_by,
            ),
            ensure_ascii=False,
        )

    @tool
    def traverse_links(source_ids: list[str]) -> str:
        """Follow authoritative plan/completion/day links one hop in either direction. Max 20 seeds and 40 nodes."""
        return json.dumps(relationships(case["tables"], source_ids), ensure_ascii=False)

    @tool
    def query_sql(sql: str) -> str:
        """One flat DuckDB SELECT on sessions/days/plans/strength. No subqueries, CTEs, UNION or external reads.
        Allowed aggregates/functions: SUM AVG COUNT MIN MAX ROUND COALESCE NULLIF CORR CAST LIST ABS DATE_TRUNC.
        Return value plus list(id) AS sources for evidence. No more than 100 rows.
        """
        return json.dumps(sandbox(case["tables"], sql), ensure_ascii=False)

    if variant == "baseline":
        return [
            search_text,
            list_recent_sessions,
            get_activity_detail,
            get_workload,
            get_fitness,
            get_training_advice,
            list_planned,
            list_strength_sessions,
            get_strength_progress,
        ]
    selected = [search_text, query_sql if variant == "sql" else query_training]
    if variant == "relationships":
        selected.append(traverse_links)
    return selected


def grade(text, expected):
    try:
        answer = json.loads(
            text.strip().removeprefix("```json").removesuffix("```").strip()
        )
        value = answer["value"]
        numerical = type(value) in (float, int) and math.isclose(
            value, expected["value"], abs_tol=0.1, rel_tol=0.001
        )
        cited = set(answer.get("sources", []))
        gold = set(expected["sources"])
        recall = len(cited & gold) / len(gold)
        unsupported = (
            bool(cited - gold)
            or answer.get("causal_claim", False) is not False
            or bool(set(answer) - {"value", "sources", "causal_claim"})
        )
        return dict(
            correct=numerical and recall >= 0.8 and not unsupported,
            numerical=numerical,
            recall=recall,
            unsupported=unsupported,
        )
    except (ValueError, KeyError, TypeError):
        return dict(
            correct=False,
            numerical=False,
            recall=0,
            unsupported=False,
            invalid_answer=True,
        )


def live_case(case, variant, model, budget, directory):
    from langchain_core.messages import HumanMessage, SystemMessage, ToolMessage
    from langchain_core.utils.function_calling import convert_to_openai_tool

    snapshot(case, directory)
    started = time.monotonic()
    row = dict(
        id=case["id"],
        split=case["split"],
        variant=variant,
        model_calls=0,
        tool_calls=0,
        query_failures=0,
        input_tokens=0,
        output_tokens=0,
    )
    with connection(case["tables"]) as con:
        tools = toolset(case, variant, con)
        by_name = {t.name: t for t in tools}
        schemas = [convert_to_openai_tool(t) for t in tools]
        messages = [
            SystemMessage(
                'Tu analyses un historique synthétique Arete. Réponds uniquement en JSON {"value": nombre, "sources": [tous les IDs de lignes contribuant au calcul], "causal_claim": false}. Si impossible, value=null. Ne devine pas les métriques manquantes. Maximum 4 appels modèle et 6 outils. Catalogue: '
                + json.dumps(CATALOG, ensure_ascii=False)
            ),
            HumanMessage(case["question"]),
        ]
        # Same initial lexical evidence for all variants; graph expansion is the sole treatment difference.
        messages[0].content += "\nSouvenirs: " + json.dumps(
            lexical(case, case["question"], variant == "relationships"),
            ensure_ascii=False,
        )
        answer = ""
        for turn in range(4):
            # UTF-8 bytes conservatively bound token count, including complete schemas/history.
            bound = (
                len(
                    json.dumps(
                        [m.model_dump() for m in messages],
                        default=str,
                        ensure_ascii=False,
                    ).encode()
                )
                + len(json.dumps(schemas).encode())
                + 512
            )
            if bound > MAX_INPUT:
                row["budget_error"] = "context"
                break
            reserve = bound * INPUT_PRICE + MAX_OUTPUT * OUTPUT_PRICE
            if (
                budget["calls"] >= MAX_CALLS
                or budget["reserved_usd"] + reserve > MAX_COST
                or time.monotonic() - budget["started"] + 60 > MAX_SECONDS
            ):
                row["budget_error"] = "experiment"
                break
            budget["calls"] += 1
            budget["reserved_usd"] += reserve
            row["model_calls"] += 1
            # Reserve durably before dispatch: a crashed experiment must not
            # silently restart with a fresh monetary allowance.
            if ledger := budget.get("ledger"):
                Path(ledger).write_text(
                    json.dumps({k: v for k, v in budget.items() if k != "started"})
                )
            try:
                response = (model if turn == 3 else model.bind_tools(tools)).invoke(
                    messages
                )
            except Exception as exc:
                row["infrastructure_error"] = type(exc).__name__
                break
            usage = response.usage_metadata or {}
            row["input_tokens"] += usage.get("input_tokens", 0)
            row["output_tokens"] += usage.get("output_tokens", 0)
            reported = response.response_metadata.get("token_usage", {}).get("cost")
            if isinstance(reported, (int, float)):
                budget["reported_usd"] += reported
            if response.response_metadata.get("finish_reason") == "length":
                row["truncated"] = True
                break
            messages.append(response)
            if not response.tool_calls:
                answer = response.text
                break
            for call in response.tool_calls:
                if time.monotonic() - budget["started"] + 25 > MAX_SECONDS:
                    row["budget_error"] = "experiment"
                    break
                if row["tool_calls"] >= MAX_TOOLS:
                    row["budget_error"] = "tools"
                    break
                row["tool_calls"] += 1
                try:
                    output = by_name[call["name"]].invoke(call["args"])
                except Exception as exc:
                    row["query_failures"] += 1
                    output = json.dumps({"error": str(exc)})
                if len(output.encode()) > 24_000:
                    output = json.dumps(
                        {
                            "error": "Tool result exceeds 24000 bytes; narrow your request"
                        }
                    )
                    row["query_failures"] += 1
                messages.append(ToolMessage(output, tool_call_id=call["id"]))
            if row.get("budget_error"):
                break
        row.update(
            grade(answer, case["expected"]),
            answer=answer,
            elapsed_ms=round((time.monotonic() - started) * 1000),
        )
        return row


def scoreboard(runs):
    summary = {}
    for variant in VARIANTS:
        rows = [r for r in runs if r["variant"] == variant]
        valid = [r for r in rows if not r.get("infrastructure_error")]
        latencies = sorted(r["elapsed_ms"] for r in valid)
        summary[variant] = {
            "runs": len(rows),
            "infrastructure_failures": len(rows) - len(valid),
            "correct": sum(r["correct"] for r in valid),
            "numerical": sum(r["numerical"] for r in valid),
            "unsupported": sum(r["unsupported"] for r in valid),
            "mean_evidence_recall": mean(r["recall"] for r in valid) if valid else None,
            "model_calls": sum(r["model_calls"] for r in rows),
            "tool_calls": sum(r["tool_calls"] for r in rows),
            "query_failures": sum(r["query_failures"] for r in rows),
            "input_tokens": sum(r["input_tokens"] for r in rows),
            "output_tokens": sum(r["output_tokens"] for r in rows),
            "median_ms": median(latencies) if latencies else None,
            "p95_ms": latencies[
                min(len(latencies) - 1, math.ceil(len(latencies) * 0.95) - 1)
            ]
            if latencies
            else None,
        }
    baseline = {
        r["id"]: r
        for r in runs
        if r["variant"] == "baseline"
        and r["split"] == "validation"
        and not r.get("infrastructure_error")
    }
    for variant in VARIANTS[1:]:
        candidates = {
            r["id"]: r
            for r in runs
            if r["variant"] == variant
            and r["split"] == "validation"
            and not r.get("infrastructure_error")
        }
        ids = sorted(baseline.keys() & candidates.keys())
        if len(ids) != 20:
            summary[variant]["heldout_verdict"] = (
                "inconclusive: incomplete paired holdout"
            )
            continue
        deltas = [
            int(candidates[k]["correct"]) - int(baseline[k]["correct"]) for k in ids
        ]
        rng = random.Random(42)
        samples = sorted(mean(rng.choices(deltas, k=len(deltas))) for _ in range(2000))
        summary[variant].update(
            paired_delta=mean(deltas),
            paired_bootstrap_95=[samples[50], samples[1949]],
            heldout_verdict="review tradeoffs"
            if samples[50] > 0
            else "inconclusive: no clear paired improvement",
        )
    return summary


def main():
    experiment_started = time.monotonic()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live", action="store_true")
    parser.add_argument("--sql-oracles", action="store_true")
    parser.add_argument("--limit", type=int, default=60)
    parser.add_argument(
        "--output", type=Path, default=ROOT / ".context/session-retrieval-report.json"
    )
    args = parser.parse_args()
    assert 1 <= args.limit <= 60
    selected = cases()[: args.limit]
    offline = [offline_comparison(c) for c in selected]
    if args.sql_oracles:
        for row, case in zip(offline, selected, strict=True):
            started = time.perf_counter()
            row["sql_oracle"] = sql_oracle_check(case)
            row["sql_ms"] = (time.perf_counter() - started) * 1000
            print("SQL oracle", case["id"], "passed", flush=True)
    report = {
        "corpus_sha256": CASES.with_suffix(".sha256").read_text().strip(),
        "offline": offline,
        "runs": [],
        "usage": {
            "calls": 0,
            "input_tokens": 0,
            "output_tokens": 0,
            "reserved_usd": 0,
            "reported_usd": 0,
        },
        "model_settings": {
            "model": "z-ai/glm-5.3-flash",
            "reasoning": "low",
            "temperature": 0,
            "max_output_tokens": MAX_OUTPUT,
            "timeout_seconds": 60,
            "retries": 0,
            "fallbacks": False,
        },
        "resource_limits": {
            "sql_container_memory_mib": 512,
            "sql_cpus": 1,
            "sql_query_seconds": 2,
            "max_model_requests": MAX_CALLS,
            "max_experiment_seconds": MAX_SECONDS,
            "max_usd": MAX_COST,
            "max_model_calls_per_case": 4,
            "max_tools_per_case": MAX_TOOLS,
        },
        "recommendation": "Inconclusive: live comparison not completed.",
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    if args.live:
        if os.getenv("ARETE_EVAL") != "1":
            parser.error("--live requires ARETE_EVAL=1")
        from pydantic import SecretStr

        from arete.agent.models.providers import build_chat_model
        from arete.agent.models.registry import ModelRoute
        from arete.config import config

        if not config.openrouter_api_key:
            report["infrastructure_error"] = "OPENROUTER_API_KEY unavailable"
        else:
            model = build_chat_model(
                route=ModelRoute(
                    "z-ai/glm-5.3-flash",
                    "https://openrouter.ai/api/v1",
                    SecretStr(config.openrouter_api_key),
                    MAX_INPUT + MAX_OUTPUT + 1024,
                    openrouter_policy="glm_flash",
                ),
                max_tokens=MAX_OUTPUT,
                timeout=60,
                max_retries=0,
                temperature=0,
            )
            # The experiment forbids even same-model provider failover; do not
            # mutate the application's shared provider policy dictionary.
            body = dict(model.extra_body or {})
            body["provider"] = {**body["provider"], "allow_fallbacks": False}
            model = model.model_copy(update={"extra_body": body})
            ledger = ROOT / ".context/session-retrieval-budget.json"
            try:
                with ledger.open("x") as reserved:
                    reserved.write(
                        json.dumps({"calls": 0, "reserved_usd": 0, "status": "started"})
                    )
            except FileExistsError:
                parser.error(
                    "A paid experiment ledger already exists; reconcile its spend before starting another experiment"
                )
            budget = dict(
                calls=0,
                reserved_usd=0.0,
                reported_usd=0.0,
                started=experiment_started,
                ledger=str(ledger),
            )
            with tempfile.TemporaryDirectory(prefix="arete-retrieval-") as directory:
                # Cases remain paired; rotate variant order to reduce provider-time bias.
                for index, case in enumerate(selected):
                    order = VARIANTS[index % 4 :] + VARIANTS[: index % 4]
                    for variant in order:
                        row = live_case(case, variant, model, budget, directory)
                        report["runs"].append(row)
                        report["usage"] = {
                            k: v for k, v in budget.items() if k != "started"
                        }
                        args.output.write_text(
                            json.dumps(report, ensure_ascii=False, indent=2)
                        )
                        print(
                            case["id"],
                            variant,
                            "infra"
                            if row.get("infrastructure_error")
                            else row["correct"],
                            flush=True,
                        )
                        if row.get("budget_error") == "experiment":
                            break
                        if len(report["runs"]) >= 4 and all(
                            r.get("infrastructure_error") for r in report["runs"][-4:]
                        ):
                            report["stop_reason"] = (
                                "four consecutive infrastructure failures"
                            )
                            break
                    if (
                        report.get("stop_reason")
                        or report["runs"][-1].get("budget_error") == "experiment"
                    ):
                        break
            report["usage"]["elapsed_seconds"] = round(
                time.monotonic() - budget["started"]
            )
    report["elapsed_seconds"] = round(time.monotonic() - experiment_started, 3)
    report["scoreboard"] = scoreboard(report["runs"])
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(args.output)


if __name__ == "__main__":
    main()
