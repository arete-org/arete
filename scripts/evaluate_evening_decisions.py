"""Evaluate synthetic evening replies, with explicit paid-model opt-in.

uv run python scripts/evaluate_evening_decisions.py --live
No database reads, athlete data, writes or generative agent calls. At most 32
sequential Jev requests, each with the production 10-second deadline and no retry.
This small regression sample does not establish production accuracy.
"""

import argparse
import asyncio
import json
from pathlib import Path
from statistics import median
from time import monotonic

from pydantic import SecretStr

from arete.agent.runtime.evening import DECISION_TIMEOUT_SECONDS, QUESTIONS
from arete.config import config
from arete.services.jev import JEV_MODEL, JevService

MAX_CASES = 32
DATASET = (
    Path(__file__).resolve().parents[1] / "tests/data/coaching/evening_decisions.jsonl"
)


async def evaluate(cases: list[dict]) -> dict:
    model = JevService(
        api_key=SecretStr(config.openrouter_api_key),
        model=JEV_MODEL,
        timeout=DECISION_TIMEOUT_SECONDS,
    )
    results = []
    for case in cases:
        started = monotonic()
        response = await model.decide(
            model.build_request(
                state={
                    "kind": "evening",
                    "id": 1,
                    "for_date": "2026-10-24",
                    "question": "Quelle disponibilité as-tu demain ?",
                    "answer": case["answer"],
                    "sessions": [
                        {
                            "id": 1,
                            "revision": 1,
                            "date": "2026-10-24",
                            "sport": "running",
                            "description": "Endurance",
                            "target_duration_min": 45,
                        }
                    ],
                },
                questions=QUESTIONS,
            )
        )
        action = response.answers["action"].model_dump()["choice"]
        availability = response.answers["availability"].model_dump()["choice"] == "yes"
        results.append(
            {
                "id": case["id"],
                "action": action,
                "availability": availability,
                "correct": action == case["action"]
                and availability == case["availability"],
                "milliseconds": round((monotonic() - started) * 1000),
                "usage": response.usage.model_dump(),
                "served_model": response.model,
            }
        )
    return {
        "model": JEV_MODEL,
        "cases": len(results),
        "correct": sum(r["correct"] for r in results),
        "median_ms": median(r["milliseconds"] for r in results),
        "max_ms": max(r["milliseconds"] for r in results),
        "results": results,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--live",
        action="store_true",
        help="Authorize the bounded, paid synthetic evaluation",
    )
    args = parser.parse_args()
    cases = [
        json.loads(line) for line in DATASET.read_text().splitlines() if line.strip()
    ]
    if not 0 < len(cases) <= MAX_CASES:
        raise ValueError("Evaluation must contain 1–32 cases")
    if not args.live:
        parser.error("Pass --live to send these synthetic cases to Jev")
    if not config.openrouter_api_key:
        raise ValueError("OPENROUTER_API_KEY is required")
    report = asyncio.run(evaluate(cases))
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if report["correct"] != report["cases"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
