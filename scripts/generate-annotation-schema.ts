/**
 * @description: Generates the checked-in runtime JSON used by Footnote annotation validators and tooling.
 * @footnote-scope: utility
 * @footnote-module: AnnotationSchemaGenerator
 * @footnote-risk: low - Generation mistakes are recoverable, but stale runtime schema output can cause validator drift.
 * @footnote-ethics: low - This script only maintains governance metadata and does not process user-facing content.
 */

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

fs.writeFileSync(runtimeSchemaPath, serializeAnnotationSchema(annotationSchema));
console.log(`Generated ${path.relative(process.cwd(), runtimeSchemaPath)}.`);
