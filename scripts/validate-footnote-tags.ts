/**
 * @description: Validates Footnote module annotations across authoring TypeScript and TSX files using the canonical runtime schema.
 * @footnote-scope: utility
 * @footnote-module: FootnoteTagValidator
 * @footnote-risk: high - Broken validation can let governance drift pass CI or block compliant files with misleading diagnostics.
 * @footnote-ethics: medium - Annotation accuracy supports traceability and auditability for contributors and downstream tooling.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

import runtimeSchema from './annotation-schema.runtime.json';
import type {
    AnnotationRuntimeSchema,
    AnnotationTag,
} from './annotation-schema.source';

export interface ValidationDiagnostic {
    filePath: string;
    line: number;
    message: string;
}

interface ParsedTag {
    line: number;
    rawValue: string;
    tagName: string;
    value: string;
}

interface ParsedHeader {
    line: number;
    tags: ParsedTag[];
}

interface ValidateAnnotationOptions {
    filePaths?: string[];
    repoRoot?: string;
    scanRoots?: string[];
}

const schema = runtimeSchema as AnnotationRuntimeSchema;
const requiredTags = schema.requiredTags as readonly AnnotationTag[];
const ignoredDirectories = new Set([
    '.cache',
    '.git',
    '.next',
    '.turbo',
    '.vercel',
    'build',
    'coverage',
    'dist',
    'node_modules',
    'temp',
    'tmp',
]);
const allowedTagSet = new Set<string>(schema.requiredTags);
const allowedScopeSet = new Set<string>(schema.allowedScopes);
const allowedLevelSet = new Set<string>(schema.allowedLevels);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(scriptDirectory, '..');

function isWhitespace(character: string): boolean {
    return character === ' ' || character === '\t';
}

function isInScopeFile(filePath: string): boolean {
    if (filePath.endsWith('.d.ts')) {
        return false;
    }

    return filePath.endsWith('.ts') || filePath.endsWith('.tsx');
}

function walkDirectory(directoryPath: string, filePaths: string[]): void {
    if (!fs.existsSync(directoryPath)) {
        return;
    }

    for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            if (ignoredDirectories.has(entry.name)) {
                continue;
            }

            walkDirectory(path.join(directoryPath, entry.name), filePaths);
            continue;
        }

        if (!entry.isFile()) {
            continue;
        }

        const filePath = path.join(directoryPath, entry.name);
        if (isInScopeFile(filePath)) {
            filePaths.push(filePath);
        }
    }
}

export function collectAnnotationFilePaths(
    repoRoot: string = defaultRepoRoot,
    scanRoots: string[] = ['packages', 'scripts']
): string[] {
    const filePaths: string[] = [];

    for (const scanRoot of scanRoots) {
        walkDirectory(path.join(repoRoot, scanRoot), filePaths);
    }

    return filePaths.sort((left, right) => left.localeCompare(right));
}

function getRelativePath(repoRoot: string, filePath: string): string {
    return path.relative(repoRoot, filePath).split(path.sep).join('/');
}

function getTagToken(lineText: string): { tagName: string; value: string } {
    let cursor = 1;
    while (
        cursor < lineText.length &&
        !isWhitespace(lineText[cursor]) &&
        lineText[cursor] !== ':'
    ) {
        cursor += 1;
    }

    const tagName = lineText.slice(0, cursor);
    let remainder = lineText.slice(cursor).trimStart();
    if (remainder.startsWith(':')) {
        remainder = remainder.slice(1).trim();
    }

    return {
        tagName,
        value: remainder,
    };
}

function parseModuleHeader(sourceFile: ts.SourceFile): ParsedHeader | null {
    const boundaryPosition =
        sourceFile.statements.length > 0
            ? sourceFile.statements[0].getFullStart()
            : 0;
    const commentRanges =
        ts.getLeadingCommentRanges(sourceFile.text, boundaryPosition) ?? [];
    const headerBlocks: ParsedHeader[] = [];

    for (const range of commentRanges) {
        const blockText = sourceFile.text.slice(range.pos, range.end);
        if (range.kind !== ts.SyntaxKind.MultiLineCommentTrivia) {
            continue;
        }

        if (!blockText.startsWith('/**')) {
            continue;
        }

        const rawLines = blockText.split(/\r?\n/);
        const startLine =
            sourceFile.getLineAndCharacterOfPosition(range.pos).line + 1;
        const tags: ParsedTag[] = [];
        let currentTag: ParsedTag | null = null;

        for (let index = 0; index < rawLines.length; index += 1) {
            let lineText = rawLines[index].trim();
            const lineNumber = startLine + index;

            if (index === 0 && lineText.startsWith('/**')) {
                lineText = lineText.slice(3).trim();
            }

            if (index === rawLines.length - 1 && lineText.endsWith('*/')) {
                lineText = lineText.slice(0, -2).trim();
            }

            if (lineText.startsWith('*')) {
                lineText = lineText.slice(1).trim();
            }

            if (lineText.length === 0) {
                currentTag = null;
                continue;
            }

            if (lineText.startsWith('@')) {
                const parsedTag = getTagToken(lineText);
                currentTag = {
                    line: lineNumber,
                    rawValue: parsedTag.value,
                    tagName: parsedTag.tagName,
                    value: parsedTag.value,
                };
                tags.push(currentTag);
                continue;
            }

            if (currentTag) {
                currentTag.value = `${currentTag.value} ${lineText}`.trim();
            }
        }

        if (
            tags.some(
                (tag) =>
                    tag.tagName === '@description' ||
                    tag.tagName.startsWith('@footnote') ||
                    tag.tagName === '@impact'
            )
        ) {
            headerBlocks.push({
                line: startLine,
                tags,
            });
        }
    }

    return headerBlocks.at(-1) ?? null;
}

function validateRationaleTag(
    diagnostics: ValidationDiagnostic[],
    filePath: string,
    tag: ParsedTag,
    tagName: '@footnote-risk' | '@footnote-ethics'
): void {
    const separatorIndex = tag.rawValue.indexOf(' - ');
    if (separatorIndex === -1) {
        diagnostics.push({
            filePath,
            line: tag.line,
            message: `Line ${tag.line}: ${tagName} must use "${schema.rationalePattern}".`,
        });
        return;
    }

    const level = tag.rawValue.slice(0, separatorIndex).trim();
    const rationale = tag.rawValue.slice(separatorIndex + 3).trim();

    if (!allowedLevelSet.has(level)) {
        diagnostics.push({
            filePath,
            line: tag.line,
            message: `Line ${tag.line}: Invalid ${tagName} level "${level}". Expected one of: ${schema.allowedLevels.join(', ')}.`,
        });
    }

    if (rationale.length === 0) {
        diagnostics.push({
            filePath,
            line: tag.line,
            message: `Line ${tag.line}: ${tagName} must include rationale text after the level.`,
        });
    }
}

function validateFile(
    absoluteFilePath: string,
    repoRoot: string
): ValidationDiagnostic[] {
    const relativeFilePath = getRelativePath(repoRoot, absoluteFilePath);
    const content = fs.readFileSync(absoluteFilePath, 'utf8');
    const sourceFile = ts.createSourceFile(
        absoluteFilePath,
        content,
        ts.ScriptTarget.Latest,
        true,
        absoluteFilePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    );
    const diagnostics: ValidationDiagnostic[] = [];
    const header = parseModuleHeader(sourceFile);

    if (!header) {
        diagnostics.push({
            filePath: relativeFilePath,
            line: 1,
            message:
                'Line 1: Missing Footnote module header with the required annotation tags.',
        });
        return diagnostics;
    }

    const requiredTagEntries = new Map<AnnotationTag, ParsedTag>();
    const orderedRequiredTags: ParsedTag[] = [];
    const seenTags = new Set<string>();

    for (const tag of header.tags) {
        if (!allowedTagSet.has(tag.tagName)) {
            diagnostics.push({
                filePath: relativeFilePath,
                line: tag.line,
                message: `Line ${tag.line}: Unknown module header tag "${tag.tagName}". The module header only allows: ${schema.requiredTags.join(', ')}.`,
            });
            continue;
        }

        const annotationTag = tag.tagName as AnnotationTag;
        orderedRequiredTags.push(tag);

        if (seenTags.has(annotationTag)) {
            diagnostics.push({
                filePath: relativeFilePath,
                line: tag.line,
                message: `Line ${tag.line}: Duplicate ${annotationTag} tag.`,
            });
            continue;
        }

        seenTags.add(annotationTag);
        requiredTagEntries.set(annotationTag, tag);
    }

    for (
        let index = 0;
        index < Math.min(orderedRequiredTags.length, schema.requiredTags.length);
        index += 1
    ) {
        const expectedTag = requiredTags[index];
        const actualTag = orderedRequiredTags[index];
        if (actualTag.tagName !== expectedTag) {
            diagnostics.push({
                filePath: relativeFilePath,
                line: actualTag.line,
                message: `Line ${actualTag.line}: Expected ${expectedTag} at position ${index + 1}, found ${actualTag.tagName}.`,
            });
            break;
        }
    }

    for (const requiredTag of requiredTags) {
        if (!requiredTagEntries.has(requiredTag)) {
            diagnostics.push({
                filePath: relativeFilePath,
                line: header.line,
                message: `Line ${header.line}: Missing required ${requiredTag} tag.`,
            });
        }
    }

    const descriptionTag = requiredTagEntries.get('@description');
    if (descriptionTag && descriptionTag.value.length === 0) {
        diagnostics.push({
            filePath: relativeFilePath,
            line: descriptionTag.line,
            message: `Line ${descriptionTag.line}: @description must include descriptive text.`,
        });
    }

    const moduleTag = requiredTagEntries.get('@footnote-module');
    if (moduleTag && moduleTag.value.length === 0) {
        diagnostics.push({
            filePath: relativeFilePath,
            line: moduleTag.line,
            message: `Line ${moduleTag.line}: @footnote-module must include a module name.`,
        });
    }

    const scopeTag = requiredTagEntries.get('@footnote-scope');
    if (scopeTag && !allowedScopeSet.has(scopeTag.value)) {
        diagnostics.push({
            filePath: relativeFilePath,
            line: scopeTag.line,
            message: `Line ${scopeTag.line}: Invalid @footnote-scope value "${scopeTag.value}". Expected one of: ${schema.allowedScopes.join(', ')}.`,
        });
    }

    const riskTag = requiredTagEntries.get('@footnote-risk');
    if (riskTag) {
        validateRationaleTag(
            diagnostics,
            relativeFilePath,
            riskTag,
            '@footnote-risk'
        );
    }

    const ethicsTag = requiredTagEntries.get('@footnote-ethics');
    if (ethicsTag) {
        validateRationaleTag(
            diagnostics,
            relativeFilePath,
            ethicsTag,
            '@footnote-ethics'
        );
    }

    return diagnostics;
}

export function validateFootnoteAnnotations(
    options: ValidateAnnotationOptions = {}
): { diagnostics: ValidationDiagnostic[]; filesValidated: number } {
    const repoRoot = options.repoRoot ?? defaultRepoRoot;
    const filePaths =
        options.filePaths ??
        collectAnnotationFilePaths(repoRoot, options.scanRoots ?? ['packages', 'scripts']);
    const diagnostics = filePaths.flatMap((filePath) =>
        validateFile(filePath, repoRoot)
    );

    return {
        diagnostics,
        filesValidated: filePaths.length,
    };
}

function formatDiagnostic(diagnostic: ValidationDiagnostic): string {
    return `Footnote tag error in ${diagnostic.filePath}: ${diagnostic.message}`;
}

function parseCliArguments(argv: string[]): ValidateAnnotationOptions {
    const options: ValidateAnnotationOptions = {};

    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];

        if (argument === '--root') {
            options.repoRoot = path.resolve(argv[index + 1]);
            index += 1;
            continue;
        }

        if (argument === '--scan-root') {
            const nextValue = argv[index + 1];
            options.scanRoots = options.scanRoots ?? [];
            options.scanRoots.push(nextValue);
            index += 1;
        }
    }

    return options;
}

function runCli(): void {
    const { diagnostics, filesValidated } = validateFootnoteAnnotations(
        parseCliArguments(process.argv.slice(2))
    );

    if (diagnostics.length > 0) {
        for (const diagnostic of diagnostics) {
            console.error(formatDiagnostic(diagnostic));
        }
        console.error('Footnote tag validation failed.');
        process.exit(1);
    }

    console.log(
        `Validated ${filesValidated} authoring TypeScript file${filesValidated === 1 ? '' : 's'} for Footnote annotations.`
    );
}

if (
    process.argv[1] &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
    runCli();
}

export { formatDiagnostic, runCli };
