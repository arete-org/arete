#!/usr/bin/env node
/* eslint-env node */
/* global __dirname, process */

/**
 * @description: Starts local web-first development flow with automatic first-run bootstrap and dependency install checks.
 * @footnote-scope: utility
 * @footnote-module: StartScript
 * @footnote-risk: medium - Incorrect orchestration can fail startup or run redundant setup/install steps.
 * @footnote-ethics: low - Local developer startup helper with no direct human-impact decisions.
 */
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { runCommand } = require('./lib/run-command.cjs');
const {
    MAX_PORT,
    resolveFootnoteBasePort,
    resolveWebPort,
} = require('./lib/dev-port-policy.cjs');

const repoRoot = path.resolve(__dirname, '..');
const envPath = path.join(repoRoot, '.env');
const settingsPath = path.join(repoRoot, 'footnote.yaml');
const nodeModulesPath = path.join(repoRoot, 'node_modules');
const pnpmStorePath = path.join(nodeModulesPath, '.pnpm');
const setupScriptPath = path.join(repoRoot, 'scripts', 'setup.cjs');
const preflightDevPortsScriptPath = path.join(
    repoRoot,
    'scripts',
    'preflight-dev-ports.cjs'
);
const apiClientWebClientDistPath = path.join(
    repoRoot,
    'packages',
    'api-client',
    'dist',
    'webClient.js'
);
const apiClientIndexDistPath = path.join(
    repoRoot,
    'packages',
    'api-client',
    'dist',
    'index.js'
);

const pnpmBin = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const nodeBin = process.execPath;

const run = (command, args, env = process.env) => {
    const result = runCommand(command, args, {
        cwd: repoRoot,
        env,
    });

    if (result.error) {
        throw result.error;
    }

    return result.status ?? 1;
};

const probePortOnHost = (port, host) =>
    new Promise((resolve) => {
        const server = net.createServer();
        server.unref();

        server.once('error', (error) => {
            const code = typeof error?.code === 'string' ? error.code : '';
            if (code === 'EAFNOSUPPORT') {
                resolve('unsupported');
                return;
            }
            resolve('unavailable');
        });

        server.listen({ port, host }, () => {
            server.close((closeError) => {
                if (closeError) {
                    resolve('unavailable');
                    return;
                }
                resolve('available');
            });
        });
    });

const isPortAvailable = async (port) => {
    const ipv6Probe = await probePortOnHost(port, '::');
    if (ipv6Probe === 'available') {
        return true;
    }
    if (ipv6Probe === 'unsupported') {
        const ipv4Probe = await probePortOnHost(port, '0.0.0.0');
        return ipv4Probe === 'available';
    }
    return false;
};

const resolveBackendDevPort = async (basePort) => {
    for (let port = basePort; port <= MAX_PORT; port += 1) {
        if (await isPortAvailable(port)) {
            return port;
        }
    }

    throw new Error(
        `[start] No available backend port found from ${basePort} through ${MAX_PORT}.`
    );
};

const main = async () => {
    const needsBootstrapFiles =
        !fs.existsSync(envPath) || !fs.existsSync(settingsPath);
    const needsDependencyInstall =
        !fs.existsSync(nodeModulesPath) || !fs.existsSync(pnpmStorePath);

    if (needsBootstrapFiles) {
        const setupStatus = run(nodeBin, [setupScriptPath]);
        if (setupStatus !== 0) {
            process.exit(setupStatus);
        }
    } else if (needsDependencyInstall) {
        const installStatus = run(pnpmBin, ['install']);
        if (installStatus !== 0) {
            process.exit(installStatus);
        }
    }

    const requestedBasePort = resolveFootnoteBasePort(process.env);
    const preflightEnv = {
        ...process.env,
        PORT: String(requestedBasePort),
    };

    const preflightStatus = run(
        nodeBin,
        [preflightDevPortsScriptPath, 'backend'],
        preflightEnv
    );
    if (preflightStatus !== 0) {
        process.exit(preflightStatus);
    }

    const backendPort = await resolveBackendDevPort(requestedBasePort);
    const webPreferredPort = resolveWebPort(process.env, backendPort);
    const devEnv = {
        ...process.env,
        PORT: String(backendPort),
        BACKEND_BASE_URL: `http://localhost:${backendPort}`,
        FOOTNOTE_WEB_PORT: String(webPreferredPort),
    };

    const needsApiClientBuild =
        !fs.existsSync(apiClientWebClientDistPath) ||
        !fs.existsSync(apiClientIndexDistPath);
    if (needsApiClientBuild) {
        const apiClientBuildStatus = run(
            pnpmBin,
            ['--filter', '@footnote/api-client', 'build:dev'],
            devEnv
        );
        if (apiClientBuildStatus !== 0) {
            process.exit(apiClientBuildStatus);
        }
    }

    if (backendPort !== requestedBasePort) {
        console.log(
            `[start] Backend port ${requestedBasePort} is unavailable. Using ${backendPort}.`
        );
    } else {
        console.log(`[start] Using backend dev port ${backendPort}.`);
    }
    console.log(
        `[start] Web dev prefers port ${webPreferredPort} (Vite may auto-fallback if busy).`
    );

    const devStatus = run(pnpmBin, ['dev'], devEnv);
    process.exit(devStatus);
};

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
