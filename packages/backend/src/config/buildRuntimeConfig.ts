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
import { buildExecutionContractTrustGraphSection } from './sections/executionContractTrustGraph.js';
import { readBotProfileConfig } from './profile.js';
import { buildRateLimitsSection } from './sections/rateLimits.js';
import { buildRuntimeSections } from './sections/runtime.js';
import { buildServiceSections } from './sections/services.js';
import { buildAlertsSection } from './sections/alerts.js';
import { buildStorageSection } from './sections/storage.js';
import { buildTurnstileSection } from './sections/turnstile.js';
import { buildVoltAgentSection } from './sections/voltagent.js';
import { buildWebSection } from './sections/web.js';
import type { RuntimeConfig, WarningSink } from './types.js';
import { buildEffectiveConfigEnv, loadServerSettings } from './settings.js';

/**
 * Builds the full backend config object from one env snapshot. Reading env
 * once keeps every config section on the same defaults, warnings, and file
 * paths during startup.
 */
export const buildRuntimeConfig = (
    env: NodeJS.ProcessEnv,
    warn: WarningSink
): RuntimeConfig => {
    const { yamlSettings, yamlEnv } = loadServerSettings(env, warn);
    const effectiveEnv = buildEffectiveConfigEnv(env, yamlEnv, warn);
    const { runtime, server } = buildRuntimeSections(effectiveEnv, warn);
    const openai = buildOpenAISection(effectiveEnv, warn);
    const ollama = buildOllamaSection(effectiveEnv);
    const modelProfiles = buildModelProfilesSection(
        effectiveEnv,
        runtime.projectRoot,
        warn
    );
    const voltagent = buildVoltAgentSection(effectiveEnv, warn);
    const web = buildWebSection(effectiveEnv, warn);
    const { reflect, trace, langfuseMetadataMirror, chatWorkflow } =
        buildServiceSections(effectiveEnv, warn);
    const executionContractTrustGraph = buildExecutionContractTrustGraphSection(
        effectiveEnv,
        warn
    );
    const turnstile = buildTurnstileSection(effectiveEnv, warn);
    const rateLimits = buildRateLimitsSection(effectiveEnv, warn);
    const storage = buildStorageSection(effectiveEnv, warn);
    const logging = buildLoggingSection(effectiveEnv, warn);
    const litestream = buildLitestreamSection(effectiveEnv);
    const alerts = buildAlertsSection(effectiveEnv, warn);
    const profile = readBotProfileConfig({
        env: effectiveEnv,
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
        langfuseMetadataMirror,
        chatWorkflow,
        executionContractTrustGraph,
        turnstile,
        rateLimits,
        storage,
        logging,
        litestream,
        alerts,
        profile,
        settings: {
            localNodes: yamlSettings?.settings.localNodes ?? null,
        },
    };
};
