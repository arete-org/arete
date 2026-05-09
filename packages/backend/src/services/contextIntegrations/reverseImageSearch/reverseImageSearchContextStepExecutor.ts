/**
 * @description: Reverse image search context-step executor for attachment grounding.
 * Runs provider-backed reverse lookup on image attachments and emits advisory
 * context messages plus citations with fail-open behavior.
 * @footnote-scope: core
 * @footnote-module: ReverseImageSearchContextStepExecutor
 * @footnote-risk: medium - Incorrect lookup shaping can degrade attachment evidence quality for image-based requests.
 * @footnote-ethics: medium - External similarity signals may be wrong, so this path stays advisory with confidence-aware fail-open handling.
 */
import {
    buildAttachmentCitation,
    getAttachmentsFromUnknownInput,
    isImageAttachment,
} from '../../attachments/attachmentContext.js';
import type { Citation } from '@footnote/contracts/ethics-core';
import {
    buildExecutedContextStepResult,
    buildSkippedContextStepResult,
    runNonBlockingIntegrationTask,
} from '../contextStepExecution.js';
import type {
    ContextStepExecutor,
    ContextStepExecutorInput,
    ContextStepResult,
} from '../../workflowEngine.js';

type ReverseImageSearchExecutorLogger = {
    warn: (message: string, meta?: Record<string, unknown>) => void;
};

export type ReverseImageSearchMatch = {
    title: string;
    url: string;
    snippet?: string;
    confidence?: number;
};

export type ReverseImageSearchProviderResponse = {
    providerId: string;
    summary?: string;
    confidence?: number;
    matches: ReverseImageSearchMatch[];
};

export type ReverseImageSearchProvider = {
    search: (input: {
        imageUrl: string;
        context?: string;
    }) => Promise<ReverseImageSearchProviderResponse>;
};

type CreateReverseImageSearchContextStepExecutorOptions = {
    provider?: ReverseImageSearchProvider | null;
    logger: ReverseImageSearchExecutorLogger;
    minConfidence?: number;
    maxMatchesPerImage?: number;
};

const REVERSE_IMAGE_SEARCH_NAME = 'reverse_image_search';
const DEFAULT_MIN_CONFIDENCE = 0.35;
const DEFAULT_MATCH_LIMIT = 2;

const normalizeConfidence = (confidence: number | undefined): number | null => {
    if (confidence === undefined || !Number.isFinite(confidence)) {
        return null;
    }
    if (confidence < 0) {
        return 0;
    }
    if (confidence > 1) {
        return 1;
    }
    return confidence;
};

export const createReverseImageSearchContextStepExecutor = ({
    provider,
    logger,
    minConfidence = DEFAULT_MIN_CONFIDENCE,
    maxMatchesPerImage = DEFAULT_MATCH_LIMIT,
}: CreateReverseImageSearchContextStepExecutorOptions): ContextStepExecutor => {
    const execute: ContextStepExecutor = async (
        input: ContextStepExecutorInput
    ): Promise<ContextStepResult> => {
        if (!input.request.requested || !input.request.eligible) {
            return buildSkippedContextStepResult({
                toolName: REVERSE_IMAGE_SEARCH_NAME,
                reasonCode: input.request.reasonCode ?? 'tool_not_requested',
            });
        }

        const attachmentList = getAttachmentsFromUnknownInput(
            input.request.input?.attachments
        );
        const imageAttachments = attachmentList.filter(isImageAttachment);

        if (imageAttachments.length === 0) {
            return buildSkippedContextStepResult({
                toolName: REVERSE_IMAGE_SEARCH_NAME,
                reasonCode: 'tool_not_used',
            });
        }
        if (!provider) {
            return buildSkippedContextStepResult({
                toolName: REVERSE_IMAGE_SEARCH_NAME,
                reasonCode: 'tool_unavailable',
            });
        }

        const userContext =
            typeof input.request.input?.latestUserInput === 'string'
                ? input.request.input.latestUserInput.trim()
                : '';
        const contextMessages: string[] = [];
        const sources: Citation[] = [];

        for (const [index, attachment] of imageAttachments.entries()) {
            const label = `Image ${index + 1}`;
            const taskResult = await runNonBlockingIntegrationTask({
                integrationName: REVERSE_IMAGE_SEARCH_NAME,
                logger,
                contextStepInput: input,
                onErrorMessage:
                    'reverse_image_search: provider lookup failed; continuing without reverse-image context.',
                task: () =>
                    provider.search({
                        imageUrl: attachment.url,
                        ...(userContext.length > 0 && { context: userContext }),
                    }),
            });
            if (taskResult.status === 'executed') {
                const result = taskResult.value;
                const normalizedConfidence = normalizeConfidence(
                    result.confidence
                );
                if (
                    normalizedConfidence !== null &&
                    normalizedConfidence < minConfidence
                ) {
                    contextMessages.push(
                        `[${label}] reverse image search confidence was low (${normalizedConfidence.toFixed(2)}); continuing without asserting a match.`
                    );
                    sources.push(
                        buildAttachmentCitation({
                            attachment,
                            title: `${label} (low-confidence reverse lookup)`,
                            snippet: `Provider ${result.providerId} returned low confidence; advisory signal only.`,
                        })
                    );
                    continue;
                }

                const topMatches = result.matches.slice(
                    0,
                    Math.max(1, maxMatchesPerImage)
                );
                if (topMatches.length === 0) {
                    contextMessages.push(
                        `[${label}] reverse image search found no confident public matches.`
                    );
                    sources.push(
                        buildAttachmentCitation({
                            attachment,
                            title: `${label} (no reverse matches)`,
                            snippet: `Provider ${result.providerId} returned no matches.`,
                        })
                    );
                    continue;
                }

                const trimmedSummary = result.summary?.trim();
                const summaryText =
                    trimmedSummary !== undefined && trimmedSummary.length > 0
                        ? trimmedSummary
                        : 'Reverse image search found related references.';
                contextMessages.push(`[${label}] ${summaryText}`);

                for (const match of topMatches) {
                    sources.push({
                        title: match.title,
                        url: match.url,
                        ...(match.snippet !== undefined && {
                            snippet: match.snippet,
                        }),
                    });
                }
            } else {
                contextMessages.push(
                    `[${label}] reverse image search failed; continuing without reverse-image grounding.`
                );
                sources.push(
                    buildAttachmentCitation({
                        attachment,
                        title: `${label} (reverse lookup failed)`,
                        snippet:
                            'Reverse image search failed while keeping response flow non-blocking.',
                    })
                );
            }
        }

        return buildExecutedContextStepResult({
            toolName: REVERSE_IMAGE_SEARCH_NAME,
            contextMessages,
            sources,
        });
    };

    return execute;
};
