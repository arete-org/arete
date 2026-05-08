/**
 * @description: File scanning context integration entry point.
 * @footnote-scope: core
 * @footnote-module: FileScanningContextIntegration
 * @footnote-risk: low - Re-exports only.
 * @footnote-ethics: low - Re-exports only.
 */
export { createFileScanningContextStepExecutor } from './fileScanningContextStepExecutor.js';

export const FILE_SCAN_INTEGRATION_NAME = 'file_scan' as const;
