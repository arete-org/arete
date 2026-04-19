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
const pnpmBin = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
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
    const result = spawnSync(command, args, {
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
    const ollamaEnabled =
        readEnvValue(envContent, 'OLLAMA_LOCAL_INFERENCE_ENABLED') === 'true';
    const hasOllamaBaseUrl = Boolean(
        readEnvValue(envContent, 'OLLAMA_BASE_URL')
    );
    const hasProvider = hasOpenAiKey || hasOllamaBaseUrl;

    if (hasOllamaBaseUrl && !ollamaEnabled) {
        console.info(
            '[setup] OLLAMA_BASE_URL is set while OLLAMA_LOCAL_INFERENCE_ENABLED is not true. This is expected for remote Ollama endpoints.'
        );
    }

    if (!hasProvider) {
        console.warn(
            '[setup] No text provider configured yet. Set OPENAI_API_KEY or OLLAMA_LOCAL_INFERENCE_ENABLED=true with OLLAMA_BASE_URL.'
        );
    }

    console.log('[setup] Complete. Start with: pnpm dev');
};

const main = () => {
    ensureEnvFileExists();
    ensureGeneratedSecrets();
    run(pnpmBin, ['install']);
    printChecklist();
};

main();
