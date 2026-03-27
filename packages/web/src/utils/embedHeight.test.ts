/* eslint-disable no-undef */
/**
 * @description: Verifies embed height measurement and debounced postMessage behavior for iframe integrations.
 * @footnote-scope: test
 * @footnote-module: EmbedHeightTest
 * @footnote-risk: medium - Missing coverage can let embed resize regressions clip cross-origin integrations.
 * @footnote-ethics: medium - Broken resize behavior can hide response and provenance content from embedded users.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createEmbedHeightMessenger,
    EMBED_HEIGHT_MESSAGE_TYPE,
    LEGACY_EMBED_HEIGHT_MESSAGE_TYPE,
    measureEmbedHeight,
} from './embedHeight';

interface MockElementLike {
    scrollHeight: number;
    offsetHeight: number;
    clientHeight: number;
}

function createMockElement(
    dimensions: Partial<MockElementLike> = {}
): MockElementLike {
    return {
        clientHeight: dimensions.clientHeight ?? 0,
        offsetHeight: dimensions.offsetHeight ?? 0,
        scrollHeight: dimensions.scrollHeight ?? 0,
    };
}

test('measureEmbedHeight uses the tallest available source', () => {
    const documentRef = {
        body: createMockElement({
            clientHeight: 450,
            offsetHeight: 500,
            scrollHeight: 720,
        }),
        documentElement: createMockElement({
            clientHeight: 600,
            offsetHeight: 610,
            scrollHeight: 640,
        }),
    } as Document;
    const root = createMockElement({
        clientHeight: 650,
        offsetHeight: 700,
        scrollHeight: 880,
    }) as HTMLElement;

    assert.equal(measureEmbedHeight(root, documentRef), 880);
});

test('createEmbedHeightMessenger posts current and legacy message types once per frame', () => {
    const postedMessages: Array<{ height: number; type: string }> = [];
    const parentWindow = {
        postMessage: (message: { height: number; type: string }) => {
            postedMessages.push(message);
        },
    } as Window;

    const scheduledFrames: Array<(time: number) => void> = [];
    const mockWindow = {
        cancelAnimationFrame: () => undefined,
        parent: parentWindow,
        requestAnimationFrame: (callback: (time: number) => void) => {
            scheduledFrames.push(callback);
            return scheduledFrames.length;
        },
    } as unknown as Window & typeof globalThis;

    const previousWindow = globalThis.window;
    Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: mockWindow,
    });

    try {
        const rootElement = createMockElement({ scrollHeight: 540 });
        const documentRef = {
            body: createMockElement({ scrollHeight: 480 }),
            documentElement: createMockElement({ scrollHeight: 500 }),
        } as Document;
        const messenger = createEmbedHeightMessenger({
            document: documentRef,
            root: rootElement as HTMLElement,
            targetWindow: parentWindow,
        });

        messenger.schedulePostHeight();
        messenger.schedulePostHeight();

        const queuedFrame = scheduledFrames.shift();
        if (!queuedFrame) {
            assert.fail('expected a queued animation frame');
        }
        queuedFrame(16);

        assert.deepEqual(postedMessages, [
            { type: EMBED_HEIGHT_MESSAGE_TYPE, height: 540 },
            { type: LEGACY_EMBED_HEIGHT_MESSAGE_TYPE, height: 540 },
        ]);
    } finally {
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: previousWindow,
        });
    }
});

test('createEmbedHeightMessenger posts again when the height grows later', () => {
    const postedMessages: Array<{ height: number; type: string }> = [];
    const parentWindow = {
        postMessage: (message: { height: number; type: string }) => {
            postedMessages.push(message);
        },
    } as Window;

    const previousWindow = globalThis.window;

    try {
        const rootElement = createMockElement({ scrollHeight: 320 });
        const scheduledFrames: Array<(time: number) => void> = [];
        const documentRef = {
            body: createMockElement({ scrollHeight: 280 }),
            documentElement: createMockElement({ scrollHeight: 300 }),
        } as Document;
        const queuedWindow = {
            cancelAnimationFrame: () => undefined,
            parent: parentWindow,
            requestAnimationFrame: (callback: (time: number) => void) => {
                scheduledFrames.push(callback);
                return scheduledFrames.length;
            },
        } as unknown as Window & typeof globalThis;
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: queuedWindow,
        });
        const messenger = createEmbedHeightMessenger({
            document: documentRef,
            root: rootElement as HTMLElement,
            targetWindow: parentWindow,
        });

        messenger.schedulePostHeight();
        const firstFrame = scheduledFrames.shift();
        if (!firstFrame) {
            assert.fail('expected the first frame to be queued');
        }
        firstFrame(16);

        rootElement.scrollHeight = 640;
        messenger.schedulePostHeight();
        const secondFrame = scheduledFrames.shift();
        if (!secondFrame) {
            assert.fail('expected the second frame to be queued');
        }
        secondFrame(32);

        assert.deepEqual(postedMessages, [
            { type: EMBED_HEIGHT_MESSAGE_TYPE, height: 320 },
            { type: LEGACY_EMBED_HEIGHT_MESSAGE_TYPE, height: 320 },
            { type: EMBED_HEIGHT_MESSAGE_TYPE, height: 640 },
            { type: LEGACY_EMBED_HEIGHT_MESSAGE_TYPE, height: 640 },
        ]);
    } finally {
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: previousWindow,
        });
    }
});
