/**
 * @arete-module: MessageProcessor
 * @arete-risk: high
 * @arete-ethics: high
 * @arete-scope: core
 *
 * @description: Core message processing and AI response generation. Handles message analysis, AI model selection, and response generation.
 *
 * @impact
 * Risk: Processing failures can break all user interactions or generate inappropriate content. Orchestrates the entire message-to-response pipeline including context building, planning, and response delivery.
 * Ethics: Controls AI response generation and content filtering. Manages model selection, prompt construction, response validation, and provenance tracking. All processing is logged and cost-tracked for transparency.
 */

import fs from 'fs';
import * as path from 'path';
import { Message } from 'discord.js';
import { OpenAIService, SupportedModel, TTSOptions } from './openaiService.js';
import { logger } from './logger.js';
import { ResponseHandler } from './response/ResponseHandler.js';
import { RateLimiter } from './RateLimiter.js';
import { config } from './env.js';
import { Planner, Plan } from './prompting/Planner.js';
import { TTS_DEFAULT_OPTIONS } from './openaiService.js';
import { ContextBuilder } from './prompting/ContextBuilder.js';
import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_IMAGE_OUTPUT_COMPRESSION,
  DEFAULT_IMAGE_OUTPUT_FORMAT,
  DEFAULT_IMAGE_QUALITY,
  DEFAULT_TEXT_MODEL,
  PROMPT_ADJUSTMENT_MIN_REMAINING_RATIO,
  EMBED_FIELD_VALUE_LIMIT
} from '../commands/image/constants.js';
import { resolveAspectRatioSettings } from '../commands/image/aspect.js';
import {
  buildImageResultPresentation,
  clampPromptForContext,
  executeImageGeneration
} from '../commands/image/sessionHelpers.js';
import { readFollowUpContext, saveFollowUpContext, type ImageGenerationContext } from '../commands/image/followUpCache.js';
import { recoverContextDetailsFromMessage, type RecoveredImageContext } from '../commands/image/contextResolver.js';
import { buildResponseMetadata } from './response/metadata.js';
import { buildFooterEmbed } from './response/provenanceFooter.js';
import type { ResponseMetadata } from '@arete/backend/ethics-core';
import type {
  ImageBackgroundType,
  ImageRenderModel,
  ImageStylePreset,
  ImageTextModel,
  ImageOutputFormat
} from '../commands/image/types.js';
//import { Pinecone } from '@pinecone-database/pinecone';

type MessageProcessorOptions = {
  openaiService: OpenAIService;
  planner?: Planner;
  systemPrompt?: string;
};

const MAIN_MODEL: SupportedModel = 'gpt-5.2';
const PLAN_CONTEXT_SIZE = 8;
const RESPONSE_CONTEXT_SIZE = 24;
const VALID_IMAGE_BACKGROUNDS: ImageBackgroundType[] = ['auto', 'transparent', 'opaque'];
const VALID_IMAGE_STYLES = new Set<ImageStylePreset>([
  'natural',
  'vivid',
  'photorealistic',
  'cinematic',
  'oil_painting',
  'watercolor',
  'digital_painting',
  'line_art',
  'sketch',
  'cartoon',
  'anime',
  'comic',
  'pixel_art',
  'cyberpunk',
  'fantasy_art',
  'surrealist',
  'minimalist',
  'vintage',
  'noir',
  '3d_render',
  'steampunk',
  'abstract',
  'pop_art',
  'dreamcore',
  'isometric',
  'unspecified'
]);
const clampOutputCompression = (value: number | undefined | null): number => {
  if (!Number.isFinite(value)) {
    return DEFAULT_IMAGE_OUTPUT_COMPRESSION;
  }
  return Math.min(100, Math.max(1, Math.round(value as number)));
};

let warnedMissingTraceToken = false;

export class MessageProcessor {
  private readonly openaiService: OpenAIService;
  private readonly contextBuilder: ContextBuilder;
  private readonly planner: Planner;
  private readonly rateLimiters: { user?: RateLimiter; channel?: RateLimiter; guild?: RateLimiter };
  //private readonly pineconeClient = new Pinecone({ apiKey: process.env.PINECONE_API_KEY || '' });
  //private readonly repoIndex = this.pineconeClient.index('discord-bot-code', 'discord-bot-code-v3tu03c.svc.aped-4627-b74a.pinecone.io');

  constructor(options: MessageProcessorOptions) {
    this.openaiService = options.openaiService;
    this.contextBuilder = new ContextBuilder(this.openaiService);
    this.planner = options.planner ?? new Planner(this.openaiService);

    this.rateLimiters = {};
    if (config.rateLimits.user.enabled) this.rateLimiters.user = new RateLimiter({ limit: config.rateLimits.user.limit, window: config.rateLimits.user.windowMs, scope: 'user' });
    if (config.rateLimits.channel.enabled) this.rateLimiters.channel = new RateLimiter({ limit: config.rateLimits.channel.limit, window: config.rateLimits.channel.windowMs, scope: 'channel' });
    if (config.rateLimits.guild.enabled) this.rateLimiters.guild = new RateLimiter({ limit: config.rateLimits.guild.limit, window: config.rateLimits.guild.windowMs, scope: 'guild' });
  }

  /**
   * Extracts channel context from a Discord message.
   * Used for cost tracking.
   * @param message - The Discord message
   * @returns {channelId: string, guildId?: string} - Channel context object with channelId and optional guildId
   */
  private getChannelGuildIdsFromMessage(message: Message): { channelId: string; guildId?: string } {
    return {
      channelId: message.channelId,
      guildId: message.guildId ?? undefined
    };
  }

  /**
   * 
   * Processes a message and generates a response based on the plan generated by the planner.
   * @param {Message} message - The message to process
   */
  public async processMessage(message: Message, directReply: boolean = true, trigger: string = ''): Promise<void> {
    const responseHandler = new ResponseHandler(message, message.channel, message.author);

    if (!message.content.trim()) return; // Ignore empty messages

    //logger.debug(`Processing message from ${message.author.id}/${message.author.tag}: ${message.content.slice(0, 100)}...`);

    // Rate limit check
    const rateLimitResult = await this.checkRateLimits(message);
    if (!rateLimitResult.allowed && rateLimitResult.error) {
      await responseHandler.sendMessage(rateLimitResult.error);
      return;
    }

    // Build context for plan
    const { context: planContext } = await this.contextBuilder.buildMessageContext(message, PLAN_CONTEXT_SIZE);

    // If there are images attached to the trigger message, process them
    let imageDescriptions: string[] = [];
    let flatImageDescriptions: string = '';
    const imageAttachments = message.attachments.filter(a => a.contentType?.startsWith('image/'));

    if (imageAttachments.size > 0) {
      logger.debug(`Processing image attachment from ${message.author.id}/${message.author.tag}`);

      // Generate descriptions for all images
      imageDescriptions.push(...await Promise.all(
        imageAttachments.map(async (a) => {
          try {
            const resp = await this.openaiService.generateImageDescription(
              a.url,
              message.content,
              {
                channelId: message.channelId,
                guildId: message.guildId ?? undefined
              }
            );
            return resp.message?.content ?? `Error generating image description for ${message.author.id}/${message.author.tag} with image ${a.url}`;
          } catch (error) {
            logger.error(`Error generating image description for ${message.author.id}/${message.author.tag} with image ${a.url}: ${error}`);
            return `Error generating image description for ${message.author.id}/${message.author.tag} with image ${a.url}`;
          }
        })
      ));

      // Add the image descriptions to the plan context
      flatImageDescriptions = imageDescriptions
        .map((desc, index) => `[Image ${index + 1}]: ${desc}`)
        .join('\n');

      planContext.push({
        role: 'system',
        content: `User also uploaded images with these automatically generated descriptions: ${flatImageDescriptions}`
      });
    }

    // Attempt to recover image embed metadata for the planner so it can request true variations.
    let recoveredImageContext: RecoveredImageContext | null = null;
    try {
      recoveredImageContext = await recoverContextDetailsFromMessage(message);
      if (recoveredImageContext) {
        const ctx = recoveredImageContext.context;
        planContext.push({
          role: 'system',
          content: `Recovered image embed context for follow-ups:\n` +
            `prompt="${ctx.prompt}"\n` +
            `textModel=${ctx.textModel} imageModel=${ctx.imageModel}\n` +
            `aspect=${ctx.aspectRatio} size=${ctx.size} background=${ctx.background} style=${ctx.style}\n` +
            `outputFormat=${ctx.outputFormat} compression=${ctx.outputCompression} allowPromptAdjustment=${ctx.allowPromptAdjustment}\n` +
            `outputId=${recoveredImageContext.responseId ?? 'n/a'} inputId=${recoveredImageContext.inputId ?? 'n/a'}`
        });
        logger.debug(`Recovered image embed for planner: outputId=${recoveredImageContext.responseId ?? 'n/a'}, inputId=${recoveredImageContext.inputId ?? 'n/a'}, promptLength=${ctx.prompt.length}.`);
      }
    } catch (error) {
      logger.debug('Failed to recover image embed context for planner:', error);
    }

    //
    // Generate plan
    //
    const plan: Plan = await this.planner.generatePlan(planContext, trigger);

    // Capture the planner's safety classification
    const plannerRiskTier = plan.riskTier;
    logger.debug(`Planner classified message ${message.id} as ${plannerRiskTier} risk.`);

    // If the plan updated the bot's presence, update it
    if (plan.presence) {
      logger.debug(`Updating presence: ${JSON.stringify(plan.presence)}`);

      // Verify presence options
      let verifiedPresenceOptions = {
        status: plan.presence.status,
        activities: plan.presence.activities,
        shardId: plan.presence.shardId,
        afk: plan.presence.afk
      }

      responseHandler.setPresence(verifiedPresenceOptions);
    }

    //
    // Handle response based on plan
    //
    switch (plan.action) {
      //
      // Ignore
      //
      case 'ignore':
        logger.debug(`Ignoring message: ${message.content.slice(0, 100)}...`);
        return;
      //
      // Regular message response
      //
      case 'image': {
        logger.debug(`Planner requested automated image generation (risk tier: ${plannerRiskTier}) for message: ${message.content.slice(0, 100)}...`);

        const request = plan.imageRequest;
        if (!request?.prompt?.trim()) {
          logger.warn('Image plan was missing a prompt; falling back to ignoring the request.');
          return;
        }

        const trimmedPrompt = request.prompt.trim();
        const normalizedPrompt = clampPromptForContext(trimmedPrompt);
        let { size, aspectRatio, aspectRatioLabel } = resolveAspectRatioSettings(
          (request.aspectRatio ?? 'auto').toLowerCase() as ImageGenerationContext['aspectRatio']
        );

        const requestedBackground = request.background?.toLowerCase() ?? 'auto';
        let background = VALID_IMAGE_BACKGROUNDS.includes(requestedBackground as ImageBackgroundType)
          ? requestedBackground as ImageBackgroundType
          : 'auto';

        let referencedContext: ImageGenerationContext | null = recoveredImageContext?.context ?? null;
        let followUpResponseId: string | null = recoveredImageContext?.responseId ?? recoveredImageContext?.inputId ?? null;
        if (recoveredImageContext) {
          logger.debug(`Using recovered image context for follow-up: outputId=${recoveredImageContext.responseId ?? 'n/a'}, inputId=${recoveredImageContext.inputId ?? 'n/a'}.`);
        }

        // Normalise style before potentially inheriting values from a reference.
        const normalizedStyle = request.style
          ? request.style.toLowerCase().replace(/[^a-z0-9]+/g, '_')
          : 'unspecified';
        let style = VALID_IMAGE_STYLES.has(normalizedStyle as ImageStylePreset)
          ? normalizedStyle as ImageStylePreset
          : 'unspecified';

        // Allow planner-supplied follow-ups only when they reference a cached or recovered context.
        const plannerFollowUpCandidate = request.followUpResponseId?.trim();
        if (plannerFollowUpCandidate) {
          const cached = readFollowUpContext(plannerFollowUpCandidate);
          const matchesRecovered = recoveredImageContext
            && (recoveredImageContext.responseId === plannerFollowUpCandidate || recoveredImageContext.inputId === plannerFollowUpCandidate);

          if (cached || matchesRecovered) {
            referencedContext = referencedContext ?? cached ?? recoveredImageContext?.context ?? null;
            followUpResponseId = plannerFollowUpCandidate;
          } else {
            logger.warn(`Planner supplied follow-up response ID "${plannerFollowUpCandidate}" that was not found in cache or recovery; ignoring.`);
          }
        }

        if (!referencedContext && message.reference?.messageId) {
          try {
            // Fetch and parse the replied-to message so we can honour its
            // generation settings instead of relying on the planner to guess.
            const referencedMessage = await message.fetchReference();
            const recovered = await recoverContextDetailsFromMessage(referencedMessage);

            if (recovered) {
              referencedContext = recovered.context;
              followUpResponseId = recovered.responseId ?? recovered.inputId ?? null;

              if (!followUpResponseId) {
                logger.warn('Recovered image context lacked response identifiers; running without follow-up linkage.');
              }

              // When the user is replying to a previous image, prefer that
              // message's settings unless the planner explicitly overrode
              // them. This keeps variations predictable and avoids mixing in
              // unrelated historical embeds.
              if ((request.aspectRatio ?? 'auto').toLowerCase() === 'auto') {
                size = referencedContext.size;
                aspectRatio = referencedContext.aspectRatio;
                aspectRatioLabel = referencedContext.aspectRatioLabel;
              }

              if (!request.background || requestedBackground === 'auto') {
                background = referencedContext.background;
              }

              if (!request.style || normalizedStyle === 'unspecified') {
                style = referencedContext.style;
              }
            }
          } catch (error) {
            // We intentionally log at debug level: if we cannot recover the
            // reference we still want to proceed with a best-effort response
            // rather than failing the entire interaction.
            logger.debug('Unable to recover referenced image context for reply-driven image request:', error);
          }
        }

        const outputFormat: ImageOutputFormat = (request.outputFormat as ImageOutputFormat | undefined)
          ?? referencedContext?.outputFormat
          ?? DEFAULT_IMAGE_OUTPUT_FORMAT;
        const outputCompression = clampOutputCompression(
          request.outputCompression ?? referencedContext?.outputCompression ?? DEFAULT_IMAGE_OUTPUT_COMPRESSION
        );

        // Assemble the same context structure used by the slash command pipeline so follow-ups work identically.
        if (trimmedPrompt.length > normalizedPrompt.length) {
          logger.warn('Automated image prompt exceeded embed limits; truncating to preserve follow-up usability.');
        }

        // Planner-driven image generations already flowed through the LLM once. We
        // allow optional refinements, but if the prompt is near the embed limit we
        // skip adjustments to avoid bloating/duplicate fields.
        const remainingRatio = Math.max(0, (EMBED_FIELD_VALUE_LIMIT - normalizedPrompt.length) / EMBED_FIELD_VALUE_LIMIT);
        const hasRoomForAdjustment = remainingRatio > PROMPT_ADJUSTMENT_MIN_REMAINING_RATIO;
        const allowPromptAdjustment = hasRoomForAdjustment
          ? (request.allowPromptAdjustment ?? referencedContext?.allowPromptAdjustment ?? false)
          : false;

        const textModel: ImageTextModel = referencedContext?.textModel ?? DEFAULT_TEXT_MODEL;
        const imageModel: ImageRenderModel = referencedContext?.imageModel ?? DEFAULT_IMAGE_MODEL;

        const context: ImageGenerationContext = {
          prompt: normalizedPrompt,
          originalPrompt: normalizedPrompt,
          refinedPrompt: null,
          textModel,
          imageModel,
          size,
          aspectRatio,
          aspectRatioLabel,
          quality: request.quality ?? referencedContext?.quality ?? DEFAULT_IMAGE_QUALITY,
          background,
          style,
          allowPromptAdjustment,
          outputFormat,
          outputCompression
        };

        await responseHandler.startTyping();

        try {
          // Reuse the shared generation helper so we get identical cost calculations and Cloudinary uploads.
          const artifacts = await executeImageGeneration(context, {
            user: {
              username: message.author.username,
              nickname: message.member?.displayName ?? message.author.username,
              guildName: message.guild?.name ?? 'Direct message channel'
            },
            followUpResponseId,
            stream: false
          });

          const presentation = buildImageResultPresentation(context, artifacts);

          if (artifacts.responseId) {
            saveFollowUpContext(artifacts.responseId, presentation.followUpContext);
          }

          const files = presentation.attachments.map(attachment => ({
            filename: attachment.name ?? 'daneel-attachment.dat',
            data: attachment.attachment as Buffer
          }));

          await responseHandler.sendEmbedMessage(presentation.embed, {
            content: presentation.content,
            files,
            directReply,
            components: presentation.components
          });
          logger.debug(`Automated image response sent for message: ${message.id}`);
        } catch (error) {
          logger.error('Automated image generation failed:', error);
          await responseHandler.sendMessage('⚠️ I tried to create an image but something went wrong.', [], directReply);
        } finally {
          // Always stop the typing indicator so the channel UI doesn't get stuck.
          responseHandler.stopTyping();
        }

        return;
      }

      case 'message': {
        logger.debug(`Generating response for message (risk tier: ${plannerRiskTier}): ${message.content.slice(0, 100)}...`);

        await responseHandler.startTyping(); // Start persistent typing indicator

        // TODO: Instead of a fixed context size, use the plan's tool call to suggest which messages to include
        let { context: responseContext } = await this.contextBuilder.buildMessageContext(message, RESPONSE_CONTEXT_SIZE);

        // Add image descriptions to context, if any
        if (flatImageDescriptions) {
          responseContext.push({
            role: 'system',
            content: `User also uploaded images with these automatically generated descriptions: 
            ${flatImageDescriptions}
            Use these descriptions for reasoning.`
          });
        }

        try {
          // Generate AI response
          logger.debug(`Generating AI response with options: ${JSON.stringify(plan.openaiOptions)}`);
          const aiResponse = await this.openaiService.generateResponse(
            MAIN_MODEL,
            responseContext,
            {
              ...plan.openaiOptions,
              channelContext: this.getChannelGuildIdsFromMessage(message)
            }
          );
          logger.debug(`Response recieved. Usage: ${JSON.stringify(aiResponse.usage)}`);

          let responseMetadata: ResponseMetadata;
          try {
            responseMetadata = buildResponseMetadata(
              aiResponse.metadata ?? null,
              plannerRiskTier,
              {
                modelVersion: MAIN_MODEL,
                conversationSnapshot: JSON.stringify(responseContext)
              }
            );
            if (aiResponse.metadata === null) {
              logger.warn(`No metadata payload received from LLM for message ${message.id}; using fallback defaults.`);
            }
          } catch (error) {
            logger.error(`Error building response metadata for message ${message.id}:`, error);
            responseMetadata = {
              responseId: 'FALLBACK-' + Date.now().toString(),
              provenance: 'Inferred',
              confidence: 0.0, // Unknown confidence
              riskTier: plannerRiskTier,
              tradeoffCount: 0,
              chainHash: 'fallback-hash',
              licenseContext: 'MIT + HL3', // Default license (MIT + HL3 core)
              modelVersion: MAIN_MODEL,
              staleAfter: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), // 7 days from now
              citations: []
            };
          }

          const originalResponseId = responseMetadata.responseId;
          if (!/^[A-Za-z0-9_-]+$/.test(originalResponseId)) {
            // Persisting metadata requires filesystem-safe identifiers, so coerce anything unexpected.
            let sanitizedResponseId = originalResponseId.replace(/[^A-Za-z0-9_-]+/g, '_'); // Replace invalid chars with underscores
            sanitizedResponseId = sanitizedResponseId.replace(/^_+/, '').replace(/_+$/, ''); // Trim leading/trailing underscores
            if (!sanitizedResponseId) {
              sanitizedResponseId = `FALLBACK_${Date.now()}`;
            }
            if (sanitizedResponseId !== originalResponseId) {
              logger.warn(
                `Sanitized responseId for message ${message.id} from "${originalResponseId}" to "${sanitizedResponseId}" to satisfy trace storage requirements.`
              );
            }
            responseMetadata = {
              ...responseMetadata,
              responseId: sanitizedResponseId
            };
          }

          if (imageDescriptions.length > 0) {
            responseMetadata = {
              ...responseMetadata,
              imageDescriptions: [...imageDescriptions]
            };
          }

          // Build provenance footer
          let footerPayload: ReturnType<typeof buildFooterEmbed> | null = null;
          try {
            footerPayload = buildFooterEmbed(responseMetadata, config.webBaseUrl);
          } catch (error) {
            logger.error(
              `Failed to build provenance footer for response ${responseMetadata.responseId}: ${(
                error as Error
              )?.message ?? error}`
            );
            footerPayload = null;
          }

          // Save trace asynchronously
          const persistTrace = async () => {
            try {
              if (!config.traceApiToken && !warnedMissingTraceToken) {
                warnedMissingTraceToken = true;
                logger.warn('TRACE_API_TOKEN is not set; backend trace ingestion will reject requests.');
              }

              const headers: Record<string, string> = {
                'Content-Type': 'application/json'
              };
              if (config.traceApiToken) {
                headers['X-Arete-Trace-Token'] = config.traceApiToken;
              }

              const traceUrl = `${config.backendBaseUrl}/api/traces`;
              const maxAttempts = 3;

              for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
                try {
                  const response = await fetch(traceUrl, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify(responseMetadata)
                  });
                  if (!response.ok) {
                    const errorText = await response.text();
                    if (response.status >= 500 && attempt < maxAttempts) {
                      logger.warn(
                        `Trace API retry ${attempt}/${maxAttempts} failed with ${response.status}; backing off before retry.`
                      );
                      await new Promise(resolve => setTimeout(resolve, 250 * attempt));
                      continue;
                    }
                    throw new Error(`Trace API ${response.status}: ${errorText}`);
                  }
                  logger.debug(
                    `Persisted response metadata for response ${responseMetadata.responseId} via backend API.`
                  );
                  return;
                } catch (error) {
                  if (attempt < maxAttempts) {
                    logger.warn(
                      `Trace API attempt ${attempt}/${maxAttempts} failed; retrying. Error: ${(error as Error)?.message ?? error}`
                    );
                    await new Promise(resolve => setTimeout(resolve, 250 * attempt));
                    continue;
                  }
                  throw error;
                }
              }
            } catch (error) {
              logger.error(
                `Failed to persist response metadata for response ${responseMetadata.responseId} (backend: ${config.backendBaseUrl}): ${(
                  error as Error
                )?.message ?? error}`
              );
            }
          };

          // Get the assistant's response
          const responseText = aiResponse.message?.content || 'No response generated.';
          const finalResponseText = responseText;

          // If the response is to be read out loud, generate speech (TTS)
          let ttsPath: string | null = null;
          if (plan.modality === 'tts') {
            // Use plan's TTS options if they exist, otherwise fall back to defaults
            const ttsOptions: TTSOptions = plan.openaiOptions?.ttsOptions || TTS_DEFAULT_OPTIONS;

            // Generate speech
            ttsPath = await this.openaiService.generateSpeech(
              responseText,
              ttsOptions,
              Date.now().toString(),
              'mp3'
            );
          }

          // If the assistant has a response, send it
          if (finalResponseText) {
            // Is this a TTS response?
            if (ttsPath) {
              // TTS - Special rules (if we're sending a TTS too, put the text transcript in a code block)
              // Read the file into a Buffer
              const fileBuffer = await fs.promises.readFile(ttsPath);

              // If we're sending a TTS too, put the text transcript in a code block
              const cleanResponseText = finalResponseText.replace(/\n/g, ' ').replace(/`/g, ''); // Replace newlines with spaces, remove backticks (since we are putting it in a code block)

              // Send the response
              await responseHandler.sendMessage(
                `\`\`\`${cleanResponseText}\`\`\``, // markdown code block for transcript
                [{
                  filename: path.basename(ttsPath),
                  data: fileBuffer
                }],
                directReply // honour caller preference for threaded replies
              );

              // Save trace asynchronously
              await persistTrace();

              // Send the provenance footer as a follow-up message
              if (footerPayload) {
                try {
                  // Footer follows as a separate message so components render even when the TTS chunk has attachments.
                  await responseHandler.sendMessage(
                    '',
                    [],
                    false,
                    false,
                    [],
                    footerPayload.embeds.map(embed => embed.build()),
                    footerPayload.components
                  );
                } catch (error) {
                  logger.error(
                    `Failed to send provenance footer follow-up for response ${responseMetadata.responseId}: ${(
                      error as Error
                    )?.message ?? error}`
                  );
                }
              }

              await cleanupTTSFile(ttsPath);
            } else {
              // NOT a TTS response - send regular response
              // Build footer embed/components
              const footerEmbed = footerPayload?.embeds[0]?.build();
              const footerEmbeds = footerEmbed ? [footerEmbed] : [];
              const footerComponents = footerPayload?.components ?? [];

              // Send the response with footer
              await responseHandler.sendMessage(
                finalResponseText,
                [],
                directReply,
                footerEmbeds.length === 0,
                [],
                footerEmbeds,
                footerComponents
              );

              // Save trace asynchronously
              await persistTrace();
            }
            logger.debug(`Response sent (${finalResponseText}) for message: ${message.content.slice(0, 100)}...`);
          }
        } finally {
          responseHandler.stopTyping(); // Stop typing indicator
        }
        return;
      }
      //
      // React with emoji (one or more) using Discord's built-in reaction feature
      //
      case 'react':
        if (plan.reaction) {
          await responseHandler.addReaction(plan.reaction);
          logger.debug(`Reaction(s) sent (${plan.reaction}) for message: ${message.content.slice(0, 100)}...`);
        } else {
          logger.debug(`No reaction specified. Ignoring message: ${message.content.slice(0, 100)}...`);
        }
        return;
      //
      // Unspecified action: Ignore
      //
      default:
        logger.debug(`No action specified. Ignoring message: ${message.content.slice(0, 100)}...`);
        return;
    }
  }

  private async checkRateLimits(message: Message): Promise<{ allowed: boolean; error?: string }> {
    const results: Array<{ allowed: boolean; error?: string }> = [];

    if (this.rateLimiters.user) results.push(await this.rateLimiters.user.check(message.author.id, message.channel.id, message.guild?.id));
    if (this.rateLimiters.channel) results.push(await this.rateLimiters.channel.check(message.author.id, message.channel.id, message.guild?.id));
    if (this.rateLimiters.guild && message.guild) results.push(await this.rateLimiters.guild.check(message.author.id, message.channel.id, message.guild.id));

    return results.find(r => !r.allowed) ?? { allowed: true };
  }
}


export async function cleanupTTSFile(ttsPath: string): Promise<void> {
  if (!ttsPath) return;

  try {
    await fs.promises.unlink(ttsPath);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code === 'ENOENT') {
      return;
    }

    logger.debug(`Failed to delete TTS file ${ttsPath}: ${err?.message ?? err}`);
  }
}


