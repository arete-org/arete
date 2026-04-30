/**
 * @description: Builds deterministic user-facing tool failure replies without speculative generated content.
 * Keeps fail-open messaging explicit when backend tools cannot provide reliable data.
 * @footnote-scope: utility
 * @footnote-module: WeatherToolFailureResponse
 * @footnote-risk: low - This helper only formats fallback text and metadata for failed tool calls.
 * @footnote-ethics: high - Prevents fabricated tool-backed claims by making failure states explicit.
 */
import type { PostChatResponse } from '@footnote/contracts/web';
import type {
    ResponseMetadata,
    ToolExecutionContext,
    ToolExecutionEvent,
} from '@footnote/contracts/ethics-core';
import type {
    AssistantResponseMetadata,
    ResponseMetadataRuntimeContext,
} from '../openaiService.js';

type ToolFailureMetadataContext = Omit<
    ResponseMetadataRuntimeContext,
    'executionContext'
> & {
    executionContext: NonNullable<
        ResponseMetadataRuntimeContext['executionContext']
    > & {
        generation: NonNullable<
            NonNullable<
                ResponseMetadataRuntimeContext['executionContext']
            >['generation']
        >;
    };
};

export const buildWeatherToolFailureResponse = ({
    toolContext,
    metadataContext,
    latestUserInput,
    buildResponseMetadata,
}: {
    toolContext: ToolExecutionContext;
    metadataContext: ToolFailureMetadataContext;
    latestUserInput: string;
    buildResponseMetadata: (
        assistantMetadata: AssistantResponseMetadata,
        runtimeContext: ResponseMetadataRuntimeContext
    ) => ResponseMetadata;
}): PostChatResponse => {
    const sanitizedInput = latestUserInput.trim();
    const locationHint =
        sanitizedInput.length > 0
            ? ` for "${sanitizedInput}"`
            : ' for that location';
    const failureMessage = [
        `I couldn't fetch live weather${locationHint}.`,
        "I don't want to guess.",
        'Please try a more specific location like "City, State" or a ZIP code.',
    ].join(' ');

    const metadataWithSkippedGenerationContext: ResponseMetadataRuntimeContext =
        {
            ...metadataContext,
            executionContext: {
                ...metadataContext.executionContext,
                generation: {
                    ...metadataContext.executionContext?.generation,
                    status: 'skipped',
                },
                tool: toolContext,
            },
        };

    const metadata = buildResponseMetadata(
        {
            model: metadataContext.modelVersion,
            citations: [],
        },
        metadataWithSkippedGenerationContext
    );
    const toolExecutionEvent: ToolExecutionEvent = {
        kind: 'tool',
        toolName: toolContext.toolName,
        status: toolContext.status,
        reasonCode: toolContext.reasonCode,
        durationMs: toolContext.durationMs,
    };

    return {
        action: 'message',
        message: failureMessage,
        modality: 'text',
        metadata: {
            ...metadata,
            execution: [
                ...(metadata.execution ?? []).filter(
                    (event) => event.kind !== 'tool'
                ),
                toolExecutionEvent,
            ],
        },
    };
};
