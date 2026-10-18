"""Keep new domain queries on private projections; complements cross-account tests."""

import ast
import re
from pathlib import Path

from arete.dataio.tenant_schema import PRIVATE_TABLES
from arete.scheduler import _CANDIDATES
from arete.services.product_kpis import TRUSTED_READS

# Bootstrap is deliberately privileged and never used by a domain request.
BOOTSTRAP = {
    "dataio/init_duckdb.py",
    "dataio/athlete_schema.py",
    "dataio/tenant_schema.py",
    "dataio/document_schema.py",
    "dataio/game_schema.py",
    "dataio/memory_schema.py",
}


def test_domain_reads_use_live_athlete_projections():
    root = Path(__file__).resolve().parents[1] / "src/arete"
    names = "|".join(PRIVATE_TABLES)
    reads = re.compile(rf"\b(?:FROM|JOIN)\s+(?:app\.)?({names})\b", re.I)
    failures = []
    for path in root.rglob("*.py"):
        relative = path.relative_to(root).as_posix()
        if relative in BOOTSTRAP:
            continue
        tree = ast.parse(path.read_text())
        for node in ast.walk(tree):
            if not isinstance(node, ast.Constant) or not isinstance(node.value, str):
                continue
            sql = node.value
            if not re.search(r"\b(?:SELECT|UPDATE|DELETE)\b", sql):
                continue
            if "CREATE TABLE" in sql or "CREATE SCHEMA" in sql:
                continue
            # DELETE's target is a write, not a read; its subqueries still count.
            sql = re.sub(r"\bDELETE\s+FROM\s+(?:app\.)?\w+", "", sql, flags=re.I)
            if (
                relative == "services/users.py"
                and sql == "SELECT email FROM app.user_settings WHERE user_id = 1"
            ):
                continue  # Bootstrap owner lookup before a scope exists.
            if relative == "scheduler.py" and sql == _CANDIDATES:
                continue  # Trusted dispatch: every athlete's zone and quiet hours.
            if relative == "services/product_kpis.py" and any(
                sql in query for query in TRUSTED_READS
            ):
                continue  # Administrators' indicators: counts, never a row.
            if reads.search(sql):
                failures.append(f"{relative}:{node.lineno}: {sql[:160]}")
    assert failures == [], "Unscoped private reads:\n" + "\n".join(failures)
