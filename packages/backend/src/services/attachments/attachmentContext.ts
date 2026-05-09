/**
 * @description: Shared attachment normalization and citation helpers for backend services.
 * Centralizes image/file classification so attachment-aware workflows stay
 * consistent across integrations and runtime paths.
 * @footnote-scope: utility
 * @footnote-module: AttachmentContext
 * @footnote-risk: medium - Attachment misclassification can degrade context quality across multiple integrations.
 * @footnote-ethics: medium - Shared attachment interpretation can influence user-visible grounding and attribution.
 */
import type { Citation } from '@footnote/contracts/ethics-core';
import type { PostChatRequest } from '@footnote/contracts/web';

export type ChatAttachment = NonNullable<
    PostChatRequest['attachments']
>[number];

export const getAttachmentsFromUnknownInput = (
    attachmentsInput: unknown
): ChatAttachment[] =>
    Array.isArray(attachmentsInput)
        ? (attachmentsInput as ChatAttachment[])
        : [];

export const isImageAttachment = (attachment: ChatAttachment): boolean => {
    const contentType = attachment.contentType?.toLowerCase() ?? '';
    return attachment.kind === 'image' || contentType.startsWith('image/');
};

export const buildAttachmentCitation = (input: {
    attachment: ChatAttachment;
    title: string;
    snippet?: string;
}): Citation => ({
    title: input.title,
    url: input.attachment.url,
    ...(input.snippet !== undefined && { snippet: input.snippet }),
});
