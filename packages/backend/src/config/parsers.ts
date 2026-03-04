/**
 * @description: Shared env parsing helpers for backend runtime config assembly.
 * @footnote-scope: utility
 * @footnote-module: BackendRuntimeConfigParsers
 * @footnote-risk: medium - Parser mistakes can silently change backend behavior across multiple config sections.
 * @footnote-ethics: medium - Parsing defaults and warnings affect abuse controls and operator understanding.
 */

import {
    supportedLogLevels,
    type SupportedLogLevel,
} from '@footnote/contracts/providers';
import type { WarningSink } from './types.js';

const VALID_LOG_LEVELS = new Set(supportedLogLevels);

/**
 * Strips protocol, port, and path details so hostname comparisons stay
 * consistent across request headers and env config.
 */
export const normalizeHostname = (value: string): string | null => {
    const trimmedValue = value.trim().toLowerCase();
    if (trimmedValue.length === 0) {
        return null;
    }

    const withoutProtocol = trimmedValue.replace(/^[a-z]+:\/\//, '');
    const hostname = withoutProtocol.split('/')[0]?.split(':')[0]?.trim();
    return hostname && hostname.length > 0 ? hostname : null;
};

/**
 * Treats empty strings as missing values so blank env overrides do not win over
 * real defaults.
 */
export const parseOptionalTrimmedString = (
    value: string | undefined
): string | null => {
    const trimmedValue = value?.trim();
    return trimmedValue ? trimmedValue : null;
};

/**
 * Parses a boolean env override and warns when the value is not clearly
 * `true` or `false`.
 */
export const parseBooleanEnv = (
    value: string | undefined,
    fallback: boolean,
    key?: string,
    warn?: WarningSink
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

    if (key && warn) {
        warn(
            `Ignoring invalid boolean for ${key}: "${value}". Using default (${fallback}).`
        );
    }

    return fallback;
};

/**
 * Splits comma-separated env values into a clean list while preserving the
 * fallback when the override is empty.
 */
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

/**
 * Parses a comma-separated hostname allowlist and normalizes each entry before
 * de-duplicating it.
 */
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

/**
 * Parses positive integer env values used for limits, ports, and timeouts.
 */
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

/**
 * Validates string env values against an allowed set and falls back safely when
 * operators provide an unsupported option.
 */
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

    const normalized = value.trim().toLowerCase();
    if (allowedValues.has(normalized as T)) {
        return normalized as T;
    }

    warn(`Ignoring invalid ${key} "${value}". Using default (${fallback}).`);
    return fallback;
};

/**
 * Special-case parser for Winston log levels so logging config stays aligned
 * with the shared provider vocabulary.
 */
export const parseLogLevelEnv = (
    value: string | undefined,
    fallback: SupportedLogLevel,
    warn: WarningSink
): SupportedLogLevel => {
    if (!value) {
        return fallback;
    }

    const normalized = value.trim().toLowerCase();
    if (VALID_LOG_LEVELS.has(normalized as SupportedLogLevel)) {
        return normalized as SupportedLogLevel;
    }

    warn(
        `Ignoring invalid LOG_LEVEL "${value}". Using default (${fallback}).`
    );
    return fallback;
};
