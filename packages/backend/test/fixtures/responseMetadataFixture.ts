/**
 * @description: Shared test fixture for baseline response metadata used across backend chat tests.
 * @footnote-scope: test
 * @footnote-module: ResponseMetadataFixture
 * @footnote-risk: low - Fixture drift can cause inconsistent test setup across backend suites.
 * @footnote-ethics: low - Uses synthetic metadata and no user-identifying values.
 */

import type { ResponseMetadata } from '@footnote/contracts/ethics-core';

export const createMetadata = (): ResponseMetadata => ({
    responseId: 'chat_test_response',
    provenance: 'Inferred',
    safetyTier: 'Low',
    tradeoffCount: 0,
    chainHash: 'abc123def456',
    licenseContext: 'MIT + HL3',
    modelVersion: 'gpt-5-mini',
    staleAfter: new Date(Date.now() + 60000).toISOString(),
    citations: [],
    trace_target: {},
    trace_final: {},
});
