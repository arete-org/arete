/**
 * @description: Re-exports realtime service types for compatibility.
 * @footnote-scope: utility
 * @footnote-module: RealtimeTypes
 * @footnote-risk: low - Type mismatches can break imports or tooling.
 * @footnote-ethics: low - Types do not change runtime behavior.
 */
// Re-export types from the main realtime service file for backward compatibility
export type * from '../utils/realtimeService.js';

