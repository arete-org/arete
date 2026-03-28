/**
 * @description: Centralizes backend runtime configuration defaults and env parsing.
 * @footnote-scope: utility
 * @footnote-module: BackendRuntimeConfig
 * @footnote-risk: medium - Misconfiguration can break API behavior or security controls.
 * @footnote-ethics: medium - Incorrect defaults can weaken abuse protections.
 */
import './bootstrapEnv.js';
import { buildRuntimeConfig } from './config/buildRuntimeConfig.js';

export type { RuntimeConfig } from './config/types.js';
export { buildRuntimeConfig } from './config/buildRuntimeConfig.js';

/**
 * Backend runtime config built once at startup with warning logs for any
 * ignored env overrides.
 */
export const runtimeConfig = buildRuntimeConfig(process.env, (message) =>
    console.warn(`[backendRuntimeConfig] ${message}`)
);
