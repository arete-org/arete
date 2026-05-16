/**
 * @description: Verifies bounded review prompt composition from shared YAML prompt fragments.
 * @footnote-scope: test
 * @footnote-module: ReviewPromptComposerTests
 * @footnote-risk: medium - Prompt composition regressions can degrade assess/refinement quality.
 * @footnote-ethics: medium - Review prompt quality affects clarity while staying non-authoritative.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    composeAssessPrompt,
    composeRefinementPrompt,
} from '../src/services/prompts/reviewPromptComposer.js';

test('composeAssessPrompt includes base assess prompt and selected modules in deterministic order', () => {
    const composed = composeAssessPrompt({
        moduleIds: ['concise_answer', 'natural_human_style'],
    });

    assert.deepEqual(composed.appliedModuleIds, [
        'natural_human_style',
        'concise_answer',
    ]);
    assert.match(composed.prompt, /Required JSON shape/);
    assert.match(composed.prompt, /repetitive contrast patterns/i);
    assert.match(composed.prompt, /longer than needed/i);
});

test('composeRefinementPrompt applies bounded module set and includes revision instruction', () => {
    const composed = composeRefinementPrompt({
        revisionPromptPrefix: 'Custom prefix.',
        revisionInstruction: 'Trim this answer and make phrasing natural.',
        moduleIds: [
            'unknown_module',
            'concise_answer',
            'natural_human_style',
            'concise_answer',
        ],
    });

    assert.deepEqual(composed.appliedModuleIds, [
        'natural_human_style',
        'concise_answer',
    ]);
    assert.match(composed.prompt, /Custom prefix\./);
    assert.match(composed.prompt, /Revision instruction:/);
    assert.match(
        composed.prompt,
        /Trim this answer and make phrasing natural\./
    );
});
