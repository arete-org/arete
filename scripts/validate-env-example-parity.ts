/**
 * @description: Enforces secrets-only policy for .env.example using shared env spec metadata.
 * @footnote-scope: utility
 * @footnote-module: ValidateEnvExampleParity
 * @footnote-risk: medium - Incorrect checks can allow confusing env-doc drift.
 * @footnote-ethics: low - Tooling-only validation with no direct user data impact.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { envSpecByKey } from '../packages/config-spec/src/env-spec';
import { logger } from '../packages/discord-bot/src/utils/logger';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDirectory, '..');
const envExamplePath = path.join(repoRoot, '.env.example');

const parseExampleKeys = (content: string): string[] => {
    const keys: string[] = [];
    const keyPattern = /^\s*([A-Z][A-Z0-9_]+)\s*=/;

    for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (line.length === 0 || line.startsWith('#')) {
            continue;
        }

        const match = line.match(keyPattern);
        if (match) {
            keys.push(match[1]);
        }
    }

    return keys;
};

const validate = (): void => {
    if (!fs.existsSync(envExamplePath)) {
        throw new Error(`Missing .env.example at ${envExamplePath}`);
    }

    const keys = parseExampleKeys(fs.readFileSync(envExamplePath, 'utf8'));
    const unknownKeys: string[] = [];
    const nonSecretKeys: string[] = [];

    for (const key of keys) {
        const entry = envSpecByKey[key as keyof typeof envSpecByKey];
        if (!entry) {
            unknownKeys.push(key);
            continue;
        }

        if (!entry.secret) {
            nonSecretKeys.push(key);
        }
    }

    unknownKeys.sort();
    nonSecretKeys.sort();

    for (const key of unknownKeys) {
        logger.error(
            `Footnote tag error in .env.example: [validate-env-example-parity] unknown key "${key}".`
        );
    }

    for (const key of nonSecretKeys) {
        logger.error(
            `Footnote tag error in .env.example: [validate-env-example-parity] "${key}" is non-secret and must move to footnote.yaml.`
        );
    }

    if (unknownKeys.length > 0 || nonSecretKeys.length > 0) {
        process.exit(1);
    }

    logger.info(
        '[validate-env-example-parity] .env.example secrets-only policy passed.'
    );
};

validate();
