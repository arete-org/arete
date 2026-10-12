"""Pure execution policy resolved from server-selected configuration."""

from dataclasses import dataclass

from arete.agent.profiles.catalog import get_profile
from arete.agent.profiles.models import AgentProfile


@dataclass(frozen=True)
class RunPolicy:
    profile: AgentProfile

    def can_execute(
        self, capability: str, tool_name: str, read_tools: frozenset[str]
    ) -> bool:
        return capability in self.profile.capabilities and (
            self.profile.training_writes
            or tool_name in read_tools
            or tool_name in self.profile.external_write_tools
        )


ProfileSpec = str | AgentProfile


def resolve_policy(profile_id: ProfileSpec) -> RunPolicy:
    return RunPolicy(
        profile_id if isinstance(profile_id, AgentProfile) else get_profile(profile_id)
    )
