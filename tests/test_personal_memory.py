"""Personal memory boundaries: provenance, time, conflicts and source isolation."""

from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, date, datetime, time
from threading import Barrier
from uuid import uuid4

import pytest
from langchain.agents.middleware import ModelRequest
from langchain_core.messages import HumanMessage, SystemMessage

from arete.agent.context.builder import build_context
from arete.agent.runtime.context import AgentContext
from arete.dataio.db import db_connection
from arete.services import athlete_facts as facts
from arete.services import personal_context as memory

TODAY = date(2026, 10, 10)


@pytest.fixture(autouse=True)
def isolated(monkeypatch, tmp_path):
    monkeypatch.setenv("ARETE_DATA_DIR", str(tmp_path))
    with db_connection() as con:
        con.execute("DELETE FROM app.athlete_fact_revisions")
        con.execute("DELETE FROM app.athlete_facts")
    yield
    with db_connection() as con:
        con.execute("DELETE FROM app.athlete_fact_revisions")
        con.execute("DELETE FROM app.athlete_facts")


def test_every_active_constraint_survives_and_expired_facts_do_not():
    oldest = facts.add_fact(
        "constraint", "Pas de mercredi", since=date(2020, 1, 1), evidence="explicit"
    )
    for i in range(35):
        facts.add_fact(
            "preference", f"Préférence {i}", since=TODAY, evidence="explicit"
        )
    facts.add_fact(
        "constraint",
        "Exception expirée",
        since=date(2026, 10, 1),
        valid_until=date(2026, 10, 9),
    )
    facts.add_fact("constraint", "Future exception", since=date(2026, 10, 11))
    block = facts.facts_block(TODAY)
    assert f"#{oldest.id}" in block and "Pas de mercredi" in block
    assert "Exception expirée" not in block and "Future exception" not in block
    assert block.count("révision 1") == 36


def test_read_failure_is_not_an_empty_memory(monkeypatch):
    def fail(**_):
        raise OSError("offline")

    monkeypatch.setattr(facts, "list_facts", fail)
    with pytest.raises(OSError, match="offline"):
        facts.facts_block(TODAY)


def test_hypotheses_are_separate_and_repetition_does_not_confirm():
    for _ in range(3):
        facts.add_fact(
            "preference", "Peut-être les côtes", evidence="hypothesis", since=TODAY
        )
    block = facts.facts_block(TODAY)
    assert "Hypothèses non confirmées" in block
    assert "Déclarations explicites" not in block


def test_revision_history_and_stale_updates_and_deletion():
    fact = facts.add_fact(
        "injury", "Genou sensible", evidence="hypothesis", since=TODAY
    )
    changed = facts.update_fact(
        fact.id, text="Genou guéri", status="resolved", expected_revision=1
    )
    assert changed and changed.revision == 2
    with pytest.raises(facts.FactConflict):
        facts.update_fact(fact.id, text="Correction ancienne", expected_revision=1)
    with pytest.raises(facts.FactConflict):
        facts.delete_fact(fact.id, expected_revision=1)
    assert [r["text"] for r in facts.fact_history(fact.id)] == [
        "Genou guéri",
        "Genou sensible",
    ]
    facts.delete_fact(fact.id, expected_revision=2)
    assert facts.fact_history(fact.id) == []
    assert not memory.search_personal_context("Genou", None, TODAY).hits


def test_concurrent_corrections_have_one_winner():
    fact = facts.add_fact("goal", "Objectif initial")
    barrier = Barrier(2)

    def change(text):
        barrier.wait(timeout=5)
        try:
            return facts.update_fact(fact.id, text=text, expected_revision=1)
        except facts.FactConflict:
            return None

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(change, ["Objectif A", "Objectif B"]))
    assert sum(result is not None for result in results) == 1
    assert len(facts.fact_history(fact.id)) == 2


def test_api_explicit_confirmation_and_expiry(router_client):
    from arete.api.athlete_facts import router

    client = router_client(router)
    fact = facts.add_fact("preference", "Courir tôt", evidence="hypothesis")
    confirmed = client.patch(
        f"/athlete-facts/{fact.id}",
        json={"evidence": "explicit", "expected_revision": 1},
    )
    assert confirmed.status_code == 200 and confirmed.json()["evidence"] == "explicit"
    assert (
        client.patch(
            f"/athlete-facts/{fact.id}", json={"text": "stale", "expected_revision": 1}
        ).status_code
        == 409
    )
    assert len(client.get(f"/athlete-facts/{fact.id}/history").json()) == 2
    assert (
        client.post(
            "/athlete-facts",
            json={"kind": "constraint", "text": " ", "since": "2026-10-10"},
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/athlete-facts",
            json={
                "kind": "constraint",
                "text": "x",
                "since": "2026-10-10",
                "valid_until": "2026-10-09",
            },
        ).status_code
        == 422
    )


def test_migration_is_idempotent_and_does_not_invent_evidence():
    import duckdb

    from arete.dataio.memory_schema import migrate

    with duckdb.connect(":memory:") as con:
        con.execute("CREATE SCHEMA app")
        con.execute(
            "CREATE TABLE app.athlete_facts(id INTEGER, text VARCHAR, source VARCHAR)"
        )
        con.execute(
            "INSERT INTO app.athlete_facts VALUES (1, 'Ancien fait', 'coach'), (2, 'Ancien autre fait', 'athlete')"
        )
        migrate(con)
        migrate(con)
        assert con.execute(
            "SELECT evidence, revision FROM app.athlete_facts ORDER BY id"
        ).fetchall() == [("legacy", 1), ("legacy", 1)]


def test_bm25_accents_negations_units_and_common_words():
    assert memory.tokenize("Été PAS 12,5 km") == ["ete", "pas", "12,5", "km"]
    passages = [
        memory.Passage("1", "a", "", "vélo interdit"),
        memory.Passage("2", "b", "", "vélo autorisé"),
    ]
    result = memory.retrieve(passages, "vélo", limits=memory.SearchLimits())
    assert len(result.hits) == 2  # Common tokens must not get zero/negative IDF.
    assert not memory.retrieve(passages, "natation", limits=memory.SearchLimits()).hits


def test_traversal_has_two_hops_and_a_hard_visit_limit():
    passages = [memory.Passage("seed", "seed", "", "ancêtre", ("child",))]
    passages += [
        memory.Passage(f"child{i}", "child", "", "autre", ("grandchild",))
        for i in range(30)
    ]
    passages += [
        memory.Passage("grandchild", "grandchild", "", "conclusion", ("too_far",)),
        memory.Passage("too_far", "too_far", "", "exclu"),
    ]
    result = memory.retrieve(
        passages, "ancêtre", limits=memory.SearchLimits(graph=True)
    )
    assert len(result.hits) == 24 and result.limited
    small = [passages[0], passages[1], *passages[-2:]]
    result = memory.retrieve(small, "ancêtre", limits=memory.SearchLimits(graph=True))
    assert [hit.passage.id for hit in result.hits] == ["seed", "child0", "grandchild"]
    assert result.hits[-1].path == ("seed", "child0", "grandchild")


def test_document_scope_and_authoritative_prescription_links():
    thread, other = str(uuid4()), str(uuid4())
    doc, foreign = str(uuid4()), str(uuid4())
    with db_connection() as con:
        for did, tid, text in [
            (doc, thread, "Consigne partenaire 90 secondes"),
            (foreign, other, "SECRET ETRANGER"),
        ]:
            con.execute(
                "INSERT INTO app.coach_documents(id,thread_id,name,size,sha256,status,extraction) VALUES (?,?,?,1,'hash','ready',?)",
                [
                    did,
                    tid,
                    "Plan",
                    json.dumps({"blocks": [{"locator": "p1", "text": text}]}),
                ],
            )
        sid = con.execute(
            "INSERT INTO app.planned_sessions(date,sport,session_type,description,provenance) VALUES (?, 'running','tempo','Alouette spécifique',?) RETURNING id",
            [
                TODAY,
                json.dumps(
                    [
                        {"document_id": doc, "locator": "p1", "quote": "source"},
                        {
                            "document_id": foreign,
                            "locator": "p1",
                            "quote": "SECRET ETRANGER",
                        },
                    ]
                ),
            ],
        ).fetchone()[0]
    try:
        result = memory.search_personal_context(
            "Alouette", thread, TODAY, memory.SearchLimits(graph=True)
        )
        texts = " ".join(h.passage.text for h in result.hits)
        assert "90 secondes" in texts and "SECRET" not in texts
        assert any(
            h.path[0].startswith(f"planned:{sid}") and len(h.path) == 2
            for h in result.hits
        )
        assert not any(
            h.passage.source.startswith("document:")
            for h in memory.search_personal_context(
                "Alouette", None, TODAY, memory.SearchLimits(graph=True)
            ).hits
        )
        with db_connection() as con:
            con.execute("DELETE FROM app.coach_documents WHERE id = ?", [doc])
        assert not any(
            h.passage.source.startswith("document:")
            for h in memory.search_personal_context(
                "Alouette", thread, TODAY, memory.SearchLimits(graph=True)
            ).hits
        )
    finally:
        with db_connection() as con:
            con.execute(
                "DELETE FROM app.coach_documents WHERE id IN (?, ?)", [doc, foreign]
            )
            con.execute("DELETE FROM app.planned_sessions WHERE id = ?", [sid])


def test_journal_archive_search_and_explicit_bound(monkeypatch):
    from arete.services.memory import memory_root

    root = memory_root()
    root.mkdir(parents=True, exist_ok=True)
    (root / "sessions-2025-01.md").write_text(
        "## 2025-01-08 — décision\nReporter la traversée des Bauges."
    )
    result = memory.search_personal_context("Bauges", None, TODAY)
    assert result.hits and result.hits[0].passage.date == "2025-01-08"
    monkeypatch.setattr(memory, "MAX_CORPUS_BYTES", 10)
    with pytest.raises(facts.MemoryLimitExceeded):
        memory.search_personal_context("Bauges", None, TODAY)


def _request(context, question="Prépare ma semaine"):
    return ModelRequest(
        model=None,
        messages=[HumanMessage(question)],
        tools=[],
        system_message=SystemMessage("Instructions serveur"),
        runtime=type("Runtime", (), {"context": context})(),
        state={},
    )


def test_context_steering_is_independent_of_retrieval_and_refreshes():
    fact = facts.add_fact(
        "constraint", "Jamais le mercredi", evidence="explicit", since=TODAY
    )
    context = AgentContext(current_datetime=datetime.combine(TODAY, time(), UTC))
    request = _request(context)
    first = build_context(request)
    assert "Jamais le mercredi" in first.system_message.text
    assert context.stats.model_calls == 0 and context.stats.memory_searches == 1
    facts.update_fact(
        fact.id, text="Mercredi possible", expected_revision=1, evidence="explicit"
    )
    second = build_context(request)
    mandatory = second.system_message.text.split("Souvenirs retrouvés")[0]
    assert "Mercredi possible" in mandatory and "Jamais le mercredi" not in mandatory
    assert request.system_message.text == "Instructions serveur"


def test_memory_budget_and_missing_memory_are_explicit(monkeypatch):
    from arete.agent.context.builder import personal_context_section

    passage = memory.Passage("one", "source", "", "charge " * 500)
    result = memory.SearchResult((memory.Hit(passage, 1, ("one",)),), 1, 1, False, 1)
    monkeypatch.setattr(
        "arete.agent.context.builder.search_personal_context", lambda *_: result
    )
    context = AgentContext(current_datetime=datetime.combine(TODAY, time(), UTC))
    text = personal_context_section(_request(context), context, 100)
    assert '"selected": 0' in text or "budget" in text

    def fail(*_):
        raise OSError("unavailable")

    monkeypatch.setattr("arete.agent.context.builder.search_personal_context", fail)
    with pytest.raises(ValueError, match="mémoire indisponible"):
        personal_context_section(_request(context), context, 100)


def test_background_missions_never_search_or_gain_tools(monkeypatch):
    def unexpected(*_):
        raise AssertionError("Background search")

    monkeypatch.setattr(
        "arete.agent.context.builder.search_personal_context", unexpected
    )
    request = _request(
        AgentContext(
            profile="briefing", current_datetime=datetime.combine(TODAY, time(), UTC)
        )
    )
    assert build_context(request).tools == []


def test_tool_requires_explicit_evidence_and_rejects_stale_revision(memory_tool):
    missing_source = json.loads(
        memory_tool({"kind": "preference", "text": "Matin", "evidence": "explicit"})
    )
    assert "error" in missing_source
    saved = json.loads(
        memory_tool(
            {
                "kind": "preference",
                "text": "Matin",
                "evidence": "explicit",
                "source_ref": "Déclaration : je préfère le matin",
            }
        )
    )
    assert saved["fact"]["evidence"] == "explicit"
    fid = saved["fact"]["id"]
    facts.update_fact(fid, text="Soir", expected_revision=1)
    stale = json.loads(
        memory_tool(
            {
                "kind": "preference",
                "text": "Midi",
                "fact_id": fid,
                "expected_revision": 1,
            }
        )
    )
    assert "error" in stale
    assert facts.get_fact(fid).text == "Soir"


def test_duplicate_sources_are_deduplicated_without_losing_distinct_blocks():
    corpus = memory.Corpus()
    corpus.add("document:1:p1", "2026-10-10", "Premier bloc")
    corpus.add("document:1:p1", "2026-10-10", "Premier bloc")
    corpus.add("document:1:p1", "2026-10-10", "Deuxième bloc")
    assert len(corpus.passages) == 2
    assert len({p.id for p in corpus.passages}) == 2


def test_lexical_context_excludes_strava_session_text():
    from arete.garmin.models import ActivitySource, ActualSession
    from arete.garmin.repository import GarminRepository

    repo = GarminRepository()
    identifier = repo.create_actual_session(
        ActualSession(
            date=TODAY,
            sport="running",
            duration_sec=600,
            name="SecretStravaLexicalMarker",
            source=ActivitySource.STRAVA,
        )
    )
    try:
        result = memory.search_personal_context(
            "SecretStravaLexicalMarker", None, TODAY
        )
        assert not any(h.passage.source == f"actual:{identifier}" for h in result.hits)
    finally:
        with db_connection() as con:
            con.execute("DELETE FROM app.actual_sessions WHERE id=?", [identifier])
