/**
 * @description: Assembles clarification responses for executed tool outcomes that require user disambiguation.
 * Keeps metadata shaping for clarification replies consistent and reusable across orchestration surfaces.
 * @footnote-scope: utility
 * @footnote-module: ToolClarificationResponse
 * @footnote-risk: low - This helper only formats a clarification reply and metadata envelope.
 * @footnote-ethics: medium - Clarification metadata must accurately signal skipped generation and tool context for traceability.
 */
import type { PostChatResponse } from '@footnote/contracts/web';
import type {
    ResponseMetadata,
    ToolExecutionContext,
} from '@footnote/contracts/ethics-core';
import type {
    AssistantResponseMetadata,
    ResponseMetadataRuntimeContext,
} from '../openaiService.js';
import { buildToolExecutionEvent } from './toolExecutionEvents.js';

type ToolClarificationMetadataContext = Omit<
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

export const buildToolClarificationResponse = ({
    toolContext,
    metadataContext,
    buildResponseMetadata,
}: {
    toolContext: ToolExecutionContext;
    metadataContext: ToolClarificationMetadataContext;
    buildResponseMetadata: (
        assistantMetadata: AssistantResponseMetadata,
        runtimeContext: ResponseMetadataRuntimeContext
    ) => ResponseMetadata;
}): PostChatResponse => {
    const clarificationMessage = [
        toolContext.clarification?.question ?? 'Which location did you mean?',
        '',
        ...(toolContext.clarification?.options ?? []).map(
            (option, index) => `${index + 1}. ${option.label}`
        ),
        '',
        'Please reply with your choice.',
    ].join('\n');

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
    const toolExecutionEvent = buildToolExecutionEvent(toolContext);

    return {
        action: 'message',
        message: clarificationMessage,
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
