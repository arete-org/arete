/**
 * @description: Builds serializable tool execution events from runtime tool execution context.
 * Keeps tool execution metadata construction explicit and reusable across orchestration surfaces.
 * @footnote-scope: utility
 * @footnote-module: ToolExecutionEvents
 * @footnote-risk: low - This helper only maps context fields into execution-event shape.
 * @footnote-ethics: medium - Tool execution events inform provenance and operator-visible trace narratives.
 */
import type {
    ToolExecutionContext,
    ToolExecutionEvent,
} from '@footnote/contracts/ethics-core';

export const buildToolExecutionEvent = (
    toolContext: ToolExecutionContext
): ToolExecutionEvent => ({
    kind: 'tool',
    toolName: toolContext.toolName,
    status: toolContext.status,
    ...(toolContext.reasonCode !== undefined && {
        reasonCode: toolContext.reasonCode,
    }),
    ...(toolContext.durationMs !== undefined && {
        durationMs: toolContext.durationMs,
    }),
    ...(toolContext.clarification !== undefined && {
        clarification: toolContext.clarification,
    }),
});
