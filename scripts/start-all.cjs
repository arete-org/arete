#!/usr/bin/env node
/* eslint-env node */
/* global __dirname, process */

/**
 * @description: Starts backend, web, and Discord bot together after preflight checks and config build.
 * @footnote-scope: utility
 * @footnote-module: StartAllScript
 * @footnote-risk: medium - Incorrect orchestration can leave developers with partial startup or hanging processes.
 * @footnote-ethics: low - Local development startup helper; no user data handling.
 */
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
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

const withoutInspectorEnv = {
    ...process.env,
    NODE_OPTIONS: '',
    VSCODE_INSPECTOR_OPTIONS: '',
};

const preflightStatus = run(nodeBin, [
    'scripts/preflight-dev-ports.cjs',
    'all',
]);
if (preflightStatus !== 0) {
    process.exit(preflightStatus);
}

const configBuildStatus = run(
    pnpmBin,
    ['--filter', '@footnote/config-spec', 'run', 'build:dev'],
    withoutInspectorEnv
);
if (configBuildStatus !== 0) {
    process.exit(configBuildStatus);
}

const concurrentlyStatus = run(pnpmBin, [
    'exec',
    'concurrently',
    '--names',
    'backend,web,bot',
    '--prefix-colors',
    'cyan,magenta,green',
    '--kill-others',
    '--kill-others-on-fail',
    'cross-env NODE_OPTIONS= VSCODE_INSPECTOR_OPTIONS= pnpm exec tsx packages/backend/src/server.ts',
    'cross-env NODE_OPTIONS= VSCODE_INSPECTOR_OPTIONS= pnpm --filter @footnote/web dev',
    'cross-env NODE_OPTIONS= VSCODE_INSPECTOR_OPTIONS= NODE_ENV=development pnpm --filter @footnote/discord-bot exec tsx src/index.ts',
]);
process.exit(concurrentlyStatus);
