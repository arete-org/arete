/**
 * @description: Public exports for shared utilities and prompt registry access.
 * @arete-scope: interface
 * @arete-module: SharedIndex
 * @arete-risk: low - Export changes can break downstream imports.
 * @arete-ethics: low - This module re-exports without processing data.
 */

export type {
  PromptCachePolicy,
  PromptDefinition,
  PromptKey,
  PromptMetadata,
  PromptVariables,
  RenderedPrompt
} from './prompts/promptRegistry';

export {
  PromptRegistry,
  getActivePromptRegistry,
  renderPrompt,
  setActivePromptRegistry
} from './prompts/promptRegistry';

/**
 * Logging utilities.
 */
export { logger, formatUsd, logLLMCostSummary, sanitizeLogData } from './logger';
export type { LLMCostTotals, LLMCostSummaryProvider } from './logger';

/**
 * Trace storage utilities for persisting and retrieving response metadata.
 */
export * from './traceStore';
export { defaultTraceStore, createTraceStoreFromEnv } from './traceStore';
export { SqliteTraceStore } from './sqliteTraceStore';

/**
 * Incident storage utilities for durable incident logging and audit trails.
 */
export * from './incidentStore';
export { SqliteIncidentStore } from './sqliteIncidentStore';

/**
 * Pseudonymization helpers for Discord-facing identifiers.
 */
export { hmacId, pseudonymizeActorId, pseudonymizeIncidentPointers, shortHash } from './pseudonymization';
