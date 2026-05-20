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
const path = require('node:path');
const { spawnSync } = require('node:child_process');

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
const isWindows = process.platform === 'win32';

const run = (command, args, env = process.env) => {
    const normalizedCommand = command.toLowerCase();
    const isWindowsBatchCommand =
        isWindows &&
        (normalizedCommand.endsWith('.cmd') ||
            normalizedCommand.endsWith('.bat'));

    // Windows batch files like `pnpm.cmd` need `cmd.exe` to launch reliably.
    const executable = isWindowsBatchCommand ? 'cmd.exe' : command;
    const executableArgs = isWindowsBatchCommand
        ? ['/d', '/s', '/c', command, ...args]
        : args;

    const result = spawnSync(executable, executableArgs, {
        cwd: repoRoot,
        env,
        stdio: 'inherit',
    });

    if (result.error) {
        throw result.error;
    }

    return result.status ?? 1;
};

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

const preflightStatus = run(nodeBin, [preflightDevPortsScriptPath, 'backend']);
if (preflightStatus !== 0) {
    process.exit(preflightStatus);
}

const needsApiClientBuild =
    !fs.existsSync(apiClientWebClientDistPath) ||
    !fs.existsSync(apiClientIndexDistPath);
if (needsApiClientBuild) {
    const apiClientBuildStatus = run(pnpmBin, [
        '--filter',
        '@footnote/api-client',
        'build:dev',
    ]);
    if (apiClientBuildStatus !== 0) {
        process.exit(apiClientBuildStatus);
    }
}

const devStatus = run(pnpmBin, ['dev']);
process.exit(devStatus);
