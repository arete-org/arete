#!/usr/bin/env node
/* eslint-env node */
/* global __dirname, process */

/**
 * @description: Bootstraps a fresh workspace by syncing env, installing deps, and validating local tooling.
 * @footnote-scope: utility
 * @footnote-module: WorkspaceBootstrapScript
 * @footnote-risk: medium - Incorrect setup can block local development across all packages.
 * @footnote-ethics: low - Local developer workflow helper; no direct user-facing behavior.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const pnpmBin = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const isWindows = process.platform === 'win32';
const workspaceEnvPath = path.join(repoRoot, '.env');

const run = (command, args, env = process.env) => {
    const normalizedCommand = command.toLowerCase();
    const isWindowsBatchCommand =
        isWindows &&
        (normalizedCommand.endsWith('.cmd') ||
            normalizedCommand.endsWith('.bat'));

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

const resolveSharedEnvPath = () => {
    const explicit = process.env.FOOTNOTE_SHARED_ENV_PATH?.trim();
    if (explicit && fs.existsSync(explicit)) {
        return explicit;
    }

    const candidates = [
        path.join(os.homedir(), '.footnote', '.env'),
        path.join(os.homedir(), 'footnote', '.env'),
    ];

    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }

    return null;
};

const ensureWorkspaceEnv = () => {
    if (fs.existsSync(workspaceEnvPath)) {
        console.log(
            '[workspace:bootstrap] .env already exists in workspace; skipping sync.'
        );
        return;
    }

    const sharedEnvPath = resolveSharedEnvPath();
    if (!sharedEnvPath) {
        console.warn(
            '[workspace:bootstrap] No shared .env found. Create .env manually or set FOOTNOTE_SHARED_ENV_PATH.'
        );
        return;
    }

    fs.copyFileSync(sharedEnvPath, workspaceEnvPath);
    console.log(`[workspace:bootstrap] Copied .env from ${sharedEnvPath}`);
};

ensureWorkspaceEnv();

const installStatus = run(pnpmBin, ['install', '--frozen-lockfile']);
if (installStatus !== 0) {
    process.exit(installStatus);
}

const prettierStatus = run(pnpmBin, ['exec', 'prettier', '--version']);
if (prettierStatus !== 0) {
    process.exit(prettierStatus);
}

const tsxStatus = run(pnpmBin, ['exec', 'tsx', '--version']);
if (tsxStatus !== 0) {
    process.exit(tsxStatus);
}

console.log('[workspace:bootstrap] Workspace is ready.');
