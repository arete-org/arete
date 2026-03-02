/**
 * @description: Exercises the structured Footnote annotation validator against representative valid and invalid TypeScript fixtures.
 * @footnote-scope: test
 * @footnote-module: FootnoteTagValidatorTests
 * @footnote-risk: low - These tests only validate tooling behavior and do not affect runtime module execution.
 * @footnote-ethics: low - The fixtures use synthetic source files to check governance rules without user data.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { validateFootnoteAnnotations } from './validate-footnote-tags';

function withTempRepo(
    files: Record<string, string>,
    callback: (repoRoot: string) => void
): void {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'footnote-tags-'));

    for (const [relativePath, content] of Object.entries(files)) {
        const absolutePath = path.join(repoRoot, relativePath);
        fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
        fs.writeFileSync(absolutePath, content);
    }

    try {
        callback(repoRoot);
    } finally {
        fs.rmSync(repoRoot, { force: true, recursive: true });
    }
}

function collectMessages(files: Record<string, string>): string[] {
    let messages: string[] = [];

    withTempRepo(files, (repoRoot) => {
        const result = validateFootnoteAnnotations({
            repoRoot,
            scanRoots: ['packages'],
        });
        messages = result.diagnostics.map((diagnostic) => diagnostic.message);
    });

    return messages;
}

test('accepts a valid .ts file', () => {
    const messages = collectMessages({
        'packages/example/src/valid.ts': `/**
 * @description: Handles a valid module header for a TypeScript source file.
 * @footnote-scope: utility
 * @footnote-module: ValidModule
 * @footnote-risk: low - Validation should pass when the schema is followed exactly.
 * @footnote-ethics: low - The module only exercises tooling and does not touch user data.
 */
export const validValue = 1;
`,
    });

    assert.deepEqual(messages, []);
});

test('accepts a valid .tsx file with web scope', () => {
    const messages = collectMessages({
        'packages/web/src/ValidPage.tsx': `/**
 * @description: Renders a valid React page component with the web scope.
 * @footnote-scope: web
 * @footnote-module: ValidPage
 * @footnote-risk: medium - Rendering failures can hide web content but stay within the page boundary.
 * @footnote-ethics: medium - UI mistakes can mislead users about transparency cues in the interface.
 */
export const ValidPage = (): JSX.Element => <main>ok</main>;
`,
    });

    assert.deepEqual(messages, []);
});

test('reports a missing @footnote-module tag in a .tsx file', () => {
    const messages = collectMessages({
        'packages/web/src/MissingModule.tsx': `/**
 * @description: Renders a page that forgot one of the required tags.
 * @footnote-scope: web
 * @footnote-risk: medium - Missing annotations should be caught before merge.
 * @footnote-ethics: low - This fixture only tests annotation governance.
 */
export const MissingModule = (): JSX.Element => <main>missing</main>;
`,
    });

    assert.ok(
        messages.some((message) =>
            message.includes('Missing required @footnote-module tag')
        )
    );
});

test('reports tags that are out of order', () => {
    const messages = collectMessages({
        'packages/example/src/out-of-order.ts': `/**
 * @footnote-module: OutOfOrderModule
 * @description: Declares tags in the wrong order on purpose.
 * @footnote-scope: utility
 * @footnote-risk: low - The validator should point to the expected position.
 * @footnote-ethics: low - This fixture only verifies static governance behavior.
 */
export const outOfOrder = true;
`,
    });

    assert.ok(
        messages.some((message) =>
            message.includes(
                'Expected @description at position 1, found @footnote-module'
            )
        )
    );
});

test('reports risk tags that omit rationale text', () => {
    const messages = collectMessages({
        'packages/example/src/missing-risk-rationale.ts': `/**
 * @description: Demonstrates a missing rationale on the risk line.
 * @footnote-scope: utility
 * @footnote-module: MissingRiskRationale
 * @footnote-risk: high
 * @footnote-ethics: low - The fixture only validates static tooling behavior.
 */
export const missingRiskRationale = true;
`,
    });

    assert.ok(
        messages.some((message) =>
            message.includes('@footnote-risk must use "level - <rationale text>"')
        )
    );
});

test('rejects moderate as a legacy level', () => {
    const messages = collectMessages({
        'packages/example/src/legacy-level.ts': `/**
 * @description: Uses the removed moderate level to ensure it is rejected.
 * @footnote-scope: utility
 * @footnote-module: LegacyLevel
 * @footnote-risk: moderate - Legacy values should fail validation.
 * @footnote-ethics: low - This fixture only tests the schema.
 */
export const legacyLevel = true;
`,
    });

    assert.ok(
        messages.some((message) =>
            message.includes('Invalid @footnote-risk level "moderate"')
        )
    );
});

test('rejects unknown tags in the module header', () => {
    const messages = collectMessages({
        'packages/example/src/unknown-tag.ts': `/**
 * @description: Uses a legacy header tag that should now be rejected.
 * @footnote-scope: utility
 * @footnote-module: UnknownTag
 * @footnote-risk: low - The validator should fail unknown annotation tags.
 * @footnote-ethics: low - This fixture only tests static governance behavior.
 * @impact: Legacy impact prose should no longer appear as a tag.
 */
export const unknownTag = true;
`,
    });

    assert.ok(
        messages.some((message) =>
            message.includes('Unknown module header tag "@impact"')
        )
    );
});
