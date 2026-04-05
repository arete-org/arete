/**
 * @description: Exports Execution Contract + TrustGraph contracts, adapter stubs, and harness utilities.
 * This keeps the prototype boundary explicit and easy to remove or revise.
 * @footnote-scope: interface
 * @footnote-module: ExecutionContractTrustGraphIndex
 * @footnote-risk: low - Export surface mistakes can expose unstable prototype APIs unintentionally.
 * @footnote-ethics: low - This index only re-exports bounded prototype modules.
 */

export * from './mappingRegistry.js';
export * from './trustGraphBenchmarkHarness.js';
export * from './trustGraphEvidenceIngestion.js';
export * from './trustGraphEvidenceTypes.js';
export * from './provenanceJoin.js';
export * from './scopeValidator.js';
export * from './tenancyOwnershipValidator.js';
export * from './trustGraphEvidenceAdapter.js';
export * from './trustGraphHttpAdapter.js';
export * from './tenancyOwnershipHttpService.js';
export * from './runtimeWiring.js';
