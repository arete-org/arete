"""Export the agent's stored briefings into the local evaluation corpus.

Usage:
    ARETE_DB=md:arete_v2 uv run python scripts/export_coach_runs.py [--limit 30]

Writes ``data/agent/corpus.jsonl`` (out of git: personal training data), one
``{"profile", "date", "text"}`` per briefing the agent wrote successfully.
``tests/test_coach_corpus.py`` checks every entry. Read-only on the database.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

CORPUS = Path(__file__).resolve().parents[1] / "data" / "agent" / "corpus.jsonl"


def main() -> None:
    from arete.services.coaching_repository import BriefingRepository

    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--limit", type=int, default=30)
    args = parser.parse_args()

    rows = [
        {"profile": "briefing", "date": b.date.isoformat(), "text": b.text}
        for b in BriefingRepository().list_recent(limit=args.limit)
        if b.source == "agent" and b.status == "ok"
    ]
    CORPUS.parent.mkdir(parents=True, exist_ok=True)
    CORPUS.write_text(
        "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows),
        encoding="utf-8",
    )
    print(f"{len(rows)} briefings written to {CORPUS}")


if __name__ == "__main__":
    main()
