/**
 * @description: Verifies /trace-preview command wiring to backend trace-card API and Discord attachment output.
 * @footnote-scope: test
 * @footnote-module: TracePreviewCommandTests
 * @footnote-risk: low - Test-only checks for command payload wiring and fail-open behavior.
 * @footnote-ethics: low - Uses synthetic TRACE values and no user-identifying data.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { botApi } from '../src/api/botApi.js';
import { runtimeConfig } from '../src/config.js';
import tracePreviewCommand from '../src/commands/trace-preview.js';

type MockInteraction = {
    user: { id: string };
    options: {
        getInteger: (name: string, required?: boolean) => number | null;
        getNumber: (name: string, required?: boolean) => number | null;
    };
    reply: (payload: unknown) => Promise<void>;
    followUp: (payload: unknown) => Promise<void>;
    replied: boolean;
    deferred: boolean;
};

test('trace-preview replies with only backend PNG attachment', async () => {
    const originalPostTraceCard = botApi.postTraceCard;
    const replyPayloads: unknown[] = [];
    let capturedRequest: unknown = null;

    botApi.postTraceCard = (async (request) => {
        capturedRequest = request;
        return {
            responseId: 'trace-card-preview-123',
            pngBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
        };
    }) as typeof botApi.postTraceCard;

    const optionValues: Record<string, number | string | null> = {
        tightness: 9,
        rationale: 6,
        attribution: 8,
        caution: 6,
        extent: 7,
        evidence_score: 3.6,
        freshness_score: 4.2,
    };

    const interaction = {
        user: { id: runtimeConfig.developerUserId as unknown as string },
        options: {
            getInteger: (name: string) =>
                (optionValues[name] as number | null) ?? null,
            getNumber: (name: string) =>
                (optionValues[name] as number | null) ?? null,
        },
        reply: async (payload: unknown) => {
            replyPayloads.push(payload);
        },
        followUp: async () => undefined,
        replied: false,
        deferred: false,
    } as unknown as MockInteraction;

    try {
        await tracePreviewCommand.execute(interaction as never);
    } finally {
        botApi.postTraceCard = originalPostTraceCard;
    }

    assert.equal(replyPayloads.length, 1);
    const payload = replyPayloads[0] as {
        embeds?: unknown[];
        files?: Array<{ name?: string }>;
    };

    assert.equal(payload.files?.[0]?.name, 'trace-card.png');
    assert.equal(payload.embeds, undefined);
    assert.deepEqual(capturedRequest, {
        temperament: {
            tightness: 9,
            rationale: 6,
            attribution: 8,
            caution: 6,
            extent: 7,
        },
        chips: {
            evidenceScore: 3.6,
            freshnessScore: 4.2,
        },
    });
});
