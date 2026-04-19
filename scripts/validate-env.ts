/**
 * @description: Validates environment variables for local and deployment targets using shared env spec metadata.
 * @footnote-scope: utility
 * @footnote-module: ValidateEnvScript
 * @footnote-risk: medium - Incorrect validation rules can block deploys or miss critical config gaps.
 * @footnote-ethics: medium - Validation gates influence security-sensitive startup configuration.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { envSpecByKey } from '../packages/config-spec/src/env-spec';
import { logger } from '../packages/discord-bot/src/utils/logger';

type ValidationTarget = 'local-dev' | 'fly-backend' | 'fly-bot';

type ValidationProfile = {
    required: string[];
    warnings: string[];
};

const TARGETS = new Set<ValidationTarget>([
    'local-dev',
    'fly-backend',
    'fly-bot',
]);

const validationProfiles: Record<ValidationTarget, ValidationProfile> = {
    'local-dev': {
        required: [],
        warnings: ['INCIDENT_PSEUDONYMIZATION_SECRET'],
    },
    'fly-backend': {
        required: [
            'OPENAI_API_KEY',
            'TRACE_API_TOKEN',
            'INCIDENT_PSEUDONYMIZATION_SECRET',
        ],
        warnings: [],
    },
    'fly-bot': {
        required: [
            'DISCORD_TOKEN',
            'DISCORD_CLIENT_ID',
            'DISCORD_GUILD_ID',
            'OPENAI_API_KEY',
            'DISCORD_USER_ID',
            'INCIDENT_PSEUDONYMIZATION_SECRET',
            'TRACE_API_TOKEN',
        ],
        warnings: [],
    },
};

const parseArgs = (): {
    target: ValidationTarget;
    assumedPresent: Set<string>;
} => {
    const args = process.argv.slice(2);
    let target: ValidationTarget | null = null;
    const assumedPresent = new Set<string>();

    for (let index = 0; index < args.length; index += 1) {
        const current = args[index];
        const next = args[index + 1];

        if (current === '--target') {
            if (!next || next.startsWith('--')) {
                throw new Error('Missing value for --target');
            }
            if (!TARGETS.has(next as ValidationTarget)) {
                throw new Error(
                    `Unsupported target "${next}". Expected one of: ${[...TARGETS].join(', ')}`
                );
            }
            target = next as ValidationTarget;
            index += 1;
            continue;
        }

        if (current === '--assume-present') {
            if (!next || next.startsWith('--')) {
                throw new Error('Missing value for --assume-present');
            }
            for (const key of next.split(',')) {
                const normalized = key.trim();
                if (normalized.length > 0) {
                    assumedPresent.add(normalized);
                }
            }
            index += 1;
            continue;
        }
    }

    if (!target) {
        throw new Error(
            `Missing --target. Expected one of: ${[...TARGETS].join(', ')}`
        );
    }

    return { target, assumedPresent };
};

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDirectory, '..');
const envPath = path.join(repoRoot, '.env');

const normalizeEnvValue = (rawValue: string): string => {
    let isInSingleQuote = false;
    let isInDoubleQuote = false;
    let commentStartIndex = -1;

    for (let index = 0; index < rawValue.length; index += 1) {
        const character = rawValue[index];
        const previousCharacter = index > 0 ? rawValue[index - 1] : '';

        if (
            character === "'" &&
            !isInDoubleQuote &&
            previousCharacter !== '\\'
        ) {
            isInSingleQuote = !isInSingleQuote;
            continue;
        }

        if (
            character === '"' &&
            !isInSingleQuote &&
            previousCharacter !== '\\'
        ) {
            isInDoubleQuote = !isInDoubleQuote;
            continue;
        }

        if (
            character === '#' &&
            !isInSingleQuote &&
            !isInDoubleQuote &&
            (index === 0 || /\s/.test(previousCharacter))
        ) {
            commentStartIndex = index;
            break;
        }
    }

    const withoutComment =
        commentStartIndex >= 0
            ? rawValue.slice(0, commentStartIndex).trim()
            : rawValue.trim();

    if (
        withoutComment.length >= 2 &&
        ((withoutComment.startsWith('"') && withoutComment.endsWith('"')) ||
            (withoutComment.startsWith("'") && withoutComment.endsWith("'")))
    ) {
        return withoutComment.slice(1, -1).trim();
    }

    return withoutComment;
};

const parseDotEnv = (source: string): Map<string, string> => {
    const values = new Map<string, string>();
    for (const rawLine of source.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (line.length === 0 || line.startsWith('#')) {
            continue;
        }
        const equalsIndex = line.indexOf('=');
        if (equalsIndex <= 0) {
            continue;
        }
        const key = line.slice(0, equalsIndex).trim();
        let value = line.slice(equalsIndex + 1).trim();
        value = normalizeEnvValue(value);
        if (key.length > 0 && value.length > 0) {
            values.set(key, value);
        }
    }
    return values;
};

const loadEnvSnapshot = (): Map<string, string> => {
    const snapshot = new Map<string, string>();
    if (fs.existsSync(envPath)) {
        const parsed = parseDotEnv(fs.readFileSync(envPath, 'utf8'));
        for (const [key, value] of parsed.entries()) {
            snapshot.set(key, value);
        }
    }

    for (const [key, value] of Object.entries(process.env)) {
        if (typeof value === 'string') {
            snapshot.set(key, value.trim());
        }
    }

    return snapshot;
};

const assertKnownKeys = (keys: string[]): void => {
    for (const key of keys) {
        if (!(key in envSpecByKey)) {
            throw new Error(
                `Validation profile references unknown env key "${key}". Add it to env spec or update the profile.`
            );
        }
    }
};

const validate = (): void => {
    const { target, assumedPresent } = parseArgs();
    const profile = validationProfiles[target];
    assertKnownKeys([...profile.required, ...profile.warnings]);

    const envSnapshot = loadEnvSnapshot();
    const missingRequired: string[] = [];
    const missingWarnings: string[] = [];

    for (const key of profile.required) {
        const value = envSnapshot.get(key);
        const hasValue = typeof value === 'string' && value.trim().length > 0;
        if (!hasValue && !assumedPresent.has(key)) {
            missingRequired.push(key);
        }
    }

    for (const key of profile.warnings) {
        const value = envSnapshot.get(key);
        const hasValue = typeof value === 'string' && value.trim().length > 0;
        if (!hasValue && !assumedPresent.has(key)) {
            missingWarnings.push(key);
        }
    }

    if (missingRequired.length > 0) {
        logger.error(`[validate-env] ${target} missing required keys:`);
        for (const key of missingRequired) {
            logger.error(`- ${key}`);
        }
    }

    if (missingWarnings.length > 0) {
        logger.warn(
            `[validate-env] ${target} missing warning-only keys (feature degradation possible):`
        );
        for (const key of missingWarnings) {
            logger.warn(`- ${key}`);
        }
    }

    if (missingRequired.length > 0) {
        process.exit(1);
    }

    logger.info(`[validate-env] ${target} validation passed.`);
};

validate();
