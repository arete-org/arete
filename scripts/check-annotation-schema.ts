/**
 * @description: Verifies that the checked-in Footnote annotation runtime JSON matches the canonical TypeScript schema source.
 * @footnote-scope: utility
 * @footnote-module: AnnotationSchemaRuntimeCheck
 * @footnote-risk: medium - A stale runtime schema would let validators and docs disagree about required governance rules.
 * @footnote-ethics: low - This check enforces repository consistency and does not touch user-facing data or behavior.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import {
    annotationSchema,
    serializeAnnotationSchema,
} from './annotation-schema.source';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const runtimeSchemaPath = path.join(__dirname, 'annotation-schema.runtime.json');
const expectedSchema = JSON.parse(serializeAnnotationSchema(annotationSchema));

let actualSchema: unknown;

try {
    actualSchema = JSON.parse(fs.readFileSync(runtimeSchemaPath, 'utf8'));
} catch {
    console.error(
        'Footnote tag error in scripts/annotation-schema.runtime.json: Runtime schema is stale. Run `pnpm generate-annotation-schema`.'
    );
    process.exit(1);
}

if (!isDeepStrictEqual(actualSchema, expectedSchema)) {
    console.error(
        'Footnote tag error in scripts/annotation-schema.runtime.json: Runtime schema is stale. Run `pnpm generate-annotation-schema`.'
    );
    process.exit(1);
}

console.log('Annotation schema runtime JSON is up to date.');
