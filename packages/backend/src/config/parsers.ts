/**
 * @description: Shared env parsing helpers for backend runtime config assembly.
 * @footnote-scope: utility
 * @footnote-module: BackendRuntimeConfigParsers
 * @footnote-risk: medium - Parser mistakes can silently change backend behavior across multiple config sections.
 * @footnote-ethics: medium - Parsing defaults and warnings affect abuse controls and operator understanding.
 */

import type { SupportedLogLevel } from '@footnote/contracts/providers';
import type { WarningSink } from './types.js';

const VALID_LOG_LEVELS = new Set([
    'error',
    'warn',
    'info',
    'http',
    'verbose',
    'debug',
    'silly',
]);

export const normalizeHostname = (value: string): string | null => {
    const trimmedValue = value.trim().toLowerCase();
    if (trimmedValue.length === 0) {
        return null;
    }

    const withoutProtocol = trimmedValue.replace(/^[a-z]+:\/\//, '');
    const hostname = withoutProtocol.split('/')[0]?.split(':')[0]?.trim();
    return hostname && hostname.length > 0 ? hostname : null;
};

export const parseOptionalTrimmedString = (
    value: string | undefined
): string | null => {
    const trimmedValue = value?.trim();
    return trimmedValue ? trimmedValue : null;
};

export const parseBooleanEnv = (
    value: string | undefined,
    fallback: boolean
): boolean => {
    if (value === undefined) {
        return fallback;
    }

    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') {
        return true;
    }

    if (normalized === 'false') {
        return false;
    }

    return fallback;
};

export const parseCsvEnv = (
    value: string | undefined,
    fallback: string[]
): string[] => {
    if (!value) {
        return [...fallback];
    }

    const entries = value
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);

    return entries.length > 0 ? entries : [...fallback];
};

export const parseHostnameListEnv = (
    value: string | undefined,
    fallback: string[]
): string[] => {
    if (!value) {
        return [...fallback];
    }

    const hostnames = value
        .split(',')
        .map((entry) => normalizeHostname(entry))
        .filter((entry): entry is string => Boolean(entry));

    return hostnames.length > 0 ? [...new Set(hostnames)] : [...fallback];
};

export const parsePositiveIntEnv = (
    value: string | undefined,
    fallback: number,
    key: string,
    warn: WarningSink
): number => {
    if (value === undefined) {
        return fallback;
    }

    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
    }

    warn(
        `Ignoring invalid positive integer for ${key}: "${value}". Using default (${fallback}).`
    );
    return fallback;
};

export const parseStringUnionEnv = <T extends string>(
    value: string | undefined,
    fallback: T,
    key: string,
    allowedValues: ReadonlySet<T>,
    warn: WarningSink
): T => {
    if (!value) {
        return fallback;
    }

    const normalized = value.trim().toLowerCase() as T;
    if (allowedValues.has(normalized)) {
        return normalized;
    }

    warn(`Ignoring invalid ${key} "${value}". Using default (${fallback}).`);
    return fallback;
};

export const parseLogLevelEnv = (
    value: string | undefined,
    fallback: SupportedLogLevel,
    warn: WarningSink
): SupportedLogLevel => {
    if (!value) {
        return fallback;
    }

    const normalized = value.trim().toLowerCase();
    if (VALID_LOG_LEVELS.has(normalized)) {
        return normalized as SupportedLogLevel;
    }

    warn(
        `Ignoring invalid LOG_LEVEL "${value}". Using default (${fallback}).`
    );
    return fallback;
};
