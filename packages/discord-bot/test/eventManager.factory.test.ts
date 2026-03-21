/**
 * @description: Verifies the event manager prefers explicit event factories over constructor guessing.
 * @footnote-scope: test
 * @footnote-module: EventManagerFactoryTest
 * @footnote-risk: medium - If this regresses, VoiceStateHandler can fail to register and /call will break again.
 * @footnote-ethics: low - This is a structural loader test with no user content.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Collection, Client, GatewayIntentBits } from 'discord.js';

import { EventManager } from '../src/utils/eventManager.js';

test('EventManager loads events through createEvent factories', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'footnote-events-'));
    const eventFile = path.join(tempDir, 'FactoryEvent.js');

    await writeFile(
        eventFile,
        [
            "exports.createEvent = (client, dependencies) => {",
            "  client.handlers.set('voiceState', { source: 'factory', dependencyCount: Object.keys(dependencies || {}).length });",
            '  return {',
            "    name: 'ready',",
            '    once: false,',
            '    execute: () => {',
            "      client.handlers.set('factoryExecuted', true);",
            '    },',
            '  };',
            '};',
            '',
        ].join('\n'),
        'utf8'
    );

    const client = new Client({ intents: [GatewayIntentBits.Guilds] });
    client.handlers = new Collection();
    const testClient = client as unknown as {
        emit: (event: string) => boolean;
        destroy: () => void;
        handlers: Collection<string, unknown>;
    };

    const manager = new EventManager(client, { contextManager: null });

    try {
        await manager.loadEvents(tempDir);
        manager.registerAll();

        assert.equal(manager.getEventCount(), 1);
        assert.deepEqual(client.handlers.get('voiceState'), {
            source: 'factory',
            dependencyCount: 1,
        });

        testClient.emit('ready');
        assert.equal(client.handlers.get('factoryExecuted'), true);
    } finally {
        testClient.destroy();
        await rm(tempDir, { recursive: true, force: true });
    }
});
