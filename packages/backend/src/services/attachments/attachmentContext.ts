/**
 * @description: Shared attachment normalization and citation helpers for backend services.
 * Centralizes image/file classification so attachment-aware workflows stay
 * consistent across integrations and runtime paths.
 * @footnote-scope: utility
 * @footnote-module: AttachmentContext
 * @footnote-risk: medium - Attachment misclassification can degrade context quality across multiple integrations.
 * @footnote-ethics: medium - Shared attachment interpretation can influence user-visible grounding and attribution.
 */
import type { Citation } from '@footnote/contracts/policy';
import type { PostChatRequest } from '@footnote/contracts/web';

export type ChatAttachment = NonNullable<
    PostChatRequest['attachments']
>[number];

const isValidChatAttachment = (value: unknown): value is ChatAttachment => {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const candidate = value as Record<string, unknown>;
    const rawUrl =
        typeof candidate.url === 'string' ? candidate.url.trim() : '';
    if (rawUrl.length === 0) {
        return false;
    }
    try {
        new URL(rawUrl);
    } catch {
        return false;
    }
    // Contract boundary: accept the shared web/discord attachment shape only.
    // Do not require surface-specific fields (for example Discord ids/filenames).
    return (
        (candidate.kind === 'image' || candidate.kind === 'file') &&
        typeof candidate.url === 'string'
    );
};

/**
 * Boundary sanitizer for external attachment payloads.
 * Fail-open behavior: returns `[]` when input is not an array or entries are invalid.
 */
export const getAttachmentsFromUnknownInput = (
    attachmentsInput: unknown
): ChatAttachment[] =>
    Array.isArray(attachmentsInput)
        ? attachmentsInput.filter(isValidChatAttachment)
        : [];

/**
 * Classifies whether an attachment is image-like for context integrations.
 * Uses `kind === 'image'` first, then falls back to `contentType` prefix checks.
 */
export const isImageAttachment = (attachment: ChatAttachment): boolean => {
    const contentType = attachment.contentType?.toLowerCase() ?? '';
    return attachment.kind === 'image' || contentType.startsWith('image/');
};

/**
 * Builds a citation from an attachment for provenance-oriented context output.
 * Authority decision: trusts `attachment.url` as the source URL.
 */
export const buildAttachmentCitation = (input: {
    attachment: ChatAttachment;
    title: string;
    snippet?: string;
}): Citation => ({
    title: input.title,
    url: input.attachment.url,
    ...(input.snippet !== undefined && { snippet: input.snippet }),
});
