#!/usr/bin/env node
/* eslint-env node */
/* global __dirname, process, console */

/**
 * @description: Performs a lightweight validation check for canonical footnote.yaml presence and parseability.
 * @footnote-scope: utility
 * @footnote-module: CheckFootnoteSettings
 * @footnote-risk: low - Validation helper only; does not mutate runtime config.
 * @footnote-ethics: low - Developer tooling only.
 */

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const repoRoot = path.resolve(__dirname, '..');
const settingsPath =
    process.env.FOOTNOTE_SETTINGS_PATH?.trim() ||
    path.join(repoRoot, 'footnote.yaml');

if (!fs.existsSync(settingsPath)) {
    console.error(
        `[settings:check] Missing settings file at ${settingsPath}. Run: pnpm settings:init`
    );
    process.exit(1);
}

let parsed;
try {
    parsed = yaml.load(fs.readFileSync(settingsPath, 'utf8'));
} catch (error) {
    console.error(
        `[settings:check] Failed to parse YAML at ${settingsPath}: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
}

if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    console.error('[settings:check] Settings root must be a YAML object.');
    process.exit(1);
}

if (parsed.version !== 1) {
    console.error('[settings:check] version must be set to 1.');
    process.exit(1);
}

console.log(`[settings:check] OK (${settingsPath})`);
