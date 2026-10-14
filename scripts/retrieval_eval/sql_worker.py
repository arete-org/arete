"""Container-only worker: synthetic JSON in, bounded results out; no credentials."""

import json
import sys

from engine import connection, execute

payload = json.loads(sys.stdin.buffer.read(2_000_001))
try:
    with connection(payload["tables"]) as con:
        result = execute(con, payload["sql"])
except Exception as exc:
    result = {"error": type(exc).__name__ + ": " + str(exc)}
print(json.dumps(result))
