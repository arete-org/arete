/**
 * @arete-module: Logger
 * @arete-risk: low
 * @arete-ethics: moderate
 * @arete-scope: utility
 *
 * @description: Re-export shared Winston-based logging utilities to keep a single source of truth.
 *
 * @impact
 * Risk: Logging failures can make debugging difficult but won't break core functionality.
 * Ethics: Logs may contain user data or sensitive information, affecting privacy and auditability.
 */
export {
  logger,
  formatUsd,
  logLLMCostSummary,
  sanitizeLogData
} from '@arete/backend/shared';
export type { LLMCostTotals, LLMCostSummaryProvider } from '@arete/backend/shared';
