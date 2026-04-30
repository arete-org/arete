/**
 * @description: Verifies deterministic mapping from tool execution context to tool execution events.
 * @footnote-scope: test
 * @footnote-module: ToolExecutionEventsTests
 * @footnote-risk: low - Focused unit tests cover one mapping helper.
 * @footnote-ethics: medium - Stable tool metadata improves trace clarity and governance visibility.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { ToolExecutionContext } from '@footnote/contracts/ethics-core';
import { buildToolExecutionEvent } from '../src/services/tools/toolExecutionEvents.js';

test('buildToolExecutionEvent maps executed tool context to tool event', () => {
    const context: ToolExecutionContext = {
        toolName: 'weather_forecast',
        status: 'executed',
    };

    assert.deepEqual(buildToolExecutionEvent(context), {
        kind: 'tool',
        toolName: 'weather_forecast',
        status: 'executed',
    });
});

test('buildToolExecutionEvent preserves failed reasonCode and durationMs', () => {
    const context: ToolExecutionContext = {
        toolName: 'weather_forecast',
        status: 'failed',
        reasonCode: 'tool_timeout',
        durationMs: 347,
    };

    assert.deepEqual(buildToolExecutionEvent(context), {
        kind: 'tool',
        toolName: 'weather_forecast',
        status: 'failed',
        reasonCode: 'tool_timeout',
        durationMs: 347,
    });
});

test('buildToolExecutionEvent preserves clarification payload when present', () => {
    const context: ToolExecutionContext = {
        toolName: 'weather_forecast',
        status: 'executed',
        clarification: {
            reasonCode: 'ambiguous_location',
            question: 'Which New York did you mean?',
            options: [
                {
                    id: 'nyc',
                    label: 'New York City, New York, United States',
                },
            ],
        },
        durationMs: 9,
    };

    const event = buildToolExecutionEvent(context);
    assert.equal(event.kind, 'tool');
    assert.equal(event.toolName, 'weather_forecast');
    assert.equal(event.status, 'executed');
    assert.equal(event.durationMs, 9);
    assert.equal(event.clarification?.reasonCode, 'ambiguous_location');
    assert.equal(event.clarification?.options.length, 1);
});
