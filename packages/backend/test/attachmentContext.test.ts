/**
 * @description: Verifies shared attachment normalization for chat context integrations.
 * Ensures Discord/web attachment payloads remain compatible with backend attachment-aware steps.
 * @footnote-scope: test
 * @footnote-module: AttachmentContextTests
 * @footnote-risk: medium - Invalid normalization can silently disable attachment-grounded tools.
 * @footnote-ethics: medium - Attachment handling influences what evidence the assistant can use.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    getAttachmentsFromUnknownInput,
    isImageAttachment,
} from '../src/services/attachments/attachmentContext.js';

test('getAttachmentsFromUnknownInput accepts contract-shaped chat attachments', () => {
    const attachments = getAttachmentsFromUnknownInput([
        {
            kind: 'image',
            url: 'https://example.com/photo.jpg',
            contentType: 'image/jpeg',
        },
        {
            kind: 'file',
            url: 'https://example.com/doc.txt',
            contentType: 'text/plain',
        },
    ]);

    assert.equal(attachments.length, 2);
    assert.equal(attachments[0]?.kind, 'image');
    assert.equal(attachments[1]?.kind, 'file');
});

test('getAttachmentsFromUnknownInput drops malformed entries', () => {
    const attachments = getAttachmentsFromUnknownInput([
        { kind: 'image', contentType: 'image/png' },
        { kind: 'file', url: 1234 },
        { kind: 'other', url: 'https://example.com/other.bin' },
    ]);

    assert.deepEqual(attachments, []);
});

test('isImageAttachment uses kind or image content type', () => {
    const byKind = isImageAttachment({
        kind: 'image',
        url: 'https://example.com/image.bin',
    });
    const byType = isImageAttachment({
        kind: 'file',
        url: 'https://example.com/image.png',
        contentType: 'image/png',
    });
    const nonImage = isImageAttachment({
        kind: 'file',
        url: 'https://example.com/readme.md',
        contentType: 'text/markdown',
    });

    assert.equal(byKind, true);
    assert.equal(byType, true);
    assert.equal(nonImage, false);
});
