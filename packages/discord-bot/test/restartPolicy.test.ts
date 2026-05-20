/**
 * @description: Validates discord bot restart failure-window thresholds used by
 * the canonical server supervisor.
 * @footnote-scope: test
 * @footnote-module: LocalNodeRestartPolicyTests
 * @footnote-risk: low - Tests only verify deterministic failure counting logic.
 * @footnote-ethics: low - Restart policy tuning affects availability, not authority semantics.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    LocalNodeRestartPolicy,
    LOCAL_NODE_FAILURE_WINDOW_MS,
} from '../src/supervisor/restartPolicy.js';

test('node is marked unhealthy after three failures in five minutes', () => {
    const policy = new LocalNodeRestartPolicy();
    const t0 = 1_700_000_000_000;

    const first = policy.recordFailure(t0);
    const second = policy.recordFailure(t0 + 60_000);
    const third = policy.recordFailure(t0 + 120_000);

    assert.equal(first.unhealthy, false);
    assert.equal(second.unhealthy, false);
    assert.equal(third.unhealthy, true);
    assert.equal(third.failureCount, 3);
});

test('failures outside the five-minute window are pruned', () => {
    const policy = new LocalNodeRestartPolicy();
    const t0 = 1_700_000_000_000;

    policy.recordFailure(t0);
    policy.recordFailure(t0 + 1_000);
    const later = policy.recordFailure(
        t0 + LOCAL_NODE_FAILURE_WINDOW_MS + 1_000
    );

    assert.equal(later.failureCount, 2);
    assert.equal(later.unhealthy, false);
});
