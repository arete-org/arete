"""Native skills discovery with fail-closed validation of the server bundle."""

from deepagents.middleware.skills import SkillsMiddleware
from langchain_core.messages import HumanMessage

from arete.agent.backends.skills import SYSTEM_SKILLS_ROUTE
from arete.agent.context.skills import requested_skill_paths
from arete.agent.runtime.context import AgentContext


class SystemSkillsMiddleware(SkillsMiddleware):
    def __init__(self, *, backend, paths: set[str]):
        super().__init__(
            backend=backend,
            sources=[(SYSTEM_SKILLS_ROUTE, "Système")],
            # The context builder owns prompt ordering and token accounting.
            system_prompt=None,
        )
        self.expected_paths = {SYSTEM_SKILLS_ROUTE + path.lstrip("/") for path in paths}

    def _validated(self, update):
        # Native discovery warns and skips malformed files. Server instructions
        # must instead fail visibly if any versioned skill disappears.
        skills = update.get("skills_metadata", []) if update is not None else []
        if (
            update is None
            or update.get("skills_load_errors")
            or len(skills) != len(self.expected_paths)
            or {skill["path"] for skill in skills} != self.expected_paths
        ):
            raise RuntimeError("System skill discovery differs from the server bundle")
        return update

    def _prepare(self, state, runtime, update):
        context = getattr(runtime, "context", None)
        if isinstance(context, AgentContext):
            question = next(
                (
                    m
                    for m in reversed(state.get("messages", []))
                    if isinstance(m, HumanMessage)
                ),
                None,
            )
            context.requested_skills = (
                requested_skill_paths(question.text, update["skills_metadata"])
                if question is not None
                else ()
            )
        return update

    def before_agent(self, state, runtime, config):
        context = getattr(runtime, "context", None)
        if (
            context
            and context.resolved_profile
            and not context.resolved_profile.filesystem_tools
        ):
            return {"skills_metadata": []}
        # Rediscover trusted metadata, never bodies or browser-supplied instructions.
        return self._prepare(
            state, runtime, self._validated(super().before_agent({}, runtime, config))
        )

    async def abefore_agent(self, state, runtime, config):
        context = getattr(runtime, "context", None)
        if (
            context
            and context.resolved_profile
            and not context.resolved_profile.filesystem_tools
        ):
            return {"skills_metadata": []}
        return self._prepare(
            state,
            runtime,
            self._validated(await super().abefore_agent({}, runtime, config)),
        )
