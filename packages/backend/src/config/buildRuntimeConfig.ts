/**
 * @description: Builds the backend runtime config from environment variables.
 * @footnote-scope: utility
 * @footnote-module: BuildBackendRuntimeConfig
 * @footnote-risk: medium - Missing a config section here can break startup or silently change behavior.
 * @footnote-ethics: medium - Central config assembly affects safety, auth, and abuse-control behavior.
 */

import { buildLoggingSection } from './sections/logging.js';
import { buildLitestreamSection } from './sections/litestream.js';
import { buildModelProfilesSection } from './sections/modelProfiles.js';
import { buildOllamaSection } from './sections/ollama.js';
import { buildOpenAISection } from './sections/openai.js';
import { readBotProfileConfig } from './profile.js';
import { buildRateLimitsSection } from './sections/rateLimits.js';
import { buildRuntimeSections } from './sections/runtime.js';
import { buildServiceSections } from './sections/services.js';
import { buildAlertsSection } from './sections/alerts.js';
import { buildStorageSection } from './sections/storage.js';
import { buildTurnstileSection } from './sections/turnstile.js';
import { buildVoltAgentSection } from './sections/voltagent.js';
import { buildWebSection } from './sections/web.js';
import { buildWebhookSection } from './sections/webhook.js';
import type { RuntimeConfig, WarningSink } from './types.js';

/**
 * Builds the full backend config object from one env snapshot. Reading env
 * once keeps every config section on the same defaults, warnings, and file
 * paths during startup.
 */
export const buildRuntimeConfig = (
    env: NodeJS.ProcessEnv,
    warn: WarningSink
): RuntimeConfig => {
    const { runtime, server } = buildRuntimeSections(env, warn);
    const openai = buildOpenAISection(env, warn);
    const ollama = buildOllamaSection(env);
    const modelProfiles = buildModelProfilesSection(
        env,
        runtime.projectRoot,
        warn
    );
    const voltagent = buildVoltAgentSection(env, warn);
    const web = buildWebSection(env, warn);
    const { reflect, trace, chatWorkflow } = buildServiceSections(env, warn);
    const turnstile = buildTurnstileSection(env, warn);
    const rateLimits = buildRateLimitsSection(env, warn);
    const webhook = buildWebhookSection(env, warn);
    const storage = buildStorageSection(env, warn);
    const logging = buildLoggingSection(env, warn);
    const litestream = buildLitestreamSection(env);
    const alerts = buildAlertsSection(env, warn);
    const profile = readBotProfileConfig({
        env,
        projectRoot: runtime.projectRoot,
        warn,
    });

    return {
        runtime,
        server,
        openai,
        ollama,
        modelProfiles,
        voltagent,
        cors: web.cors,
        csp: web.csp,
        reflect,
        trace,
        chatWorkflow,
        turnstile,
        rateLimits,
        webhook,
        storage,
        logging,
        litestream,
        alerts,
        profile,
    };
};
