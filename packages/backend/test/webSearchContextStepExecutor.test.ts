/**
 * @description: Verifies web-search context-step executor behavior and fail-open handling.
 * @footnote-scope: test
 * @footnote-module: WebSearchContextStepExecutorTests
 * @footnote-risk: low - Coverage is isolated to one optional context integration seam.
 * @footnote-ethics: medium - Correct context-step status helps maintain transparent retrieval provenance.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWebSearchContextStepExecutor } from '../src/services/contextIntegrations/webSearch/index.js';

test('web-search context-step executor emits context message for valid request', async () => {
    const executor = createWebSearchContextStepExecutor();
    const result = await executor({
        request: {
            integrationName: 'web_search',
            requested: true,
            eligible: true,
            input: {
                query: 'Footnote architecture',
                contextSize: 'medium',
                intent: 'repo_explainer',
                repoHints: ['architecture'],
            },
        },
        workflowId: 'wf_test',
        workflowName: 'message_reviewed',
        attempt: 1,
    });

    assert.equal(result.executionContext.toolName, 'web_search');
    assert.equal(result.executionContext.status, 'executed');
    assert.equal((result.contextMessages?.length ?? 0) > 0, true);
});

test('web-search context-step executor skips when request is not requested', async () => {
    const executor = createWebSearchContextStepExecutor();
    const result = await executor({
        request: {
            integrationName: 'web_search',
            requested: false,
            eligible: false,
            reasonCode: 'tool_not_requested',
        },
        workflowId: 'wf_test',
        workflowName: 'message_reviewed',
        attempt: 1,
    });

    assert.equal(result.executionContext.status, 'skipped');
    assert.equal(result.executionContext.reasonCode, 'tool_not_requested');
});

test('web-search context-step executor fails open on invalid input', async () => {
    const executor = createWebSearchContextStepExecutor();
    const result = await executor({
        request: {
            integrationName: 'web_search',
            requested: true,
            eligible: true,
            input: {
                query: '   ',
            },
        },
        workflowId: 'wf_test',
        workflowName: 'message_reviewed',
        attempt: 1,
    });

    assert.equal(result.executionContext.status, 'failed');
    assert.equal(
        result.executionContext.reasonCode,
        'unspecified_tool_outcome'
    );
});

test('web-search context-step executor skips when provider policy has no available candidates', async () => {
    const executor = createWebSearchContextStepExecutor({
        providerPolicy: {
            mode: 'strict',
            enabledProviders: ['brave'],
            providerOrder: ['brave'],
        },
    });
    const result = await executor({
        request: {
            integrationName: 'web_search',
            requested: true,
            eligible: true,
            input: {
                query: 'Footnote architecture',
            },
        },
        workflowId: 'wf_test',
        workflowName: 'message_reviewed',
        attempt: 1,
    });

    assert.equal(result.executionContext.status, 'skipped');
    assert.equal(result.executionContext.reasonCode, 'tool_unavailable');
});
