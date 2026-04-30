/**
 * @description: Adapts existing tool-registry execution into workflow-owned context-step executor shape.
 * Keeps workflow engine provider-neutral while preserving current weather tool semantics.
 * @footnote-scope: core
 * @footnote-module: ToolRegistryContextStepAdapter
 * @footnote-risk: medium - Mapping mistakes can misclassify tool outcomes or lose context payloads during workflow integration.
 * @footnote-ethics: medium - Tool outcome normalization affects provenance clarity and fail-open trust signals.
 */
import type { ToolExecutionContext } from '@footnote/contracts/ethics-core';
import type {
    ContextStepExecutor,
    ContextStepRequest,
    ContextStepResult,
} from '../workflowEngine.js';
import type { WeatherForecastTool } from '../openMeteoForecastTool.js';
import {
    executeSelectedTool,
    resolveToolSelection,
} from '../tools/toolRegistry.js';

const buildContextToolIntentInput = (
    request: ContextStepRequest
): Record<string, unknown> | undefined => {
    if (request.input && typeof request.input === 'object') {
        return request.input;
    }

    return undefined;
};

const buildFallbackToolExecutionContext = (
    request: ContextStepRequest
): ToolExecutionContext => ({
    toolName: request.integrationName,
    status: request.eligible ? 'failed' : 'skipped',
    reasonCode:
        request.reasonCode ??
        (request.eligible ? 'unspecified_tool_outcome' : 'tool_unavailable'),
});

export const createToolRegistryContextStepExecutor = ({
    weatherForecastTool,
    onWarn,
}: {
    weatherForecastTool?: WeatherForecastTool;
    onWarn?: (message: string, meta?: Record<string, unknown>) => void;
}): ContextStepExecutor => {
    const warn = onWarn ?? (() => undefined);

    return async ({ request }): Promise<ContextStepResult> => {
        const normalizedInput = buildContextToolIntentInput(request);
        const toolSelection = resolveToolSelection({
            generation: {
                reasoningEffort: 'low',
                verbosity: 'low',
                toolIntent: {
                    toolName: request.integrationName,
                    requested: request.requested,
                    ...(normalizedInput !== undefined && {
                        input: normalizedInput,
                    }),
                },
            },
            weatherForecastTool,
            ...(request.reasonCode !== undefined && {
                inheritedToolExecution: {
                    toolName: request.integrationName,
                    status: request.eligible ? 'failed' : 'skipped',
                    reasonCode: request.reasonCode,
                } satisfies ToolExecutionContext,
            }),
        });

        const execution = await executeSelectedTool({
            toolSelection,
            weatherForecastTool,
            onWarn: warn,
        });
        const executionContext =
            execution.toolExecutionContext ??
            toolSelection.toolExecution ??
            buildFallbackToolExecutionContext(request);

        return {
            executionContext,
            ...(execution.toolResultMessage !== undefined && {
                contextMessages: [execution.toolResultMessage],
            }),
            ...(executionContext.clarification !== undefined && {
                clarification: executionContext.clarification,
            }),
        };
    };
};
