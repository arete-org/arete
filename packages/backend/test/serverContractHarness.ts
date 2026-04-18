/**
 * @description: Boots the real backend server entrypoint for transport-level contract tests.
 * Provides deterministic setup for env, static fixtures, readiness checks, and teardown.
 * @footnote-scope: test
 * @footnote-module: ServerContractHarness
 * @footnote-risk: medium - Harness bugs can hide transport regressions or cause flaky CI behavior.
 * @footnote-ethics: low - Test-only infrastructure with no user-facing behavior impact.
 */
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';

type StartBackendServerContractHarnessOptions = {
    envOverrides?: Record<string, string>;
};

type StaticFixture = {
    routePath: string;
    indexWasCreated: boolean;
    createdAssetPath: string;
    createdIndexPath: string | null;
    cleanup: () => Promise<void>;
};

export type BackendServerContractHarness = {
    baseUrl: string;
    host: string;
    port: number;
    staticFixture: {
        routePath: string;
        indexWasCreated: boolean;
    };
    stop: () => Promise<void>;
};

const TEST_HOST = '127.0.0.1';

const getRepoRoot = (): string =>
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const wait = async (milliseconds: number): Promise<void> =>
    new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
    });

const reserveFreePort = async (): Promise<number> =>
    new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, TEST_HOST, () => {
            const address = server.address();
            if (!address || typeof address === 'string') {
                server.close(() => {
                    reject(new Error('Failed to reserve an IPv4 TCP port.'));
                });
                return;
            }

            const { port } = address;
            server.close((error) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve(port);
            });
        });
    });

const ensureStaticFixture = async (
    repoRoot: string
): Promise<StaticFixture> => {
    const distDir = path.join(repoRoot, 'packages/web/dist');
    await fs.mkdir(distDir, { recursive: true });

    const uniqueId = randomUUID();
    const assetFileName = `server-contract-${uniqueId}.js`;
    const createdAssetPath = path.join(distDir, assetFileName);
    await fs.writeFile(
        createdAssetPath,
        "window.__SERVER_CONTRACT_ASSET__ = 'ok';\n",
        'utf8'
    );

    const indexPath = path.join(distDir, 'index.html');
    let indexWasCreated = false;
    try {
        await fs.access(indexPath);
    } catch {
        indexWasCreated = true;
        await fs.writeFile(
            indexPath,
            '<!doctype html><html><head><meta charset="utf-8"><title>server-contract</title></head><body>server-contract-index</body></html>',
            'utf8'
        );
    }

    return {
        routePath: `/${assetFileName}`,
        indexWasCreated,
        createdAssetPath,
        createdIndexPath: indexWasCreated ? indexPath : null,
        cleanup: async () => {
            await fs.rm(createdAssetPath, { force: true });
            if (indexWasCreated) {
                await fs.rm(indexPath, { force: true });
            }
        },
    };
};

const waitForHttpReady = async (
    baseUrl: string,
    child: ChildProcess
): Promise<void> => {
    const start = Date.now();
    const timeoutMs = 15_000;

    while (Date.now() - start < timeoutMs) {
        if (child.exitCode !== null) {
            throw new Error(
                `Backend server exited early with code ${child.exitCode}.`
            );
        }

        try {
            const response = await fetch(`${baseUrl}/config.json`, {
                method: 'GET',
            });
            if (response.status >= 200 && response.status < 500) {
                return;
            }
        } catch {
            // Retry until timeout.
        }

        await wait(100);
    }

    throw new Error('Timed out waiting for backend server readiness.');
};

const stopChildProcess = async (child: ChildProcess): Promise<void> => {
    if (child.exitCode !== null) {
        return;
    }

    await new Promise<void>((resolve, reject) => {
        let settled = false;
        const timeout = setTimeout(() => {
            if (settled) {
                return;
            }
            child.kill('SIGKILL');
        }, 8_000);

        child.once('exit', () => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timeout);
            resolve();
        });

        child.once('error', (error) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timeout);
            reject(error);
        });

        child.kill('SIGTERM');
    });
};

export const startBackendServerContractHarness = async ({
    envOverrides = {},
}: StartBackendServerContractHarnessOptions = {}): Promise<BackendServerContractHarness> => {
    const repoRoot = getRepoRoot();
    const staticFixture = await ensureStaticFixture(repoRoot);
    const port = await reserveFreePort();
    const dataDir = await fs.mkdtemp(
        path.join(os.tmpdir(), 'footnote-server-contract-data-')
    );
    const child = spawn(
        process.execPath,
        ['--import', 'tsx', 'packages/backend/src/server.ts'],
        {
            cwd: repoRoot,
            env: {
                ...process.env,
                NODE_ENV: 'test',
                HOST: TEST_HOST,
                PORT: port.toString(),
                DATA_DIR: dataDir,
                PROVENANCE_SQLITE_PATH: path.join(dataDir, 'provenance.db'),
                INCIDENT_SQLITE_PATH: path.join(dataDir, 'incidents.db'),
                INCIDENT_PSEUDONYMIZATION_SECRET: 'server-contract-secret',
                TRACE_API_TOKEN: 'trace-token',
                REFLECT_SERVICE_TOKEN: 'service-token',
                ALLOWED_ORIGINS: 'https://allowed.example',
                FRAME_ANCESTORS: 'https://allowed-frame.example',
                GITHUB_WEBHOOK_SECRET: 'server-contract-secret',
                GITHUB_WEBHOOK_REPOSITORY: 'acme/server-contract',
                OPENAI_API_KEY: '',
                OLLAMA_BASE_URL: '',
                ...envOverrides,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        }
    );

    let outputBuffer = '';
    child.stdout?.on('data', (chunk: Buffer) => {
        outputBuffer += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
        outputBuffer += chunk.toString('utf8');
    });

    const baseUrl = `http://${TEST_HOST}:${port}`;
    try {
        await waitForHttpReady(baseUrl, child);
    } catch (error) {
        await stopChildProcess(child).catch(() => undefined);
        await staticFixture.cleanup().catch(() => undefined);
        await fs
            .rm(dataDir, { recursive: true, force: true })
            .catch(() => undefined);
        const details =
            outputBuffer.length > 0
                ? `\nServer output:\n${outputBuffer}`
                : '\nServer output: <empty>';
        throw new Error(
            `Failed to boot backend server contract harness: ${
                error instanceof Error ? error.message : String(error)
            }${details}`,
            {
                cause: error,
            }
        );
    }

    return {
        baseUrl,
        host: TEST_HOST,
        port,
        staticFixture: {
            routePath: staticFixture.routePath,
            indexWasCreated: staticFixture.indexWasCreated,
        },
        stop: async () => {
            await stopChildProcess(child);
            await staticFixture.cleanup();
            await fs.rm(dataDir, { recursive: true, force: true });
        },
    };
};
