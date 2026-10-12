"""Enforce dependency direction, including local imports and future additions."""

import ast
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "src" / "arete"


def imports(path):
    for node in ast.walk(ast.parse(path.read_text())):
        if isinstance(node, ast.ImportFrom):
            if node.level:
                package = path.relative_to(ROOT.parent).with_suffix("").parts[:-1]
                package = package[: len(package) - node.level + 1]
                base = ".".join((*package, *(node.module or "").split("."))).rstrip(".")
            else:
                base = node.module or ""
            yield base
            for name in node.names:
                yield f"{base}.{name.name}"
        elif isinstance(node, ast.Import):
            yield from (name.name for name in node.names)


def test_services_do_not_depend_on_agent_or_transport_frameworks():
    forbidden = (
        "arete.agent",
        "arete.coaching",
        "arete.api",
        "langchain",
        "langgraph",
        "deepagents",
        "fastapi",
        "starlette",
    )
    violations = [
        f"{p.relative_to(ROOT)}: {name}"
        for p in (ROOT / "services").rglob("*.py")
        for name in imports(p)
        if name.startswith(forbidden)
    ]
    assert not violations, "\n".join(violations)


def test_lower_layers_never_import_factory_or_application_transport():
    violations = [
        f"{p.relative_to(ROOT)}: {name}"
        for p in (ROOT / "agent").rglob("*.py")
        if p.name != "factory.py"
        for name in imports(p)
        if name.startswith(("arete.agent.factory", "arete.coaching", "arete.api"))
    ]
    assert not violations, "\n".join(violations)


def test_factory_is_only_imported_by_composition_root():
    violations = [
        str(p.relative_to(ROOT))
        for p in ROOT.rglob("*.py")
        if p != ROOT / "coaching.py"
        and any(name.startswith("arete.agent.factory") for name in imports(p))
    ]
    assert not violations


def test_profile_capabilities_are_registered_and_preloads_authorized():
    from arete.agent.capabilities.registry import CAPABILITIES, validate_registry
    from arete.agent.profiles.catalog import PROFILES

    validate_registry()
    for profile in PROFILES.values():
        assert set(profile.capabilities) <= CAPABILITIES.keys()
        assert profile.id in {"chat", "slack"} or not profile.training_writes


def test_memory_and_journal_have_independent_tool_owners_and_policy():
    from dataclasses import replace

    from arete.agent.capabilities.discovery import tool_available
    from arete.agent.capabilities.registry import (
        FACT_MEMORY_TOOL_NAMES,
        JOURNAL_TOOL_NAMES,
    )
    from arete.agent.middlewares.fact_memory import FactMemoryMiddleware
    from arete.agent.middlewares.journal import JournalMiddleware
    from arete.agent.profiles.catalog import get_profile

    facts = FactMemoryMiddleware(model=None)
    journal = JournalMiddleware()
    assert {t.name for t in facts.tools} == FACT_MEMORY_TOOL_NAMES
    assert {t.name for t in journal.tools} == JOURNAL_TOOL_NAMES
    assert not FACT_MEMORY_TOOL_NAMES & JOURNAL_TOOL_NAMES
    profile = replace(get_profile("chat"), journal_tools=False)
    assert all(tool_available(profile, name) for name in FACT_MEMORY_TOOL_NAMES)
    assert not any(tool_available(profile, name) for name in JOURNAL_TOOL_NAMES)
    profile = replace(get_profile("chat"), fact_memory_tools=False)
    assert all(tool_available(profile, name) for name in JOURNAL_TOOL_NAMES)
    assert not any(tool_available(profile, name) for name in FACT_MEMORY_TOOL_NAMES)
