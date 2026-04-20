/**
 * @description: Kebab-case bridge entrypoint so workspace TS path mapping can resolve @footnote/api-client/web-client.
 * @footnote-scope: interface
 * @footnote-module: WebClientBridgeEntrypoint
 * @footnote-risk: low - Re-export only; no runtime behavior changes.
 * @footnote-ethics: low - No governance impact; maintains consistent validated API access.
 */

export * from './webClient.js';
