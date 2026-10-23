"""Semantic memory decisions never weaken provenance, time or concurrency."""

import asyncio
import json
from dataclasses import replace
from datetime import date, timedelta
from unittest.mock import AsyncMock

import pytest
from anyio import to_thread

from arete.dataio.db import db_connection
from arete.services import athlete_facts as facts
from arete.services.fact_memory import (
    MAX_CANDIDATES,
    FactDraft,
    MemoryDecision,
    candidates,
    remember,
)

TODAY = date(2026, 10, 12)


@pytest.fixture(autouse=True)
def clean():
    with db_connection() as con:
        con.execute("DELETE FROM app.athlete_fact_revisions")
        con.execute("DELETE FROM app.athlete_facts")
    yield
    with db_connection() as con:
        con.execute("DELETE FROM app.athlete_fact_revisions")
        con.execute("DELETE FROM app.athlete_facts")


def draft(text="Je cours le matin", **changes):
    return replace(
        FactDraft("preference", text, "explicit", "chat:test:quote", TODAY, None),
        **changes,
    )


def response(choices, choice, probability=1.0):
    other = (1 - probability) / (len(choices) - 1) if len(choices) > 1 else 0
    return MemoryDecision(
        type="choice",
        choice=choice,
        confidence=probability,
        probabilities={key: probability if key == choice else other for key in choices},
    )


def classifier(choice, probability=1.0):
    async def classify(state, choices):
        return response(choices, choice, probability)

    return AsyncMock(side_effect=classify)


def test_first_fact_and_exact_repeat_need_no_model_and_report_truthful_receipts():
    decide = AsyncMock(side_effect=AssertionError("No semantic decision needed"))
    first = asyncio.run(remember(draft(), classify=decide))
    repeat = asyncio.run(remember(draft("  JE cours le matin "), classify=decide))
    assert first["action"] == "created" and first["saved"]
    assert repeat["action"] == "already_present" and not repeat["saved"]
    assert repeat["fact"]["id"] == first["fact"]["id"]
    decide.assert_not_called()


@pytest.mark.parametrize(
    "probability,action", [(0.9, "already_present"), (0.89, "created")]
)
def test_semantic_duplicate_requires_threshold_and_returns_real_fact(
    probability, action
):
    original = facts.add_fact(**draft().fields())
    decide = classifier(f"duplicate_{original.id}", probability)
    result = asyncio.run(
        remember(draft("Mes entraînements se font en matinée"), classify=decide)
    )
    assert result["action"] == action
    assert len(facts.list_facts()) == (1 if action == "already_present" else 2)
    if action == "already_present":
        assert result["fact"] == original.to_dict()
        assert len(facts.fact_history(original.id)) == 1
    state = decide.call_args.args[0]
    assert state["candidates"][str(original.id)] == original.text
    assert "source_ref" not in state  # The classifier doesn't need source identity.


def test_contradiction_requires_clarification_without_rewriting_either_fact():
    original = facts.add_fact(**draft().fields())
    result = asyncio.run(
        remember(
            draft("Jamais le matin"),
            classify=classifier(f"contradiction_{original.id}", 0.7),
        )
    )
    assert result["action"] == "needs_clarification" and not result["saved"]
    assert result["fact"] == original.to_dict()
    assert facts.list_facts() == [original]


@pytest.mark.parametrize("change", ["edit", "delete", "insert"])
@pytest.mark.parametrize("choice", ["create", "duplicate"])
def test_changed_snapshot_cannot_commit_or_suppress_a_fact(change, choice):
    original = facts.add_fact(**draft().fields())

    async def decide(state, choices):
        if change == "edit":
            await to_thread.run_sync(
                lambda: facts.update_fact(original.id, text="Soir", expected_revision=1)
            )
        elif change == "delete":
            await to_thread.run_sync(
                lambda: facts.delete_fact(original.id, expected_revision=1)
            )
        else:
            await to_thread.run_sync(
                lambda: facts.add_fact(**draft("Matinée").fields())
            )
        return response(
            choices, "create" if choice == "create" else f"duplicate_{original.id}"
        )

    with pytest.raises(facts.FactConflict, match="mémoire a changé"):
        asyncio.run(remember(draft("Matinée"), classify=decide))
    assert len(facts.list_facts()) == {"edit": 1, "delete": 0, "insert": 2}[change]


@pytest.mark.parametrize("change", ["hypothesis", "exception", "resolved", "expired"])
def test_evidence_and_validity_cannot_be_collapsed(change):
    original = facts.add_fact(**draft().fields())
    proposed = draft("Matinée")
    if change == "hypothesis":
        proposed = replace(proposed, evidence="hypothesis")
    elif change == "exception":
        proposed = replace(proposed, valid_until=TODAY + timedelta(days=3))
    elif change == "resolved":
        facts.update_fact(original.id, status="resolved")
    else:
        facts.update_fact(original.id, valid_until=TODAY)
        proposed = replace(
            proposed,
            since=TODAY + timedelta(days=1),
            valid_until=TODAY + timedelta(days=3),
        )
    decide = AsyncMock(side_effect=AssertionError("No comparable candidates"))
    result = asyncio.run(remember(proposed, classify=decide))
    assert result["action"] == "created"
    decide.assert_not_called()


def test_complete_candidates_are_bounded_and_include_zero_overlap_paraphrases():
    originals = [
        facts.add_fact(**draft(f"Entraînement {i} " + "é" * 260).fields())
        for i in range(9)
    ]
    selected = candidates(draft("Course au lever du soleil"), originals)
    assert len(selected) == MAX_CANDIDATES
    assert all(f.text.endswith("é" * 260) for f in selected)


def test_classifier_errors_and_unknown_targets_fail_without_writes():
    facts.add_fact(**draft().fields())
    with pytest.raises(ValueError, match="unavailable"):
        asyncio.run(
            remember(
                draft("Matinée"),
                classify=AsyncMock(side_effect=ValueError("unavailable")),
            )
        )
    with pytest.raises(ValueError, match="choix proposés"):
        asyncio.run(
            remember(
                draft("Matinée"),
                classify=AsyncMock(
                    return_value=response({"duplicate_999": "unknown"}, "duplicate_999")
                ),
            )
        )
    assert len(facts.list_facts()) == 1


def test_memory_lifecycle_after_semantic_reuse():
    original = facts.add_fact(**draft().fields())
    result = asyncio.run(
        remember(draft("Matinée"), classify=classifier(f"duplicate_{original.id}"))
    )
    assert result["action"] == "already_present"
    assert original.text in facts.facts_block(TODAY)
    changed = facts.update_fact(
        original.id, text="Le soir", expected_revision=1, valid_until=TODAY
    )
    assert changed.revision == 2
    assert "Le soir" in facts.facts_block(TODAY)
    assert "Le soir" not in facts.facts_block(TODAY + timedelta(days=1))
    assert facts.delete_fact(original.id, expected_revision=2)
    assert facts.fact_history(original.id) == []
    assert facts.facts_block(TODAY) == ""


def test_explicit_source_is_grounded_and_identity_is_server_owned(memory_tool):
    args = {"kind": "preference", "text": "Courir le matin", "evidence": "explicit"}
    invalid = json.loads(memory_tool({**args, "source_ref": "assistant says so"}))
    assert "error" in invalid and not facts.list_facts()
    valid = json.loads(memory_tool({**args, "source_ref": "je préfère le matin"}))
    assert valid["fact"]["source_ref"].startswith("chat:")
    assert valid["fact"]["source_ref"].endswith(": je préfère le matin")
    assert (
        "runtime"
        not in __import__(
            "arete.agent.tools.fact_memory", fromlist=["remember_fact"]
        ).remember_fact.tool_call_schema["properties"]
    )


def test_concurrent_semantic_creations_cannot_both_commit():
    facts.add_fact(**draft("Je cours sur route").fields())

    async def run():
        barrier = asyncio.Event()
        ready = 0

        async def decide(state, choices):
            nonlocal ready
            ready += 1
            if ready == 2:
                barrier.set()
            async with asyncio.timeout(2):
                await barrier.wait()
            return response(choices, "create")

        return await asyncio.gather(
            remember(draft("Je préfère courir le matin"), classify=decide),
            remember(draft("Je préfère courir en matinée"), classify=decide),
            return_exceptions=True,
        )

    results = asyncio.run(run())
    assert sum(isinstance(r, dict) and r["action"] == "created" for r in results) == 1
    assert sum(isinstance(r, facts.FactConflict) for r in results) == 1
    assert len(facts.list_facts()) == 2


def test_cancelled_classification_does_not_write():
    facts.add_fact(**draft().fields())

    async def run():
        started = asyncio.Event()

        async def decide(state, choices):
            started.set()
            await asyncio.sleep(5)
            return response(choices, "create")

        task = asyncio.create_task(remember(draft("Soir"), classify=decide))
        async with asyncio.timeout(2):
            await started.wait()
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task

    asyncio.run(run())
    assert len(facts.list_facts()) == 1


@pytest.mark.parametrize(
    "action,saved,has_card",
    [
        ("created", True, True),
        ("updated", True, True),
        ("already_present", False, False),
        ("needs_clarification", False, False),
    ],
)
def test_only_actual_writes_emit_memory_update_cards(action, saved, has_card):
    from langchain_core.messages import ToolMessage

    from arete.agent.runtime.events import coach_card

    message = ToolMessage(
        name="remember_fact",
        tool_call_id="save",
        content=json.dumps(
            {
                "action": action,
                "saved": saved,
                "fact": {"id": 1},
            }
        ),
    )
    assert (coach_card(message) is not None) == has_card
