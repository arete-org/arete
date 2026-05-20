/**
 * @description: Verifies canonical footnote.yaml source-boundary behavior for backend runtime config.
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

const withSettingsFile = (contents: string): string => {
    const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'footnote-settings-boundary-')
    );
    const settingsPath = path.join(tempDir, 'footnote.yaml');
    fs.writeFileSync(settingsPath, contents, 'utf8');
    return settingsPath;
};

test('missing footnote.yaml warns and continues with defaults', () => {
    const warnings: string[] = [];
    const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'footnote-settings-boundary-')
    );
    const missingPath = path.join(tempDir, 'footnote.yaml');

    const config = buildRuntimeConfig(
        {
            NODE_ENV: 'development',
            FOOTNOTE_SETTINGS_PATH: missingPath,
        },
        (message) => warnings.push(message)
    );

    assert.equal(config.rateLimits.web.ip.limit, 3);
    assert.match(
        warnings.join('\n'),
        /Server settings YAML not found at .*footnote\.yaml/i
    );
});

test('settings_yaml env keys in process.env are ignored with warning', () => {
    const warnings: string[] = [];
    const settingsPath = withSettingsFile(
        ['version: 1', 'rate-limits:', '  web-api-rate-limit-ip: 41', ''].join(
            '\n'
        )
    );

    const config = buildRuntimeConfig(
        {
            NODE_ENV: 'test',
            FOOTNOTE_SETTINGS_PATH: settingsPath,
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

test('integer settings reject non-integer numbers', () => {
    const settingsPath = withSettingsFile(
        ['version: 1', 'rate-limits:', '  web-api-rate-limit-ip: 3.5', ''].join(
            '\n'
        )
    );

    assert.throws(() => {
        buildRuntimeConfig(
            {
                NODE_ENV: 'test',
                FOOTNOTE_SETTINGS_PATH: settingsPath,
            },
            () => undefined
        );
    }, /rate-limits\.web-api-rate-limit-ip must be an integer/i);
});

test('secret env key in footnote.yaml fails validation', () => {
    const settingsPath = withSettingsFile(
        [
            'version: 1',
            'security:',
            '  trace-api-token: should-not-be-here',
            '',
        ].join('\n')
    );

    assert.throws(() => {
        buildRuntimeConfig(
            {
                NODE_ENV: 'test',
                FOOTNOTE_SETTINGS_PATH: settingsPath,
            },
            () => undefined
        );
    }, /maps to secret env key TRACE_API_TOKEN/i);
});

test('bootstrap env key in footnote.yaml fails validation', () => {
    const settingsPath = withSettingsFile(
        ['version: 1', 'runtime:', '  fly-app-name: footnote-server', ''].join(
            '\n'
        )
    );

    assert.throws(() => {
        buildRuntimeConfig(
            {
                NODE_ENV: 'test',
                FOOTNOTE_SETTINGS_PATH: settingsPath,
            },
            () => undefined
        );
    }, /maps to bootstrap env key FLY_APP_NAME/i);
});

test('rejects removed settings.localNodes.configPath shape', () => {
    const settingsPath = withSettingsFile(
        [
            'version: 1',
            'settings:',
            '  localNodes:',
            '    configPath: /data/config/local-discord-nodes.yaml',
            '',
        ].join('\n')
    );

    assert.throws(() => {
        buildRuntimeConfig(
            {
                NODE_ENV: 'test',
                FOOTNOTE_SETTINGS_PATH: settingsPath,
            },
            () => undefined
        );
    }, /settings\.localNodes\.configPath is removed/i);
});

test('canonical discord-bots definitions load from footnote.yaml', () => {
    const settingsPath = withSettingsFile(
        [
            'version: 1',
            'discord-bots:',
            '  - id: main-discord',
            '    enabled: true',
            '    required: false',
            '    credentials:',
            '      discord-token-env: DISCORD_TOKEN',
            '      discord-client-id-env: DISCORD_CLIENT_ID',
            '      discord-guild-ids-env: DISCORD_GUILD_IDS',
            '      discord-user-id-env: DISCORD_USER_ID',
            '      incident-secret-env: INCIDENT_PSEUDONYMIZATION_SECRET',
            '    profile:',
            '      id: main',
            '      display-name: Main',
            '',
        ].join('\n')
    );

    const config = buildRuntimeConfig(
        {
            NODE_ENV: 'test',
            FOOTNOTE_SETTINGS_PATH: settingsPath,
        },
        () => undefined
    );

    assert.equal(config.settings.discordBots?.length, 1);
    assert.equal(config.settings.discordBots?.[0]?.id, 'main-discord');
    assert.equal(
        config.settings.discordBots?.[0]?.credentials?.discordGuildIdsEnv,
        'DISCORD_GUILD_IDS'
    );
});

test('invalid present YAML fails startup', () => {
    const settingsPath = withSettingsFile('version: [1\n');

    assert.throws(() => {
        buildRuntimeConfig(
            {
                NODE_ENV: 'test',
                FOOTNOTE_SETTINGS_PATH: settingsPath,
            },
            () => undefined
        );
    }, /YAMLException|unexpected end/i);
});
