"""What the coaching agent sends to the model, broken down, in tokens.

Usage:
    ARETE_DB=/path/to/a/copy.duckdb uv run python scripts/agent_context_budget.py

Builds the real chat graph with a stand-in model that records each request
instead of sending it, then prints:

- the fixed cost of every model call (system prompt, tool schemas, context),
  with the Dashboard open,
- what each open page adds to the system prompt (its data rides along, so a
  question about the screen needs no tool call),
- what the analytics toolkit's narrow reads cost.

No network, no model. Point ``ARETE_DB`` at a **copy**: the schema is migrated
on start, as the backend does. Tokens are counted with ``o200k_base`` — an
approximation, since the free router picks the model per request — so read
the numbers as relative weights, and re-run before and after any change to a
prompt, a tool description or a page fetcher.
"""

from __future__ import annotations

import json
from typing import Any
from unittest.mock import patch

import tiktoken
from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage
from langchain_core.utils.function_calling import convert_to_openai_tool

_ENCODING = tiktoken.get_encoding("o200k_base")
PAGES = ("dashboard", "analytics", "planning", "log", "settings")


def tokens(text: str) -> int:
    return len(_ENCODING.encode(text))


class _Recorder(GenericFakeChatModel):
    """Plays a scripted turn and keeps every request it was handed."""

    calls: list[dict[str, Any]] = []

    def bind_tools(self, tools, **kwargs):
        self._bound = [convert_to_openai_tool(t) for t in tools]
        return self

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        _Recorder.calls.append(
            {"messages": list(messages), "tools": list(getattr(self, "_bound", []))}
        )
        return super()._generate(messages, stop=stop, run_manager=run_manager, **kwargs)


def _tool_call(name: str, args: dict[str, Any]) -> AIMessage:
    return AIMessage(
        content="",
        tool_calls=[{"name": name, "args": args, "id": name, "type": "tool_call"}],
    )


def record_turn(page: str, script: list[AIMessage]) -> list[dict[str, Any]]:
    """Run one turn of the real chat graph and return the recorded requests."""
    import arete.coaching as agent_module
    from arete.agent.runtime.context import AgentContext

    _Recorder.calls = []
    model = _Recorder(messages=iter(script))
    with patch.object(agent_module, "build_chat_model", lambda **kw: model):
        agent_module.get_agent.cache_clear()
        agent_module.get_agent().invoke(
            {"messages": [{"role": "user", "content": "Comment je vais ?"}]},
            context=AgentContext(source={"panel_context": json.dumps({"page": page})}),
            config={"recursion_limit": 100},
        )
    agent_module.get_agent.cache_clear()
    return list(_Recorder.calls)


def call_cost(call: dict[str, Any]) -> dict[str, Any]:
    system = sum(tokens(m.text) for m in call["messages"] if m.type == "system")
    tools = {t["function"]["name"]: tokens(json.dumps(t)) for t in call["tools"]}
    others = sum(
        tokens(m.text or json.dumps(getattr(m, "tool_calls", [])))
        for m in call["messages"]
        if m.type != "system"
    )
    return {"system": system, "tools": tools, "messages": others}


def main() -> None:
    from arete.agent.context.sections import page_section
    from arete.agent.runtime.context import AgentContext
    from arete.agent.tools.analytics import (
        get_fitness,
        get_training_advice,
        get_workload,
        list_recent_sessions,
    )
    from arete.dataio.init_duckdb import main as init_schema

    init_schema()

    first = call_cost(record_turn("dashboard", [AIMessage(content="ok")])[0])
    tool_total = sum(first["tools"].values())
    print("FIXED COST — every model call")
    print(f"  system prompt          {first['system']:7d}")
    print(f"  tool schemas ({len(first['tools'])})       {tool_total:7d}")
    for name, cost in sorted(first["tools"].items(), key=lambda kv: -kv[1]):
        print(f"      {name:22s} {cost:7d}")
    print(f"  user message           {first['messages']:7d}")
    print(
        f"  total                  {first['system'] + tool_total + first['messages']:7d}"
    )

    print("\nOPEN PAGE — system prompt with that page open")
    for page in PAGES:
        system = call_cost(record_turn(page, [AIMessage(content="ok")])[0])["system"]
        print(f"  {page:10s} {system:7d}")

    print("\nSERVER PAGE READS — injected context")
    for page in PAGES:
        out = page_section(
            AgentContext(source={"panel_context": json.dumps({"page": page})})
        )
        print(f"  {page:10s} {tokens(out):7d}")

    print("\nANALYTICS TOOLKIT READS")
    for label, tool, args in (
        ("get_workload(28)", get_workload, {"days": 28}),
        ("get_fitness(42)", get_fitness, {"days": 42}),
        ("get_training_advice", get_training_advice, {}),
        ("list_recent_sessions(20)", list_recent_sessions, {"limit": 20}),
    ):
        print(f"  {label:26s} {tokens(tool.invoke(args)):7d}")


if __name__ == "__main__":
    main()
