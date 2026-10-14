"""Read-only sensitivity diagnostics for the frozen evaluation; never rescores its gate.

JSON-prefix parsing measures format sensitivity only. Trailing prose remains
unvalidated and cannot turn a frozen failure into an accepted answer.
"""

from __future__ import annotations

import argparse
import json
import random
from collections import Counter
from pathlib import Path
from statistics import mean

from run import VARIANTS, cases, grade


def diagnostics(report):
    gold = {case["id"]: case["expected"] for case in cases()}
    rows = report["runs"]
    assert len(rows) <= 240
    assert len({(r["id"], r["variant"]) for r in rows}) == len(rows)
    result = {"splits": {}, "observed_holdout_pairs": {}}
    for variant in VARIANTS:
        by_split = {}
        for split in ("development", "validation"):
            group = [r for r in rows if r["variant"] == variant and r["split"] == split]
            valid = [r for r in group if not r.get("infrastructure_error")]
            prefix_supported, prefix_numerical, format_only = 0, 0, 0
            for row in valid:
                raw = row["answer"].strip().removeprefix("```json").strip()
                try:
                    parsed, _ = json.JSONDecoder().raw_decode(raw)
                    parsed_grade = grade(json.dumps(parsed), gold[row["id"]])
                    prefix_supported += int(parsed_grade["correct"])
                    prefix_numerical += int(parsed_grade["numerical"])
                    format_only += int(parsed_grade["correct"] and not row["correct"])
                except (ValueError, TypeError):
                    pass  # An invalid prefix is explicitly not a diagnostic success.
            by_split[split] = {
                "runs": len(group),
                "valid": len(valid),
                "strict_correct": sum(r["correct"] for r in valid),
                "prefix_numerical_diagnostic": prefix_numerical,
                "prefix_supported_diagnostic": prefix_supported,
                "format_only_diagnostic": format_only,
                "infrastructure_failures": dict(
                    Counter(
                        r["infrastructure_error"]
                        for r in group
                        if r.get("infrastructure_error")
                    )
                ),
                "budget_failures": dict(
                    Counter(r["budget_error"] for r in group if r.get("budget_error"))
                ),
                "truncated": sum(bool(r.get("truncated")) for r in valid),
                "query_failures": sum(r["query_failures"] for r in group),
            }
        result["splits"][variant] = by_split
    for variant in VARIANTS[1:]:
        result["observed_holdout_pairs"][variant] = paired_difference(
            rows, variant, "baseline"
        )
    result["candidate_comparisons"] = {
        "typed_vs_relationships": paired_difference(rows, "typed", "relationships"),
        "typed_vs_sql": paired_difference(rows, "typed", "sql"),
    }
    result["limitations"] = [
        "These diagnostics never alter the frozen scores or promotion gate.",
        "JSON-prefix diagnostics do not validate trailing prose.",
        "Observed-pair intervals exclude infrastructure failures and may have selection bias.",
        "Only two held-out histories exist; case-level intervals do not establish population generalization.",
    ]
    return result


def paired_difference(rows, candidate_name, baseline_name):
    base = {
        r["id"]: r
        for r in rows
        if r["variant"] == baseline_name
        and r["split"] == "validation"
        and not r.get("infrastructure_error")
    }
    candidate = {
        r["id"]: r
        for r in rows
        if r["variant"] == candidate_name
        and r["split"] == "validation"
        and not r.get("infrastructure_error")
    }
    ids = sorted(base.keys() & candidate.keys())
    if not ids:
        return {"paired_cases": 0, "verdict": "inconclusive"}
    deltas = [int(candidate[k]["correct"]) - int(base[k]["correct"]) for k in ids]
    rng = random.Random(42)
    samples = sorted(mean(rng.choices(deltas, k=len(deltas))) for _ in range(2000))
    return {
        "paired_cases": len(ids),
        "paired_delta": mean(deltas),
        "bootstrap_95": [samples[50], samples[1949]],
        "missing_pairs": 20 - len(ids),
        "verdict": "inconclusive: incomplete comparison"
        if len(ids) < 20
        else "consult the frozen gate and isolation checks",
        "case_ids": ids,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    report = json.loads(args.input.read_text())
    args.output.write_text(
        json.dumps(diagnostics(report), ensure_ascii=False, indent=2) + "\n"
    )


if __name__ == "__main__":
    main()
