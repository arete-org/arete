"""Adapt a model-authored static chart to a bounded browser artifact."""

import json
from typing import Annotated, Any

from langchain.tools import ToolRuntime
from langchain_core.messages import ToolMessage
from pydantic import Field

from arete.agent.runtime.charts import retain_chart
from arete.agent.runtime.context import AgentContext
from arete.agent.tools.validation import typed_tool
from arete.services.charts import (
    DEFAULT_CHART_HEIGHT,
    MAX_CHART_HEIGHT,
    MAX_CHART_HTML_BYTES,
    MAX_CHART_SUMMARY_CHARS,
    MAX_CHART_TITLE_CHARS,
    MIN_CHART_HEIGHT,
    ChartSpec,
)


@typed_tool
def render_chart(
    title: Annotated[str, Field(min_length=1, max_length=MAX_CHART_TITLE_CHARS)],
    summary: Annotated[str, Field(min_length=1, max_length=MAX_CHART_SUMMARY_CHARS)],
    html: Annotated[str, Field(min_length=1, max_length=MAX_CHART_HTML_BYTES)],
    runtime: ToolRuntime[Any],
    height_px: Annotated[
        int, Field(strict=True, ge=MIN_CHART_HEIGHT, le=MAX_CHART_HEIGHT)
    ] = DEFAULT_CHART_HEIGHT,
) -> ToolMessage:
    """Affiche un graphique HTML/SVG statique dans une carte du chat navigateur.
    Consulte chart-rendering pour le format et les classes autorisées.
    summary décrit les données, leur période, leurs unités et la conclusion.
    """
    context = runtime.context
    assert isinstance(context, AgentContext), "Server chart context required"
    assert runtime.tool_call_id, "Native tool call ID required"
    try:
        if context.profile != "chat":
            raise ValueError(
                "Les graphiques sont disponibles uniquement dans le chat navigateur."
            )
        spec = ChartSpec(title=title, summary=summary, html=html, height_px=height_px)
        card = retain_chart(context, runtime.tool_call_id, spec)
    except ValueError as exc:
        return ToolMessage(
            name="render_chart",
            tool_call_id=runtime.tool_call_id,
            status="error",
            content=json.dumps({"error": str(exc)}, ensure_ascii=False),
        )
    return ToolMessage(
        name="render_chart",
        tool_call_id=runtime.tool_call_id,
        content=json.dumps(
            {
                "rendered": True,
                "id": card.id,
                "title": card.title,
                "summary": card.summary,
            },
            ensure_ascii=False,
        ),
        artifact=card.model_dump(),
    )
