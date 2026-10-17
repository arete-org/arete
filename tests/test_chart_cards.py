"""Charts cross the tool, transport and browser boundary without executing code."""

import asyncio
import json
import logging
import re
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from langchain.agents import create_agent
from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage, ToolMessage

from arete.agent.capabilities.discovery import authorized_tools, tool_available
from arete.agent.middlewares.capabilities import ToolkitMiddleware
from arete.agent.middlewares.events import ToolEventMiddleware
from arete.agent.runtime.context import AgentContext
from arete.agent.runtime.events import chart_card
from arete.agent.runtime.policy import slack_policy
from arete.agent.tools.charts import render_chart
from arete.services.charts import ChartSpec, validate_chart_html

SVG = '<svg viewBox="0 0 320 200" role="img" aria-label="Distance"><polyline class="series-blue chart-line" points="20,80 100,20"/></svg>'
ARGS = {
    "title": "Distance hebdomadaire",
    "summary": "20 puis 40 km, semaines 1 et 2. Source : séances enregistrées.",
    "html": SVG,
}


class Model(GenericFakeChatModel):
    def bind_tools(self, tools, **kwargs):
        return self


def graph_for(*calls):
    return create_agent(
        Model(
            messages=iter(
                [
                    AIMessage(
                        content="Je prépare le graphique.", tool_calls=list(calls)
                    ),
                    AIMessage(content="La distance passe de 20 à 40 km."),
                ]
            ),
            disable_streaming=True,
        ),
        tools=authorized_tools("chat"),
        context_schema=AgentContext,
        middleware=[ToolEventMiddleware(), ToolkitMiddleware()],
    )


def chart_call(identifier="chart", **overrides):
    return {
        "type": "tool_call",
        "id": identifier,
        "name": "render_chart",
        "args": {**ARGS, **overrides},
    }


@pytest.mark.parametrize(
    "markup",
    [
        "<script>alert(1)</script>",
        "<style>svg{display:none}</style>",
        '<a href="https://example.com">Lien</a>',
        '<img src="https://example.com/pixel">',
        '<iframe srcdoc="test"></iframe>',
        "<form></form>",
        '<meta http-equiv="refresh" content="0;url=https://example.com">',
        '<svg viewBox="0 0 10 10" onload="alert(1)"></svg>',
        '<svg viewBox="0 0 10 10" style="color:red"></svg>',
        '<svg viewBox="0 0 10 10"><use href="#shape"/></svg>',
        '<svg viewBox="0 0 10 10"><foreignObject><div>HTML</div></foreignObject></svg>',
        '<svg viewBox="0 0 10 10"><animate attributeName="href"/></svg>',
        '<svg viewBox="0 0 10 10"><path fill="url(https://example.com)"/></svg>',
        '<svg viewBox="0 0 10 10"><text class="unknown">Texte</text></svg>',
        '<svg viewBox="0 0 10 10"><rect width="NaN"/></svg>',
        '<svg viewBox="0 0 10 10"><rect width="1e99"/></svg>',
        '<svg viewBox="0 0 10 10"><path d="M0,0 L1e99,5"/></svg>',
        '<svg viewBox="0 0 10 10"><g transform="scale(1e99)"></g></svg>',
        '<svg viewBox="0 0 10 10"><rect width="-1"/></svg>',
        '<svg viewBox="0 0 10 10"><g></svg>',
        '<svg viewBox="0 0 10 10" viewBox="0 0 20 20"></svg>',
        '<svg viewBox="0 0 10 0"></svg>',
        "<svg></svg>",
        "<text>Orphelin</text>",
        "<!DOCTYPE html>" + SVG,
        '<?xml version="1.0"?>' + SVG,
        "<!-- commentaire -->" + SVG,
        SVG + "\x00",
    ],
)
def test_rejects_unsupported_markup_instead_of_silently_changing_it(markup):
    with pytest.raises(ValueError):
        validate_chart_html(markup)


def test_normalizes_only_safe_markup_and_escapes_data():
    html = validate_chart_html(SVG.replace('Distance"', 'Distance &amp; durée"'))
    assert 'viewBox="0 0 320 200"' in html
    assert 'aria-label="Distance &amp; durée"' in html
    assert "</polyline>" in html
    assert validate_chart_html(html) == html


def test_byte_element_and_depth_limits_are_explicit():
    root = '<svg viewBox="0 0 320 200">'
    validate_chart_html(root + "<rect/>" * 511 + "</svg>")
    validate_chart_html(root + "<g>" * 15 + "</g>" * 15 + "</svg>")
    for html in [
        root + "<rect/>" * 512 + "</svg>",
        root + "<g>" * 16 + "</g>" * 16 + "</svg>",
        root + "<desc>" + "🏃" * 4096 + "</desc></svg>",
    ]:
        with pytest.raises(ValueError):
            validate_chart_html(html)


@pytest.mark.parametrize(
    "overrides",
    [
        {"title": " "},
        {"title": "x" * 121},
        {"summary": ""},
        {"summary": "x" * 601},
        {"height_px": 159},
        {"height_px": 481},
        {"height_px": True},
        {"height_px": "280"},
        {"extra": "ignored?"},
    ],
)
def test_invalid_arguments_never_become_a_card(overrides):
    with pytest.raises(ValueError):
        ChartSpec(**{**ARGS, **overrides})


def test_skill_examples_use_the_actual_authoring_contract():
    path = (
        Path(__file__).resolve().parents[1]
        / "src/arete/agent/skills/system/chart-rendering/SKILL.md"
    )
    examples = re.findall(r"```html\n(.*?)\n```", path.read_text(), re.DOTALL)
    assert len(examples) == 2
    for example in examples:
        validate_chart_html(example)


def test_chart_skill_reads_natively_then_renders_without_auxiliary_calls(
    monkeypatch, tmp_path, caplog, client
):
    from arete.agent.backends.skills import SystemSkillsBackend
    from arete.agent.factory import build_agent
    from arete.agent.middlewares.skills import SystemSkillsMiddleware
    from arete.agent.profiles.catalog import CHAT_PROFILE
    from arete.agent.runtime.execution import invoke_agent
    from arete.coaching import build_agent_filesystem

    monkeypatch.setattr("arete.services.memory.memory_root", lambda: tmp_path)
    caplog.set_level(logging.INFO, logger="arete.observability.agent")
    skill_path = "/skills/system/chart-rendering/SKILL.md"
    catalog = client.get("/agent/skills").json()
    assert any(
        skill["name"] == "chart-rendering" and skill["path"] == skill_path
        for skill in catalog
    )
    body = (
        Path(__file__).resolve().parents[1]
        / "src/arete/agent/skills/system/chart-rendering/SKILL.md"
    ).read_text()
    snapshot = {"/chart-rendering/SKILL.md": body}
    filesystem = build_agent_filesystem(system_skills=SystemSkillsBackend(snapshot))
    requests = []

    class CaptureSkills(SystemSkillsMiddleware):
        async def awrap_model_call(self, request, handler):
            requests.append(request)
            return await handler(request)

    graph = build_agent(
        CHAT_PROFILE,
        model=Model(
            messages=iter(
                [
                    AIMessage(
                        content="",
                        tool_calls=[
                            {
                                "name": "read_file",
                                "args": {"file_path": skill_path},
                                "id": "read",
                            }
                        ],
                    ),
                    AIMessage(content="", tool_calls=[chart_call()]),
                    AIMessage(content="La distance passe de 20 à 40 km."),
                ]
            ),
            disable_streaming=True,
        ),
        context_tokens=128_000,
        output_tokens=8_000,
        filesystem=filesystem,
        skills=CaptureSkills(backend=filesystem.backend, paths=set(snapshot)),
    )
    context = AgentContext()
    context.garmin_freshness = {"state": "fresh"}
    asyncio.run(
        invoke_agent(
            graph,
            {
                "messages": [
                    {"role": "user", "content": "/chart-rendering Trace ma distance."}
                ]
            },
            context=context,
        )
    )
    assert context.stats.model_calls == 3
    assert context.stats.skill_reads == 1
    assert len(context.chart_cards) == 1
    assert all(body not in request.system_message.text for request in requests)
    assert not any(isinstance(message, ToolMessage) for message in requests[0].messages)
    assert any(
        isinstance(message, ToolMessage) and "viewBox" in message.text
        for message in requests[1].messages
    )
    assert any(
        "profile=chat calls=3 tools=2" in record.getMessage()
        for record in caplog.records
    )


@pytest.mark.parametrize(
    "profile", ["slack", "automation", "briefing", "feedback", "review"]
)
def test_charts_are_only_available_to_browser_chat(profile):
    assert tool_available("chat", "render_chart")
    assert not tool_available(profile, "render_chart")
    assert "render_chart" not in {tool.name for tool in authorized_tools(profile)}


def test_slack_coaching_policy_does_not_inherit_browser_rendering():
    context = AgentContext(profile="slack")
    context.slack_product = SimpleNamespace(private=False)
    context.slack_decision = SimpleNamespace(
        surface="coach", private_data=False, outbound=False
    )
    assert not tool_available(slack_policy(context), "render_chart")


@pytest.mark.parametrize("async_mode", [False, True])
def test_native_tool_results_keep_artifact_out_of_model_receipt(async_mode):
    graph = graph_for(
        chart_call(), chart_call("invalid", html="<script>bad()</script>")
    )
    context = AgentContext()
    context.page_section = "Page déjà lue"
    args = ({"messages": [{"role": "user", "content": "Trace ma distance."}]},)
    kwargs = {"context": context, "config": {"recursion_limit": 10}}
    result = (
        asyncio.run(graph.ainvoke(*args, **kwargs))
        if async_mode
        else graph.invoke(*args, **kwargs)
    )
    messages = [
        message for message in result["messages"] if isinstance(message, ToolMessage)
    ]
    good = next(message for message in messages if message.tool_call_id == "chart")
    bad = next(message for message in messages if message.tool_call_id == "invalid")
    assert good.status == "success" and json.loads(good.content)["rendered"]
    assert "<svg" not in good.content
    assert good.artifact["html"] == validate_chart_html(SVG)
    assert chart_card(good)["html"] == good.artifact["html"]
    assert bad.status == "error" and chart_card(bad) is None
    assert len(context.chart_cards) == 1
    assert context.page_section == "Page déjà lue"


def test_parallel_tools_share_only_their_invocation_bound():
    contexts = [AgentContext(), AgentContext()]

    def invoke(index):
        return render_chart.func(
            **ARGS,
            runtime=SimpleNamespace(
                context=contexts[index // 8], tool_call_id=f"chart-{index % 8}"
            ),
        )

    with ThreadPoolExecutor(max_workers=4) as executor:
        results = list(executor.map(invoke, range(16)))
    assert sum(result.status == "success" for result in results) == 8
    assert all(len(context.chart_cards) == 4 for context in contexts)
    assert not contexts[0].chart_cards.keys() & contexts[1].chart_cards.keys()


@pytest.mark.parametrize("supports", [False, True])
def test_http_stream_negotiates_chart_events_and_keeps_the_answer(client, supports):
    with patch(
        "arete.api.agent.get_agent",
        return_value=graph_for(chart_call(), chart_call("bad", height_px=999)),
    ):
        response = client.post(
            "/agent/chat/stream",
            json={
                "messages": [{"role": "user", "content": "Trace ma distance."}],
                **({"supports_chart_cards": True} if supports else {}),
            },
        )
    assert response.status_code == 200
    events = [
        json.loads(line[6:])
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]
    charts = [event for event in events if event["type"] == "chart_card"]
    assert len(charts) == int(supports)
    if supports:
        assert charts[0]["html"] == validate_chart_html(SVG)
        assert events.index(charts[0]) < len(events) - 1
    assert events[-1]["type"] == "done"
    assert "20 à 40 km" in events[-1]["message"]["content"]
    assert len([event for event in events if event["type"] == "tool_start"]) == 2


def test_nonstreaming_response_retains_cards_without_tool_history(client):
    async def compacted(_graph, _state, *, context):
        render_chart.func(
            **ARGS, runtime=SimpleNamespace(context=context, tool_call_id="chart")
        )
        # Native compaction can remove tool messages; HTTP must use the receipt.
        return {"messages": [AIMessage(content="La distance a doublé.")]}

    with (
        patch("arete.api.agent.get_agent", return_value=object()),
        patch("arete.api.agent.invoke_agent", side_effect=compacted),
    ):
        response = client.post(
            "/agent/chat",
            json={"messages": [{"role": "user", "content": "Trace ma distance."}]},
        )
    assert response.status_code == 200
    assert response.json()["charts"][0]["html"] == validate_chart_html(SVG)
    assert response.json()["message"]["content"] == "La distance a doublé."
