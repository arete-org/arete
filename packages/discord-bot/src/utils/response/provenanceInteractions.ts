/**
 * @description: Handles provenance footer interactions, lenses, and trace lookups.
 * @arete-scope: interface
 * @arete-module: ProvenanceInteractions
 * @arete-risk: moderate - Interaction failures can block provenance navigation.
 * @arete-ethics: high - Provenance access affects user trust and accountability.
 */
import type {
  ButtonInteraction,
  InteractionReplyOptions,
  Message,
  ModalSubmitInteraction,
  StringSelectMenuInteraction,
  GuildMember,
  APIInteractionGuildMember
} from 'discord.js';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle
} from 'discord.js';
import type { ResponseMetadata, Citation } from '@arete/backend/ethics-core';
import { logger } from '../logger.js';
import { ResponseHandler } from './ResponseHandler.js';
import { OpenAIService, type OpenAIMessage, type OpenAIOptions, type SupportedModel } from '../openaiService.js';
import { config, renderPrompt } from '../env.js';
import { Planner } from '../prompting/Planner.js';

export type AlternativeLensKey =
  | 'DANEEL'
  | 'UTILITARIAN'
  | 'DEONTOLOGICAL'
  | 'VIRTUE_ETHICS'
  | 'EASTERN'
  | 'CUSTOM';

export interface AlternativeLensDefinition {
  key: AlternativeLensKey;
  label: string;
  description: string;
  requiresCustomDescription?: boolean;
}

export interface AlternativeLensContext {
  /**
   * Raw text of the assistant message to reinterpret.
   */
  messageText: string;
  /**
   * Persisted provenance metadata for the message, when available.
   */
  metadata: ResponseMetadata | null;
  /**
   * Discord message identifier associated with the provenance footer.
   * Useful when posting follow-up replies.
   */
  messageId: string;
  /**
   * Discord channel identifier where the interaction took place.
   */
  channelId: string;
  /**
   * Stored response identifier, if it could be recovered from the footer.
   */
  responseId?: string;
}

export interface AlternativeLensSession {
  context: AlternativeLensContext;
  selectedLensKey: AlternativeLensKey | null;
  customDescription: string | null;
}

type LensTelemetryInteraction = ButtonInteraction | StringSelectMenuInteraction;
type AlternativeLensAction = 'alt_lens:init' | 'alt_lens:select' | 'alt_lens:submit';

// -----------------------------
// Lens catalogue configuration
// -----------------------------
const LENS_DEFINITIONS: AlternativeLensDefinition[] = [
  {
    key: 'DANEEL',
    label: 'Asimovian (Daneel character)',
    description: 'Channel Daneel Olivaw: state clean facts, guard human welfare, and apply Zeroth Law judgment.'
  },
  {
    key: 'UTILITARIAN',
    label: 'Utilitarian',
    description: 'Prioritise overall outcomes and collective wellbeing.'
  },
  {
    key: 'DEONTOLOGICAL',
    label: 'Deontological',
    description: 'Emphasise duties, rules, and principled obligations.'
  },
  {
    key: 'VIRTUE_ETHICS',
    label: 'Virtue Ethics',
    description: 'Highlight character, cultivation of virtues, and moral exemplars.'
  },
  {
    key: 'EASTERN',
    label: 'Eastern Philosophy',
    description: 'Incorporate perspectives rooted in Confucian, Buddhist, or Daoist thought.'
  },
  {
    key: 'CUSTOM',
    label: 'Custom Lens',
    description: 'Provide your own framing or perspective.',
    requiresCustomDescription: true
  }
];

const provenanceLogger = logger.child({ module: 'provenance' });

export const ALTERNATIVE_LENS_SELECT_PREFIX = 'alt_lens_select:';
export const ALTERNATIVE_LENS_SUBMIT_PREFIX = 'alt_lens_submit:';
export const ALTERNATIVE_LENS_MODAL_PREFIX = 'alt_lens_custom_modal:';
export const ALT_LENS_CUSTOM_DESCRIPTION_INPUT_ID = 'alt_lens_custom_description';

export const buildAlternativeLensSessionKey = (userId: string, messageId: string) => `${userId}:${messageId}`;
export const buildExplainSessionKey = (messageId: string) => `explain:${messageId}`;

// -----------------------------
// Session lifecycle helpers
// -----------------------------
const sessions = new Map<string, AlternativeLensSession>();
const explainInProgress = new Set<string>();
const alternativeLensInProgress = new Set<string>();

export function resolveMemberDisplayName(
  member: GuildMember | APIInteractionGuildMember | null | undefined,
  fallback: string
): string {
  if (!member) {
    return fallback;
  }

  if ('displayName' in member && typeof member.displayName === 'string' && member.displayName.length > 0) {
    return member.displayName;
  }

  if ('nickname' in member && typeof member.nickname === 'string' && member.nickname.length > 0) {
    return member.nickname;
  }
  
  if ('nick' in member && typeof member.nick === 'string' && member.nick.length > 0) {
    return member.nick;
  }

  if ('user' in member && member.user && typeof member.user.username === 'string') {
    return member.user.username;
  }

  return fallback;
}

export function isExplainInProgress(key: string): boolean {
  return explainInProgress.has(key);
}

export function markExplainInProgress(key: string): void {
  explainInProgress.add(key);
}

export function clearExplainInProgress(key: string): void {
  explainInProgress.delete(key);
}

export function isAlternativeLensInProgress(key: string): boolean {
  return alternativeLensInProgress.has(key);
}

export function markAlternativeLensInProgress(key: string): void {
  alternativeLensInProgress.add(key);
}

export function clearAlternativeLensInProgress(key: string): void {
  alternativeLensInProgress.delete(key);
}

export function getAlternativeLensDefinitions(): AlternativeLensDefinition[] {
  return LENS_DEFINITIONS.slice();
}

export function getAlternativeLensDefinition(key: AlternativeLensKey): AlternativeLensDefinition | undefined {
  return LENS_DEFINITIONS.find(lens => lens.key === key);
}

export function createAlternativeLensSession(sessionKey: string, context: AlternativeLensContext): AlternativeLensSession {
  const session: AlternativeLensSession = {
    context,
    selectedLensKey: null,
    customDescription: null
  };
  sessions.set(sessionKey, session);
  return session;
}

export function getAlternativeLensSession(sessionKey: string): AlternativeLensSession | undefined {
  return sessions.get(sessionKey);
}

export function setAlternativeLensSelection(sessionKey: string, lensKey: AlternativeLensKey): AlternativeLensSession | undefined {
  const session = sessions.get(sessionKey);
  if (!session) {
    return undefined;
  }

  session.selectedLensKey = lensKey;
  if (lensKey !== 'CUSTOM') {
    session.customDescription = null;
  }
  return session;
}

export function setAlternativeLensCustomDescription(sessionKey: string, description: string): AlternativeLensSession | undefined {
  const session = sessions.get(sessionKey);
  if (!session) {
    return undefined;
  }

  session.customDescription = description.trim();
  return session;
}

export function clearAlternativeLensSession(sessionKey: string): void {
  sessions.delete(sessionKey);
}

/**
 * 
 * @param interaction - The Discord component that triggered the event.
 * @param action - The provenance action identifier.
 * @param responseId - Provenance response ID to associate with the metadata.
 * @param extra - Additional context to include in the log entry.
 * @returns - A structured log context object.
 */
function buildAlternativeLensLogContext(
  interaction: LensTelemetryInteraction,
  action: AlternativeLensAction,
  responseId?: string,
  extra?: Record<string, unknown>
): Record<string, unknown> {
  return {
    action,
    userId: interaction.user.id,
    guildId: interaction.guild?.id ?? null,
    channelId: interaction.channelId ?? null,
    messageId: interaction.message.id,
    ...(responseId ? { responseId } : {}),
    ...extra
  };
}

export function buildLensPayload(session: AlternativeLensSession): {
  key: AlternativeLensKey;
  label: string;
  description: string;
} | null {
  if (!session.selectedLensKey) {
    return null;
  }

  const definition = getAlternativeLensDefinition(session.selectedLensKey);
  if (!definition) {
    return null;
  }

  if (definition.key === 'CUSTOM') {
    if (!session.customDescription) {
      return null;
    }
    return {
      key: definition.key,
      label: definition.label,
      description: session.customDescription
    };
  }

  return {
    key: definition.key,
    label: definition.label,
    description: definition.description
  };
}

export interface AlternativeLensGenerationContext {
  messageText: string;
  metadata: ResponseMetadata | null;
  channelId?: string;
}

export interface AlternativeLensPayload {
  key: AlternativeLensKey;
  label: string;
  description: string;
}

export interface ExplanationContext {
  messageText: string;
  confidence?: number;
  tradeoffCount?: number;
  chainHash?: string;
  reasoningTrace?: string;
  channelId?: string;
}

const DEFAULT_ALT_LENS_MODEL: SupportedModel = 'gpt-5-mini';

// -----------------------------
// Lens message generation
// -----------------------------
/**
 * Calls OpenAI to rewrite the original assistant message using the requested lens.
 * Includes provenance metadata so the model can reference trade-offs and citations when useful.
 */
export async function generateAlternativeLensMessage(
  openaiService: OpenAIService,
  context: AlternativeLensGenerationContext,
  lens: AlternativeLensPayload,
  openaiOptions?: OpenAIOptions
): Promise<string> {
  const baseSystemPrompt = renderPrompt('discord.chat.system').content;
  const systemPromptLines = [
    'You are an ethics editor who rewrites assistant responses using a specified philosophical or cultural lens.',
    'Preserve factual accuracy and original intent while foregrounding the requested perspective.',
    'Respond in natural markdown with no JSON, tool calls, or metadata markers (like <ARETE_METADATA>).'
  ];
  const metadataSummary = formatMetadataSummary(context.metadata);
  const userPromptSections = [
    `Selected lens: ${lens.label}`,
    `Lens guidance: ${lens.description}`,
    `Provenance summary:\n${metadataSummary}`,
    'Original assistant response:',
    context.messageText
  ];

  const messages: OpenAIMessage[] = [
    { role: 'system', content: `${baseSystemPrompt}\n\n${systemPromptLines.join(' ')}`.trim() },
    { role: 'user', content: userPromptSections.join('\n\n') }
  ];

  const requestOptions: OpenAIOptions = {
    reasoningEffort: 'low',
    verbosity: 'medium',
    ...(openaiOptions ?? {})
  };

  const response = await openaiService.generateResponse(
    DEFAULT_ALT_LENS_MODEL,
    messages,
    {
      ...requestOptions,
      channelContext:
        requestOptions.channelContext ??
        (context.channelId
          ? { channelId: context.channelId, guildId: undefined }
          : undefined)
    }
  );

  const text = response.message?.content?.trim();
  if (!text) {
    throw new Error('The model returned an empty alternative lens response.');
  }

  return text;
}

// -----------------------------
// Explanation generation
// -----------------------------
/**
 * Summarises the reasoning behind the assistant's prior reply so users understand how the answer was produced.
 */
export async function generateExplanationMessage(
  openaiService: OpenAIService,
  context: ExplanationContext,
  openaiOptions?: OpenAIOptions
): Promise<string> {
  const baseSystemPrompt = renderPrompt('discord.chat.system').content;
  const metadataLines: string[] = [];

  if (typeof context.confidence === 'number') {
    metadataLines.push(`Reported confidence: ${(context.confidence * 100).toFixed(0)}%`);
  }
  if (typeof context.tradeoffCount === 'number') {
    metadataLines.push(`Trade-offs noted: ${context.tradeoffCount}`);
  }
  if (context.chainHash) {
    metadataLines.push(`Chain hash: ${context.chainHash}`);
  }

  const systemPrompt = [
    'You are an ethics-focused analyst who describes the reasoning behind an assistant reply.',
    'Deliver a clear, factual explanation without inventing new commitments or policies.',
    'Highlight risk, uncertainty, and trade-offs when relevant.'
  ].join(' ');

  const userSections = [
    'Summarise the key reasoning steps that produced the assistant response shown below.',
    'Do not repeat the entire answer; focus on rationale, evidence, and any safeguards or trade-offs.',
    'Keep the explanation under eight sentences.',
    metadataLines.length > 0 ? `Assistant metadata:\n- ${metadataLines.join('\n- ')}` : null,
    context.reasoningTrace ? `Internal reasoning trace:\n${context.reasoningTrace}` : null,
    `Assistant reply:\n${context.messageText}`
  ].filter(Boolean);

  const messages: OpenAIMessage[] = [
    { role: 'system', content: `${baseSystemPrompt}\n\n${systemPrompt}`.trim() },
    { role: 'user', content: userSections.join('\n\n') }
  ];

  const requestOptions: OpenAIOptions = {
    reasoningEffort: 'low',
    verbosity: 'medium',
    ...(openaiOptions ?? {})
  };

  const response = await openaiService.generateResponse(
    DEFAULT_ALT_LENS_MODEL,
    messages,
    {
      ...requestOptions,
      channelContext:
        requestOptions.channelContext ??
        (context.channelId
          ? { channelId: context.channelId, guildId: undefined }
          : undefined)
    }
  );

  const text = response.message?.content?.trim();
  if (!text) {
    throw new Error('The model returned an empty explanation response.');
  }

  return text;
}

type PlannerRequest =
  | {
      kind: 'alternative_lens';
      messageText: string;
      lens: AlternativeLensPayload;
      metadata: ResponseMetadata | null;
    }
  | {
      kind: 'explain';
      messageText: string;
      metadata: ResponseMetadata | null;
      reasoningTrace?: string;
    };

export async function requestProvenanceOpenAIOptions(
  openaiService: OpenAIService,
  request: PlannerRequest
): Promise<OpenAIOptions | undefined> {
  try {
    const planner = new Planner(openaiService);
    const baseSystemPrompt = renderPrompt('discord.chat.system').content;

    const context: OpenAIMessage[] = [
      { role: 'system', content: baseSystemPrompt },
      { role: 'assistant', content: request.messageText }
    ];

    const instructions: string[] = [
      'A user clicked a provenance control. Recommend OpenAI options (reasoning effort, verbosity, etc.) for the follow-up response.'
    ];

    if (request.kind === 'alternative_lens') {
      instructions.push(
        `Task: Reframe the assistant response using the "${request.lens.label}" perspective.`,
        `Lens guidance: ${request.lens.description}`
      );
      if (request.metadata) {
        instructions.push(`Provenance metadata:\n${formatMetadataSummary(request.metadata)}`);
      }
    } else {
      instructions.push('Task: Provide a concise explanation of the reasoning behind the assistant’s previous response.');
      if (request.metadata) {
        instructions.push(`Provenance metadata:\n${formatMetadataSummary(request.metadata)}`);
      }
      if (request.reasoningTrace) {
        instructions.push(`Internal reasoning trace:\n${request.reasoningTrace}`);
      }
    }

    context.push({ role: 'user', content: instructions.join('\n\n') });

    const plan = await planner.generatePlan(context, `provenance-${request.kind}`);
    return plan.openaiOptions;
  } catch (error) {
    logger.warn('Failed to retrieve planner options for provenance interaction:', error);
    return undefined;
  }
}

function formatMetadataSummary(metadata: ResponseMetadata | null): string {
  if (!metadata) {
    return 'Metadata unavailable; focus on the lens reinterpretation using the supplied text.';
  }

  const confidencePercent = Number.isFinite(metadata.confidence)
    ? `${Math.round(metadata.confidence * 100)}%`
    : 'Unknown';

  const baseLines = [
    `Response ID: ${metadata.responseId}`,
    `Provenance: ${metadata.provenance}`,
    `Confidence: ${confidencePercent}`,
    `Risk tier: ${metadata.riskTier}`,
    `Trade-offs noted: ${metadata.tradeoffCount}`
  ];

  if (metadata.citations.length > 0) {
    const citationSummaries = metadata.citations.map((citation: Citation) => `${citation.title} (${citation.url.toString()})`);
    baseLines.push(`Citations: ${citationSummaries.join('; ')}`);
  } else {
    baseLines.push('Citations: None supplied by the original response.');
  }

  return baseLines.join('\n');
}

// -----------------------------
// Metadata and message recovery
// -----------------------------
export function extractResponseIdFromFooterText(footerText?: string | null): string | null {
  if (!footerText) {
    return null;
  }

  const match = footerText.match(/^([\w.-]+)\W+([\w.-]+)\W+([\w-]+)\W+/);
  return match?.[3] ?? null;
}

export function deriveResponseIdFromMessage(message: Message | null): string | null {
  if (!message) {
    return null;
  }

  for (const embed of message.embeds ?? []) {
    const responseId = extractResponseIdFromFooterText(embed.footer?.text);
    if (responseId) {
      return responseId;
    }
  }

  return null;
}

export async function resolveProvenanceMetadata(message: Message): Promise<{ responseId?: string; metadata: ResponseMetadata | null }> {
  const responseId = deriveResponseIdFromMessage(message);
  if (!responseId) {
    return { metadata: null };
  }

  try {
    const response = await fetch(`${config.backendBaseUrl}/trace/${responseId}.json`);
    if (!response.ok) {
      logger.warn(`Failed to load provenance metadata for response ${responseId}: HTTP ${response.status}`);
      return { responseId, metadata: null };
    }
    const metadata = (await response.json()) as ResponseMetadata;
    return { responseId, metadata };
  } catch (error) {
    logger.warn(`Failed to load provenance metadata for response ${responseId}:`, error);
    return { responseId, metadata: null };
  }
}

export async function recoverFullMessageText(message: Message): Promise<string> {
  const directContent = message.content?.trim();
  if (directContent) {
    return directContent;
  }

  const referencedId = message.reference?.messageId;
  if (referencedId && message.channel.isTextBased()) {
    try {
      const referenced = await message.channel.messages.fetch(referencedId);
      if (referenced?.content?.trim()) {
        return referenced.content.trim();
      }
    } catch (error) {
      logger.warn(`Failed to fetch referenced message ${referencedId} while preparing alternative lens:`, error);
    }
  }

  return '';
}

// -----------------------------
// Interaction handlers
// -----------------------------
export async function handleAlternativeLensButton(interaction: ButtonInteraction): Promise<void> {
  const baseContext = buildAlternativeLensLogContext(interaction, 'alt_lens:init');
  let telemetryContext = baseContext;
  provenanceLogger.info('Alternative lens init started', { ...telemetryContext, phase: 'start' });

  try {
    const messageText = await recoverFullMessageText(interaction.message);
    if (!messageText) {
      provenanceLogger.error('Alternative lens init failed (missing message text)', {
        ...telemetryContext,
        phase: 'error',
        reason: 'missing_message_text'
      });
      await interaction.reply({
        content: 'I could not find the response text to reinterpret. Please try again from the original message.',
        flags: [1 << 6]
      });
      return;
    }

    // Prime session state with the text + metadata snapshot from the original response.
    const { responseId, metadata } = await resolveProvenanceMetadata(interaction.message);
    if (responseId) {
      telemetryContext = buildAlternativeLensLogContext(interaction, 'alt_lens:init', responseId);
    }
    const sessionKey = buildAlternativeLensSessionKey(interaction.user.id, interaction.message.id);
    clearAlternativeLensSession(sessionKey);
    createAlternativeLensSession(sessionKey, {
      messageText,
      metadata,
      messageId: interaction.message.id,
      channelId: interaction.message.channelId,
      responseId
    });

    const selectOptions = getAlternativeLensDefinitions();
    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId(`${ALTERNATIVE_LENS_SELECT_PREFIX}${interaction.message.id}`)
      .setPlaceholder('Choose a lens')
      .addOptions(
        selectOptions.map(option =>
          new StringSelectMenuOptionBuilder()
            .setLabel(option.label)
            .setValue(option.key)
            .setDescription(
              option.description.length > 100 ? `${option.description.slice(0, 97)}...` : option.description
            )
        )
      );

    const selectRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);
    const submitRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${ALTERNATIVE_LENS_SUBMIT_PREFIX}${interaction.message.id}`)
        .setLabel('Submit')
        .setStyle(ButtonStyle.Primary)
    );

    await interaction.reply({
      content: 'Pick a perspective to reframe this answer. Selecting "Custom Lens" will prompt for details.',
      components: [selectRow, submitRow],
      flags: [1 << 6]
    } satisfies InteractionReplyOptions);
    provenanceLogger.info('Alternative lens init completed', { ...telemetryContext, phase: 'success' });
  } catch (error) {
    provenanceLogger.error('Alternative lens init error', {
      ...telemetryContext,
      phase: 'error',
      reason: 'initialisation_failed',
      error
    });
    const replyOptions: InteractionReplyOptions = {
      content: 'Something went wrong while starting the alternative lens flow. Please try again later.',
      flags: [1 << 6]
    };

    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(replyOptions);
    } else {
      await interaction.reply(replyOptions);
    }
  }
}

export async function handleAlternativeLensSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  const baseContext = buildAlternativeLensLogContext(interaction, 'alt_lens:select');
  let telemetryContext = baseContext;
  provenanceLogger.info('Alternative lens select started', { ...telemetryContext, phase: 'start' });

  try {
    const { customId, values } = interaction;
    const selected = values?.[0];

    if (!selected) {
      provenanceLogger.error('Alternative lens select failed (no selection)', {
        ...telemetryContext,
        phase: 'error',
        reason: 'no_selection'
      });
      await interaction.deferUpdate();
      return;
    }

    const messageId = customId.slice(ALTERNATIVE_LENS_SELECT_PREFIX.length);
    const lensDefinition = getAlternativeLensDefinition(selected as AlternativeLensKey);

    if (!lensDefinition) {
      provenanceLogger.error('Alternative lens select failed (unknown lens)', {
        ...telemetryContext,
        phase: 'error',
        reason: 'unknown_lens',
        lensKey: selected
      });
      await interaction.reply({
        content: 'That lens is no longer available. Please choose a different option.',
        flags: [1 << 6]
      });
      return;
    }

    const sessionKey = buildAlternativeLensSessionKey(interaction.user.id, messageId);
    const session = setAlternativeLensSelection(sessionKey, lensDefinition.key);
    if (!session) {
      provenanceLogger.error('Alternative lens select failed (session expired)', {
        ...telemetryContext,
        phase: 'error',
        reason: 'session_expired',
        lensKey: lensDefinition.key
      });
      await interaction.reply({
        content: 'That alternative lens session expired. Click **Alternative Lens** again to restart.',
        flags: [1 << 6]
      });
      return;
    }

    if (session.context.responseId) {
      telemetryContext = buildAlternativeLensLogContext(interaction, 'alt_lens:select', session.context.responseId);
    }

    if (lensDefinition.requiresCustomDescription) {
      const input = new TextInputBuilder()
        .setCustomId(ALT_LENS_CUSTOM_DESCRIPTION_INPUT_ID)
        .setLabel('Describe the custom lens')
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('Explain the perspective you want to apply.')
        .setMinLength(10)
        .setMaxLength(500);

      if (session.customDescription) {
        input.setValue(session.customDescription);
      }

      const modal = new ModalBuilder()
        .setCustomId(`${ALTERNATIVE_LENS_MODAL_PREFIX}${messageId}`)
        .setTitle('Custom Lens Details')
        .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));

      await interaction.showModal(modal);
      provenanceLogger.info('Alternative lens select completed', {
        ...telemetryContext,
        phase: 'success',
        lensKey: lensDefinition.key,
        mode: 'modal_prompt'
      });
      return;
    }

    await interaction.deferUpdate();
    provenanceLogger.info('Alternative lens select completed', {
      ...telemetryContext,
      phase: 'success',
      lensKey: lensDefinition.key
    });
  } catch (error) {
    provenanceLogger.error('Alternative lens select error', {
      ...telemetryContext,
      phase: 'error',
      reason: 'selection_failed',
      error
    });
    if (!interaction.deferred && !interaction.replied) {
      await interaction.reply({
        content: 'Something went wrong while updating the alternative lens selection. Please try again later.',
        flags: [1 << 6]
      }).catch(() => undefined);
    }
  }
}

export async function handleAlternativeLensModal(interaction: ModalSubmitInteraction): Promise<void> {
  const messageId = interaction.customId.slice(ALTERNATIVE_LENS_MODAL_PREFIX.length);
  const sessionKey = buildAlternativeLensSessionKey(interaction.user.id, messageId);
  const session = getAlternativeLensSession(sessionKey);

  if (!session) {
    await interaction.reply({
      content: 'That alternative lens session expired. Click **Alternative Lens** again to restart.',
      flags: [1 << 6]
    });
    return;
  }

  const description = interaction.fields.getTextInputValue(ALT_LENS_CUSTOM_DESCRIPTION_INPUT_ID).trim();
  if (!description) {
    await interaction.reply({
      content: 'Please describe your custom lens before submitting.',
      flags: [1 << 6]
    });
    return;
  }

  setAlternativeLensSelection(sessionKey, 'CUSTOM');
  setAlternativeLensCustomDescription(sessionKey, description);
  await interaction.reply({
    content: 'Custom lens saved. Press Submit when you are ready to generate the alternative perspective.',
    flags: [1 << 6]
  });
}

export async function handleAlternativeLensSubmit(interaction: ButtonInteraction, openaiService: OpenAIService): Promise<void> {
  const baseContext = buildAlternativeLensLogContext(interaction, 'alt_lens:submit');
  let telemetryContext = baseContext;
  provenanceLogger.info('Alternative lens submit started', { ...telemetryContext, phase: 'start' });

  const messageId = interaction.customId.slice(ALTERNATIVE_LENS_SUBMIT_PREFIX.length);
  const sessionKey = buildAlternativeLensSessionKey(interaction.user.id, messageId);
  const session = getAlternativeLensSession(sessionKey);

  if (!session) {
    provenanceLogger.error('Alternative lens submit failed (session expired)', {
      ...telemetryContext,
      phase: 'error',
      reason: 'session_expired'
    });
    await interaction.reply({
      content: 'That alternative lens session expired. Click **Alternative Lens** again to start over.',
      flags: [1 << 6]
    });
    return;
  }

  if (session.context.responseId) {
    telemetryContext = buildAlternativeLensLogContext(interaction, 'alt_lens:submit', session.context.responseId);
  }

  if (!session.context.messageText) {
    clearAlternativeLensSession(sessionKey);
    provenanceLogger.error('Alternative lens submit failed (missing message text)', {
      ...telemetryContext,
      phase: 'error',
      reason: 'missing_message_text'
    });
    await interaction.reply({
      content: 'The original response is no longer available for reinterpretation. Start a new alternative lens request.',
      flags: [1 << 6]
    });
    return;
  }

  const lens = buildLensPayload(session);
  if (!lens) {
    provenanceLogger.error('Alternative lens submit failed (lens not selected)', {
      ...telemetryContext,
      phase: 'error',
      reason: 'missing_lens'
    });
    await interaction.reply({
      content: 'Select a lens first. If you choose Custom Lens, provide a description before submitting.',
      flags: [1 << 6]
    });
    return;
  }

  if (isAlternativeLensInProgress(messageId)) {
    provenanceLogger.error('Alternative lens submit failed (already in progress)', {
      ...telemetryContext,
      phase: 'error',
      reason: 'in_progress'
    });
    await interaction.reply({
      content: '⚠️ An alternative lens is already being generated for this response. Please wait for it to finish.',
      flags: [1 << 6]
    });
    return;
  }

  markAlternativeLensInProgress(messageId);

  const requester = resolveMemberDisplayName(interaction.member, interaction.user.username);
  const lensDescription = lens.description?.trim() ?? '';
  const lensDetails = lensDescription ? `\n> ${lensDescription}` : '';
  const progressContent = `⏳ Alternative lens requested by **${requester}** — **${lens.label}**${lensDetails}\nGenerating response…`;

  try {
    await interaction.reply({
      content: progressContent,
      allowedMentions: { parse: [] }
    });
  } catch (error) {
    clearAlternativeLensInProgress(messageId);
    provenanceLogger.error('Alternative lens submit failed (acknowledgement error)', {
      ...telemetryContext,
      phase: 'error',
      reason: 'ack_failed',
      error
    });
    if (!interaction.replied) {
      await interaction.followUp({
        content: 'I could not begin generating that alternative lens. Please try again.',
        flags: [1 << 6]
      }).catch(() => undefined);
    }
    return;
  }

  try {
    const plannerOptions = await requestProvenanceOpenAIOptions(openaiService, {
      kind: 'alternative_lens',
      messageText: session.context.messageText,
      lens,
      metadata: session.context.metadata
    });

    const generated = await generateAlternativeLensMessage(
      openaiService,
      {
        messageText: session.context.messageText,
        metadata: session.context.metadata,
        channelId: session.context.channelId
      },
      lens,
      plannerOptions
    );

    const channel = interaction.channel;
    if (!channel || !channel.isSendable()) {
      provenanceLogger.error('Alternative lens submit failed (unsendable channel)', {
        ...telemetryContext,
        phase: 'error',
        reason: 'unsendable_channel'
      });
      await interaction.editReply({
        content: 'I could not post the alternative lens response in this channel.'
      });
      return;
    }

    const customNote = lens.key === 'CUSTOM' && lensDescription ? `\n> Custom guidance: ${lensDescription}` : '';
    const combinedContent = `**Alternative Lens: ${lens.label}**${customNote}\n\n${generated.trim()}`;
    let targetMessage: Message | null = null;

    if (channel.isTextBased()) {
      try {
        targetMessage = await channel.messages.fetch(session.context.messageId);
      } catch (fetchError) {
        logger.warn(
          `Failed to fetch original message ${session.context.messageId} for alternative lens reply:`,
          fetchError
        );
      }
    }

    if (targetMessage) {
      const responseHandler = new ResponseHandler(targetMessage, channel, interaction.user);
      await responseHandler.sendMessage(combinedContent, [], true, true);
    } else {
      // If the original message cannot be fetched, fall back to responding directly to the interaction message.
      const fallbackHandler = new ResponseHandler(interaction.message as Message, channel, interaction.user);
      await fallbackHandler.sendMessage(combinedContent, [], true, true);
    }

    const completionSummary = lensDescription
      ? `✅ Posted alternative lens (${lens.label} — ${lensDescription}).`
      : `✅ Posted alternative lens (${lens.label}).`;
    await interaction.editReply({ content: completionSummary });
    provenanceLogger.info('Alternative lens submit completed', {
      ...telemetryContext,
      phase: 'success',
      lensKey: lens.key
    });
  } catch (error) {
    provenanceLogger.error('Alternative lens submit error', {
      ...telemetryContext,
      phase: 'error',
      reason: 'generation_failed',
      error
    });
    await interaction.editReply({
      content: 'I could not generate that alternative lens. Please try again later.'
    });
  } finally {
    clearAlternativeLensSession(sessionKey);
    clearAlternativeLensInProgress(messageId);
  }
}


