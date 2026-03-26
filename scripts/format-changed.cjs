#!/usr/bin/env node
/* eslint-env node */
/* global process, console */
/**
 * @description: Runs Prettier on changed files only, with optional base-ref support for CI.
 * @footnote-scope: utility
 * @footnote-module: FormatChangedScript
 * @footnote-risk: low - Formatting scope mistakes may skip style checks but do not alter runtime behavior.
 * @footnote-ethics: low - Developer tooling has minimal direct user-facing ethical impact.
 */

const { spawnSync } = require('node:child_process');

const SUPPORTED_EXTENSIONS = new Set([
    '.ts',
    '.tsx',
    '.js',
    '.jsx',
    '.cjs',
    '.mjs',
    '.json',
    '.md',
    '.yaml',
    '.yml',
]);

const mode = process.argv.includes('--write') ? 'write' : 'check';
const baseRef = process.env.FORMAT_BASE_REF?.trim();

const runGit = (args) => {
    const result = spawnSync('git', args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.status !== 0) {
        const message = result.stderr?.trim() || `git ${args.join(' ')}`;
        throw new Error(message);
    }
    return result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
};

const isSupportedFile = (path) => {
    const lower = path.toLowerCase();
    for (const extension of SUPPORTED_EXTENSIONS) {
        if (lower.endsWith(extension)) {
            return true;
        }
    }
    return false;
};

const listChangedFiles = () => {
    if (baseRef) {
        return runGit([
            'diff',
            '--name-only',
            '--diff-filter=ACMR',
            `${baseRef}...HEAD`,
        ]);
    }

    const unstaged = runGit(['diff', '--name-only', '--diff-filter=ACMR']);
    const staged = runGit([
        'diff',
        '--cached',
        '--name-only',
        '--diff-filter=ACMR',
    ]);
    const untracked = runGit(['ls-files', '--others', '--exclude-standard']);
    return [...unstaged, ...staged, ...untracked];
};

const uniqueSorted = (values) => [...new Set(values)].sort();

const runPrettier = (modeArg, files) => {
    const pnpmBinary = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
    let prettierResult = spawnSync(
        pnpmBinary,
        ['exec', 'prettier', `--${modeArg}`, ...files],
        { stdio: 'inherit' }
    );

    // On Windows, direct `pnpm.cmd` spawn can fail in some environments.
    // Fall back to invoking the active pnpm CLI entrypoint through Node.
    if (prettierResult.error && process.env.npm_execpath) {
        prettierResult = spawnSync(
            process.execPath,
            [
                process.env.npm_execpath,
                'exec',
                'prettier',
                `--${modeArg}`,
                ...files,
            ],
            { stdio: 'inherit' }
        );
    }

    return prettierResult;
};

try {
    const changedFiles =
        uniqueSorted(listChangedFiles()).filter(isSupportedFile);
    if (changedFiles.length === 0) {
        console.log('No changed files matched Prettier-supported extensions.');
        process.exit(0);
    }

    console.log(
        `Running Prettier (${mode}) on ${changedFiles.length} changed file(s).`
    );
    const prettierResult = runPrettier(mode, changedFiles);
    if (prettierResult.error) {
        console.error(
            `format-changed failed to start prettier: ${prettierResult.error.message}`
        );
        process.exit(1);
    }
    process.exit(prettierResult.status ?? 1);
} catch (error) {
    console.error(
        `format-changed failed: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
}
