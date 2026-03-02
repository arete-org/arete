/**
 * @description: Defines the canonical Footnote annotation schema used to generate runtime validation data and documentation snippets.
 * @footnote-scope: utility
 * @footnote-module: AnnotationSchemaSource
 * @footnote-risk: medium - Schema drift here would misconfigure validators and annotation guidance across the repository.
 * @footnote-ethics: medium - Inconsistent governance guidance can weaken traceability and contributor trust in annotation meaning.
 */

export const annotationSchema = {
    allowedScopes: ['core', 'utility', 'interface', 'web', 'test'],
    allowedLevels: ['low', 'medium', 'high'],
    requiredTags: [
        '@description',
        '@footnote-scope',
        '@footnote-module',
        '@footnote-risk',
        '@footnote-ethics',
    ],
    rationalePattern: 'level - <rationale text>',
} as const;

export interface AnnotationRuntimeSchema {
    allowedLevels: readonly string[];
    allowedScopes: readonly string[];
    rationalePattern: string;
    requiredTags: readonly string[];
}

export type AnnotationSchema = typeof annotationSchema;
export type AnnotationTag = AnnotationSchema['requiredTags'][number];

export const serializeAnnotationSchema = (
    schema: AnnotationSchema = annotationSchema
): string => `${JSON.stringify(schema, null, 4)}\n`;
