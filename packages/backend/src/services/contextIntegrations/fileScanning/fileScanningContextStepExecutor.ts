/**
 * @description: File scanning context-step executor for attachment grounding.
 * Scans image attachments with the backend image-description task and reports
 * non-image files as structured advisory context.
 * @footnote-scope: core
 * @footnote-module: FileScanningContextStepExecutor
 * @footnote-risk: medium - Incorrect attachment handling can reduce grounding quality for attachment-driven prompts.
 * @footnote-ethics: medium - Attachment summaries can influence assistant claims, so this path stays fail-open and explicit about uncertainty.
 */
import type { Citation } from '@footnote/contracts/ethics-core';
import type { PostChatRequest } from '@footnote/contracts/web';
import type { InternalImageDescriptionTaskService } from '../../internalText.js';
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

type ChatAttachment = NonNullable<PostChatRequest['attachments']>[number];

const buildAttachmentSource = (
    attachment: ChatAttachment,
    title: string,
    snippet?: string
): Citation => ({
    title,
    url: attachment.url,
    ...(snippet !== undefined && { snippet }),
});

export const createFileScanningContextStepExecutor = ({
    imageDescriptionTaskService,
    logger,
}: CreateFileScanningContextStepExecutorOptions): ContextStepExecutor => {
    const execute: ContextStepExecutor = async (
        input: ContextStepExecutorInput
    ): Promise<ContextStepResult> => {
        const requestedAttachments = input.request.input?.attachments;
        const attachmentList = Array.isArray(requestedAttachments)
            ? (requestedAttachments as ChatAttachment[])
            : [];
        const userContext =
            typeof input.request.input?.latestUserInput === 'string'
                ? input.request.input.latestUserInput.trim()
                : '';

        if (!input.request.requested || !input.request.eligible) {
            return {
                executionContext: {
                    toolName: 'file_scan',
                    status: 'skipped',
                    reasonCode:
                        input.request.reasonCode ?? 'tool_not_requested',
                },
            };
        }

        if (attachmentList.length === 0) {
            return {
                executionContext: {
                    toolName: 'file_scan',
                    status: 'skipped',
                    reasonCode: 'tool_not_used',
                },
            };
        }

        const contextMessages: string[] = [];
        const sources: Citation[] = [];

        for (const [index, attachment] of attachmentList.entries()) {
            const contentType = attachment.contentType?.toLowerCase() ?? '';
            const isImage =
                attachment.kind === 'image' || contentType.startsWith('image/');
            if (isImage) {
                if (!imageDescriptionTaskService) {
                    contextMessages.push(
                        `[Attachment ${index + 1}] image present but image scanning is unavailable in this runtime.`
                    );
                    sources.push(
                        buildAttachmentSource(
                            attachment,
                            `Attachment ${index + 1} (image)`,
                            'Image scanning unavailable at runtime.'
                        )
                    );
                    continue;
                }

                try {
                    const response =
                        await imageDescriptionTaskService.runImageDescriptionTask(
                            {
                                task: 'image_description',
                                imageUrl: attachment.url,
                                ...(userContext.length > 0 && {
                                    context: userContext,
                                }),
                            }
                        );
                    contextMessages.push(
                        `[Attachment ${index + 1}] ${response.result.description}`
                    );
                    sources.push(
                        buildAttachmentSource(
                            attachment,
                            `Attachment ${index + 1} (image)`,
                            'Backend image-description context integration.'
                        )
                    );
                } catch (error) {
                    logger.warn(
                        'file_scan: image-description task failed; continuing without image grounding.',
                        {
                            attachmentIndex: index + 1,
                            error:
                                error instanceof Error
                                    ? error.message
                                    : String(error),
                        }
                    );
                    contextMessages.push(
                        `[Attachment ${index + 1}] image scan failed; continue without image-grounded details.`
                    );
                    sources.push(
                        buildAttachmentSource(
                            attachment,
                            `Attachment ${index + 1} (image)`,
                            'Image scan failed in fail-open mode.'
                        )
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
                buildAttachmentSource(
                    attachment,
                    `Attachment ${index + 1} (file)`,
                    `Detected file attachment (${normalizedType}).`
                )
            );
        }

        return {
            executionContext: {
                toolName: 'file_scan',
                status: 'executed',
            },
            ...(contextMessages.length > 0 && { contextMessages }),
            ...(sources.length > 0 && { sources }),
        };
    };

    return execute;
};
