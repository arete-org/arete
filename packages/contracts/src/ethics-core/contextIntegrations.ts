/**
 * @description: Canonical context-integration vocabulary shared across packages.
 * Defines stable integration identifiers used by planner, orchestration, and
 * execution metadata.
 * @footnote-scope: interface
 * @footnote-module: ContextIntegrationContracts
 * @footnote-risk: low - Identifier drift can break integration routing and telemetry matching.
 * @footnote-ethics: medium - Stable naming keeps provenance and governance interpretation consistent.
 */
export const CONTEXT_INTEGRATION_NAMES = [
    'weather_forecast',
    'web_search',
    'file_scan',
    'trustgraph',
    'reverse_image_search',
] as const;

export type ContextIntegrationName =
    | (typeof CONTEXT_INTEGRATION_NAMES)[number]
    | (string & {});
