"""Offline schema, prefix and ledger-read comparison against a source checkout.

uv run python scripts/measure_coach_runtime.py [source-root]

No database or model I/O: context readers return fixed synthetic sections.
Use the same interpreter/dependencies for historical and current sources.
The single cold-import sample is diagnostic, not a latency benchmark.
"""

import argparse
import importlib
import json
import sys
from collections import Counter
from datetime import UTC, datetime
from os.path import commonprefix
from pathlib import Path
from time import perf_counter
from types import SimpleNamespace
from unittest.mock import patch


class Request(SimpleNamespace):
    def override(self, **changes):
        return Request(**{**vars(self), **changes})


def measure(source_root: Path) -> dict:
    if not (source_root / "arete/coaching.py").is_file():
        raise ValueError("Source root must contain arete/coaching.py")
    sys.path.insert(0, str(source_root.resolve()))
    started = perf_counter()
    importlib.import_module("arete.coaching")
    cold_ms = round((perf_counter() - started) * 1000)

    import tiktoken
    from langchain_core.messages import SystemMessage
    from langchain_core.utils.function_calling import convert_to_openai_tool

    import arete.agent.context.builder as builder
    from arete.agent.capabilities.discovery import authorized_tools
    from arete.agent.runtime.budget import MAX_MODEL_CALLS
    from arete.agent.runtime.context import AgentContext

    schemas = [
        json.dumps(convert_to_openai_tool(tool), ensure_ascii=False)
        for tool in authorized_tools("chat")
    ]
    encoding = tiktoken.get_encoding("o200k_base")
    reads: Counter[str] = Counter()

    def block(name):
        def read(*_):
            reads[name] += 1
            return (name + " ") * 100

        return read

    patches = {
        name: block(name) for name in ("facts_block", "journal_block", "followup_block")
    }
    if hasattr(builder, "body_block"):
        patches["body_block"] = lambda *_: ""
    patches.update(
        {
            name: (lambda *_: "")
            for name in (
                "system_skills_section",
                "personal_context_section",
                "attachment_section",
                "surface_section",
            )
        }
    )
    patches.update(
        tool_instructions_suffix=lambda *_: "capabilities " * 200,
        page_section=lambda *_: "page " * 200,
    )
    with patch.multiple(builder, **patches):
        context = AgentContext(current_datetime=datetime(2026, 10, 23, 12, tzinfo=UTC))
        context.garmin_freshness = {"status": "fresh"}
        request = Request(
            runtime=SimpleNamespace(context=context),
            state={},
            tools=[],
            messages=[],
            system_message=SystemMessage("harness " * 500),
        )
        normal = builder.build_context(request).system_message.text
        final = builder.build_context(
            request.override(state={"run_model_call_count": MAX_MODEL_CALLS - 1})
        ).system_message.text
        context.garmin_freshness = {"status": "stale"}
        changed = builder.build_context(request).system_message.text
        builder.build_context(request)
    return {
        "root": str(source_root),
        "coaching_import_ms": cold_ms,
        "anthropic_loaded": "anthropic" in sys.modules,
        "tool_count": len(schemas),
        "schema_characters": sum(map(len, schemas)),
        "schema_tokens_o200k": sum(len(encoding.encode(s)) for s in schemas),
        "synthetic_prompt_chars": len(normal),
        "prefix_final_chars": len(commonprefix([normal, final])),
        "prefix_sync_changed_chars": len(commonprefix([normal, changed])),
        "reads_over_four_calls": dict(reads),
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source_root", type=Path, nargs="?", default=Path("src"))
    print(json.dumps(measure(parser.parse_args().source_root), indent=2))
