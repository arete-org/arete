/**
 * @description: Canonical footnote.yaml settings spec derived from shared env metadata.
 * @footnote-scope: interface
 * @footnote-module: FootnoteSettingsSpec
 * @footnote-risk: medium - Incorrect spec mapping can route non-secret settings to wrong runtime targets.
 * @footnote-ethics: low - Spec-only module for operator-facing configuration ergonomics.
 */

import { envConfigSourceByKey, envEntries } from '@footnote/config-spec';

export type SettingsValueKind =
    | 'string'
    | 'boolean'
    | 'integer'
    | 'number'
    | 'csv'
    | 'enum'
    | 'json';

export type SettingsSpecEntry = {
    envKey: string;
    section: string;
    path: string[];
    kind: SettingsValueKind;
    description: string;
    defaultValue?: string | number | boolean | readonly string[];
    allowedValues?: readonly string[];
};

const toKebabCase = (value: string): string =>
    value.replace(/_/g, '-').replace(/\s+/g, '-').toLowerCase();

const ENV_PATH_OVERRIDES: Record<string, string[]> = {
    HOST: ['server', 'host'],
    PORT: ['server', 'port'],
    DATA_DIR: ['server', 'data-dir'],
    WEB_TRUST_PROXY: ['server', 'trust-proxy'],
    ALLOWED_ORIGINS: ['web', 'allowed-origins'],
    FRAME_ANCESTORS: ['web', 'frame-ancestors'],
};

const resolveEnvPath = (entry: { key: string; section: string }): string[] =>
    ENV_PATH_OVERRIDES[entry.key] ?? [
        toKebabCase(entry.section),
        toKebabCase(entry.key),
    ];

export const envPathSourceEntries = envEntries
    .filter((entry) => !('isPattern' in entry && entry.isPattern === true))
    .filter((entry) => entry.section !== 'discord-bot')
    .map((entry) => {
        const source =
            envConfigSourceByKey[
                entry.key as keyof typeof envConfigSourceByKey
            ] ?? 'settings_yaml';
        return {
            envKey: entry.key,
            path: resolveEnvPath(entry),
            source,
        };
    });

export const settingsSpecEntries: SettingsSpecEntry[] = envEntries
    .filter((entry) => !('isPattern' in entry && entry.isPattern === true))
    .filter((entry) => entry.section !== 'discord-bot')
    .filter(
        (entry) =>
            envConfigSourceByKey[
                entry.key as keyof typeof envConfigSourceByKey
            ] === 'settings_yaml'
    )
    .map((entry) => ({
        envKey: entry.key,
        section: toKebabCase(entry.section),
        path: resolveEnvPath(entry),
        kind: entry.kind as SettingsValueKind,
        description: entry.description,
        defaultValue:
            entry.defaultValue.kind === 'literal'
                ? (entry.defaultValue.value as
                      | string
                      | number
                      | boolean
                      | readonly string[])
                : undefined,
        allowedValues:
            'allowedValues' in entry ? entry.allowedValues : undefined,
    }))
    .sort((left, right) =>
        left.path.join('.').localeCompare(right.path.join('.'))
    );
