/**
 * @description: Main orchestration point controlling system initialization, authentication, and event routing.
 * @footnote-scope: core
 * @footnote-module: Main
 * @footnote-risk: high - Failure here can halt the application or expose tokens and credentials.
 * @footnote-ethics: high - Determines which modules (including cost tracking and audit systems) are initialized, affecting transparency and accountability across the bot.
 */

import { Client, GatewayIntentBits, Events, Collection } from 'discord.js';
import path from 'path';
import { fileURLToPath } from 'url';
import { CommandHandler } from './utils/commandHandler.js';
import { EventManager } from './utils/eventManager.js';
import { logger } from './utils/logger.js';
import { runtimeConfig } from './config.js';
import { OpenAIService } from './utils/openaiService.js';
import type { Command } from './commands/BaseCommand.js';
import type { ResponseMetadata } from '@footnote/contracts/ethics-core';
import { botApi } from './api/botApi.js';
import {
    evictFollowUpContext,
    readFollowUpContext,
    saveFollowUpContext,
} from './commands/image/followUpCache.js';
import { runImageGenerationSession } from './commands/image.js';
import {
    IMAGE_RETRY_CUSTOM_ID_PREFIX,
    IMAGE_VARIATION_ASPECT_SELECT_PREFIX,
    IMAGE_VARIATION_CANCEL_CUSTOM_ID_PREFIX,
    IMAGE_VARIATION_GENERATE_CUSTOM_ID_PREFIX,
    IMAGE_VARIATION_PROMPT_INPUT_ID,
    IMAGE_VARIATION_PROMPT_MODAL_ID_PREFIX,
    IMAGE_VARIATION_QUALITY_SELECT_PREFIX,
    IMAGE_VARIATION_RESET_PROMPT_CUSTOM_ID_PREFIX,
    IMAGE_VARIATION_PROMPT_ADJUST_SELECT_PREFIX,
    IMAGE_VARIATION_IMAGE_MODEL_SELECT_PREFIX,
    IMAGE_VARIATION_CUSTOM_ID_PREFIX,
} from './commands/image/constants.js';
import {
    buildImageResultPresentation,
    clampPromptForContext,
    createRetryButtonRow,
    executeImageGeneration,
    formatRetryCountdown,
} from './commands/image/sessionHelpers.js';
import { recoverContextFromMessage } from './commands/image/contextResolver.js';
import {
    applyVariationCooldown,
    buildPromptModal,
    buildVariationConfiguratorView,
    disposeVariationSession,
    getVariationSession,
    initialiseVariationSession,
    resetVariationCooldown,
    setVariationSessionUpdater,
    updateVariationSession,
} from './commands/image/variationSessions.js';
import { resolveAspectRatioSettings } from './commands/image/aspect.js';
import type { ImageGenerationContext } from './commands/image/followUpCache.js';
import type {
    ImageQualityType,
    ImageRenderModel,
} from './commands/image/types.js';
import {
    buildTokenSummaryLine,
    consumeImageTokens,
    describeTokenAvailability,
    refundImageTokens,
} from './utils/imageTokens.js';
import { LLMCostEstimator } from './utils/LLMCostEstimator.js';
import type { ChannelContextManager } from './state/ChannelContextManager.js';
import { resolveMemberDisplayName } from './utils/response/provenanceInteractions.js';
import { parseProvenanceActionCustomId } from './utils/response/provenanceCgi.js';
import {
    handleIncidentReportButton,
    handleIncidentReportCancel,
    handleIncidentReportConsent,
    handleIncidentReportModal,
    INCIDENT_REPORT_CANCEL_PREFIX,
    INCIDENT_REPORT_CONSENT_PREFIX,
    INCIDENT_REPORT_MODAL_PREFIX,
} from './utils/response/incidentReporting.js';
import {
    handleIncidentViewSelect,
    INCIDENT_VIEW_SELECT_PREFIX,
} from './commands/incident.js';
//import express from 'express'; // For webhook
//import bodyParser from "body-parser"; // For webhook

type ClientWithCommands = Client & {
    commands?: Map<string, Command>;
};

// ====================
// Environment Setup
// ====================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Set up cost estimator if enabled, to track OpenAI API usage and costs
let costEstimator: LLMCostEstimator | undefined = undefined;
if (runtimeConfig.costEstimator.enabled) {
    costEstimator = new LLMCostEstimator({
        enabled: true,
        contextManager: null as ChannelContextManager | null,
    });
    logger.info('LLMCostEstimator initialized');
} else {
    logger.debug('LLMCostEstimator disabled by configuration');
}

// Initialize OpenAI service
/**
 * Shared OpenAI service instance used by commands, planners, and interaction
 * handlers in the bot process.
 */
export const openaiService = new OpenAIService(
    runtimeConfig.openaiApiKey,
    costEstimator
); // Exported for use in other files, like /news command

// Re-export modules needed by server.js
export { OpenAIService } from './utils/openaiService.js';
export { buildResponseMetadata } from './utils/response/metadata.js';
export { RateLimiter } from './utils/RateLimiter.js';

// ====================
// Client Configuration
// ====================
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildVoiceStates,
    ],
    presence: { status: 'online' },
});

// ====================
// Initialize Managers
// ====================
const commandHandler = new CommandHandler();
const eventManager = new EventManager(client, {
    openai: { apiKey: runtimeConfig.openaiApiKey },
    openaiService,
    costEstimator,
});

// Initialize client handlers
client.handlers = new Collection();

// VoiceStateHandler will be instantiated by EventManager (auto-registers itself to client.handlers)

// ====================
// Load and Register Commands
// ====================
// Use an async IIFE to handle top-level await
(async () => {
    try {
        // Load commands first
        const commands = await commandHandler.loadCommands();

        // Deploy commands to Discord
        logger.debug('Deploying commands to Discord...');
        await commandHandler.deployCommands(
            runtimeConfig.token,
            runtimeConfig.clientId,
            runtimeConfig.guildId
        );

        // Store commands in memory for execution
        commands.forEach((cmd, name) => {
            const clientWithCommands = client as ClientWithCommands;
            clientWithCommands.commands =
                clientWithCommands.commands || new Map();
            clientWithCommands.commands.set(name, cmd);
            logger.debug(`Command stored in memory: ${name}`);
        });

        // Load events after commands are registered
        logger.debug('Loading events...');
        await eventManager.loadEvents(__dirname + '/events');
        eventManager.registerAll();
        logger.debug('Events loaded and registered.');

        // Login to Discord after everything is set up
        logger.debug('Logging in to Discord...');
        await client.login(runtimeConfig.token);
        logger.info('Bot is now connected to Discord and ready!');
    } catch (error) {
        logger.error('Failed to initialize bot:' + error);
        process.exit(1);
    }
})();

// ====================
// Process Handlers
// ====================
// Client ready handler
client.once(Events.ClientReady, () => {
    logger.info(`Logged in as ${client.user?.tag}`);
});

/**
 * Builds the status message that appears at the top of the variation
 * configurator. We always surface the caller's remaining tokens so they can
 * immediately see how many high-quality attempts remain before the next refill.
 */
function buildVariationStatusMessage(userId: string, base?: string): string {
    const isDeveloper = userId === runtimeConfig.developerUserId;
    if (isDeveloper) {
        return base
            ? `${base}\n\nDeveloper bypass active—image tokens are not required.`
            : 'Developer bypass active—image tokens are not required.';
    }

    const summary = buildTokenSummaryLine(userId);
    return base ? `${base}\n\n${summary}` : summary;
}

const DISCORD_MESSAGE_MAX_LENGTH = 2000;
const DETAILS_CODE_FENCE_PREFIX = '```json\n';
const DETAILS_CODE_FENCE_SUFFIX = '\n```';
const DETAILS_TRUNCATION_SUFFIX = '\n... (truncated)';
const DETAILS_FALLBACK_REASON = 'metadata_unavailable';

type DetailsFallbackPayload = {
    responseId: string | null;
    metadata: null;
    reason: typeof DETAILS_FALLBACK_REASON;
};

function buildDetailsPayload(
    responseId: string | undefined,
    metadata: ResponseMetadata | null
): ResponseMetadata | DetailsFallbackPayload {
    if (metadata) {
        return metadata;
    }

    return {
        responseId: responseId ?? null,
        metadata: null,
        reason: DETAILS_FALLBACK_REASON,
    };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return (
        !!value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        Object.getPrototypeOf(value) === Object.prototype
    );
}

const PROVENANCE_VALUES = new Set(['Retrieved', 'Inferred', 'Speculative']);
const RISK_TIER_VALUES = new Set(['Low', 'Medium', 'High']);

function isValidCitationList(value: unknown): boolean {
    if (!Array.isArray(value)) {
        return false;
    }

    return value.every((citation) => {
        if (!isPlainObject(citation)) {
            return false;
        }

        if (
            typeof citation.title !== 'string' ||
            typeof citation.url !== 'string'
        ) {
            return false;
        }

        if (
            'snippet' in citation &&
            citation.snippet !== undefined &&
            typeof citation.snippet !== 'string'
        ) {
            return false;
        }

        return true;
    });
}

function isValidResponseMetadataPayload(
    payload: unknown
): payload is ResponseMetadata {
    if (!isPlainObject(payload)) {
        return false;
    }

    if (
        typeof payload.responseId !== 'string' ||
        payload.responseId.length < 1
    ) {
        return false;
    }

    if (
        typeof payload.provenance !== 'string' ||
        !PROVENANCE_VALUES.has(payload.provenance)
    ) {
        return false;
    }

    if (
        typeof payload.riskTier !== 'string' ||
        !RISK_TIER_VALUES.has(payload.riskTier)
    ) {
        return false;
    }

    if (
        typeof payload.tradeoffCount !== 'number' ||
        !Number.isFinite(payload.tradeoffCount) ||
        payload.tradeoffCount < 0
    ) {
        return false;
    }

    if (
        typeof payload.chainHash !== 'string' ||
        payload.chainHash.trim().length === 0
    ) {
        return false;
    }

    if (
        typeof payload.licenseContext !== 'string' ||
        payload.licenseContext.trim().length === 0
    ) {
        return false;
    }

    if (
        typeof payload.modelVersion !== 'string' ||
        payload.modelVersion.trim().length === 0
    ) {
        return false;
    }

    if (typeof payload.staleAfter !== 'string') {
        return false;
    }

    const staleAfterDate = new Date(payload.staleAfter);
    if (Number.isNaN(staleAfterDate.getTime())) {
        return false;
    }

    return isValidCitationList(payload.citations);
}

function formatInlineJsonObject(value: Record<string, unknown>): string {
    const entries = Object.entries(value).filter(
        ([, entryValue]) => entryValue !== undefined
    );
    const serializedEntries = entries.map(
        ([entryKey, entryValue]) =>
            `${JSON.stringify(entryKey)}: ${JSON.stringify(entryValue)}`
    );
    return `{ ${serializedEntries.join(', ')} }`;
}

function serializeDetailsPayload(
    payload: ResponseMetadata | DetailsFallbackPayload
): string {
    if (!('provenance' in payload)) {
        return JSON.stringify(payload, null, 2);
    }

    const lines: string[] = ['{'];
    const entries = Object.entries(payload).filter(
        ([, value]) => value !== undefined
    );

    for (let index = 0; index < entries.length; index += 1) {
        const [key, value] = entries[index];
        const hasTrailingComma = index < entries.length - 1;
        const trailingComma = hasTrailingComma ? ',' : '';

        if (key === 'citations' && Array.isArray(value)) {
            lines.push('  "citations": [');
            for (
                let citationIndex = 0;
                citationIndex < value.length;
                citationIndex += 1
            ) {
                const citation = value[citationIndex];
                const citationComma =
                    citationIndex < value.length - 1 ? ',' : '';
                if (isPlainObject(citation)) {
                    lines.push(
                        `    ${formatInlineJsonObject(citation)}${citationComma}`
                    );
                } else {
                    lines.push(
                        `    ${JSON.stringify(citation)}${citationComma}`
                    );
                }
            }
            lines.push(`  ]${trailingComma}`);
            continue;
        }

        if (key === 'temperament' && isPlainObject(value)) {
            lines.push(
                `  "temperament": ${formatInlineJsonObject(value)}${trailingComma}`
            );
            continue;
        }

        lines.push(
            `  ${JSON.stringify(key)}: ${JSON.stringify(value)}${trailingComma}`
        );
    }

    lines.push('}');
    return lines.join('\n');
}

function formatDetailsPayloadForDiscord(
    payload: ResponseMetadata | DetailsFallbackPayload
): string {
    const serialized = serializeDetailsPayload(payload);
    const maxPayloadLength =
        DISCORD_MESSAGE_MAX_LENGTH -
        DETAILS_CODE_FENCE_PREFIX.length -
        DETAILS_CODE_FENCE_SUFFIX.length;

    if (serialized.length <= maxPayloadLength) {
        return `${DETAILS_CODE_FENCE_PREFIX}${serialized}${DETAILS_CODE_FENCE_SUFFIX}`;
    }

    const truncatedPayloadLength = Math.max(
        0,
        maxPayloadLength - DETAILS_TRUNCATION_SUFFIX.length
    );
    const truncatedPayload = `${serialized.slice(0, truncatedPayloadLength)}${DETAILS_TRUNCATION_SUFFIX}`;
    return `${DETAILS_CODE_FENCE_PREFIX}${truncatedPayload}${DETAILS_CODE_FENCE_SUFFIX}`;
}

function extractMetadataFromTraceResponse(
    payload: unknown
): ResponseMetadata | null {
    if (isValidResponseMetadataPayload(payload)) {
        return payload;
    }

    if (
        isPlainObject(payload) &&
        'metadata' in payload &&
        isValidResponseMetadataPayload(
            (payload as { metadata?: unknown }).metadata
        )
    ) {
        return (payload as { metadata: ResponseMetadata }).metadata;
    }

    return null;
}

// Slash commands handler
client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isChatInputCommand()) {
        const command = (
            interaction.client as ClientWithCommands
        ).commands?.get(interaction.commandName);

        if (!command) {
            logger.error(
                `No command matching ${interaction.commandName} was found.`
            );
            return;
        }

        logger.info(`Executing command: ${interaction.commandName}`);

        try {
            await command.execute(interaction);
        } catch (error) {
            logger.error(
                `Error executing command ${interaction.commandName}: ${error}`
            );
        }

        return;
    }

    if (interaction.isStringSelectMenu()) {
        const { customId, values } = interaction;

        const selected = values?.[0];

        if (!selected) {
            await interaction.deferUpdate();
            return;
        }

        const respondWithExpiryNotice = async () => {
            await interaction.reply({
                content:
                    '⚠️ That variation configurator expired. Press the variation button again.',
                flags: [1 << 6],
            });
        };

        if (customId.startsWith(IMAGE_VARIATION_QUALITY_SELECT_PREFIX)) {
            const responseId = customId.slice(
                IMAGE_VARIATION_QUALITY_SELECT_PREFIX.length
            );
            const session = updateVariationSession(
                interaction.user.id,
                responseId,
                (current) => {
                    current.quality = selected as ImageQualityType;
                }
            );

            if (!session) {
                await respondWithExpiryNotice();
                return;
            }

            const refreshed =
                resetVariationCooldown(interaction.user.id, responseId) ??
                session;
            await interaction.update(
                buildVariationConfiguratorView(refreshed, {
                    statusMessage: buildVariationStatusMessage(
                        interaction.user.id
                    ),
                })
            );
            return;
        }

        if (customId.startsWith(IMAGE_VARIATION_ASPECT_SELECT_PREFIX)) {
            const responseId = customId.slice(
                IMAGE_VARIATION_ASPECT_SELECT_PREFIX.length
            );
            const session = updateVariationSession(
                interaction.user.id,
                responseId,
                (current) => {
                    const { size, aspectRatio, aspectRatioLabel } =
                        resolveAspectRatioSettings(
                            selected as ImageGenerationContext['aspectRatio']
                        );
                    current.size = size;
                    current.aspectRatio = aspectRatio;
                    current.aspectRatioLabel = aspectRatioLabel;
                }
            );

            if (!session) {
                await respondWithExpiryNotice();
                return;
            }

            const refreshed =
                resetVariationCooldown(interaction.user.id, responseId) ??
                session;
            await interaction.update(
                buildVariationConfiguratorView(refreshed, {
                    statusMessage: buildVariationStatusMessage(
                        interaction.user.id
                    ),
                })
            );
            return;
        }

        if (customId.startsWith(IMAGE_VARIATION_IMAGE_MODEL_SELECT_PREFIX)) {
            const responseId = customId.slice(
                IMAGE_VARIATION_IMAGE_MODEL_SELECT_PREFIX.length
            );
            const session = updateVariationSession(
                interaction.user.id,
                responseId,
                (current) => {
                    current.imageModel = selected as ImageRenderModel;
                }
            );

            if (!session) {
                await respondWithExpiryNotice();
                return;
            }

            const refreshed =
                resetVariationCooldown(interaction.user.id, responseId) ??
                session;
            await interaction.update(
                buildVariationConfiguratorView(refreshed, {
                    statusMessage: buildVariationStatusMessage(
                        interaction.user.id
                    ),
                })
            );
            return;
        }

        if (customId.startsWith(IMAGE_VARIATION_PROMPT_ADJUST_SELECT_PREFIX)) {
            const responseId = customId.slice(
                IMAGE_VARIATION_PROMPT_ADJUST_SELECT_PREFIX.length
            );
            const session = updateVariationSession(
                interaction.user.id,
                responseId,
                (current) => {
                    current.allowPromptAdjustment = selected === 'allow';
                }
            );

            if (!session) {
                await respondWithExpiryNotice();
                return;
            }

            const refreshed =
                resetVariationCooldown(interaction.user.id, responseId) ??
                session;
            await interaction.update(
                buildVariationConfiguratorView(refreshed, {
                    statusMessage: buildVariationStatusMessage(
                        interaction.user.id
                    ),
                })
            );
            return;
        }

        if (customId.startsWith(INCIDENT_VIEW_SELECT_PREFIX)) {
            await handleIncidentViewSelect(interaction);
            return;
        }
    }

    if (interaction.isModalSubmit()) {
        const { customId } = interaction;

        if (customId.startsWith(INCIDENT_REPORT_MODAL_PREFIX)) {
            await handleIncidentReportModal(interaction);
            return;
        }

        if (customId.startsWith(IMAGE_VARIATION_PROMPT_MODAL_ID_PREFIX)) {
            const responseId = customId.slice(
                IMAGE_VARIATION_PROMPT_MODAL_ID_PREFIX.length
            );
            const rawPrompt = interaction.fields.getTextInputValue(
                IMAGE_VARIATION_PROMPT_INPUT_ID
            );
            const trimmedPrompt = rawPrompt?.trim();

            if (!trimmedPrompt) {
                await interaction.reply({
                    content: '⚠️ The prompt cannot be empty.',
                    flags: [1 << 6], // [1 << 6] = EPHEMERAL
                });
                return;
            }

            const session = updateVariationSession(
                interaction.user.id,
                responseId,
                (current) => {
                    const normalized = clampPromptForContext(trimmedPrompt);
                    current.prompt = normalized;
                    current.refinedPrompt = normalized;
                }
            );

            if (!session) {
                await interaction.reply({
                    content:
                        '⚠️ That variation configurator expired. Press the variation button again.',
                    flags: [1 << 6], // [1 << 6] = EPHEMERAL
                });
                return;
            }

            const refreshed =
                resetVariationCooldown(interaction.user.id, responseId) ??
                session;
            try {
                if (refreshed.messageUpdater) {
                    await refreshed.messageUpdater(
                        buildVariationConfiguratorView(refreshed, {
                            statusMessage: buildVariationStatusMessage(
                                interaction.user.id
                            ),
                        })
                    );
                }
            } catch (error) {
                logger.warn(
                    'Failed to refresh variation configurator after prompt update:' +
                        error
                );
            }

            await interaction.reply({
                content:
                    '✅ Prompt updated! Adjust other settings and press **Generate variation** when ready.',
                flags: [1 << 6], // [1 << 6] = EPHEMERAL
            });
            return;
        }
    }

    // ====================
    // Button Interactions
    // ====================
    if (interaction.isButton()) {
        const { customId } = interaction;

        const provenanceAction = parseProvenanceActionCustomId(customId);
        if (provenanceAction) {
            if (provenanceAction.action === 'details') {
                await interaction.deferReply({
                    flags: [1 << 6], // [1 << 6] = EPHEMERAL
                });
                let metadata: ResponseMetadata | null = null;
                try {
                    const traceResponse = await botApi.getTrace(
                        provenanceAction.responseId
                    );
                    metadata = extractMetadataFromTraceResponse(
                        traceResponse.data
                    );
                } catch (error) {
                    logger.warn(
                        'Failed to load provenance metadata for details action',
                        {
                            responseId: provenanceAction.responseId,
                            error:
                                error instanceof Error
                                    ? error.message
                                    : String(error),
                        }
                    );
                }

                const detailsPayload = buildDetailsPayload(
                    provenanceAction.responseId,
                    metadata
                );
                await interaction.editReply({
                    content: formatDetailsPayloadForDiscord(detailsPayload),
                });
                return;
            }

            if (provenanceAction.action === 'report_issue') {
                await handleIncidentReportButton(interaction);
                return;
            }
        }

        if (customId.startsWith(INCIDENT_REPORT_CANCEL_PREFIX)) {
            await handleIncidentReportCancel(interaction);
            return;
        }

        if (customId.startsWith(INCIDENT_REPORT_CONSENT_PREFIX)) {
            await handleIncidentReportConsent(interaction);
            return;
        }

        // Variation buttons all share the same prefix, so handle the specific
        // actions (generate, reset, cancel, prompt modal) before the generic
        // configurator entry point to avoid mis-routing follow-up clicks.
        if (customId.startsWith(IMAGE_VARIATION_GENERATE_CUSTOM_ID_PREFIX)) {
            const responseId = customId.slice(
                IMAGE_VARIATION_GENERATE_CUSTOM_ID_PREFIX.length
            );
            const session = getVariationSession(
                interaction.user.id,
                responseId
            );
            if (!session) {
                await interaction.reply({
                    content:
                        '⚠️ That variation configurator expired. Press the variation button again.',
                    flags: [1 << 6], // [1 << 6] = EPHEMERAL
                });
                return;
            }

            const cooldownRemaining = session.cooldownUntil
                ? Math.max(
                      0,
                      Math.ceil((session.cooldownUntil - Date.now()) / 1000)
                  )
                : 0;
            if (cooldownRemaining > 0) {
                await interaction.reply({
                    content: `⚠️ Please wait ${formatRetryCountdown(cooldownRemaining)} before generating another variation.`,
                    flags: [1 << 6], // [1 << 6] = EPHEMERAL
                });
                return;
            }

            const developerBypass =
                interaction.user.id === runtimeConfig.developerUserId;
            let tokenSpend = null as ReturnType<
                typeof consumeImageTokens
            > | null;

            // Spend tokens only when the user is not in developer bypass mode. This keeps
            // chained variations consistent with the slash-command flow.
            if (!developerBypass) {
                const spendResult = consumeImageTokens(
                    interaction.user.id,
                    session.quality,
                    session.imageModel
                );
                if (!spendResult.allowed) {
                    const statusMessage = buildVariationStatusMessage(
                        interaction.user.id,
                        describeTokenAvailability(
                            session.quality,
                            spendResult,
                            session.imageModel
                        )
                    );

                    const updatedSession =
                        spendResult.remainingTokens === 0 &&
                        spendResult.refreshInSeconds > 0
                            ? (applyVariationCooldown(
                                  interaction.user.id,
                                  responseId,
                                  spendResult.refreshInSeconds
                              ) ?? session)
                            : (resetVariationCooldown(
                                  interaction.user.id,
                                  responseId
                              ) ?? session);

                    if (session.messageUpdater) {
                        try {
                            await session.messageUpdater(
                                buildVariationConfiguratorView(updatedSession, {
                                    statusMessage,
                                })
                            );
                        } catch (error) {
                            logger.warn(
                                'Failed to refresh variation configurator after token denial: ' +
                                    error
                            );
                        }
                    }

                    await interaction.reply({
                        content: statusMessage,
                        flags: [1 << 6], // [1 << 6] = EPHEMERAL
                    });
                    return;
                }

                tokenSpend = spendResult;
            }

            try {
                if (session.messageUpdater) {
                    await session.messageUpdater({
                        content: '⏳ Generating variation…',
                        embeds: [],
                        components: [],
                    });
                }
            } catch (error) {
                logger.warn(
                    'Failed to update variation configurator before generation:' +
                        error
                );
            }

            await interaction.deferReply();

            try {
                const runContext = {
                    prompt: session.prompt,
                    originalPrompt: session.originalPrompt,
                    refinedPrompt: session.refinedPrompt,
                    textModel: session.textModel,
                    imageModel: session.imageModel,
                    size: session.size,
                    aspectRatio: session.aspectRatio,
                    aspectRatioLabel: session.aspectRatioLabel,
                    quality: session.quality,
                    background: session.background,
                    style: session.style,
                    allowPromptAdjustment: session.allowPromptAdjustment,
                    outputFormat: session.outputFormat,
                    outputCompression: session.outputCompression,
                };

                const result = await runImageGenerationSession(
                    interaction,
                    runContext,
                    responseId
                );

                if (!result.success && tokenSpend) {
                    refundImageTokens(interaction.user.id, tokenSpend.cost);
                }
            } catch (error) {
                logger.error(
                    'Unexpected error while generating variation:' + error
                );
                if (tokenSpend) {
                    refundImageTokens(interaction.user.id, tokenSpend.cost);
                }
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({
                        content:
                            '⚠️ Something went wrong while generating that variation.',
                        flags: [1 << 6], // [1 << 6] = EPHEMERAL
                    });
                }
            } finally {
                disposeVariationSession(`${interaction.user.id}:${responseId}`);
            }

            return;
        }

        if (
            customId.startsWith(IMAGE_VARIATION_RESET_PROMPT_CUSTOM_ID_PREFIX)
        ) {
            const responseId = customId.slice(
                IMAGE_VARIATION_RESET_PROMPT_CUSTOM_ID_PREFIX.length
            );
            const session = updateVariationSession(
                interaction.user.id,
                responseId,
                (current) => {
                    current.prompt = current.originalPrompt;
                    current.refinedPrompt = current.originalPrompt;
                }
            );

            if (!session) {
                await interaction.reply({
                    content:
                        '⚠️ That variation configurator expired. Press the variation button again.',
                    flags: [1 << 6], // [1 << 6] = EPHEMERAL
                });
                return;
            }

            const refreshed =
                resetVariationCooldown(interaction.user.id, responseId) ??
                session;
            await interaction.update(
                buildVariationConfiguratorView(refreshed, {
                    statusMessage: buildVariationStatusMessage(
                        interaction.user.id
                    ),
                })
            );
            return;
        }

        if (customId.startsWith(IMAGE_VARIATION_CANCEL_CUSTOM_ID_PREFIX)) {
            const responseId = customId.slice(
                IMAGE_VARIATION_CANCEL_CUSTOM_ID_PREFIX.length
            );
            disposeVariationSession(`${interaction.user.id}:${responseId}`);
            await interaction.update({
                content: '❎ Variation cancelled.',
                embeds: [],
                components: [],
            });
            return;
        }

        if (customId.startsWith(IMAGE_VARIATION_PROMPT_MODAL_ID_PREFIX)) {
            const responseId = customId.slice(
                IMAGE_VARIATION_PROMPT_MODAL_ID_PREFIX.length
            );
            const session = getVariationSession(
                interaction.user.id,
                responseId
            );
            if (!session) {
                await interaction.reply({
                    content:
                        '⚠️ That variation configurator expired. Press the variation button again.',
                    flags: [1 << 6], // [1 << 6] = EPHEMERAL
                });
                return;
            }

            await interaction.showModal(
                buildPromptModal(responseId, session.prompt)
            );
            return;
        }

        if (customId.startsWith(IMAGE_VARIATION_CUSTOM_ID_PREFIX)) {
            const followUpResponseId = customId.slice(
                IMAGE_VARIATION_CUSTOM_ID_PREFIX.length
            );
            if (!followUpResponseId) {
                await interaction.reply({
                    content: '⚠️ I could not determine which image to vary.',
                    flags: [1 << 6], // [1 << 6] = EPHEMERAL
                });
                return;
            }

            let cachedContext = readFollowUpContext(followUpResponseId);

            if (!cachedContext) {
                try {
                    const recovered = await recoverContextFromMessage(
                        interaction.message
                    );
                    if (recovered) {
                        cachedContext = recovered;
                        saveFollowUpContext(followUpResponseId, recovered);
                    }
                } catch (error) {
                    logger.error(
                        'Failed to recover cached context for variation button:' +
                            error
                    );
                }
            }

            if (!cachedContext) {
                await interaction.reply({
                    content:
                        '⚠️ Sorry, I can no longer create a variation for that image. Please run /image again.',
                    flags: [1 << 6], // [1 << 6] = EPHEMERAL
                });
                return;
            }

            cachedContext.originalPrompt =
                cachedContext.originalPrompt ?? cachedContext.prompt;
            cachedContext.refinedPrompt = cachedContext.refinedPrompt ?? null;
            saveFollowUpContext(followUpResponseId, cachedContext);

            const session = initialiseVariationSession(
                interaction.user.id,
                followUpResponseId,
                cachedContext
            );

            await interaction.deferReply({ flags: [1 << 6] });
            const view = buildVariationConfiguratorView(session, {
                statusMessage: buildVariationStatusMessage(interaction.user.id),
            });
            await interaction.editReply(view);
            const storedSession = setVariationSessionUpdater(
                interaction.user.id,
                followUpResponseId,
                (options) => interaction.editReply(options)
            );
            if (!storedSession) {
                logger.warn(
                    'Failed to store variation configurator updater: session missing after initialisation.'
                );
            }

            return;
        }

        // Other button handlers fall through to the retry logic below.
        if (customId.startsWith(IMAGE_RETRY_CUSTOM_ID_PREFIX)) {
            const retryKey = interaction.customId.slice(
                IMAGE_RETRY_CUSTOM_ID_PREFIX.length
            );
            if (!retryKey) {
                await interaction.reply({
                    content: '⚠️ I could not find that image request to retry.',
                    flags: [1 << 6], // [1 << 6] = EPHEMERAL
                });
                return;
            }

            const cachedContext = readFollowUpContext(retryKey);
            if (!cachedContext) {
                await interaction.reply({
                    content:
                        '⚠️ Sorry, that retry expired. Please ask me to generate a new image.',
                    flags: [1 << 6], // [1 << 6] = EPHEMERAL
                });
                return;
            }

            const isDeveloper =
                interaction.user.id === runtimeConfig.developerUserId;
            let retrySpend = null as ReturnType<
                typeof consumeImageTokens
            > | null;
            if (!isDeveloper) {
                const spendResult = consumeImageTokens(
                    interaction.user.id,
                    cachedContext.quality,
                    cachedContext.imageModel
                );
                if (!spendResult.allowed) {
                    const message = `${describeTokenAvailability(cachedContext.quality, spendResult, cachedContext.imageModel)}\n\n${buildTokenSummaryLine(interaction.user.id)}`;
                    const countdown = spendResult.refreshInSeconds;
                    const retryRow =
                        countdown > 0
                            ? createRetryButtonRow(
                                  retryKey,
                                  formatRetryCountdown(countdown)
                              )
                            : undefined;
                    try {
                        await interaction.update({
                            content: message,
                            components: retryRow ? [retryRow] : [],
                        });
                    } catch {
                        await interaction.reply({
                            content: message,
                            flags: [1 << 6], // [1 << 6] = EPHEMERAL
                            components: retryRow ? [retryRow] : [],
                        });
                    }
                    return;
                }

                retrySpend = spendResult;
            }

            await interaction.deferReply();

            try {
                await interaction.message
                    .edit({ components: [] })
                    .catch(() => undefined);

                const artifacts = await executeImageGeneration(cachedContext, {
                    user: {
                        username: interaction.user.username,
                        nickname: resolveMemberDisplayName(
                            interaction.member,
                            interaction.user.username
                        ),
                        guildName:
                            interaction.guild?.name ??
                            `No guild for ${interaction.type} interaction`,
                    },
                });

                const presentation = buildImageResultPresentation(
                    cachedContext,
                    artifacts
                );

                if (artifacts.responseId) {
                    saveFollowUpContext(
                        artifacts.responseId,
                        presentation.followUpContext
                    );
                }
                evictFollowUpContext(retryKey);

                await interaction.editReply({
                    content: presentation.content,
                    embeds: [presentation.embed],
                    files: presentation.attachments,
                    attachments: [],
                    components: presentation.components,
                });
            } catch (error) {
                if (retrySpend) {
                    refundImageTokens(interaction.user.id, retrySpend.cost);
                }
                logger.error(
                    'Unexpected error while handling image retry button: ' +
                        error
                );
                try {
                    await interaction.editReply({
                        content:
                            '⚠️ I was unable to generate that image. Please try again later.',
                        components: [],
                    });
                } catch (replyError) {
                    logger.error(
                        'Failed to send retry failure message: ' + replyError
                    );
                }
            }

            return;
        }
    }
});

// ====================
// Handle Uncaught Exceptions
// ====================
process.on('unhandledRejection', (error: Error) => {
    logger.error(`Unhandled promise rejection: ${error}`);
});

process.on('uncaughtException', (error: Error) => {
    logger.error(`Uncaught exception: ${error}`);
    process.exit(1);
});
