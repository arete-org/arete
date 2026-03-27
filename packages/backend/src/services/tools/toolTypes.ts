/**
 * @description: Backend-local contracts for tool selection and execution wiring.
 * These keep orchestrator/tool integration serializable and provider-agnostic.
 * @footnote-scope: interface
 * @footnote-module: ChatToolTypes
 * @footnote-risk: low - Type drift can mis-shape tool telemetry but does not alter core model execution directly.
 * @footnote-ethics: low - These types describe execution metadata and do not make autonomous decisions.
 */
import type {
    ToolExecutionContext,
    ToolInvocationIntent,
    ToolInvocationRequest,
} from '@footnote/contracts/ethics-core';
import type { ChatGenerationPlan } from '../chatGenerationTypes.js';

export type BackendToolSelection = {
    generation: ChatGenerationPlan;
    toolIntent: ToolInvocationIntent;
    toolRequest: ToolInvocationRequest;
    toolExecution?: ToolExecutionContext;
};

export type ToolPolicyLogEvent = {
    event: 'chat.orchestration.tool_policy';
    policy: string;
    droppedToolName: 'web_search';
    selectedToolName: 'weather_forecast';
};
