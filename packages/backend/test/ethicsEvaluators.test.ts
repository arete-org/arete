/**
 * @description: Verifies deterministic provenance evaluator heuristics and precedence.
 * @footnote-scope: test
 * @footnote-module: EthicsEvaluatorsTests
 * @footnote-risk: medium - Regressions here can misclassify response provenance and mislead downstream UX.
 * @footnote-ethics: high - Provenance labels drive transparency and user trust decisions.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    computeProvenance,
    computeProvenanceSignals,
} from '../src/ethics-core/evaluators.js';

test('computeProvenance returns Retrieved when retrieval signals exist', () => {
    const provenance = computeProvenance([
        'web_search_call executed for current events',
        'Source: https://example.com/article',
    ]);

    assert.equal(provenance, 'Retrieved');
});

test('computeProvenance returns Speculative when speculation signals exist without retrieval signals', () => {
    const provenance = computeProvenance([
        'I might be wrong, but this appears to be true.',
    ]);

    assert.equal(provenance, 'Speculative');
});

test('computeProvenance keeps Retrieved precedence when retrieval and speculation signals both exist', () => {
    const provenance = computeProvenance([
        'According to https://example.com, this might change tomorrow.',
    ]);

    assert.equal(provenance, 'Retrieved');
});

test('computeProvenance returns Inferred for grounded context with no retrieval or speculation markers', () => {
    const provenance = computeProvenance([
        'The answer summarizes known system constraints and tradeoffs.',
    ]);

    assert.equal(provenance, 'Inferred');
});

test('computeProvenance stays fail-open and deterministic for empty context', () => {
    const provenance = computeProvenance([]);

    assert.equal(provenance, 'Speculative');
});

test('computeProvenanceSignals returns a serializable signal map', () => {
    const signals = computeProvenanceSignals([
        'Citation: [1](https://example.com)',
        'This might be stale.',
    ]);

    assert.deepEqual(signals, {
        retrieval: true,
        speculation: true,
        hasContext: true,
    });
    assert.equal(typeof JSON.stringify(signals), 'string');
});
