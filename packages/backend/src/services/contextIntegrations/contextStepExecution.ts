/**
 * @description: Shared helpers for context-step execution status shaping and non-blocking task execution.
 * Keeps context-integration status conventions and error handling consistent
 * while preserving continuation behavior when integration work fails.
 * @footnote-scope: utility
 * @footnote-module: ContextStepExecution
 * @footnote-risk: medium - Inconsistent status shaping can confuse workflow telemetry and debugging.
 * @footnote-ethics: medium - Non-blocking integration behavior affects reliability and transparency boundaries.
 */
import type {
    ContextStepResult,
    ContextStepExecutorInput,
} from '../workflowEngine.js';
import type { ToolInvocationReasonCode } from '@footnote/contracts/ethics-core';

type NonBlockingExecutionLogger = {
    warn: (message: string, meta?: Record<string, unknown>) => void;
};

export const buildSkippedContextStepResult = (input: {
    toolName: string;
    reasonCode: ToolInvocationReasonCode;
}): ContextStepResult => ({
    executionContext: {
        toolName: input.toolName,
        status: 'skipped',
        reasonCode: input.reasonCode,
    },
});

export const buildExecutedContextStepResult = (input: {
    toolName: string;
    clarification?: ContextStepResult['clarification'];
    durationMs?: number;
    contextMessages?: string[];
    sources?: ContextStepResult['sources'];
    integrationContext?: ContextStepResult['integrationContext'];
}): ContextStepResult => ({
    executionContext: {
        toolName: input.toolName,
        status: 'executed',
        ...(input.clarification !== undefined && {
            clarification: input.clarification,
        }),
        ...(input.durationMs !== undefined && { durationMs: input.durationMs }),
    },
    ...(input.contextMessages !== undefined &&
        input.contextMessages.length > 0 && {
            contextMessages: input.contextMessages,
        }),
    ...(input.sources !== undefined &&
        input.sources.length > 0 && {
            sources: input.sources,
        }),
    ...(input.integrationContext !== undefined && {
        integrationContext: input.integrationContext,
    }),
    ...(input.clarification !== undefined && {
        clarification: input.clarification,
    }),
});

export const buildFailedContextStepResult = (input: {
    toolName: string;
    reasonCode: ToolInvocationReasonCode;
    durationMs?: number;
    contextMessages?: string[];
    sources?: ContextStepResult['sources'];
    integrationContext?: ContextStepResult['integrationContext'];
}): ContextStepResult => ({
    executionContext: {
        toolName: input.toolName,
        status: 'failed',
        reasonCode: input.reasonCode,
        ...(input.durationMs !== undefined && { durationMs: input.durationMs }),
    },
    ...(input.contextMessages !== undefined &&
        input.contextMessages.length > 0 && {
            contextMessages: input.contextMessages,
        }),
    ...(input.sources !== undefined &&
        input.sources.length > 0 && {
            sources: input.sources,
        }),
    ...(input.integrationContext !== undefined && {
        integrationContext: input.integrationContext,
    }),
});

export const runNonBlockingIntegrationTask = async <T>(input: {
    integrationName: string;
    logger: NonBlockingExecutionLogger;
    contextStepInput: ContextStepExecutorInput;
    task: () => Promise<T>;
    onErrorMessage: string;
}): Promise<
    | { status: 'executed'; value: T }
    | {
          status: 'degraded';
          error: string;
      }
> => {
    try {
        const value = await input.task();
        return { status: 'executed', value };
    } catch (error) {
        const errorMessage =
            error instanceof Error ? error.message : String(error);
        input.logger.warn(input.onErrorMessage, {
            integrationName: input.integrationName,
            attempt: input.contextStepInput.attempt,
            workflowId: input.contextStepInput.workflowId,
            workflowName: input.contextStepInput.workflowName,
            error: errorMessage,
        });
        return {
            status: 'degraded',
            error: errorMessage,
        };
    }
};
