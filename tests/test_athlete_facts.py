"""Durable, editable facts about the athlete, given to every model call."""

from __future__ import annotations

import json
from datetime import date

import pytest

from arete.dataio.db import connect
from arete.services import athlete_facts


@pytest.fixture(autouse=True)
def _clean():
    con = connect()
    con.execute("DELETE FROM app.athlete_facts")
    con.close()
    yield
    con = connect()
    con.execute("DELETE FROM app.athlete_facts")
    con.close()


def test_active_facts_reach_the_prompt_and_resolved_ones_leave_it():
    knee = athlete_facts.add_fact(
        "injury", "Douleur genou droit en descente", since=date(2026, 9, 2)
    )
    athlete_facts.add_fact("constraint", "Pas de séance le mercredi (garde d'enfants)")
    block = athlete_facts.facts_block()
    assert f"#{knee.id}" in block
    assert "Douleur genou droit" in block
    assert "2026-09-02" in block
    assert "contrainte" in block
    athlete_facts.update_fact(knee.id, status="resolved")
    assert "genou" not in athlete_facts.facts_block()
    assert len(athlete_facts.list_facts()) == 2  # kept, just not in the prompt


def test_no_fact_no_block_and_bad_input_refused():
    assert athlete_facts.facts_block() == ""
    with pytest.raises(ValueError):
        athlete_facts.add_fact("mood", "x")
    with pytest.raises(ValueError):
        athlete_facts.add_fact("other", "x" * 301)


def test_the_tool_records_corrects_and_closes(memory_tool):
    saved = json.loads(
        memory_tool({"kind": "injury", "text": "Tendon d'Achille sensible"})
    )
    fact_id = saved["fact"]["id"]
    assert saved["fact"]["source"] == "coach"
    closed = json.loads(
        memory_tool(
            {
                "kind": "injury",
                "text": "Tendon d'Achille guéri",
                "fact_id": fact_id,
                "status": "resolved",
            }
        )
    )
    assert closed["fact"]["status"] == "resolved"
    assert "error" in json.loads(
        memory_tool({"kind": "injury", "text": "x", "fact_id": 999999})
    )
    assert "error" in json.loads(
        memory_tool({"kind": "goal", "text": "x", "status": "resolved"})
    )


def test_the_context_carries_the_facts():
    from unittest.mock import MagicMock

    from arete.agent.context.builder import build_context

    athlete_facts.add_fact("preference", "Préfère courir le matin")
    request = MagicMock()
    request.runtime.context = None
    request.state = {}
    request.tools = []
    request.system_message = None
    build_context(request)
    system = request.override.call_args.kwargs["system_message"].text
    assert "Préfère courir le matin" in system


def test_the_routes(router_client):
    from arete.api.athlete_facts import router

    client = router_client(router)
    created = client.post(
        "/athlete-facts", json={"kind": "goal", "text": "Semi sous 1h30"}
    )
    assert created.status_code == 201 and created.json()["source"] == "athlete"
    fact_id = created.json()["id"]
    assert (
        client.patch(f"/athlete-facts/{fact_id}", json={"status": "resolved"}).json()[
            "status"
        ]
        == "resolved"
    )
    assert [f["id"] for f in client.get("/athlete-facts").json()] == [fact_id]
    assert (
        client.delete(f"/athlete-facts/{fact_id}?expected_revision=2").status_code
        == 204
    )
    assert client.delete(f"/athlete-facts/{fact_id}").status_code == 404
    assert (
        client.post("/athlete-facts", json={"kind": "mood", "text": "x"}).status_code
        == 422
    )


def test_repeated_declaration_reuses_the_fact_without_inventing_more_evidence():
    original = athlete_facts.add_fact(
        "preference",
        "Je préfère m’entraîner le matin",
        evidence="explicit",
        source_ref="message original",
    )
    repeated = athlete_facts.add_fact(
        "preference",
        "  je préfère m'entraîner  le matin ",
        evidence="explicit",
        source_ref="autre mention",
    )
    assert repeated.id == original.id
    assert repeated.revision == 1
    assert repeated.source_ref == "message original"
    assert len(athlete_facts.list_facts()) == 1
    hypothesis = athlete_facts.add_fact(
        "preference", original.text, evidence="hypothesis"
    )
    assert hypothesis.id != original.id
    assert hypothesis.evidence == "hypothesis"


def test_resolved_fact_cannot_be_recreated_by_repeating_a_tool_call():
    original = athlete_facts.add_fact("preference", "Matin", evidence="explicit")
    athlete_facts.update_fact(original.id, status="resolved", expected_revision=1)
    with pytest.raises(athlete_facts.FactConflict, match="désactivé"):
        athlete_facts.add_fact("preference", "Matin", evidence="explicit")
    assert len(athlete_facts.list_facts()) == 1
