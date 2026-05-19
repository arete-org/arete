/**
 * @description: Verifies server settings YAML boundary behavior for backend runtime config.
 * @footnote-scope: test
 * @footnote-module: BackendSettingsBoundaryTest
 * @footnote-risk: medium - Missing tests can allow config-source regressions across runtime boundaries.
 * @footnote-ethics: medium - Boundary regressions can blur secret and operator-control semantics.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildRuntimeConfig } from '../src/config/buildRuntimeConfig.js';

test('settings_yaml env keys in process.env are ignored with warning', () => {
    const warnings: string[] = [];
    const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'footnote-settings-')
    );
    const settingsPath = path.join(tempDir, 'footnote.server.yaml');
    fs.writeFileSync(
        settingsPath,
        'settings:\n  env:\n    WEB_API_RATE_LIMIT_IP: 41\n',
        'utf8'
    );

    const config = buildRuntimeConfig(
        {
            NODE_ENV: 'test',
            FOOTNOTE_SERVER_SETTINGS_PATH: settingsPath,
            WEB_API_RATE_LIMIT_IP: '999',
        },
        (message) => warnings.push(message)
    );

    assert.equal(config.rateLimits.web.ip.limit, 41);
    assert.match(
        warnings.join('\n'),
        /Ignoring deprecated env key WEB_API_RATE_LIMIT_IP/i
    );
});

test('secret env key in settings yaml fails validation', () => {
    const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'footnote-settings-')
    );
    const settingsPath = path.join(tempDir, 'footnote.server.yaml');
    fs.writeFileSync(
        settingsPath,
        'settings:\n  env:\n    TRACE_API_TOKEN: should-not-be-here\n',
        'utf8'
    );

    assert.throws(() => {
        buildRuntimeConfig(
            {
                NODE_ENV: 'test',
                FOOTNOTE_SERVER_SETTINGS_PATH: settingsPath,
            },
            () => undefined
        );
    }, /must not contain secret values|not YAML-configurable/i);
});

test('integer settings reject non-integer numbers', () => {
    const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'footnote-settings-')
    );
    const settingsPath = path.join(tempDir, 'footnote.server.yaml');
    fs.writeFileSync(
        settingsPath,
        'settings:\n  env:\n    WEB_API_RATE_LIMIT_IP: 3.5\n',
        'utf8'
    );

    assert.throws(() => {
        buildRuntimeConfig(
            {
                NODE_ENV: 'test',
                FOOTNOTE_SERVER_SETTINGS_PATH: settingsPath,
            },
            () => undefined
        );
    }, /settings\.env\.WEB_API_RATE_LIMIT_IP must be an integer/i);
});

test('rejects removed settings.localNodes.configPath', () => {
    const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'footnote-settings-')
    );
    const settingsPath = path.join(tempDir, 'footnote.server.yaml');
    fs.writeFileSync(
        settingsPath,
        'settings:\n  localNodes:\n    configPath: /data/config/local-discord-nodes.yaml\n',
        'utf8'
    );

    assert.throws(() => {
        buildRuntimeConfig(
            {
                NODE_ENV: 'test',
                FOOTNOTE_SERVER_SETTINGS_PATH: settingsPath,
            },
            () => undefined
        );
    }, /settings\.localNodes\.configPath is removed/i);
});

test('rejects bootstrap env keys in YAML settings.env', () => {
    const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'footnote-settings-')
    );
    const settingsPath = path.join(tempDir, 'footnote.server.yaml');
    fs.writeFileSync(
        settingsPath,
        'settings:\n  env:\n    FLY_APP_NAME: footnote-server\n',
        'utf8'
    );

    assert.throws(() => {
        buildRuntimeConfig(
            {
                NODE_ENV: 'test',
                FOOTNOTE_SERVER_SETTINGS_PATH: settingsPath,
            },
            () => undefined
        );
    }, /not YAML-configurable/i);
});

test('LOCAL_DISCORD_NODES_CONFIG_PATH warns and is ignored', () => {
    const warnings: string[] = [];
    const config = buildRuntimeConfig(
        {
            NODE_ENV: 'test',
            LOCAL_DISCORD_NODES_CONFIG_PATH: '/tmp/legacy.yaml',
        },
        (message) => warnings.push(message)
    );

    assert.equal(config.settings.localNodes, null);
    assert.match(
        warnings.join('\n'),
        /LOCAL_DISCORD_NODES_CONFIG_PATH is unsupported.*Ignoring env value/i
    );
});

test('canonical localNodes definitions load under settings.localNodes.nodes', () => {
    const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'footnote-settings-')
    );
    const settingsPath = path.join(tempDir, 'footnote.server.yaml');
    fs.writeFileSync(
        settingsPath,
        [
            'version: 1',
            'settings:',
            '  localNodes:',
            '    nodes:',
            '      - id: main-discord',
            '        enabled: true',
            '        required: false',
            '        credentials:',
            '          discordTokenEnv: DISCORD_TOKEN',
            '          discordClientIdEnv: DISCORD_CLIENT_ID',
            '          discordGuildIdEnv: DISCORD_GUILD_ID',
            '          discordUserIdEnv: DISCORD_USER_ID',
            '          incidentSecretEnv: INCIDENT_PSEUDONYMIZATION_SECRET',
            '        profile:',
            '          id: main',
            '          displayName: Main',
            '',
        ].join('\n'),
        'utf8'
    );

    const config = buildRuntimeConfig(
        {
            NODE_ENV: 'test',
            FOOTNOTE_SERVER_SETTINGS_PATH: settingsPath,
        },
        () => undefined
    );

    assert.equal(config.settings.localNodes?.nodes.length, 1);
    assert.equal(config.settings.localNodes?.nodes[0]?.id, 'main-discord');
});
