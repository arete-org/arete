"""Pure execution policy resolved from server-selected configuration."""

from dataclasses import dataclass, replace

from arete.agent.profiles.catalog import get_profile
from arete.agent.profiles.models import AgentProfile
from arete.agent.prompts.coach import SYSTEM_SKILL
from arete.agent.prompts.product import CLARIFY_INSTRUCTIONS, PRODUCT_INSTRUCTIONS
from arete.agent.runtime.context import AgentContext


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


def slack_policy(context: AgentContext) -> AgentProfile:
    """Narrow the shared graph from trusted preflight state, never model state."""
    decision = context.slack_decision
    service = context.slack_product
    assert decision is not None and service is not None, "Slack preflight required"
    profile = get_profile("slack")
    private = service.private
    assert not decision.private_data or private, "Private classification requires DM"
    if private:
        assert context.slack_visibility == "private", "Private Slack data requires DM"
    if decision.surface == "clarify" or (private and decision.outbound):
        capabilities: tuple[str, ...] = ()
        instructions = CLARIFY_INSTRUCTIONS
    elif private:
        capabilities = ("admin_data",)
        instructions = PRODUCT_INSTRUCTIONS + (
            "\nConsultation privée en lecture seule : aucune action sortante. "
            "Pour contacter un tiers, demander un nouveau fil sans données privées."
        )
    elif decision.surface == "coach":
        return replace(
            get_profile("chat"),
            id="slack",
            system_prompt=profile.system_prompt,
            instructions=SYSTEM_SKILL + "\n\n" + get_profile("chat").instructions,
        )
    else:
        capabilities = ("slack_product",)
        instructions = PRODUCT_INSTRUCTIONS
    return replace(
        profile,
        capabilities=capabilities,
        instructions=instructions,
        training_writes=False,
        page_context=False,
        filesystem_tools=False,
        journal_tools=False,
        fact_memory_tools=False,
        external_write_tools=(
            profile.external_write_tools
            if capabilities == ("slack_product",)
            else frozenset()
        ),
    )
