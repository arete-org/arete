#!/usr/bin/env node
/* eslint-env node */
/* global __dirname, process, console */

/**
 * @description: Bootstraps local development by creating .env, generating local secrets, and installing dependencies.
 * @footnote-scope: utility
 * @footnote-module: SetupScript
 * @footnote-risk: medium - Incorrect setup mutations can leave local runtime config inconsistent.
 * @footnote-ethics: low - Developer-only setup flow with no direct user-facing data impact.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const envPath = path.join(repoRoot, '.env');
const envExamplePath = path.join(repoRoot, '.env.example');
const settingsPath = path.join(repoRoot, 'footnote.yaml');
const pnpmBin = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const isWindows = process.platform === 'win32';
const lineEnding = process.platform === 'win32' ? '\r\n' : '\n';

const requiredGeneratedSecrets = [
    'INCIDENT_PSEUDONYMIZATION_SECRET',
    'TRACE_API_TOKEN',
];

const readEnvFile = () => {
    if (!fs.existsSync(envPath)) {
        return null;
    }
    return fs.readFileSync(envPath, 'utf8');
};

const ensureEnvFileExists = () => {
    if (fs.existsSync(envPath)) {
        console.log('[setup] Found existing .env file.');
        return;
    }

    if (!fs.existsSync(envExamplePath)) {
        throw new Error('Missing .env.example. Cannot create .env.');
    }

    fs.copyFileSync(envExamplePath, envPath);
    console.log('[setup] Created .env from .env.example.');
};

const ensureSettingsFileExists = () => {
    if (fs.existsSync(settingsPath)) {
        console.log('[setup] Found existing footnote.yaml.');
        return;
    }

    const generatorPath = path.join(
        repoRoot,
        'scripts',
        'generate-footnote-settings.cjs'
    );

    const result = spawnSync(
        process.execPath,
        [generatorPath, '--if-missing'],
        {
            cwd: repoRoot,
            stdio: 'inherit',
        }
    );

    if (result.error) {
        throw result.error;
    }
    if ((result.status ?? 1) !== 0) {
        throw new Error('Failed to generate default footnote.yaml.');
    }
};

const readEnvValue = (envContent, key) => {
    const pattern = new RegExp(`^${key}=(.*)$`, 'm');
    const match = envContent.match(pattern);
    if (!match) {
        return null;
    }
    const valueWithoutComment = match[1].replace(/\s+#.*$/, '');
    const value = valueWithoutComment.trim();
    return value.length > 0 ? value : null;
};

const upsertEnvValue = (envContent, key, value) => {
    const keyPattern = new RegExp(`^${key}=.*$`, 'm');
    const replacement = `${key}=${value}`;

    if (keyPattern.test(envContent)) {
        return envContent.replace(keyPattern, replacement);
    }

    const suffix =
        envContent.endsWith('\n') || envContent.endsWith('\r\n')
            ? ''
            : lineEnding;
    return `${envContent}${suffix}${replacement}${lineEnding}`;
};

const generateSecret = () => crypto.randomBytes(32).toString('hex');

const ensureGeneratedSecrets = () => {
    const source = readEnvFile();
    if (source === null) {
        throw new Error('Expected .env to exist before generating secrets.');
    }

    let updatedEnv = source;
    let generatedCount = 0;

    for (const key of requiredGeneratedSecrets) {
        const existing = readEnvValue(updatedEnv, key);
        if (existing) {
            continue;
        }

        const generated = generateSecret();
        updatedEnv = upsertEnvValue(updatedEnv, key, generated);
        process.env[key] = generated;
        generatedCount += 1;
        console.warn(`[setup] Generated ${key} in .env.`);
    }

    if (generatedCount > 0) {
        fs.writeFileSync(envPath, updatedEnv, 'utf8');
    }

    if (generatedCount === 0) {
        console.log('[setup] Local secrets already set.');
    }
};

const run = (command, args) => {
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
        stdio: 'inherit',
    });

    if (result.error) {
        throw result.error;
    }

    const exitCode = result.status ?? 1;
    if (exitCode !== 0) {
        process.exit(exitCode);
    }
};

const printChecklist = () => {
    const envContent = readEnvFile() ?? '';
    const hasOpenAiKey = Boolean(readEnvValue(envContent, 'OPENAI_API_KEY'));
    const hasOllamaApiKey = Boolean(readEnvValue(envContent, 'OLLAMA_API_KEY'));
    const hasProviderSecret = hasOpenAiKey || hasOllamaApiKey;

    if (!hasProviderSecret) {
        console.warn(
            '[setup] No provider secret configured yet. Startup is still allowed; model-dependent features will show setup-required responses until provider config is added.'
        );
    }

    console.log('[setup] Runtime settings live in footnote.yaml.');
    console.log('[setup] Complete. Start with: pnpm start');
};

const main = () => {
    ensureEnvFileExists();
    ensureGeneratedSecrets();
    ensureSettingsFileExists();
    run(pnpmBin, ['install']);
    printChecklist();
};

main();
