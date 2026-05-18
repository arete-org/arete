/**
 * @description: Enforces strict key parity between .env.example and shared env spec metadata.
 * @footnote-scope: utility
 * @footnote-module: ValidateEnvExampleParity
 * @footnote-risk: medium - Incorrect parity checks can block valid config changes or miss drift.
 * @footnote-ethics: low - Tooling-only validation with no direct user data impact.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { envEntries } from '../packages/config-spec/src/env-spec';
import { logger } from '../packages/discord-bot/src/utils/logger';

type PatternSpec = {
    key: string;
    regex: RegExp;
};

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDirectory, '..');
const envExamplePath = path.join(repoRoot, '.env.example');

const parseExampleKeys = (content: string): Set<string> => {
    const keys = new Set<string>();
    const keyPattern = /^\s*([A-Z][A-Z0-9_]+)\s*=/;

    for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (line.length === 0 || line.startsWith('#')) {
            continue;
        }

        const match = line.match(keyPattern);
        if (match) {
            keys.add(match[1]);
        }
    }

    return keys;
};

const buildPatternSpecs = (): PatternSpec[] => {
    const patternEntries = envEntries.filter(
        (entry) => 'isPattern' in entry && entry.isPattern === true
    );

    return patternEntries.map((entry) => {
        const expression = `^${entry.key.replace(/<[^>]+>/g, '[A-Z0-9_]+')}$`;
        return {
            key: entry.key,
            regex: new RegExp(expression),
        };
    });
};

const validate = (): void => {
    if (!fs.existsSync(envExamplePath)) {
        throw new Error(`Missing .env.example at ${envExamplePath}`);
    }

    const envExampleKeys = parseExampleKeys(
        fs.readFileSync(envExamplePath, 'utf8')
    );
    const patternSpecs = buildPatternSpecs();

    const specConcreteKeys = new Set<string>(
        envEntries
            .filter(
                (entry) => !('isPattern' in entry && entry.isPattern === true)
            )
            .map((entry) => String(entry.key))
    );

    const missingInExample: string[] = [];
    for (const key of specConcreteKeys) {
        if (!envExampleKeys.has(key)) {
            missingInExample.push(key);
        }
    }

    const unexpectedInExample: string[] = [];
    for (const key of envExampleKeys) {
        if (specConcreteKeys.has(key)) {
            continue;
        }

        const matchesPattern = patternSpecs.some((patternSpec) =>
            patternSpec.regex.test(key)
        );

        if (!matchesPattern) {
            unexpectedInExample.push(key);
        }
    }

    missingInExample.sort();
    unexpectedInExample.sort();

    if (missingInExample.length > 0) {
        for (const key of missingInExample) {
            logger.error(
                `Footnote tag error in .env.example: [validate-env-example-parity] missing key "${key}".`
            );
        }
    }

    if (unexpectedInExample.length > 0) {
        for (const key of unexpectedInExample) {
            logger.error(
                `Footnote tag error in .env.example: [validate-env-example-parity] unexpected key "${key}".`
            );
        }
    }

    if (missingInExample.length > 0 || unexpectedInExample.length > 0) {
        process.exit(1);
    }

    logger.info('[validate-env-example-parity] .env.example parity passed.');
};

validate();
