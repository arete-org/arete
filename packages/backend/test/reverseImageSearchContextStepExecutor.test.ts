/**
 * @description: Verifies reverse-image context-step execution behavior and non-blocking degradation.
 * @footnote-scope: test
 * @footnote-module: ReverseImageSearchContextStepExecutorTests
 * @footnote-risk: medium - Regressions can silently drop image context or misreport execution state.
 * @footnote-ethics: medium - Reverse-image context affects provenance and confidence signaling for users.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createReverseImageSearchContextStepExecutor } from '../src/services/contextIntegrations/reverseImageSearch/index.js';

const createBaseInput = () => ({
    workflowId: 'wf_test',
    workflowName: 'test',
    attempt: 1,
    request: {
        integrationName: 'reverse_image_search',
        requested: true,
        eligible: true,
        input: {
            attachments: [
                {
                    kind: 'image',
                    url: 'https://example.com/image.png',
                    contentType: 'image/png',
                },
            ],
            latestUserInput: 'Check this image',
        },
    },
});

test('reverse image executor skips when no image attachments are present', async () => {
    const executor = createReverseImageSearchContextStepExecutor({
        logger: { warn: () => undefined },
    });
    const result = await executor({
        ...createBaseInput(),
        request: {
            integrationName: 'reverse_image_search',
            requested: true,
            eligible: true,
            input: {
                attachments: [
                    {
                        kind: 'file',
                        url: 'https://example.com/data.txt',
                        contentType: 'text/plain',
                    },
                ],
            },
        },
    });

    assert.equal(result.executionContext.status, 'skipped');
    assert.equal(result.executionContext.reasonCode, 'tool_not_used');
});

test('reverse image executor returns executed with provider matches', async () => {
    const executor = createReverseImageSearchContextStepExecutor({
        logger: { warn: () => undefined },
        provider: {
            search: async () => ({
                providerId: 'stub',
                confidence: 0.9,
                summary: 'Likely from a public event archive.',
                matches: [
                    {
                        title: 'Match 1',
                        url: 'https://source.example/match-1',
                        snippet: 'archive match',
                    },
                ],
            }),
        },
    });
    const result = await executor(createBaseInput());

    assert.equal(result.executionContext.status, 'executed');
    assert.equal(result.sources?.[0]?.url, 'https://source.example/match-1');
    assert.ok(
        result.contextMessages?.some((line) =>
            line.includes('Likely from a public event archive.')
        )
    );
});

test('reverse image executor skips when provider is unavailable', async () => {
    const executor = createReverseImageSearchContextStepExecutor({
        logger: { warn: () => undefined },
    });
    const result = await executor(createBaseInput());

    assert.equal(result.executionContext.status, 'skipped');
    assert.equal(result.executionContext.reasonCode, 'tool_unavailable');
});

test('reverse image executor degrades gracefully on provider failure', async () => {
    let warned = false;
    const executor = createReverseImageSearchContextStepExecutor({
        logger: {
            warn: () => {
                warned = true;
            },
        },
        provider: {
            search: async () => {
                throw new Error('provider down');
            },
        },
    });
    const result = await executor(createBaseInput());

    assert.equal(result.executionContext.status, 'executed');
    assert.equal(warned, true);
    assert.ok(
        result.contextMessages?.some((line) =>
            line.includes('reverse image search failed')
        )
    );
});
