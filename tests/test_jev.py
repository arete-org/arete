"""Reusable Jev Decisions transport contracts, independent of Slack routing."""

import asyncio
import json

import httpx
import pytest
from pydantic import SecretStr

from arete.services.jev import (
    JEV_MAX_QUESTIONS,
    JEV_MAX_REQUEST_BYTES,
    JEV_MODEL,
    JEV_PROVIDER,
    JEV_TIMEOUT,
    ChoiceAnswer,
    JevService,
    NoulAnswer,
    ScoreAnswer,
)


def decision_request():
    return JevService(SecretStr("test-secret"), JEV_MODEL, JEV_TIMEOUT).build_request(
        state={"ticket": "Le paiement ne fonctionne plus."},
        questions={
            "team": {
                "type": "choice",
                "instructions": "Qui traite ce ticket ?",
                "criteria": {"billing": "Paiement", "account": "Compte"},
            },
            "is_bug": {
                "type": "noul",
                "instructions": "Est-ce un bug ?",
                "criteria": {"true": "Erreur", "false": "Question"},
            },
            "priority": {
                "type": "score",
                "instructions": "Quelle urgence ?",
                "criteria": ["Faible", "Moyenne", "Forte"],
            },
        },
    )


def call(request):
    return asyncio.run(
        JevService(
            api_key=SecretStr("test-secret"), model=JEV_MODEL, timeout=JEV_TIMEOUT
        ).decide(request)
    )


@pytest.fixture
def decisions_api(jev_api):
    jev_api.payload["answers"] = {
        "team": {
            "type": "choice",
            "choice": "billing",
            "confidence": 0.9,
            "probabilities": {"billing": 0.95, "account": 0.05},
        },
        "is_bug": {"type": "noul", "noul": 0.96},
        "priority": {"type": "score", "score": 1.8},
    }
    return jev_api


def test_service_supports_all_three_primitives_in_one_request(decisions_api):
    request = decision_request()
    response = call(request)
    assert isinstance(response.answers["team"], ChoiceAnswer)
    assert isinstance(response.answers["is_bug"], NoulAnswer)
    assert isinstance(response.answers["priority"], ScoreAnswer)
    assert response.answers["is_bug"].noul == 0.96
    assert len(decisions_api.requests) == 1
    sent = decisions_api.requests[0]
    assert json.loads(sent.content) == request
    assert sent.headers["Authorization"] == "Bearer test-secret"
    assert sent.headers["Content-Type"] == "application/json"
    assert sent.extensions["timeout"] == dict.fromkeys(
        ("connect", "read", "write", "pool"), 15
    )
    assert "test-secret" not in repr(
        JevService(SecretStr("test-secret"), JEV_MODEL, 15)
    )


@pytest.mark.parametrize(
    "kind", ["wrong_type", "noul_range", "score_range", "nan", "missing_usage"]
)
def test_service_rejects_invalid_typed_responses(decisions_api, kind):
    answers = decisions_api.payload["answers"]
    if kind == "wrong_type":
        answers["team"] = {"type": "noul", "noul": 0.5}
    elif kind == "noul_range":
        answers["is_bug"]["noul"] = -0.1
    elif kind == "score_range":
        answers["priority"]["score"] = 3
    elif kind == "nan":
        answers["priority"]["score"] = "NaN"
    else:
        del decisions_api.payload["usage"]
    with pytest.raises(ValueError):
        call(decision_request())
    assert len(decisions_api.requests) == 1


@pytest.mark.parametrize("bound", ["bytes", "questions"])
def test_service_bounds_input_before_http(decisions_api, bound):
    request = decision_request()
    if bound == "bytes":
        request["state"] = "x" * JEV_MAX_REQUEST_BYTES
        error = ValueError
    else:
        request["questions"] = {
            str(i): request["questions"]["team"] for i in range(JEV_MAX_QUESTIONS + 1)
        }
        error = AssertionError
    with pytest.raises(error):
        call(request)
    assert not decisions_api.requests


def test_service_connection_failure_is_not_retried(decisions_api):
    async def disconnect(request):
        raise httpx.ConnectError("connection failed", request=request)

    decisions_api.handler = disconnect
    with pytest.raises(httpx.ConnectError):
        call(decision_request())
    assert len(decisions_api.requests) == 1


def test_request_snapshots_do_not_share_provider_or_caller_state():
    service = JevService(SecretStr("test"), JEV_MODEL, JEV_TIMEOUT)
    state = {"messages": ["Original"]}
    questions = decision_request()["questions"]
    first = service.build_request(state=state, questions=questions, session_id="first")
    second = service.build_request(
        state=state, questions=questions, session_id="second"
    )
    first["state"]["messages"].append("Changed")
    first["questions"]["team"]["criteria"].clear()
    first["provider"]["max_price"]["prompt"] = 100
    assert second["state"] == state == {"messages": ["Original"]}
    assert second["questions"] == questions
    assert second["provider"] == JEV_PROVIDER
    assert first["session_id"] != second["session_id"]


def test_price_cap_cannot_be_removed_from_a_request(decisions_api):
    request = decision_request()
    request["provider"] = {}
    with pytest.raises(AssertionError, match="price cap"):
        call(request)
    assert not decisions_api.requests


def test_service_logs_usage_even_when_a_decision_is_rejected(decisions_api, caplog):
    import logging

    decisions_api.payload["answers"]["team"]["choice"] = "unknown"
    with caplog.at_level(logging.INFO), pytest.raises(ValueError):
        call(decision_request())
    records = [r for r in caplog.records if r.message.startswith("Agent model call:")]
    assert len(records) == 1
    assert "input_tokens" in records[0].message and "cost" in records[0].message
    assert "error=ValueError" in records[0].message
    assert "test-secret" not in records[0].message
