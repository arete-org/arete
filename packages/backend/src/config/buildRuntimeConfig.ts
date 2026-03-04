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
import { buildReflectSection } from './sections/reflect.js';
import { buildRuntimeSection } from './sections/runtime.js';
import { buildServerSection } from './sections/server.js';
import { buildStorageSection } from './sections/storage.js';
import { buildTraceSection } from './sections/trace.js';
import { buildTurnstileSection } from './sections/turnstile.js';
import { buildWebSection } from './sections/web.js';
import { buildWebhookSection } from './sections/webhook.js';
import type { RuntimeConfig, WarningSink } from './types.js';

export const buildRuntimeConfig = (
    env: NodeJS.ProcessEnv,
    warn: WarningSink
): RuntimeConfig => {
    const runtime = buildRuntimeSection(env, warn);
    const server = buildServerSection(env, warn);
    const openai = buildOpenAISection(env, warn);
    const web = buildWebSection(env, warn);
    const reflect = buildReflectSection(env, warn);
    const trace = buildTraceSection(env, warn);
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
