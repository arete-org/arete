"""A persisted rollout selects the next graph without mutating a running one."""

from types import SimpleNamespace

import pytest

from arete import coaching
from arete.agent.runtime.execution import run_config
from arete.services.athlete_scope import athlete_scope
from arete.services.feature_flags import FeatureFlags, set_feature_flags


@pytest.mark.parametrize(
    "factory",
    [
        coaching.get_agent,
        coaching.build_briefing_agent,
        coaching.build_feedback_agent,
        coaching.build_review_agent,
        coaching.build_evening_agent,
    ],
)
def test_cached_route_changes_on_next_invocation_and_reverts(monkeypatch, factory):
    monkeypatch.setenv("LLM_PROVIDER", "openrouter")
    monkeypatch.setenv("OPENROUTER_API_KEY", "test-key")
    monkeypatch.setattr(
        coaching,
        "_assemble",
        lambda profile, **kw: SimpleNamespace(
            config={"metadata": {"model": "glm" if kw["glm_flash"] else "free"}},
        ),
    )
    factory.cache_clear()
    set_feature_flags(FeatureFlags())
    try:
        original = factory()
        set_feature_flags(FeatureFlags(glm_flash=True))
        switched = factory()
        assert switched is not original
        assert run_config(graph=switched)["metadata"]["model"] == "glm"
        assert run_config(graph=original)["metadata"]["model"] == "free"
        with athlete_scope(123):
            assert factory() is not switched
        assert factory() is switched
        set_feature_flags(FeatureFlags())
        assert factory() is original
        # Another process only needs the persisted switch: no cache invalidation message.
        factory.cache_clear()
        assert run_config(graph=factory())["metadata"]["model"] == "free"
    finally:
        set_feature_flags(FeatureFlags())
        factory.cache_clear()
