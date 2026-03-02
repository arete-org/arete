/**
 * @description: Verifies that the checked-in Footnote annotation runtime JSON stays synchronized with the canonical TypeScript schema source.
 * @footnote-scope: test
 * @footnote-module: AnnotationSchemaTests
 * @footnote-risk: low - These tests only guard schema generation drift in developer tooling.
 * @footnote-ethics: low - The test asserts repository consistency and does not process user data.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    annotationSchema,
    serializeAnnotationSchema,
} from './annotation-schema.source';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const runtimeSchemaPath = path.join(__dirname, 'annotation-schema.runtime.json');

test('runtime annotation schema matches the source schema exactly', () => {
    const runtimeSchemaText = fs.readFileSync(runtimeSchemaPath, 'utf8');

    assert.deepEqual(
        JSON.parse(runtimeSchemaText),
        JSON.parse(serializeAnnotationSchema(annotationSchema))
    );
});
