/**
 * @description: Validates server-local Discord node YAML parsing and credential
 * resolution behavior used by the canonical server deployment.
 * @footnote-scope: test
 * @footnote-module: LocalNodesConfigTests
 * @footnote-risk: low - Tests only exercise deterministic config validation logic.
 * @footnote-ethics: medium - Correct required/optional node behavior governs safe availability defaults.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    DEFAULT_LOCAL_DISCORD_NODES_CONFIG_PATH,
    loadLocalNodeConfig,
} from '../src/supervisor/localNodesConfig.js';

const writeTempConfig = (contents: string): string => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'footnote-nodes-'));
    const configPath = path.join(directory, 'local-discord-nodes.yaml');
    fs.writeFileSync(configPath, contents, 'utf8');
    return configPath;
};

test('local node YAML parse succeeds for Footnote/Danny/Myuri examples', () => {
    const configPath = writeTempConfig(`
version: 1
nodes:
  - id: footnote
    required: true
    credentials:
      discordTokenEnv: FOOTNOTE_DISCORD_TOKEN
      discordClientIdEnv: FOOTNOTE_DISCORD_CLIENT_ID
      discordGuildIdsEnv: FOOTNOTE_DISCORD_GUILD_IDS
      discordUserIdEnv: FOOTNOTE_DISCORD_USER_ID
      incidentSecretEnv: INCIDENT_PSEUDONYMIZATION_SECRET
    profile:
      id: footnote
      displayName: Footnote
      mentionAliases: [footnote, fn]
  - id: danny
    enabled: false
    credentials:
      discordTokenEnv: DANNY_DISCORD_TOKEN
      discordClientIdEnv: DANNY_DISCORD_CLIENT_ID
      discordGuildIdEnv: DANNY_DISCORD_GUILD_ID
      discordUserIdEnv: DANNY_DISCORD_USER_ID
      incidentSecretEnv: INCIDENT_PSEUDONYMIZATION_SECRET
    profile:
      id: danny
      displayName: Danny
      overlayPath: /data/profiles/danny.md
  - id: myuri
    credentials:
      discordTokenEnv: MYURI_DISCORD_TOKEN
      discordClientIdEnv: MYURI_DISCORD_CLIENT_ID
      discordGuildIdEnv: MYURI_DISCORD_GUILD_ID
      discordUserIdEnv: MYURI_DISCORD_USER_ID
      incidentSecretEnv: INCIDENT_PSEUDONYMIZATION_SECRET
    profile:
      id: myuri
      displayName: Myuri
`);

    const result = loadLocalNodeConfig({
        configPath,
        env: {
            FOOTNOTE_DISCORD_TOKEN: 'token-footnote',
            FOOTNOTE_DISCORD_CLIENT_ID: 'client-footnote',
            FOOTNOTE_DISCORD_GUILD_IDS: 'guild-a,guild-b',
            FOOTNOTE_DISCORD_USER_ID: 'user-footnote',
            MYURI_DISCORD_TOKEN: 'token-myuri',
            MYURI_DISCORD_CLIENT_ID: 'client-myuri',
            MYURI_DISCORD_GUILD_ID: 'guild-myuri',
            MYURI_DISCORD_USER_ID: 'user-myuri',
            INCIDENT_PSEUDONYMIZATION_SECRET: 'incident-secret',
        },
    });

    assert.equal(result.status, 'configured');
    assert.equal(result.activeNodes.length, 2);
    assert.deepEqual(
        result.activeNodes.map((entry) => entry.id),
        ['footnote', 'myuri']
    );
    assert.equal(result.activeNodes[0].profile.displayName, 'Footnote');
    assert.equal(
        result.activeNodes[1].credentials.discordGuildIds,
        'guild-myuri'
    );
    assert.deepEqual(result.disabledNodes, [
        {
            id: 'danny',
            required: false,
            reason: 'node_disabled_in_config',
        },
    ]);
});

test('missing config file returns zero local nodes without failure', () => {
    const result = loadLocalNodeConfig({
        env: {},
        configPath: '/tmp/does-not-exist-local-nodes.yaml',
    });

    assert.equal(result.status, 'missing');
    assert.equal(result.configPath, '/tmp/does-not-exist-local-nodes.yaml');
    assert.equal(result.activeNodes.length, 0);
    assert.equal(result.disabledNodes.length, 0);
});

test('duplicate node id fails with clear schema error', () => {
    const configPath = writeTempConfig(`
version: 1
nodes:
  - id: footnote
    credentials:
      discordTokenEnv: FOOTNOTE_DISCORD_TOKEN
      discordClientIdEnv: FOOTNOTE_DISCORD_CLIENT_ID
      discordGuildIdEnv: FOOTNOTE_DISCORD_GUILD_ID
      discordUserIdEnv: FOOTNOTE_DISCORD_USER_ID
      incidentSecretEnv: INCIDENT_PSEUDONYMIZATION_SECRET
    profile:
      id: footnote
      displayName: Footnote
  - id: footnote
    credentials:
      discordTokenEnv: SECOND_TOKEN
      discordClientIdEnv: SECOND_CLIENT_ID
      discordGuildIdEnv: SECOND_GUILD_ID
      discordUserIdEnv: SECOND_USER_ID
      incidentSecretEnv: INCIDENT_PSEUDONYMIZATION_SECRET
    profile:
      id: second
      displayName: Second
`);

    assert.throws(
        () => loadLocalNodeConfig({ configPath, env: {} }),
        /Duplicate node id "footnote"/
    );
});

test('required node missing credential env fails startup', () => {
    const configPath = writeTempConfig(`
version: 1
nodes:
  - id: footnote
    required: true
    credentials:
      discordTokenEnv: FOOTNOTE_DISCORD_TOKEN
      discordClientIdEnv: FOOTNOTE_DISCORD_CLIENT_ID
      discordGuildIdEnv: FOOTNOTE_DISCORD_GUILD_ID
      discordUserIdEnv: FOOTNOTE_DISCORD_USER_ID
      incidentSecretEnv: INCIDENT_PSEUDONYMIZATION_SECRET
    profile:
      id: footnote
      displayName: Footnote
`);

    assert.throws(
        () =>
            loadLocalNodeConfig({
                configPath,
                env: {
                    FOOTNOTE_DISCORD_CLIENT_ID: 'client',
                    FOOTNOTE_DISCORD_GUILD_ID: 'guild',
                    FOOTNOTE_DISCORD_USER_ID: 'user',
                    INCIDENT_PSEUDONYMIZATION_SECRET: 'incident',
                },
            }),
        /Required local node "footnote" is not launchable/
    );
});

test('optional node missing credential env is disabled', () => {
    const configPath = writeTempConfig(`
version: 1
nodes:
  - id: myuri
    required: false
    credentials:
      discordTokenEnv: MYURI_DISCORD_TOKEN
      discordClientIdEnv: MYURI_DISCORD_CLIENT_ID
      discordGuildIdEnv: MYURI_DISCORD_GUILD_ID
      discordUserIdEnv: MYURI_DISCORD_USER_ID
      incidentSecretEnv: INCIDENT_PSEUDONYMIZATION_SECRET
    profile:
      id: myuri
      displayName: Myuri
`);

    const result = loadLocalNodeConfig({
        configPath,
        env: {},
    });

    assert.equal(result.activeNodes.length, 0);
    assert.deepEqual(result.disabledNodes, [
        {
            id: 'myuri',
            required: false,
            reason: 'missing_credential_env_value:MYURI_DISCORD_TOKEN',
        },
    ]);
});

test('default local node config path is used when env path is unset', () => {
    const result = loadLocalNodeConfig({
        env: {},
        readFile: () => {
            const error = new Error('missing') as NodeJS.ErrnoException;
            error.code = 'ENOENT';
            throw error;
        },
    });

    assert.equal(result.status, 'missing');
    assert.equal(result.configPath, DEFAULT_LOCAL_DISCORD_NODES_CONFIG_PATH);
});
