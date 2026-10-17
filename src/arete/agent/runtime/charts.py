"""Invocation-local chart receipts survive native message compaction."""

import hashlib

from arete.agent.runtime.context import AgentContext
from arete.services.charts import MAX_CHARTS_PER_RUN, ChartCard, ChartSpec


def retain_chart(context: AgentContext, call_id: str, spec: ChartSpec) -> ChartCard:
    identifier = hashlib.sha256(f"{context.run_id}:{call_id}".encode()).hexdigest()
    card = ChartCard(id=identifier, **spec.model_dump())
    # Native synchronous ToolNode calls can overlap in worker threads. Only
    # this tiny reservation is locked; parsing never holds the lock.
    with context.chart_lock:
        if identifier in context.chart_cards:
            if context.chart_cards[identifier] != card:
                raise ValueError(
                    "Un appel de graphique ne peut pas changer de contenu."
                )
            return context.chart_cards[identifier]
        if len(context.chart_cards) >= MAX_CHARTS_PER_RUN:
            raise ValueError("Maximum quatre graphiques par réponse.")
        context.chart_cards[identifier] = card
    return card
