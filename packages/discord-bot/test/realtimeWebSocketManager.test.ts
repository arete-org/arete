/**
 * @description: Validates realtime websocket lifecycle behavior and event dispatch.
 * @footnote-scope: test
 * @footnote-module: RealtimeWebSocketManagerTests
 * @footnote-risk: medium - Missing tests could hide websocket lifecycle regressions in voice sessions.
 * @footnote-ethics: low - Uses synthetic payloads only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import type WebSocket from 'ws';

import { RealtimeWebSocketManager } from '../src/realtime/RealtimeWebSocketManager.js';

const waitForEvent = <T>(
    register: (resolve: (value: T) => void) => void,
    timeoutMs = 1000
): Promise<T> =>
    new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error('Timed out waiting for event'));
        }, timeoutMs);

        register((value) => {
            clearTimeout(timer);
            resolve(value);
        });
    });

test('RealtimeWebSocketManager connects, dispatches events, and resets on close', async () => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await waitForEvent<void>((resolve) => {
        wss.once('listening', () => resolve());
    });

    const address = wss.address();
    assert.ok(address && typeof address === 'object');
    const url = `ws://127.0.0.1:${address.port}`;

    const socketPromise = waitForEvent<WebSocket>((resolve) => {
        wss.once('connection', (socket) => resolve(socket));
    });

    const manager = new RealtimeWebSocketManager();
    const rawMessagePromise = waitForEvent<WebSocket.RawData>((resolve) => {
        manager.onMessage((data) => resolve(data));
    });
    const eventPromise = waitForEvent<void>((resolve) => {
        manager.on('session.ready', () => resolve());
    });

    await manager.connect(url, {});
    assert.equal(manager.isConnectionReady(), true);

    const serverSocket = await socketPromise;
    serverSocket.send(
        JSON.stringify({
            type: 'session.ready',
            payload: 'ok',
        })
    );

    const rawMessage = await rawMessagePromise;
    assert.ok(rawMessage);
    await eventPromise;

    const closePromise = waitForEvent<void>((resolve) => {
        manager.onClose(() => resolve());
    });

    serverSocket.close(1000, 'test_close');
    await closePromise;
    assert.equal(manager.isConnectionReady(), false);

    manager.disconnect();
    await waitForEvent<void>((resolve) => {
        wss.close(() => resolve());
    });
});
