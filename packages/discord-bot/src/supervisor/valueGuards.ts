/**
 * @description: Shared runtime value guards used by local-node supervisor parsing paths.
 * @footnote-scope: utility
 * @footnote-module: SupervisorValueGuards
 * @footnote-risk: low - Type-guard bugs can misclassify untrusted config payloads.
 * @footnote-ethics: low - Guard consistency helps predictable config validation behavior.
 */

export const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null;
