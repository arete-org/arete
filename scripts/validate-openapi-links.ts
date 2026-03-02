/**
 * @description: Validates bidirectional links between OpenAPI operations and code annotations to prevent spec/code drift.
 * @footnote-scope: utility
 * @footnote-module: OpenApiLinksValidator
 * @footnote-risk: medium - Broken link validation can allow stale API contracts to pass CI checks.
 * @footnote-ethics: medium - Accurate API traceability supports transparent and reliable system behavior.
 */
/**
 * Purpose:
 * - Validate that OpenAPI operationIds are linked to code references.
 * - Check both directions:
 *   1) spec -> code (declared refs point to real files)
 *   2) code -> spec (annotated operationIds exist in openapi.yaml)
 * - Fail fast in CI when links drift.
 */
import fs from 'node:fs';
import path from 'node:path';

type SpecOperation = {
    method: string;
    path: string;
    line: number;
    codeRefs: string[];
};

type AnnotationRef = {
    file: string;
    line: number;
};

const repoRoot = path.resolve(__dirname, '..');
const openApiPath = path.join(repoRoot, 'docs', 'api', 'openapi.yaml');
const packagesDir = path.join(repoRoot, 'packages');

const METHOD_PATTERN =
    /^\s{8}(get|post|put|patch|delete|options|head|trace):\s*$/i;
const PATH_PATTERN = /^\s{4}(\/[^:]+):\s*$/;
const OPERATION_ID_PATTERN = /^\s{12}operationId:\s*([A-Za-z0-9_]+)\s*$/;
const X_CODE_REFS_PATTERN = /^\s{12}x-codeRefs:\s*$/;
const CODE_REF_ITEM_PATTERN = /^\s{16}-\s+(.+?)\s*$/;
const API_OPERATION_TAG_PATTERN = /@api\.operationId:\s*([A-Za-z0-9_]+)/g;

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

const errorMessages: string[] = [];

const pushError = (message: string): void => {
    errorMessages.push(message);
};

const toRepoRelative = (absolutePath: string): string =>
    path.relative(repoRoot, absolutePath).split(path.sep).join('/');

const parseOpenApiOperations = (
    contents: string
): Map<string, SpecOperation> => {
    const operations = new Map<string, SpecOperation>();
    const lines = contents.split(/\r?\n/);

    let currentPath: string | null = null;
    let currentMethod: string | null = null;
    let currentOperationId: string | null = null;
    let collectingCodeRefsFor: string | null = null;

    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];

        const pathMatch = line.match(PATH_PATTERN);
        if (pathMatch) {
            currentPath = pathMatch[1];
            currentMethod = null;
            currentOperationId = null;
            collectingCodeRefsFor = null;
            continue;
        }

        const methodMatch = line.match(METHOD_PATTERN);
        if (methodMatch) {
            currentMethod = methodMatch[1].toUpperCase();
            currentOperationId = null;
            collectingCodeRefsFor = null;
            continue;
        }

        const operationIdMatch = line.match(OPERATION_ID_PATTERN);
        if (operationIdMatch) {
            const operationId = operationIdMatch[1];
            if (!currentPath || !currentMethod) {
                pushError(
                    `openapi.yaml:${index + 1} operationId "${operationId}" is not nested under a valid path+method block`
                );
                continue;
            }

            if (operations.has(operationId)) {
                pushError(
                    `openapi.yaml:${index + 1} duplicate operationId "${operationId}"`
                );
                continue;
            }

            operations.set(operationId, {
                method: currentMethod,
                path: currentPath,
                line: index + 1,
                codeRefs: [],
            });
            currentOperationId = operationId;
            collectingCodeRefsFor = null;
            continue;
        }

        if (line.match(X_CODE_REFS_PATTERN)) {
            collectingCodeRefsFor = currentOperationId;
            if (!collectingCodeRefsFor) {
                pushError(
                    `openapi.yaml:${index + 1} x-codeRefs found before operationId in current method block`
                );
            }
            continue;
        }

        if (collectingCodeRefsFor) {
            const codeRefItemMatch = line.match(CODE_REF_ITEM_PATTERN);
            if (codeRefItemMatch) {
                const operation = operations.get(collectingCodeRefsFor);
                if (operation) {
                    operation.codeRefs.push(codeRefItemMatch[1].trim());
                }
                continue;
            }

            // Stop collecting when list indentation ends.
            const startsWithRefIndent = line.startsWith('                ');
            if (!startsWithRefIndent || line.trim().length === 0) {
                collectingCodeRefsFor = null;
            }
        }
    }

    return operations;
};

const walk = (dir: string, onFile: (filePath: string) => void): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            if (IGNORED_DIRS.has(entry.name)) {
                continue;
            }
            walk(path.join(dir, entry.name), onFile);
            continue;
        }

        if (entry.isFile()) {
            onFile(path.join(dir, entry.name));
        }
    }
};

const findAnnotatedOperationIds = (): Map<string, AnnotationRef[]> => {
    const operationToRefs = new Map<string, AnnotationRef[]>();

    walk(packagesDir, (filePath) => {
        if (!filePath.endsWith('.ts') && !filePath.endsWith('.tsx')) {
            return;
        }
        if (filePath.endsWith('.d.ts')) {
            return;
        }

        const contents = fs.readFileSync(filePath, 'utf8');
        let match = API_OPERATION_TAG_PATTERN.exec(contents);
        while (match) {
            const operationId = match[1];
            const beforeMatch = contents.slice(0, match.index);
            const line = beforeMatch.split(/\r?\n/).length;
            const refs = operationToRefs.get(operationId) ?? [];
            refs.push({ file: toRepoRelative(filePath), line });
            operationToRefs.set(operationId, refs);
            match = API_OPERATION_TAG_PATTERN.exec(contents);
        }
        API_OPERATION_TAG_PATTERN.lastIndex = 0;
    });

    return operationToRefs;
};

const validateCodeRefs = (operations: Map<string, SpecOperation>): void => {
    const fileCache = new Map<string, string>();

    for (const [operationId, operation] of operations.entries()) {
        if (operation.codeRefs.length === 0) {
            pushError(
                `openapi.yaml:${operation.line} operationId "${operationId}" (${operation.method} ${operation.path}) is missing x-codeRefs entries`
            );
            continue;
        }

        for (const codeRef of operation.codeRefs) {
            const [refPath, symbol] = codeRef.split('#');
            if (!refPath) {
                pushError(
                    `openapi.yaml:${operation.line} operationId "${operationId}" contains invalid x-codeRef "${codeRef}"`
                );
                continue;
            }

            const absoluteRefPath = path.resolve(repoRoot, refPath);
            if (!absoluteRefPath.startsWith(repoRoot)) {
                pushError(
                    `openapi.yaml:${operation.line} operationId "${operationId}" contains out-of-repo x-codeRef "${codeRef}"`
                );
                continue;
            }

            if (!fs.existsSync(absoluteRefPath)) {
                pushError(
                    `openapi.yaml:${operation.line} operationId "${operationId}" references missing file "${refPath}"`
                );
                continue;
            }

            if (!symbol) {
                continue;
            }

            const fileContents =
                fileCache.get(absoluteRefPath) ??
                fs.readFileSync(absoluteRefPath, 'utf8');
            fileCache.set(absoluteRefPath, fileContents);

            if (!fileContents.includes(symbol)) {
                pushError(
                    `openapi.yaml:${operation.line} operationId "${operationId}" references symbol "${symbol}" not found in "${refPath}"`
                );
            }
        }
    }
};

const validateBidirectionalLinks = (
    operations: Map<string, SpecOperation>,
    annotations: Map<string, AnnotationRef[]>
): void => {
    for (const [annotatedOperationId, refs] of annotations.entries()) {
        if (operations.has(annotatedOperationId)) {
            continue;
        }

        const locations = refs.map((ref) => `${ref.file}:${ref.line}`).join(', ');
        pushError(
            `Code annotations reference unknown operationId "${annotatedOperationId}" at ${locations}`
        );
    }

    for (const operationId of operations.keys()) {
        if (annotations.has(operationId)) {
            continue;
        }

        const operation = operations.get(operationId);
        if (!operation) {
            continue;
        }
        pushError(
            `openapi.yaml:${operation.line} operationId "${operationId}" (${operation.method} ${operation.path}) has no @api.operationId code annotations`
        );
    }
};

const main = (): void => {
    if (!fs.existsSync(openApiPath)) {
        console.error(`OpenAPI spec not found at ${toRepoRelative(openApiPath)}`);
        process.exit(1);
    }

    const openApiContents = fs.readFileSync(openApiPath, 'utf8');
    const operations = parseOpenApiOperations(openApiContents);
    const annotations = findAnnotatedOperationIds();

    if (operations.size === 0) {
        console.error('No operationIds found in docs/api/openapi.yaml');
        process.exit(1);
    }

    validateCodeRefs(operations);
    validateBidirectionalLinks(operations, annotations);

    if (errorMessages.length > 0) {
        console.error('OpenAPI code-link validation failed:');
        for (const message of errorMessages) {
            console.error(`- ${message}`);
        }
        process.exit(1);
    }

    const totalCodeRefs = Array.from(operations.values()).reduce(
        (sum, operation) => sum + operation.codeRefs.length,
        0
    );
    const totalAnnotations = Array.from(annotations.values()).reduce(
        (sum, refs) => sum + refs.length,
        0
    );

    console.log(
        `Validated OpenAPI links: ${operations.size} operations, ${totalCodeRefs} x-codeRefs, ${totalAnnotations} @api.operationId annotations.`
    );
};

main();

