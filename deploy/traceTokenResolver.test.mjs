/**
 * @description: Verifies trace token resolution precedence and persistence behavior.
 * @footnote-scope: test
 * @footnote-module: TraceTokenResolverTests
 * @footnote-risk: medium - Missing tests can let token auth behavior regress silently.
 * @footnote-ethics: medium - Token handling bugs can weaken service-to-service trust boundaries.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
    formatTraceTokenSourceLog,
    resolveTraceToken,
} from './traceTokenResolver.mjs';

const withTempDir = async (fn) => {
    const tempDir = await fs.mkdtemp(
        path.join(os.tmpdir(), 'footnote-trace-token-')
    );
    try {
        await fn(tempDir);
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
    }
};

test('env token takes precedence over file/default', async () => {
    await withTempDir(async (tempDir) => {
        const tokenPath = path.join(tempDir, 'secrets', 'trace-api-token');
        await fs.mkdir(path.dirname(tokenPath), { recursive: true });
        await fs.writeFile(tokenPath, 'file-token\n', 'utf8');

        const resolved = await resolveTraceToken({
            env: {
                TRACE_API_TOKEN: 'env-token',
                TRACE_API_TOKEN_FILE: tokenPath,
            },
            defaultTokenPath: tokenPath,
        });

        assert.equal(resolved.token, 'env-token');
        assert.equal(resolved.source, 'env');
        assert.equal(resolved.path, undefined);
    });
});

test('TRACE_API_TOKEN_FILE is used when env token is missing', async () => {
    await withTempDir(async (tempDir) => {
        const tokenPath = path.join(tempDir, 'custom-token');
        await fs.writeFile(tokenPath, 'file-token\n', 'utf8');

        const resolved = await resolveTraceToken({
            env: { TRACE_API_TOKEN_FILE: tokenPath },
        });

        assert.equal(resolved.token, 'file-token');
        assert.equal(resolved.source, 'existing-file');
        assert.equal(resolved.path, tokenPath);
    });
});

test('default path token file is created when env and file are absent', async () => {
    await withTempDir(async (tempDir) => {
        const tokenPath = path.join(tempDir, 'secrets', 'trace-api-token');

        const resolved = await resolveTraceToken({
            env: {},
            defaultTokenPath: tokenPath,
        });

        assert.equal(resolved.path, tokenPath);
        assert.equal(resolved.source, 'generated-file');
        assert.equal(typeof resolved.token, 'string');
        assert.equal(resolved.token.length, 64);

        const stored = (await fs.readFile(tokenPath, 'utf8')).trim();
        assert.equal(stored, resolved.token);
    });
});

test('existing default token is reused on subsequent runs', async () => {
    await withTempDir(async (tempDir) => {
        const tokenPath = path.join(tempDir, 'secrets', 'trace-api-token');

        const first = await resolveTraceToken({
            env: {},
            defaultTokenPath: tokenPath,
        });
        const second = await resolveTraceToken({
            env: {},
            defaultTokenPath: tokenPath,
        });

        assert.equal(first.source, 'generated-file');
        assert.equal(second.source, 'existing-file');
        assert.equal(first.token, second.token);
    });
});

test('empty token file fails with clear error', async () => {
    await withTempDir(async (tempDir) => {
        const tokenPath = path.join(tempDir, 'secrets', 'trace-api-token');
        await fs.mkdir(path.dirname(tokenPath), { recursive: true });
        await fs.writeFile(tokenPath, '\n', 'utf8');

        await assert.rejects(
            async () =>
                resolveTraceToken({
                    env: {},
                    defaultTokenPath: tokenPath,
                }),
            /exists but is empty/
        );
    });
});

test('unreadable token file path fails clearly', async () => {
    await withTempDir(async (tempDir) => {
        const tokenPath = path.join(tempDir, 'secrets');
        await fs.mkdir(tokenPath, { recursive: true });

        await assert.rejects(
            async () =>
                resolveTraceToken({
                    env: { TRACE_API_TOKEN_FILE: tokenPath },
                }),
            /Failed to read trace token file/
        );
    });
});

test('unwritable default token path fails clearly', async () => {
    await withTempDir(async (tempDir) => {
        const blockingFilePath = path.join(tempDir, 'blocker');
        await fs.writeFile(blockingFilePath, 'x', 'utf8');
        const tokenPath = path.join(blockingFilePath, 'trace-api-token');

        await assert.rejects(
            async () =>
                resolveTraceToken({
                    env: {},
                    defaultTokenPath: tokenPath,
                }),
            /Failed to prepare trace token directory/
        );
    });
});

test('source log line reports source but never token value', async () => {
    const line = formatTraceTokenSourceLog({
        source: 'generated-file',
        path: '/data/secrets/trace-api-token',
    });
    assert.equal(
        line,
        'TRACE_TOKEN_SOURCE=generated-file path=/data/secrets/trace-api-token'
    );
    assert.equal(line.includes('token='), false);
});
