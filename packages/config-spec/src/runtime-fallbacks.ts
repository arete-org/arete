/**
 * @description: Non-env runtime fallbacks that support config assembly without pretending to be env defaults.
 * @footnote-scope: utility
 * @footnote-module: RuntimeFallbacks
 * @footnote-risk: low - Wrong fallback URLs can break internal connectivity in specific deployments.
 * @footnote-ethics: low - These are operational helpers rather than user-facing policy settings.
 */

export const runtimeFallbacks = {
    discordBot: {
        flyInternalBackendBaseUrl: 'http://footnote-backend.internal:3000',
    },
} as const;
