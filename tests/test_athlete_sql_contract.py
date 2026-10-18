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


def _trusted(relative: str, sql: str) -> bool:
    """The deliberate cross-athlete reads, each matched exactly."""
    # Bootstrap owner lookup before a scope exists.
    if relative == "services/users.py":
        return sql == "SELECT email FROM app.user_settings WHERE user_id = 1"
    # Trusted dispatch: every athlete's zone and quiet hours.
    if relative == "scheduler.py":
        return sql == _CANDIDATES
    # Administrators' indicators: counts, never a row.
    if relative == "services/product_kpis.py":
        return sql in TRUSTED_READS
    return False


def test_trusted_reads_match_whole_statements_only():
    read = TRUSTED_READS[0]
    assert _trusted("services/product_kpis.py", read)
    # A piece of a trusted read, reused in a new statement, is checked again.
    assert not _trusted("services/product_kpis.py", read[: len(read) // 2])
    assert not _trusted("services/product_kpis.py", f"{read} JOIN app.goals g")
    assert not _trusted("services/briefing.py", read)


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
            if _trusted(relative, sql):
                continue
            if reads.search(sql):
                failures.append(f"{relative}:{node.lineno}: {sql[:160]}")
    assert failures == [], "Unscoped private reads:\n" + "\n".join(failures)
