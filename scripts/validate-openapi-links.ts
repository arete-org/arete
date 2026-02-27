/**
 * Purpose:
 * - Validate that OpenAPI operationIds are linked to code references.
 * - Check both directions:
 *   1) spec -> code (declared refs point to real files)
 *   2) code -> spec (annotated operationIds exist in openapi.yaml)
 * - Fail fast in CI when links drift.
 */
