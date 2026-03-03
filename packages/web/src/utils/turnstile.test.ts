/**
 * @description: Covers shared Turnstile execution and focus rules for the web ask surfaces.
 * @footnote-scope: test
 * @footnote-module: WebTurnstileRulesTests
 * @footnote-risk: medium - Missing tests could let duplicate CAPTCHA execution or focus jumps return unnoticed.
 * @footnote-ethics: medium - Regressions here directly affect accessibility and user friction on public surfaces.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    shouldAutoFocusAskInput,
    shouldExecuteTurnstileChallenge,
    type TurnstileExecutionState,
} from './turnstile.js';

const baseExecutionState: TurnstileExecutionState = {
    isCaptchaDisabled: false,
    hasToken: false,
    hasError: false,
    hasWidget: true,
    isExecuting: false,
    isMounted: true,
};

test('prompt button remains the only auto-focus path', () => {
    assert.equal(shouldAutoFocusAskInput('prompt-button'), true);
    assert.equal(shouldAutoFocusAskInput('turnstile-verify'), false);
    assert.equal(shouldAutoFocusAskInput('submit-cleanup'), false);
});

test('mounted auto-execution requires a ready mounted widget and no in-flight challenge', () => {
    assert.equal(
        shouldExecuteTurnstileChallenge('mount', baseExecutionState),
        true
    );
    assert.equal(
        shouldExecuteTurnstileChallenge('mount', {
            ...baseExecutionState,
            isExecuting: true,
        }),
        false
    );
    assert.equal(
        shouldExecuteTurnstileChallenge('mount', {
            ...baseExecutionState,
            hasToken: true,
        }),
        false
    );
});

test('fallback execution only runs when onLoad has not marked the widget mounted yet', () => {
    assert.equal(
        shouldExecuteTurnstileChallenge('fallback', {
            ...baseExecutionState,
            isMounted: false,
        }),
        true
    );
    assert.equal(
        shouldExecuteTurnstileChallenge('fallback', baseExecutionState),
        false
    );
});

test('submit-time execution is blocked when widget state is already satisfied or unavailable', () => {
    assert.equal(
        shouldExecuteTurnstileChallenge('submit', baseExecutionState),
        true
    );
    assert.equal(
        shouldExecuteTurnstileChallenge('submit', {
            ...baseExecutionState,
            hasError: true,
        }),
        false
    );
    assert.equal(
        shouldExecuteTurnstileChallenge('submit', {
            ...baseExecutionState,
            hasWidget: false,
        }),
        false
    );
    assert.equal(
        shouldExecuteTurnstileChallenge('submit', {
            ...baseExecutionState,
            isCaptchaDisabled: true,
        }),
        false
    );
});
