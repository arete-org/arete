/**
 * @description: Validates canonical Discord bot definition parsing and runtime credential resolution behavior.
 * @footnote-scope: test
 * @footnote-module: LocalNodesConfigTests
 * @footnote-risk: low - Tests only exercise deterministic config validation logic.
 * @footnote-ethics: medium - Correct required/optional bot behavior governs safe availability defaults.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    parseLocalNodeDefinitions,
    resolveLocalNodeDefinitions,
} from '../src/supervisor/localNodesConfig.js';

test('discord bot definition parse succeeds for multiple bots', () => {
    const parsed = parseLocalNodeDefinitions([
        {
            id: 'footnote',
            required: true,
            credentials: {
                discordTokenEnv: 'FOOTNOTE_DISCORD_TOKEN',
                discordClientIdEnv: 'FOOTNOTE_DISCORD_CLIENT_ID',
                discordGuildIdsEnv: 'FOOTNOTE_DISCORD_GUILD_IDS',
                discordUserIdEnv: 'FOOTNOTE_DISCORD_USER_ID',
                incidentSecretEnv: 'INCIDENT_PSEUDONYMIZATION_SECRET',
            },
            profile: {
                id: 'footnote',
                displayName: 'Footnote',
                mentionAliases: ['footnote', 'fn'],
            },
        },
        {
            id: 'danny',
            enabled: false,
            credentials: {
                discordTokenEnv: 'DANNY_DISCORD_TOKEN',
                discordClientIdEnv: 'DANNY_DISCORD_CLIENT_ID',
                discordGuildIdsEnv: 'DANNY_DISCORD_GUILD_IDS',
                discordUserIdEnv: 'DANNY_DISCORD_USER_ID',
                incidentSecretEnv: 'INCIDENT_PSEUDONYMIZATION_SECRET',
            },
            profile: {
                id: 'danny',
                displayName: 'Danny',
                overlayPath: '/data/profiles/danny.md',
            },
        },
        {
            id: 'myuri',
            credentials: {
                discordTokenEnv: 'MYURI_DISCORD_TOKEN',
                discordClientIdEnv: 'MYURI_DISCORD_CLIENT_ID',
                discordGuildIdsEnv: 'MYURI_DISCORD_GUILD_IDS',
                discordUserIdEnv: 'MYURI_DISCORD_USER_ID',
                incidentSecretEnv: 'INCIDENT_PSEUDONYMIZATION_SECRET',
            },
            profile: {
                id: 'myuri',
                displayName: 'Myuri',
            },
        },
    ]);

    const result = resolveLocalNodeDefinitions(parsed, {
        FOOTNOTE_DISCORD_TOKEN: 'token-footnote',
        FOOTNOTE_DISCORD_CLIENT_ID: 'client-footnote',
        FOOTNOTE_DISCORD_GUILD_IDS: 'guild-a,guild-b',
        FOOTNOTE_DISCORD_USER_ID: 'user-footnote',
        MYURI_DISCORD_TOKEN: 'token-myuri',
        MYURI_DISCORD_CLIENT_ID: 'client-myuri',
        MYURI_DISCORD_GUILD_IDS: 'guild-myuri-a,guild-myuri-b',
        MYURI_DISCORD_USER_ID: 'user-myuri',
        INCIDENT_PSEUDONYMIZATION_SECRET: 'incident-secret',
    });

    assert.equal(result.activeNodes.length, 2);
    assert.deepEqual(
        result.activeNodes.map((entry) => entry.id),
        ['footnote', 'myuri']
    );
    assert.equal(result.activeNodes[0].profile.displayName, 'Footnote');
    assert.equal(
        result.activeNodes[1].credentials.discordGuildIds,
        'guild-myuri-a,guild-myuri-b'
    );
    assert.deepEqual(result.disabledNodes, [
        {
            id: 'danny',
            required: false,
            reason: 'node_disabled_in_config',
        },
    ]);
});

test('duplicate node id fails with clear schema error', () => {
    assert.throws(
        () =>
            parseLocalNodeDefinitions([
                {
                    id: 'footnote',
                    credentials: {
                        discordTokenEnv: 'A',
                        discordClientIdEnv: 'B',
                        discordGuildIdsEnv: 'C',
                        discordUserIdEnv: 'D',
                        incidentSecretEnv: 'E',
                    },
                    profile: { id: 'one', displayName: 'One' },
                },
                {
                    id: 'footnote',
                    credentials: {
                        discordTokenEnv: 'F',
                        discordClientIdEnv: 'G',
                        discordGuildIdsEnv: 'H',
                        discordUserIdEnv: 'I',
                        incidentSecretEnv: 'J',
                    },
                    profile: { id: 'two', displayName: 'Two' },
                },
            ]),
        /Duplicate node id "footnote"/
    );
});

test('required bot missing credential env fails startup', () => {
    const parsed = parseLocalNodeDefinitions([
        {
            id: 'footnote',
            required: true,
            credentials: {
                discordTokenEnv: 'FOOTNOTE_DISCORD_TOKEN',
                discordClientIdEnv: 'FOOTNOTE_DISCORD_CLIENT_ID',
                discordGuildIdsEnv: 'FOOTNOTE_DISCORD_GUILD_IDS',
                discordUserIdEnv: 'FOOTNOTE_DISCORD_USER_ID',
                incidentSecretEnv: 'INCIDENT_PSEUDONYMIZATION_SECRET',
            },
            profile: { id: 'footnote', displayName: 'Footnote' },
        },
    ]);

    assert.throws(
        () =>
            resolveLocalNodeDefinitions(parsed, {
                FOOTNOTE_DISCORD_CLIENT_ID: 'client',
                FOOTNOTE_DISCORD_GUILD_IDS: 'guild',
                FOOTNOTE_DISCORD_USER_ID: 'user',
                INCIDENT_PSEUDONYMIZATION_SECRET: 'incident',
            }),
        /Required discord bot "footnote" is not launchable/
    );
});

test('optional bot missing credential env is disabled', () => {
    const parsed = parseLocalNodeDefinitions([
        {
            id: 'myuri',
            required: false,
            credentials: {
                discordTokenEnv: 'MYURI_DISCORD_TOKEN',
                discordClientIdEnv: 'MYURI_DISCORD_CLIENT_ID',
                discordGuildIdsEnv: 'MYURI_DISCORD_GUILD_IDS',
                discordUserIdEnv: 'MYURI_DISCORD_USER_ID',
                incidentSecretEnv: 'INCIDENT_PSEUDONYMIZATION_SECRET',
            },
            profile: { id: 'myuri', displayName: 'Myuri' },
        },
    ]);

    const result = resolveLocalNodeDefinitions(parsed, {});
    assert.equal(result.activeNodes.length, 0);
    assert.deepEqual(result.disabledNodes, [
        {
            id: 'myuri',
            required: false,
            reason: 'missing_credential_env_value:MYURI_DISCORD_TOKEN',
        },
    ]);
});
