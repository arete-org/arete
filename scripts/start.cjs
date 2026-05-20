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

const pnpmBin = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const nodeBin = process.execPath;
const isWindows = process.platform === 'win32';

const resolveCommand = (command, env = process.env) => {
    if (path.isAbsolute(command)) {
        return command;
    }

    if (command.includes(path.sep) || (path.sep === '\\' && command.includes('/'))) {
        return path.resolve(repoRoot, command);
    }

    const pathValue = env.PATH || env.Path || env.path || '';
    const pathDirs = pathValue.split(path.delimiter).filter(Boolean);
    const pathext = isWindows
        ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
              .split(';')
              .map((ext) => ext.toLowerCase())
        : [''];
    const hasExtension = !!path.extname(command);
    const candidates = isWindows && !hasExtension
        ? pathext.map((ext) => `${command}${ext}`)
        : [command];

    for (const dir of pathDirs) {
        for (const candidate of candidates) {
            const fullPath = path.join(dir, candidate);
            if (fs.existsSync(fullPath)) {
                return fullPath;
            }
        }
    }

    throw new Error(`Unable to resolve executable: ${command}`);
};

const run = (command, args, env = process.env) => {
    const executable = resolveCommand(command, env);
    const result = spawnSync(executable, args, {
        cwd: repoRoot,
        env,
        stdio: 'inherit',
        shell: false,
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

const devStatus = run(pnpmBin, ['dev']);
process.exit(devStatus);
