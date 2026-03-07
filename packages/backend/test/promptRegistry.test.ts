/**
 * @description: Verifies backend prompt registry wiring uses the shared canonical catalog and shared override semantics.
 * @footnote-scope: test
 * @footnote-module: BackendPromptRegistryTests
 * @footnote-risk: medium - Missing tests here can let backend prompt ownership drift or ignore overrides.
 * @footnote-ethics: high - Backend prompt selection sets canonical behavior for web reflect responses.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createBackendPromptRegistry } from '../src/services/prompts/promptRegistry.js';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const canonicalPromptCatalogPath = path.resolve(
    testDirectory,
    '../../prompts/src/defaults.yaml'
);

test('backend prompt registry exposes the canonical reflect chat prompt', () => {
    // Pass the shared canonical catalog directly so PROMPT_CONFIG_PATH and
    // runtimeConfig.runtime.promptConfigPath cannot change this assertion.
    const registry = createBackendPromptRegistry({
        overridePath: canonicalPromptCatalogPath,
    });

    assert.match(
        registry.renderPrompt('reflect.chat.system').content,
        /You are Footnote, an AI assistant from the Footnote project\./
    );
});

test('backend prompt registry applies PROMPT_CONFIG_PATH-style overrides', () => {
    const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'footnote-backend-prompts-')
    );
    const overridePath = path.join(tempDir, 'override.yaml');

    fs.writeFileSync(
        overridePath,
        [
            'reflect:',
            '  chat:',
            '    system:',
            '      template: |-',
            '        Backend override prompt.',
        ].join('\n'),
        'utf8'
    );

    const registry = createBackendPromptRegistry({ overridePath });

    assert.equal(
        registry.renderPrompt('reflect.chat.system').content,
        'Backend override prompt.'
    );
});

test('backend renderPrompt keeps default variables when explicit undefined values are passed', () => {
    const registry = createBackendPromptRegistry({
        overridePath: canonicalPromptCatalogPath,
    });

    const rendered = registry.renderPrompt('reflect.chat.system', {
        botProfileDisplayName: undefined,
    }).content;

    assert.match(
        rendered,
        /You are Footnote, an AI assistant from the Footnote project\./
    );
});
