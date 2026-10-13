"""Time GET requests against a running Arete API.

Usage:
    uv run python scripts/latency_probe.py --base http://localhost:8001
    uv run python scripts/latency_probe.py --base https://arete-two-woad.vercel.app \
        --prefix /api -n 10 /settings /metrics/player-stats

Behind Vercel Deployment Protection, set VERCEL_AUTOMATION_BYPASS_SECRET.
One client serves every request, so TLS is paid once: the first call of the
first path includes it. Each path prints its first call apart (the cold
number) from the median and maximum of all calls, in milliseconds.

When the API sends ``Server-Timing``, each path also prints the database
statements of its last call and the median database and server times: the
difference between ``p50_ms`` and ``srv_ms`` is the network.

The defaults are the dashboard's GET requests (``{today}`` is replaced by
today's date). It also sends ``POST /gamification/sync`` and, for a session
still to do, ``GET /garmin/workouts?ids={id}``: pass them explicitly.
"""

from __future__ import annotations

import argparse
import datetime
import os
import re
import statistics
import time

import httpx

DEFAULT_PATHS = (
    "/health",
    "/settings",
    "/settings/gamification",
    "/goals/next",
    "/garmin/planned?start_date={today}&end_date={today}",
    "/garmin/actual?start_date={today}&end_date={today}",
    "/strength/sessions?limit=200",
    "/garmin/sync/status",
    "/plan/today",
    "/metrics/player-stats",
    "/metrics/fitness",
    "/metrics/workload",
    "/garmin/health/daily?date={today}",
    "/tips/daily",
    "/analytics/overview",
)

_DB = re.compile(r'db;dur=([\d.]+);desc="(\d+) statements"')
_TOTAL = re.compile(r"total;dur=([\d.]+)")


def probe(client: httpx.Client, url: str, n: int) -> list[tuple[float, httpx.Response]]:
    """``n`` responses, each with its client-side duration in milliseconds."""
    calls = []
    for _ in range(n):
        start = time.perf_counter()
        response = client.get(url)
        calls.append(((time.perf_counter() - start) * 1000, response))
    return calls


def server_timings(responses: list[httpx.Response]) -> tuple[str, str, str]:
    """Statements of the last call, median db and server ms; ``-`` if absent."""
    db, total = [], []
    statements = "-"
    for response in responses:
        header = response.headers.get("server-timing", "")
        if (db_match := _DB.search(header)) and (total_match := _TOTAL.search(header)):
            db.append(float(db_match.group(1)))
            total.append(float(total_match.group(1)))
            statements = db_match.group(2)
    if not db:
        return statements, "-", "-"
    return statements, f"{statistics.median(db):.0f}", f"{statistics.median(total):.0f}"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--base", default="http://localhost:8001")
    parser.add_argument("--prefix", default="", help="e.g. /api on Vercel")
    parser.add_argument("-n", type=int, default=5, help="requests per path")
    parser.add_argument("paths", nargs="*", default=DEFAULT_PATHS)
    args = parser.parse_args()

    headers = {}
    secret = os.environ.get("VERCEL_AUTOMATION_BYPASS_SECRET")
    if secret:
        headers["x-vercel-protection-bypass"] = secret
    today = datetime.date.today().isoformat()

    print(
        f"{'path':58} {'status':>6} {'n':>3} {'first_ms':>9} {'p50_ms':>8} "
        f"{'max_ms':>8} {'stmts':>6} {'db_ms':>6} {'srv_ms':>7}"
    )
    with httpx.Client(base_url=args.base, headers=headers, timeout=120) as client:
        for path in args.paths:
            path = path.replace("{today}", today)
            calls = probe(client, args.prefix + path, args.n)
            timings = [ms for ms, _ in calls]
            responses = [response for _, response in calls]
            statements, db_ms, server_ms = server_timings(responses)
            print(
                f"{path:58} {responses[-1].status_code:>6} {len(timings):>3} "
                f"{timings[0]:>9.0f} {statistics.median(timings):>8.0f} "
                f"{max(timings):>8.0f} {statements:>6} {db_ms:>6} {server_ms:>7}"
            )


if __name__ == "__main__":
    main()
