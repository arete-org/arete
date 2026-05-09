/**
 * @description: File scanning context-step executor for attachment grounding.
 * Scans image attachments with the backend image-description task and reports
 * non-image files as structured advisory context.
 * @footnote-scope: core
 * @footnote-module: FileScanningContextStepExecutor
 * @footnote-risk: medium - Incorrect attachment handling can reduce grounding quality for attachment-driven prompts.
 * @footnote-ethics: medium - Attachment summaries can influence assistant claims, so this path stays fail-open and explicit about uncertainty.
 */
import type { Citation } from '@footnote/contracts/policy';
import type { InternalImageDescriptionTaskService } from '../../internalText.js';
import {
    buildAttachmentCitation,
    getAttachmentsFromUnknownInput,
    isImageAttachment,
} from '../../attachments/attachmentContext.js';
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

type FileScanningExecutorLogger = {
    warn: (message: string, meta?: Record<string, unknown>) => void;
};

type CreateFileScanningContextStepExecutorOptions = {
    imageDescriptionTaskService?: InternalImageDescriptionTaskService | null;
    logger: FileScanningExecutorLogger;
};

const FILE_SCAN_TOOL_NAME = 'file_scan';

export const createFileScanningContextStepExecutor = ({
    imageDescriptionTaskService,
    logger,
}: CreateFileScanningContextStepExecutorOptions): ContextStepExecutor => {
    const execute: ContextStepExecutor = async (
        input: ContextStepExecutorInput
    ): Promise<ContextStepResult> => {
        const attachmentList = getAttachmentsFromUnknownInput(
            input.request.input?.attachments
        );
        const userContext =
            typeof input.request.input?.latestUserInput === 'string'
                ? input.request.input.latestUserInput.trim()
                : '';

        if (!input.request.requested || !input.request.eligible) {
            return buildSkippedContextStepResult({
                toolName: FILE_SCAN_TOOL_NAME,
                reasonCode: input.request.reasonCode ?? 'tool_not_requested',
            });
        }

        if (attachmentList.length === 0) {
            return buildSkippedContextStepResult({
                toolName: FILE_SCAN_TOOL_NAME,
                reasonCode: 'tool_not_used',
            });
        }

        const contextMessages: string[] = [];
        const sources: Citation[] = [];

        for (const [index, attachment] of attachmentList.entries()) {
            const contentType = attachment.contentType?.toLowerCase() ?? '';
            if (isImageAttachment(attachment)) {
                if (!imageDescriptionTaskService) {
                    contextMessages.push(
                        `[Attachment ${index + 1}] image present but image scanning is unavailable in this runtime.`
                    );
                    sources.push(
                        buildAttachmentCitation({
                            attachment,
                            title: `Attachment ${index + 1} (image)`,
                            snippet: 'Image scanning unavailable at runtime.',
                        })
                    );
                    continue;
                }

                const taskResult = await runNonBlockingIntegrationTask({
                    integrationName: FILE_SCAN_TOOL_NAME,
                    logger,
                    contextStepInput: input,
                    onErrorMessage:
                        'file_scan: image-description task failed; continuing without image grounding.',
                    task: () =>
                        imageDescriptionTaskService.runImageDescriptionTask({
                            task: 'image_description',
                            imageUrl: attachment.url,
                            ...(userContext.length > 0 && {
                                context: userContext,
                            }),
                        }),
                });
                if (taskResult.status === 'executed') {
                    const response = taskResult.value;
                    contextMessages.push(
                        `[Attachment ${index + 1}] ${response.result.description}`
                    );
                    sources.push(
                        buildAttachmentCitation({
                            attachment,
                            title: `Attachment ${index + 1} (image)`,
                            snippet:
                                'Backend image-description context integration.',
                        })
                    );
                } else {
                    contextMessages.push(
                        `[Attachment ${index + 1}] image scan failed; continue without image-grounded details.`
                    );
                    sources.push(
                        buildAttachmentCitation({
                            attachment,
                            title: `Attachment ${index + 1} (image)`,
                            snippet:
                                'Image scan failed while keeping response flow non-blocking.',
                        })
                    );
                }
                continue;
            }

            const normalizedType =
                contentType.length > 0 ? contentType : 'unknown';
            contextMessages.push(
                `[Attachment ${index + 1}] non-image file attached (${normalizedType}).`
            );
            sources.push(
                buildAttachmentCitation({
                    attachment,
                    title: `Attachment ${index + 1} (file)`,
                    snippet: `Detected file attachment (${normalizedType}).`,
                })
            );
        }

        return buildExecutedContextStepResult({
            toolName: FILE_SCAN_TOOL_NAME,
            contextMessages,
            sources,
        });
    };

    return execute;
};
