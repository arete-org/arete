"""Analytics toolkit: narrow reads over the existing metrics/analytics routes.

The routes carry their bounds in FastAPI ``Query`` metadata, which does
nothing when the function is called directly — so the tools must validate
their own arguments, and these tests are what say they do.
"""

from __future__ import annotations

import json

from arete.agent.capabilities.registry import ANALYTICS_INSTRUCTIONS, CAPABILITIES
from arete.agent.tools.analytics import (
    ANALYTICS_TOOLS,
    get_fitness,
    get_training_advice,
    get_workload,
    list_recent_sessions,
)

# ---------------------------------------------------------------------------
# Registration
# ---------------------------------------------------------------------------


def test_analytics_toolkit_registered():
    tk = CAPABILITIES["analytics"]
    assert {t.name for t in tk.tools} == {
        "get_workload",
        "get_fitness",
        "get_training_advice",
        "list_recent_sessions",
        "get_activity_detail",
    }
    assert tk.instructions == ANALYTICS_INSTRUCTIONS
    # Read-only: background profiles may run it, it writes nothing.
    assert "get_activity_detail" in tk.read_tools


def test_tool_names_match_the_registry():
    assert {t.name for t in ANALYTICS_TOOLS} == {
        t.name for t in CAPABILITIES["analytics"].tools
    }


def test_every_tool_documents_itself():
    # The description is the only thing the model sees when picking a tool.
    for tool in ANALYTICS_TOOLS:
        assert tool.description and len(tool.description) > 40, tool.name


# ---------------------------------------------------------------------------
# Reads against the (empty) test database — they must answer, not raise
# ---------------------------------------------------------------------------


def test_workload_reads_the_default_window():
    out = json.loads(get_workload.invoke({}))
    assert "acwr" in out and "window_days" in out


def test_the_window_is_told_apart_from_the_data_coverage():
    """`days_analyzed` next to a `days` argument read as the window.

    Models duly wrote "ACWR sur 5 jours" for a 28-day request. The tool
    boundary now names both explicitly rather than asking them to be careful.
    """
    out = json.loads(get_workload.invoke({"days": 28}))
    assert out["window_days"] == 28
    assert "days_with_data" in out
    assert "days_analyzed" not in out

    out = json.loads(get_fitness.invoke({"days": 60}))
    assert out["window_days"] == 60
    assert "days_with_data" in out
    assert "days_analyzed" not in out


def test_fitness_reads_the_default_window():
    out = json.loads(get_fitness.invoke({}))
    assert {"ctl", "atl", "tsb", "form_zone"} <= set(out)


def test_two_windows_are_comparable():
    # The point of the toolkit: the same metric over two periods, which the
    # fixed 30-day page dump cannot give. Both windows carry ACWR here; a
    # window under 28 days is covered by TestAcwrNeedsEnoughHistory.
    short = json.loads(get_workload.invoke({"days": 28}))
    long = json.loads(get_workload.invoke({"days": 90}))
    assert "acwr" in short and "acwr" in long
    assert short["window_days"] == 28 and long["window_days"] == 90


def test_advice_answers_even_without_data():
    out = json.loads(get_training_advice.invoke({}))
    assert "risk_level" in out and isinstance(out["recommendations"], list)


def test_recent_sessions_answer_shape():
    out = json.loads(list_recent_sessions.invoke({"limit": 5}))
    assert isinstance(out["sessions"], list)


# ---------------------------------------------------------------------------
# Bounds — the routes' Query metadata does not apply to a direct call
# ---------------------------------------------------------------------------


def test_workload_rejects_a_window_outside_the_route_bounds():
    assert "error" in json.loads(get_workload.invoke({"days": 5}))
    assert "error" in json.loads(get_workload.invoke({"days": 400}))


def test_fitness_rejects_a_window_outside_the_route_bounds():
    assert "error" in json.loads(get_fitness.invoke({"days": 3}))
    assert "error" in json.loads(get_fitness.invoke({"days": 500}))


def test_advice_rejects_an_unknown_sport_type():
    out = json.loads(get_training_advice.invoke({"sport_type": "yoga"}))
    assert "error" in out


def test_recent_sessions_rejects_bad_paging():
    assert "error" in json.loads(list_recent_sessions.invoke({"limit": 0}))
    assert "error" in json.loads(list_recent_sessions.invoke({"limit": 5000}))
    assert "error" in json.loads(list_recent_sessions.invoke({"offset": -1}))


def test_errors_never_raise_out_of_a_tool():
    # A failing read must reach the model as an error payload, not kill the run.
    import arete.services.metrics as metrics

    original = metrics.get_workload_metrics
    metrics.get_workload_metrics = lambda days: (_ for _ in ()).throw(
        RuntimeError("duckdb is away")
    )
    try:
        out = json.loads(get_workload.invoke({"days": 28}))
    finally:
        metrics.get_workload_metrics = original
    assert out["error"].startswith("RuntimeError")


def test_oversized_result_degrades_to_an_error_not_a_truncation():
    import arete.agent.tools.analytics as mod

    original = mod.MAX_TOOL_OUTPUT_CHARS
    mod.MAX_TOOL_OUTPUT_CHARS = 10
    try:
        out = json.loads(get_workload.invoke({"days": 28}))
    finally:
        mod.MAX_TOOL_OUTPUT_CHARS = original
    assert "too large" in out["error"]


# ---------------------------------------------------------------------------
# Through the graph: search -> load -> use, on the async path the panel uses
# ---------------------------------------------------------------------------


def test_full_graph_search_load_then_read():
    from langchain.agents import create_agent
    from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
    from langchain_core.messages import AIMessage

    from arete.agent.capabilities.discovery import authorized_tools
    from arete.agent.middlewares.capabilities import ToolkitMiddleware
    from arete.agent.runtime.context import AgentContext

    class FakeToolModel(GenericFakeChatModel):
        def bind_tools(self, tools, **kwargs):
            return self

    def call(name, args, call_id):
        return AIMessage(
            content="",
            tool_calls=[
                {"name": name, "args": args, "id": call_id, "type": "tool_call"}
            ],
        )

    messages = iter(
        [
            call("get_workload", {"days": 28}, "3"),
            AIMessage(content="Ta charge est stable."),
        ]
    )
    graph = create_agent(
        FakeToolModel(messages=messages),
        tools=authorized_tools("chat"),
        middleware=[ToolkitMiddleware()],
        system_prompt="t",
        context_schema=AgentContext,
    )
    result = graph.invoke(
        {"messages": [{"role": "user", "content": "ma charge ?"}]},
        context=AgentContext(source={}),
        config={"recursion_limit": 12},
    )

    contents = [m.content for m in result["messages"] if m.type == "tool"]
    # The toolkit tool ran: the ToolNode does not know it, the middleware does.
    assert "acwr" in json.loads(contents[0])


def test_loading_analytics_leaves_planning_out_of_the_request():
    # Progressive loading still holds with two toolkits registered.
    from arete.agent.capabilities.discovery import authorized_tools

    names = {getattr(t, "name", "") for t in authorized_tools("chat")}
    assert "get_workload" in names
    assert "create_planned_session" in names


class TestAcwrNeedsEnoughHistory:
    """A short window cannot produce an acute:chronic ratio.

    Chronic load averages four weekly sums over 28 days. Fetch only seven and
    the last three weeks are empty, the denominator collapses, and the ratio
    explodes — the coach read 3.2 "danger" on a 7-day window the same day the
    28-day window read 0.99 "optimal".
    """

    def test_a_short_window_omits_the_ratio_and_says_why(self):
        out = json.loads(get_workload.invoke({"days": 7}))
        assert "acwr" not in out
        assert "acwr_zone" not in out
        assert "28" in out["acwr_unavailable"]

    def test_what_a_short_window_can_answer_is_still_there(self):
        out = json.loads(get_workload.invoke({"days": 7}))
        # Monotony, strain and acute load are 7-day concepts: still valid.
        assert "monotony" in out and "strain" in out and "acute_load" in out

    def test_a_full_window_reports_the_ratio(self):
        out = json.loads(get_workload.invoke({"days": 28}))
        assert "acwr" in out
        assert "acwr_unavailable" not in out
