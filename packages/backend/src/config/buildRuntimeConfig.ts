/**
 * @description: Orchestrates one-pass backend runtime config construction from process env.
 * @footnote-scope: utility
 * @footnote-module: BuildBackendRuntimeConfig
 * @footnote-risk: medium - Missing a config section here can break startup or silently change behavior.
 * @footnote-ethics: medium - Central config assembly affects safety, auth, and abuse-control behavior.
 */

import { buildLoggingSection } from './sections/logging.js';
import { buildOpenAISection } from './sections/openai.js';
import { buildRateLimitsSection } from './sections/rateLimits.js';
import { buildRuntimeSections } from './sections/runtime.js';
import { buildServiceSections } from './sections/services.js';
import { buildStorageSection } from './sections/storage.js';
import { buildTurnstileSection } from './sections/turnstile.js';
import { buildWebSection } from './sections/web.js';
import { buildWebhookSection } from './sections/webhook.js';
import type { RuntimeConfig, WarningSink } from './types.js';

/**
 * Builds the full backend config object from one environment snapshot so all
 * sections agree on the same defaults and warnings.
 */
export const buildRuntimeConfig = (
    env: NodeJS.ProcessEnv,
    warn: WarningSink
): RuntimeConfig => {
    const { runtime, server } = buildRuntimeSections(env, warn);
    const openai = buildOpenAISection(env, warn);
    const web = buildWebSection(env, warn);
    const { reflect, trace } = buildServiceSections(env, warn);
    const turnstile = buildTurnstileSection(env, warn);
    const rateLimits = buildRateLimitsSection(env, warn);
    const webhook = buildWebhookSection(env, warn);
    const storage = buildStorageSection(env, warn);
    const logging = buildLoggingSection(env, warn);

    return {
        runtime,
        server,
        openai,
        cors: web.cors,
        csp: web.csp,
        reflect,
        trace,
        turnstile,
        rateLimits,
        webhook,
        storage,
        logging,
    };
};
