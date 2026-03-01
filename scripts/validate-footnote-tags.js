#!/usr/bin/env node

/**
 * Validates Footnote module annotations across the repository.
 * Checks for required tags and enforces canonical risk and ethics levels.
 */

const fs = require('fs');
const path = require('path');

const REQUIRED_TAGS = [
    '@description',
    '@footnote-module',
    '@footnote-risk',
    '@footnote-ethics',
    '@footnote-scope',
];
const ALLOWED_LEVELS = new Set(['high', 'moderate', 'low']);
const ALLOWED_SCOPES = new Set(['core', 'utility', 'interface', 'test']);
const IGNORED_DIRS = new Set([
    '.git',
    '.next',
    '.turbo',
    '.vercel',
    '.cache',
    'node_modules',
    'dist',
    'build',
    'coverage',
    'tmp',
    'temp',
]);

const repoRoot = path.resolve(__dirname, '..');
let hasErrors = false;
let filesValidated = 0;

function walk(dir, onFile) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            if (IGNORED_DIRS.has(entry.name)) {
                continue;
            }
            walk(path.join(dir, entry.name), onFile);
        } else if (entry.isFile()) {
            onFile(path.join(dir, entry.name));
        }
    }
}

function logError(filePath, message) {
    hasErrors = true;
    console.error(`Footnote tag error in ${filePath}: ${message}`);
}

function extractTagValue(block, tag) {
    const tagPattern = new RegExp(`${tag}:\\s*([^\\r\\n*]+)`);
    const match = block.match(tagPattern);
    return match ? match[1].trim() : null;
}

function normalizeLevel(value) {
    if (!value) {
        return null;
    }
    const levelToken = value.split('-')[0]?.trim().toLowerCase();
    return levelToken || null;
}

function validateFile(filePath) {
    if (!filePath.endsWith('.ts') || filePath.endsWith('.d.ts')) {
        return;
    }

    const content = fs.readFileSync(filePath, 'utf8');
    if (!content.includes('@footnote-module')) {
        return;
    }

    const relativePath = path.relative(repoRoot, filePath);
    const blocks = content.match(/\/\*\*[\s\S]*?\*\//g);
    const headerBlock = blocks
        ? blocks.find((block) => block.includes('@footnote-module'))
        : null;

    if (!headerBlock) {
        logError(
            relativePath,
            'Found @footnote-module reference but could not parse the JSDoc block.'
        );
        return;
    }

    filesValidated += 1;

    const values = {};
    for (const tag of REQUIRED_TAGS) {
        const value = extractTagValue(headerBlock, tag);
        if (!value) {
            logError(relativePath, `Missing required ${tag} tag or value.`);
            continue;
        }
        values[tag] = value;
    }

    const riskValue = values['@footnote-risk'];
    const riskLevel = normalizeLevel(riskValue);
    if (riskValue && !riskLevel) {
        logError(relativePath, 'Missing @footnote-risk level before description.');
    } else if (riskLevel && !ALLOWED_LEVELS.has(riskLevel)) {
        logError(
            relativePath,
            `Invalid @footnote-risk level "${riskLevel}" (from "${riskValue}"). Expected one of: ${Array.from(ALLOWED_LEVELS).join(', ')}.`
        );
    }

    const ethicsValue = values['@footnote-ethics'];
    const ethicsLevel = normalizeLevel(ethicsValue);
    if (ethicsValue && !ethicsLevel) {
        logError(
            relativePath,
            'Missing @footnote-ethics level before description.'
        );
    } else if (ethicsLevel && !ALLOWED_LEVELS.has(ethicsLevel)) {
        logError(
            relativePath,
            `Invalid @footnote-ethics level "${ethicsLevel}" (from "${ethicsValue}"). Expected one of: ${Array.from(ALLOWED_LEVELS).join(', ')}.`
        );
    }

    const scope = values['@footnote-scope'];
    if (scope && !ALLOWED_SCOPES.has(scope)) {
        logError(
            relativePath,
            `Invalid @footnote-scope value "${scope}". Expected one of: ${Array.from(ALLOWED_SCOPES).join(', ')}.`
        );
    }
}

walk(repoRoot, validateFile);

if (filesValidated > 0) {
    console.log(
        `Validated ${filesValidated} Footnote-tagged module${filesValidated === 1 ? '' : 's'}.`
    );
} else {
    console.log('No Footnote-tagged modules found to validate.');
}

if (hasErrors) {
    console.error('Footnote tag validation failed.');
    process.exit(1);
}

process.exit(0);

