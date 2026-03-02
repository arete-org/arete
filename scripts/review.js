#!/usr/bin/env node
// @ts-check

/**
 * @description: Runs the repository's review checks in one place and emits a single, predictable diagnostic format.
 * @footnote-scope: utility
 * @footnote-module: ReviewOrchestrator
 * @footnote-risk: moderate - Broken orchestration can hide validation failures or block contributor workflows.
 * @footnote-ethics: low - Validation output supports traceability, but it does not directly process user-facing data.
 */

/**
 * Why this file exists:
 * - Contributors should only need one command (`pnpm review`) before opening a PR.
 * - CI should use the exact same orchestration logic as local development.
 * - Each underlying tool reports problems differently, so we normalize everything into
 *   one small JSON shape that humans and machines can both consume reliably.
 *
 * High-level flow:
 * 1. Confirm the required local binaries exist before doing any real work.
 * 2. Optionally detect changed files when `--changed-only` is used.
 * 3. Run each validator as a subprocess.
 * 4. Parse each tool's output into `{ file, line, message, severity }`.
 * 5. Print one final pass/fail summary and exit non-zero when errors exist.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

/** @typedef {'error' | 'warning'} Severity */

/**
 * Stable diagnostic payload emitted by the orchestrator.
 *
 * We keep this intentionally small so the output is easy to read in a terminal and easy to
 * parse in CI logs. Some upstream validators do not report a precise line number, so `line`
 * falls back to `1` in those cases instead of inventing a fake location.
 * @typedef {{
 *   file: string;
 *   line: number;
 *   message: string;
 *   severity: Severity;
 * }} Diagnostic
 */

/**
 * Minimal wrapper around `spawnSync` output.
 *
 * Keeping only the fields we actually use makes the parser code easier to read than passing
 * the full Node child-process result object through the entire file.
 * @typedef {{
 *   status: number;
 *   stdout: string;
 *   stderr: string;
 *   error: Error | null;
 * }} CommandResult
 */

/**
 * Description of one validator step in the pipeline.
 *
 * `shouldRun` lets `--changed-only` skip work safely.
 * `run` owns the subprocess invocation.
 * `parse` converts tool-specific output into the shared diagnostic shape.
 * @typedef {{
 *   name: string;
 *   shouldRun: () => boolean;
 *   run: () => CommandResult;
 *   parse: (result: CommandResult) => Diagnostic[];
 * }} Validator
 */

const repoRoot = path.resolve(__dirname, '..');
const isWindows = process.platform === 'win32';
const pnpmBinary = isWindows ? 'pnpm.cmd' : 'pnpm';
const changedOnly = process.argv.includes('--changed-only');

/** @type {ReadonlySet<string>} */
const trackedTypeScriptRoots = new Set(['packages', 'mcp']);

/**
 * Convert paths into repository-relative POSIX-style strings.
 *
 * We do this for two reasons:
 * - CI and local machines should print the same file paths even when separators differ.
 * - Relative paths are easier to scan than long absolute paths in validation output.
 *
 * If a path cannot be made safely relative to the repo root, we leave it as-is and only
 * normalize the slashes.
 * @param {string} targetPath
 * @returns {string}
 */
function normalizePath(targetPath) {
    const absoluteTargetPath = path.isAbsolute(targetPath)
        ? targetPath
        : path.resolve(repoRoot, targetPath);
    const relativePath = path.relative(repoRoot, absoluteTargetPath);

    if (
        relativePath &&
        relativePath !== '.' &&
        !relativePath.startsWith('..') &&
        !path.isAbsolute(relativePath)
    ) {
        return relativePath.split(path.sep).join('/');
    }

    return targetPath.split(path.sep).join('/');
}

/**
 * Emit one diagnostic as a single JSON line.
 *
 * Newline-delimited JSON keeps the output stable for CI while still being readable enough
 * for a person who wants to eyeball the raw log.
 * @param {Diagnostic} diagnostic
 */
function printDiagnostic(diagnostic) {
    process.stdout.write(`${JSON.stringify(diagnostic)}\n`);
}

/**
 * Run a subprocess and capture UTF-8 output.
 *
 * We avoid a shell by default because it makes argument handling more predictable. The one
 * exception is Windows `.cmd` files such as `pnpm.cmd`; those need to be launched through
 * the standard `cmd.exe` executable to avoid `EINVAL` failures from `spawnSync`.
 * @param {string} command
 * @param {string[]} args
 * @returns {CommandResult}
 */
function runCommand(command, args) {
    // On Windows, calling `pnpm.cmd` directly via `spawnSync` can fail even though the same
    // command works fine in an interactive terminal. Routing through the standard `cmd.exe`
    // executable keeps the automation behavior aligned with how contributors actually run
    // pnpm locally, without depending on environment-provided shell paths.
    const executable =
        isWindows && command.toLowerCase().endsWith('.cmd')
            ? 'cmd.exe'
            : command;
    const executableArgs =
        isWindows && command.toLowerCase().endsWith('.cmd')
            ? ['/d', '/s', '/c', command, ...args]
            : args;

    const result = spawnSync(executable, executableArgs, {
        cwd: repoRoot,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
    });

    return {
        status: result.status ?? 1,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        error: result.error ?? null,
    };
}

/**
 * Run a git command and return the non-empty output lines.
 *
 * This helper keeps the changed-file logic below readable and treats git failures as
 * "no data available" rather than crashing the whole review command.
 * @param {string[]} args
 * @returns {string[]}
 */
function readGitLines(args) {
    const result = runCommand('git', args);
    if (result.status !== 0) {
        return [];
    }

    return result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
}

/**
 * Collect files changed since `HEAD`, plus any untracked files.
 *
 * Why this is slightly broader than a simple `git diff`:
 * - New files need to be linted and type-checked too.
 * - Deleted files still matter for cross-file validators, because removing a file can break
 *   an OpenAPI code reference or another repository-wide invariant.
 * - Repositories without a first commit yet do not have `HEAD`, so we fall back to git's
 *   tracked/untracked file listing in that case.
 * @returns {string[]}
 */
function getChangedFiles() {
    const hasHead = runCommand('git', ['rev-parse', '--verify', 'HEAD']).status === 0;
    const diffLines = hasHead
        ? readGitLines(['diff', '--name-only', '--relative', 'HEAD', '--'])
        : readGitLines(['ls-files', '--cached', '--modified', '--others', '--exclude-standard']);
    const untrackedLines = hasHead
        ? readGitLines(['ls-files', '--others', '--exclude-standard'])
        : [];

    return Array.from(new Set([...diffLines, ...untrackedLines])).map((filePath) =>
        filePath.split(path.sep).join('/')
    );
}

/**
 * Create a temporary `tsconfig` that only includes the changed TypeScript files.
 *
 * TypeScript does not offer a clean "type-check only these files but still use the repo
 * compiler options" CLI mode, so we generate a tiny throwaway config that extends the root
 * config and narrows the file list.
 * @param {string[]} files
 * @returns {{ cleanup: () => void; configPath: string }}
 */
function createChangedOnlyTsconfig(files) {
    const tempDirectory = fs.mkdtempSync(path.join(repoRoot, '.review-'));
    const configPath = path.join(tempDirectory, 'tsconfig.changed.json');
    const config = {
        extends: '../tsconfig.json',
        files: files.map((filePath) =>
            path.relative(tempDirectory, path.resolve(repoRoot, filePath)).split(path.sep).join('/')
        ),
    };

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    return {
        configPath,
        cleanup: () => {
            fs.rmSync(tempDirectory, { recursive: true, force: true });
        },
    };
}

/**
 * Parse a `file:line` location string from validator output.
 *
 * Some validators bundle several locations into one sentence. Breaking them back into a
 * structured shape lets us keep the final output consistent.
 * @param {string} location
 * @returns {{ file: string; line: number } | null}
 */
function parseFileLocation(location) {
    const match = location.match(/^(.*?):(\d+)$/);
    if (!match) {
        return null;
    }

    return {
        file: normalizePath(match[1]),
        line: Number(match[2]),
    };
}

/**
 * Parse output from the Footnote tag validator.
 *
 * That script currently emits plain English error lines instead of JSON, so we match the
 * known error sentence structure and convert it into the shared diagnostic payload.
 * @param {CommandResult} result
 * @returns {Diagnostic[]}
 */
function parseFootnoteTagDiagnostics(result) {
    const diagnostics = [];
    const combinedOutput = `${result.stdout}\n${result.stderr}`;

    for (const line of combinedOutput.split(/\r?\n/)) {
        const match = line.match(/^Footnote tag error in (.+?): (.+)$/);
        if (!match) {
            continue;
        }

        diagnostics.push({
            file: normalizePath(match[1]),
            line: 1,
            message: match[2],
            severity: 'error',
        });
    }

    // If the validator failed but did not print any recognizable error lines, surface a
    // fallback diagnostic so the failure is still visible in CI.
    if (diagnostics.length === 0 && result.status !== 0) {
        diagnostics.push({
            file: 'scripts/validate-footnote-tags.js',
            line: 1,
            message:
                result.stderr.trim() ||
                result.stdout.trim() ||
                'Footnote tag validation failed without a parseable diagnostic.',
            severity: 'error',
        });
    }

    return diagnostics;
}

/**
 * Parse output from the OpenAPI link validator.
 *
 * This validator mixes a few output styles:
 * - `openapi.yaml:<line> ...`
 * - summary text for missing code annotations
 * - a success summary when everything passes
 *
 * We ignore the success summary and only emit diagnostics for actual failures.
 * @param {CommandResult} result
 * @returns {Diagnostic[]}
 */
function parseOpenApiDiagnostics(result) {
    /** @type {Diagnostic[]} */
    const diagnostics = [];
    const combinedOutput = `${result.stdout}\n${result.stderr}`;

    for (const rawLine of combinedOutput.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (
            !line ||
            line === 'OpenAPI code-link validation failed:' ||
            line.startsWith('Validated OpenAPI links:')
        ) {
            continue;
        }

        const message = line.startsWith('- ') ? line.slice(2) : line;
        const openApiLineMatch = message.match(/^openapi\.yaml:(\d+)\s+(.+)$/);
        if (openApiLineMatch) {
            diagnostics.push({
                file: 'docs/api/openapi.yaml',
                line: Number(openApiLineMatch[1]),
                message: openApiLineMatch[2],
                severity: 'error',
            });
            continue;
        }

        const annotationMatch = message.match(
            /^Code annotations reference unknown operationId "(.+)" at (.+)$/
        );
        if (annotationMatch) {
            const [, operationId, locations] = annotationMatch;
            // One OpenAPI problem may point at several code annotations. We split them into
            // separate diagnostics so editors and CI can associate each location cleanly.
            for (const locationText of locations.split(', ')) {
                const location = parseFileLocation(locationText);
                if (!location) {
                    continue;
                }
                diagnostics.push({
                    file: location.file,
                    line: location.line,
                    message: `Unknown OpenAPI operationId "${operationId}".`,
                    severity: 'error',
                });
            }
            continue;
        }

        const missingSpecMatch = message.match(/^OpenAPI spec not found at (.+)$/);
        if (missingSpecMatch) {
            diagnostics.push({
                file: normalizePath(missingSpecMatch[1]),
                line: 1,
                message: 'OpenAPI spec file is missing.',
                severity: 'error',
            });
            continue;
        }

        const noOperationIdsMatch = message.match(/^No operationIds found in (.+)$/);
        if (noOperationIdsMatch) {
            diagnostics.push({
                file: normalizePath(noOperationIdsMatch[1]),
                line: 1,
                message: 'No operationIds found in the OpenAPI specification.',
                severity: 'error',
            });
            continue;
        }

        diagnostics.push({
            file: 'docs/api/openapi.yaml',
            line: 1,
            message,
            severity: 'error',
        });
    }

    if (diagnostics.length === 0 && result.status !== 0) {
        diagnostics.push({
            file: 'docs/api/openapi.yaml',
            line: 1,
            message:
                result.stderr.trim() ||
                result.stdout.trim() ||
                'OpenAPI validation failed without a parseable diagnostic.',
            severity: 'error',
        });
    }

    return diagnostics;
}

/**
 * Parse TypeScript compiler output emitted with `--pretty false`.
 *
 * We deliberately disable pretty formatting when invoking `tsc` so the output stays plain
 * text and stable across terminals, shells, and CI logs.
 * @param {CommandResult} result
 * @returns {Diagnostic[]}
 */
function parseTypeScriptDiagnostics(result) {
    /** @type {Diagnostic[]} */
    const diagnostics = [];
    const combinedOutput = `${result.stdout}\n${result.stderr}`;

    for (const rawLine of combinedOutput.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || /^Found \d+ error/.test(line)) {
            continue;
        }

        const match = line.match(/^(.*)\((\d+),(\d+)\): (error|warning) TS\d+: (.+)$/);
        if (!match) {
            continue;
        }

        diagnostics.push({
            file: normalizePath(match[1]),
            line: Number(match[2]),
            message: match[5],
            severity: match[4] === 'warning' ? 'warning' : 'error',
        });
    }

    if (diagnostics.length === 0 && result.status !== 0) {
        diagnostics.push({
            file: 'tsconfig.json',
            line: 1,
            message:
                result.stderr.trim() ||
                result.stdout.trim() ||
                'TypeScript validation failed without a parseable diagnostic.',
            severity: 'error',
        });
    }

    return diagnostics;
}

/**
 * Parse JSON output from ESLint.
 *
 * ESLint already supports structured output, so this is the simplest parser in the file:
 * decode the JSON, then map each ESLint message into the shared diagnostic shape.
 * @param {CommandResult} result
 * @returns {Diagnostic[]}
 */
function parseEslintDiagnostics(result) {
    /** @type {Diagnostic[]} */
    const diagnostics = [];
    const stdout = result.stdout.trim();

    if (stdout.length > 0) {
        try {
            /** @type {Array<{ filePath: string; messages: Array<{ line?: number; severity: number; message: string }> }>} */
            const entries = JSON.parse(stdout);
            for (const entry of entries) {
                const file = normalizePath(entry.filePath);
                for (const message of entry.messages) {
                    diagnostics.push({
                        file,
                        line: message.line && message.line > 0 ? message.line : 1,
                        message: message.message,
                        severity: message.severity === 1 ? 'warning' : 'error',
                    });
                }
            }
        } catch (_error) {
            // Fall through to a generic failure diagnostic below.
        }
    }

    if (diagnostics.length === 0 && result.status !== 0) {
        diagnostics.push({
            file: 'eslint.config.mjs',
            line: 1,
            message:
                result.stderr.trim() ||
                result.stdout.trim() ||
                'ESLint failed without a parseable diagnostic.',
            severity: 'error',
        });
    }

    return diagnostics;
}

/**
 * Check that the required locally-installed binaries are available before any validator runs.
 *
 * This makes failures much friendlier for contributors. A missing `tsx` binary should produce
 * a direct "install dependencies first" message instead of a long subprocess stack trace.
 * @returns {Diagnostic[]}
 */
function preflightBinaries() {
    /** @type {Diagnostic[]} */
    const diagnostics = [];
    const checks = [
        { name: 'tsx', args: ['exec', 'tsx', '--version'] },
        { name: 'typescript', args: ['exec', 'tsc', '--version'] },
        { name: 'eslint', args: ['exec', 'eslint', '--version'] },
    ];

    for (const check of checks) {
        const result = runCommand(pnpmBinary, check.args);
        if (result.status === 0) {
            continue;
        }

        diagnostics.push({
            file: 'review',
            line: 1,
            message: `Missing required local binary "${check.name}". Run "pnpm install" before "pnpm review".`,
            severity: 'error',
        });
    }

    return diagnostics;
}

/**
 * Count errors and warnings for the final summary line.
 * @param {Diagnostic[]} diagnostics
 * @returns {{ errors: number; warnings: number }}
 */
function countDiagnostics(diagnostics) {
    return diagnostics.reduce(
        (counts, diagnostic) => {
            if (diagnostic.severity === 'error') {
                counts.errors += 1;
            } else {
                counts.warnings += 1;
            }
            return counts;
        },
        { errors: 0, warnings: 0 }
    );
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function isTypeScriptSource(value) {
    return /\.(ts|tsx)$/.test(value) && !value.endsWith('.d.ts');
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function isLintablePackageSource(value) {
    return /^packages\/.+\.(ts|tsx|js|jsx)$/.test(value);
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function isTrackedTypeScriptSource(value) {
    if (!isTypeScriptSource(value)) {
        return false;
    }

    const rootSegment = value.split('/')[0];
    return trackedTypeScriptRoots.has(rootSegment);
}

/**
 * @param {Diagnostic[]} diagnostics
 * @param {Set<string>} changedFiles
 * @returns {Diagnostic[]}
 */
function filterDiagnosticsToChangedFiles(diagnostics, changedFiles) {
    return diagnostics.filter((diagnostic) => changedFiles.has(diagnostic.file));
}

function main() {
    const preflightDiagnostics = preflightBinaries();
    if (preflightDiagnostics.length > 0) {
        for (const diagnostic of preflightDiagnostics) {
            process.stderr.write(`${diagnostic.message}\n`);
            printDiagnostic(diagnostic);
        }

        const counts = countDiagnostics(preflightDiagnostics);
        process.stdout.write(
            `${counts.errors} error${counts.errors === 1 ? '' : 's'}, ${counts.warnings} warning${counts.warnings === 1 ? '' : 's'} - FAIL\n`
        );
        process.exit(1);
    }

    const changedFiles = changedOnly ? getChangedFiles() : [];
    const changedFileSet = new Set(changedFiles);
    // Deleted files are useful for deciding whether repo-wide validators should run, but we
    // cannot pass deleted paths to tools like ESLint or TypeScript.
    const existingChangedFiles = changedFiles.filter((filePath) =>
        fs.existsSync(path.resolve(repoRoot, filePath))
    );
    const changedTypeScriptFiles = existingChangedFiles.filter(isTypeScriptSource);
    const changedTrackedTypeScriptFiles =
        existingChangedFiles.filter(isTrackedTypeScriptSource);
    const changedLintableFiles = existingChangedFiles.filter(isLintablePackageSource);
    // OpenAPI link validation is cross-file by nature. We still limit when it runs, but once
    // it does run, it needs the full repo/spec view to catch broken references correctly.
    const shouldRunOpenApiInChangedMode = changedFiles.some(
        (filePath) =>
            filePath === 'docs/api/openapi.yaml' ||
            /^packages\/.+\.(ts|tsx)$/.test(filePath)
    );

    /** @type {Array<() => void>} */
    const cleanupTasks = [];

    /** @type {Validator[]} */
    const validators = [
        {
            name: 'validate-footnote-tags',
            shouldRun: () => !changedOnly || changedTypeScriptFiles.length > 0,
            run: () => runCommand(process.execPath, ['scripts/validate-footnote-tags.js']),
            parse: (result) => {
                const diagnostics = parseFootnoteTagDiagnostics(result);
                // The validator itself is repo-wide. In changed-only mode we filter the emitted
                // diagnostics afterward so contributors only see problems tied to touched files.
                return changedOnly
                    ? filterDiagnosticsToChangedFiles(diagnostics, changedFileSet)
                    : diagnostics;
            },
        },
        {
            name: 'validate-openapi-links',
            shouldRun: () => !changedOnly || shouldRunOpenApiInChangedMode,
            run: () =>
                runCommand(pnpmBinary, [
                    'exec',
                    'tsx',
                    'scripts/validate-openapi-links.ts',
                ]),
            parse: (result) => parseOpenApiDiagnostics(result),
        },
        {
            name: 'tsc --noEmit',
            shouldRun: () => !changedOnly || changedTrackedTypeScriptFiles.length > 0,
            run: () => {
                if (!changedOnly) {
                    return runCommand(pnpmBinary, [
                        'exec',
                        'tsc',
                        '--noEmit',
                        '--pretty',
                        'false',
                    ]);
                }

                const tempConfig = createChangedOnlyTsconfig(changedTrackedTypeScriptFiles);
                cleanupTasks.push(tempConfig.cleanup);
                return runCommand(pnpmBinary, [
                    'exec',
                    'tsc',
                    '--noEmit',
                    '--pretty',
                    'false',
                    '--project',
                    tempConfig.configPath,
                ]);
            },
            parse: (result) => parseTypeScriptDiagnostics(result),
        },
        {
            name: 'eslint',
            shouldRun: () => !changedOnly || changedLintableFiles.length > 0,
            run: () =>
                runCommand(pnpmBinary, [
                    'exec',
                    'eslint',
                    '--format',
                    'json',
                    '--no-warn-ignored',
                    ...(changedOnly ? changedLintableFiles : ['packages/']),
                ]),
            parse: (result) => parseEslintDiagnostics(result),
        },
    ];

    /** @type {Diagnostic[]} */
    const diagnostics = [];

    try {
        for (const validator of validators) {
            if (!validator.shouldRun()) {
                // Skipping is expected in changed-only mode; it is not a warning.
                continue;
            }

            const result = validator.run();
            if (result.error) {
                diagnostics.push({
                    file: 'review',
                    line: 1,
                    message: `${validator.name} failed to start: ${result.error.message}`,
                    severity: 'error',
                });
                continue;
            }

            diagnostics.push(...validator.parse(result));
        }
    } finally {
        while (cleanupTasks.length > 0) {
            const cleanup = cleanupTasks.pop();
            cleanup?.();
        }
    }

    for (const diagnostic of diagnostics) {
        printDiagnostic(diagnostic);
    }

    const counts = countDiagnostics(diagnostics);
    const failed = counts.errors > 0;
    process.stdout.write(
        `${counts.errors} error${counts.errors === 1 ? '' : 's'}, ${counts.warnings} warning${counts.warnings === 1 ? '' : 's'} - ${failed ? 'FAIL' : 'PASS'}\n`
    );
    process.exit(failed ? 1 : 0);
}

main();
