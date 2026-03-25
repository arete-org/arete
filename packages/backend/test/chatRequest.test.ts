/**
 * @description: Covers request-body edge cases for the chat request parser.
 * @footnote-scope: test
 * @footnote-module: ChatRequestTests
 * @footnote-risk: medium - Missing tests could leave oversized request handling hanging or leaking sockets.
 * @footnote-ethics: low - This is transport hardening rather than user-facing policy logic.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import type { IncomingMessage } from 'node:http';

import { parseChatRequest } from '../src/handlers/chatRequest.js';

type TestRequest = PassThrough &
    Partial<IncomingMessage> & {
        headers: IncomingMessage['headers'];
    };

const createRequest = (headers: IncomingMessage['headers']): TestRequest => {
    const request = new PassThrough() as TestRequest;
    request.headers = headers;
    return request;
};

test('parseChatRequest resumes oversized requests rejected by content-length', async () => {
    const request = createRequest({
        'content-length': '999999',
    });
    let resumed = false;
    const originalResume = request.resume.bind(request);
    request.resume = (() => {
        resumed = true;
        return originalResume();
    }) as typeof request.resume;

    const result = await parseChatRequest(
        request as IncomingMessage,
        1024
    );

    assert.equal(result.success, false);
    if (result.success) {
        return;
    }

    assert.equal(result.error.statusCode, 413);
    assert.equal(resumed, true);
});

test('parseChatRequest resolves cleanly when an oversized streamed body destroys the request', async () => {
    const request = createRequest({});
    const resultPromise = parseChatRequest(
        request as IncomingMessage,
        5
    );

    request.write('123456');
    request.end();

    const result = await resultPromise;
    assert.equal(result.success, false);
    if (result.success) {
        return;
    }

    assert.equal(result.error.statusCode, 413);
    assert.equal(result.error.payload.error, 'Request payload too large');
});
