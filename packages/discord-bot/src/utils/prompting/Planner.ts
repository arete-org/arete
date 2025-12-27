/**
 * @description: Plans bot actions and LLM options before responding to messages.
 * @arete-scope: core
 * @arete-module: Planner
 * @arete-risk: high - Planning errors can trigger wrong modality or unsafe actions.
 * @arete-ethics: high - Plan selection affects user trust and safety outcomes.
 */
import { renderPrompt } from '../env.js';
import { logger } from '../logger.js';
import { OpenAIService, OpenAIMessage, OpenAIOptions, OpenAIResponse, SupportedModel, TTS_DEFAULT_OPTIONS } from '../openaiService.js';
import { ActivityOptions } from 'discord.js';
import type { RiskTier } from '@arete/backend/ethics-core';
import { DEFAULT_IMAGE_OUTPUT_COMPRESSION } from '../../commands/image/constants.js';
import type { ImageQualityType } from '../../commands/image/types.js';

const PLANNING_MODEL: SupportedModel = 'gpt-5-nano';
const PLANNING_OPTIONS: OpenAIOptions = { reasoningEffort: 'low' };
const DEFAULT_RISK_TIER: RiskTier = 'Low';

export interface Plan {
  action: 'message' | 'react' | 'ignore' | 'image';
  modality: 'text' | 'tts';
  reaction?: string;
  openaiOptions: OpenAIOptions;
  presence?: {
    status?: 'online' | 'idle' | 'dnd' | 'invisible';
    activities?: ActivityOptions[];
    shardId?: number | null;
    afk?: boolean;
  }
  imageRequest?: ImagePlanRequest;
  riskTier: RiskTier;
}

type ImagePlanRequest = {
  prompt: string;
  aspectRatio?: 'auto' | 'square' | 'portrait' | 'landscape';
  background?: string;
  quality?: ImageQualityType;
  style?: string;
  allowPromptAdjustment?: boolean;
  followUpResponseId?: string;
  outputFormat?: 'png' | 'webp' | 'jpeg';
  outputCompression?: number;
};

const defaultPlan: Plan = {
  action: 'ignore',
  modality: 'text',
  openaiOptions: {
    reasoningEffort: 'low',
    verbosity: 'low',
    tool_choice: 'auto',
    webSearch: {
      query: '',
      allowedDomains: [],
      searchContextSize: 'low',
      userLocation: { type: 'approximate' }
    },
    ttsOptions: TTS_DEFAULT_OPTIONS
  },
  riskTier: DEFAULT_RISK_TIER
};

const planFunction = {
  name: "generate-plan",
  description: "Generates a structured plan for responding to a message.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["message", "react", "ignore", "image"],
        description: `The action to take: 
        'message' sends a message response (some combination of text and files), 
        'react' uses Discord's react feature to react to the last message with one or more emoji, 'ignore' does nothing, and 
        'image' generates an image using the dedicated pipeline. 
        Based on the last message (which triggered this to run) and the context of the conversation (especially the most recent messages by timestamp), you should decide which of these actions to take. 
        Depending on how you were triggered, a response may not be neccessary (such as a catchup event, which simply ran because N number of messages were sent from other users since your last response). 
        If unsure, prefer to 'react'.`
      },
      modality: {
        type: "string",
        enum: ["text", "tts"],
        description: `The modality to use: 
        'text' sends just a text response, 
        'tts' sends that text response along with a TTS reading. 
        Prefer 'tts' for short/causal responses, or when asked to (and then set 'reasoningEffort' and 'verbosity' to 'low'), and 'text' for longer/more complex responses.
        If 'action' is 'image', always use 'text'.`
      },
      reaction: {
        type: "string",
        description: "A string containing only emoji characters (no text). Required when action is 'react'. Example: 🤖👍",
      },
      imageRequest: {
        type: "object",
        description: "Details for image generation when action is 'image'.",
        properties: {
          prompt: { type: "string", description: "Detailed description of the image to generate." },
          aspect_ratio: {
            type: "string",
            enum: ["auto", "square", "portrait", "landscape"],
            description: "Override aspect ratio for the generated image, only if explicitly requested (otherwise omit)."
          },
          background: {
            type: "string",
            enum: ["auto", "transparent", "opaque"],
            description: "Override background mode for the generated image, only if explicitly requested (otherwise omit)."
          },
          output_format: {
            type: "string",
            enum: ["png", "webp", "jpeg"],
            description: "Override output format, only if explicitly requested (otherwise omit)."
          },
          output_compression: {
            type: "integer",
            minimum: 1,
            maximum: 100,
            description: "Override compression quality (1-100% quality), only if explicitly requested (otherwise omit)."
          },
          quality: {
            type: "string",
            enum: ["low", "medium", "high", "auto"],
            description: "Override image quality, only if explicitly requested (otherwise omit)."
          },
          style: {
            type: "string",
            description: "Override style preset (e.g., natural, photorealistic, watercolor), only if explicitly requested (otherwise omit)."
          },
          allowPromptAdjustment: {
            type: "boolean",
            description: "Whether the model may adjust the prompt before rendering. Leave false unless the user explicitly asks for prompt improvements."
          },
          followUpResponseId: {
            type: "string",
            description: "Existing response ID when requesting a variation."
          }
        },
        required: ["prompt"]
      },
      openaiOptions: {
        type: "object",
        properties: {
          reasoningEffort: {
            type: "string",
            enum: ["minimal", "low", "medium", "high"],
            description: "The level of reasoning to use, with 'low' being the default. 'minimal' is for very simple tasks, 'high' is for complex tasks and should be used sparingly."
          },
          verbosity: {
            type: "string",
            enum: ["low", "medium","high"],
            description: "The level of verbosity to use. Prefer 'low' for casual conversation, and 'medium' for more detailed responses. Only use 'high' when explicitly asked to be verbose."
          },
          tool_choice: {
            type: "object",
            properties: {
              type: {
                type: "string",
                enum: ["none", "web_search"],
                description: "Only choose 'web_search' when you can produce a meaningful, non-empty query; otherwise use 'none' ('none' performs no tool calls). 'web_search' performs a web search for a given query and should be used to find information that the assistant needs to respond to the message (real-time information especially). Always pair this with reasoningEffort >= low."
              }
            },
            required: ["type"]
          },
          webSearch: {
            type: "object",
            properties: {
              query: { type: "string", description: "If tool_choice.type is web_search, you must provide a concise, non-empty query summarizing the user’s ask; do not return an empty string. web_search is required whenever the answer depends on versioned, time-sensitive, comparative, or externally verifiable facts (e.g., model versions, releases, benchmarks, pricing). If you cannot justify high confidence without lookup, you must perform a web_search rather than speculate." },
              //allowedDomains: { type: "array", items: { type: "string" }, description: "An array of allowed domains to search within." },
              searchContextSize: { type: "string", enum: ["low", "medium", "high"], description: "Controls the breadth of external context retrieved. Use 'low' only when a single, stable fact is sufficient. Use 'medium' for comparisons, synthesis, or when confidence beyond a single source is required (e.g., model versions, release differences, benchmarks, pricing, timelines). Use 'high' only for complex, multi-factor, or high-stakes queries where missing context could materially affect correctness. Default to 'medium' when uncertainty exists." },
              /*userLocation: {
                type: "object",
                properties: {
                  type: { type: "string", enum: ["approximate", "exact"], description: "The type of user location." },
                  country: { type: "string", description: "The ISO country code." },
                  city: { type: "string", description: "The city." },
                  region: { type: "string", description: "The region." },
                  timezone: { type: "string", description: "The IANA timezone." }
                },
                required: ["type"]
              }*/
            },
            required: ["query", "searchContextSize"]
          },
          ttsOptions: {
            type: "object",
            description: "Controls how the TTS response should be generated. Use only if 'modality' is 'tts'.",
            properties: {
              //model:      { type: "string", description: "The model to use for TTS." }, // hardcoded to "gpt-4o-mini-tts" for now
              //voice:      { type: "string", description: "The voice to use for TTS." }, // hardcoded to "echo" for now
              speed: { type: "string", enum: ["slow", "normal", "fast"], description: "Speed of speech." },
              pitch: { type: "string", enum: ["low", "normal", "high"], description: "Pitch of speech." },
              emphasis: { type: "string", enum: ["low", "normal", "high"], description: "Level of emphasis." },
              style: { type: "string", enum: ["casual", "narrative", "cheerful", "sad", "angry"], description: "Speaking style." },
              styleDegree: { type: "string", enum: ["low", "normal", "high"], description: "Weight of speaking style." },
              styleNote: { type: "string", description: "Additional notes about the speaking style." }
            },
            required: ["speed", "pitch", "emphasis", "style", "styleDegree"]
          }
        },
        required: ["reasoningEffort", "verbosity", "tool_choice"]
      },
      presence: {
        type: "object",
        description: "The new presence to set for the Discord bot",
        properties: {
          status: {
            type: "string",
            enum: ["online", "idle", "dnd", "invisible"],
            description: "The bot's overall status."
          },
          activities: {
            type: "array",
            description: "List of activities for the bot to display.",
            items: {
              type: "object",
              properties: {
                type: {
                  type: "integer",
                  enum: [0, 1, 2, 3, 4, 5],
                  description: "Activity type: 0 = Playing, 1 = Streaming, 2 = Listening, 3 = Watching, 4 = Custom (prefer this), 5 = Competing."
                },
                name: { type: "string", description: "The activity alone (e.g., chess) to be used with prefixed activity types (e.g., Playing chess, but without the 'Playing ' prefix). 24 characters max." },
                state: { type: "string", description: "The full activity string (e.g., Playing chess with Jordan). 30 characters max." },
                url: { type: "string", description: "Streaming URL (required if type = 1)" },
              },
              required: ["type", "name", "state"]
            }
          },
          afk: { type: "boolean", description: "Whether the bot is AFK" },
          //shardId: { type: "number", description: "Shard ID to apply this presence to" }
        },
        required: ["status"]
      },
      riskTier: {
        type: "string",
        enum: ["Low", "Medium", "High"],
        description: "Risk classification for this turn dependant on context. Use Low for harmless chat, Medium when sensitivity rises, and High when refusal or escalation may be needed."
      }
    },
    required: ["action", "modality", "openaiOptions", "presence", "riskTier"]
  }
};

export class Planner {
  constructor(private readonly openaiService: OpenAIService) { }

  public async generatePlan(context: OpenAIMessage[] = [], trigger: string = ''): Promise<Plan> {
    try {
      const messages: OpenAIMessage[] = [...context];

      const plannerPrompt = renderPrompt('discord.planner.system', {
        webSearchHint: 'When the user asks for lookup/verification/what’s new/availability, choose web_search and emit a clear query (no empty strings). If you can’t form a query, fall back to tool_choice: none.'
      }).content;
      const openaiResponse = await this.openaiService.generateResponse(
        PLANNING_MODEL,
        [
          { role: 'system', content: plannerPrompt },
          { role: 'system', content: `This planner was triggered because ${trigger}.` }, // The planner should know how it was triggered: Either a Discord direct reply/ping, or it decided to reply itself (e.g. a catchup event)
          ...messages
        ],
        {
          ...PLANNING_OPTIONS,
          functions: [planFunction],
          function_call: { name: 'generate-plan' }
        }
      )

      const response: OpenAIResponse = {
        normalizedText: openaiResponse.message?.content,
        message: openaiResponse.message,
        finish_reason: openaiResponse.finish_reason,
        usage: openaiResponse.usage,
        newPresence: openaiResponse.newPresence
      }
      logger.debug(`Plan generated. Usage: ${JSON.stringify(response.usage)}`);

      const funcCall = response.message?.function_call;
      if (funcCall?.arguments) {
        try {
          const parsed = JSON.parse(funcCall.arguments) as Partial<Plan>;
          const validatedPlan = this.validatePlan(parsed);
          logger.debug(`Validated plan: ${JSON.stringify(validatedPlan)}`);
          return validatedPlan;
        } catch {
          logger.warn('Failed to parse plan arguments, using default');
          return defaultPlan;
        }
      }

      return defaultPlan;
    } catch (error) {
      logger.error('Planner.generatePlan error:', error);
      return defaultPlan;
    }
  }

  private validatePlan(plan: Partial<Plan>): Plan {
    //logger.debug(`Validating plan: ${JSON.stringify(plan)}`);
    //logger.debug(`Default plan: ${JSON.stringify(defaultPlan)}`);

    // Deep copy of defaultPlan
    const validatedPlan: Plan = JSON.parse(JSON.stringify(defaultPlan));

    // Merge openaiOptions (with nested ttsOptions)
    if (plan.openaiOptions) {
      validatedPlan.openaiOptions = {
        ...validatedPlan.openaiOptions,
        ...plan.openaiOptions,
        ...(plan.openaiOptions.ttsOptions ? {
          ttsOptions: {
            ...validatedPlan.openaiOptions.ttsOptions,
            ...plan.openaiOptions.ttsOptions
          }
        } : {})
      };
    }

    // Merge other top-level properties
    const mergedPlan: Plan = {
      ...validatedPlan,
      ...plan,
      openaiOptions: validatedPlan.openaiOptions,
      //repoQuery: (plan.repoQuery ?? validatedPlan.repoQuery ?? '') as string
    };

    if (plan.imageRequest) {
      mergedPlan.imageRequest = this.normalizeImageRequest(plan.imageRequest);
    }

    // Ensure callers always see a supported risk tier value
    mergedPlan.riskTier = this.normalizeRiskTier(plan.riskTier);

    // Image actions must never trigger TTS or web search; enforce text modality
    // and clear tool/web search hints to avoid accidental spend.
    if (mergedPlan.action === 'image') {
      mergedPlan.modality = 'text';
      mergedPlan.openaiOptions = {
        ...mergedPlan.openaiOptions,
        tool_choice: 'none',
        webSearch: undefined
      };
    }

    return mergedPlan;
  }

  private normalizeRiskTier(candidate: Partial<Plan>['riskTier']): RiskTier {
    // Tighten to the ethics-core enum; default to Low so we never block responses
    if (candidate === 'Low' || candidate === 'Medium' || candidate === 'High') {
      return candidate;
    }

    if (candidate !== undefined) {
      logger.warn(`Planner returned unexpected risk tier "${candidate}", defaulting to ${DEFAULT_RISK_TIER}.`);
    }

    return DEFAULT_RISK_TIER;
  }

  private normalizeImageRequest(request: Partial<ImagePlanRequest>): ImagePlanRequest {
    const aspectRatioCandidate = (request as Record<string, unknown>).aspect_ratio ?? request.aspectRatio;
    const aspectRatio = this.isValidAspectRatio(aspectRatioCandidate) ? aspectRatioCandidate : undefined;

    const background = typeof request.background === 'string' ? request.background : undefined;
    const style = typeof request.style === 'string' ? request.style : undefined;
    const quality = this.normalizeQuality((request as Record<string, unknown>).quality ?? request.quality);

    const formatCandidate = (request as Record<string, unknown>).output_format ?? request.outputFormat;
    const normalizedFormat = typeof formatCandidate === 'string'
      ? this.normalizeOutputFormat(formatCandidate)
      : undefined;

    const compressionCandidate = (request as Record<string, unknown>).output_compression ?? request.outputCompression;
    const normalizedCompression = typeof compressionCandidate === 'number' || typeof compressionCandidate === 'string'
      ? this.clampOutputCompression(compressionCandidate)
      : undefined;

    const followUpResponseId = typeof request.followUpResponseId === 'string' && request.followUpResponseId.trim()
      ? request.followUpResponseId.trim()
      : undefined;

    return {
      prompt: (request.prompt ?? '').toString(),
      aspectRatio,
      background,
      quality: quality ?? undefined,
      style,
      // Automated image requests should only opt into prompt adjustments when the
      // planner is absolutely certain the user requested it. Leaving this false by
      // default keeps follow-up embeds compact and faithful to the user's wording.
      allowPromptAdjustment: request.allowPromptAdjustment !== undefined
        ? Boolean(request.allowPromptAdjustment)
        : false,
      followUpResponseId,
      outputFormat: normalizedFormat,
      outputCompression: normalizedCompression
    };
  }

  private isValidAspectRatio(value: unknown): value is ImagePlanRequest['aspectRatio'] {
    return value === 'auto' || value === 'square' || value === 'portrait' || value === 'landscape';
  }

  private normalizeQuality(candidate: unknown): ImageQualityType | undefined {
    const normalized = typeof candidate === 'string' ? candidate.toLowerCase() : '';
    const allowed: ImageQualityType[] = ['low', 'medium', 'high', 'auto'];
    if (allowed.includes(normalized as ImageQualityType)) {
      return normalized as ImageQualityType;
    }
    if (normalized) {
      logger.warn(`Planner returned unsupported image quality "${candidate}", ignoring override.`);
    }
    return undefined;
  }

  private normalizeOutputFormat(candidate: unknown): ImagePlanRequest['outputFormat'] {
    const normalized = typeof candidate === 'string' ? candidate.trim().toLowerCase() : '';
    if (normalized === 'png' || normalized === 'webp' || normalized === 'jpeg') {
      return normalized;
    }
    if (normalized) {
      logger.warn(`Planner returned unsupported output format "${candidate}", ignoring override.`);
    }
    return undefined;
  }

  private clampOutputCompression(candidate: unknown): number {
    const value = typeof candidate === 'number' ? candidate : Number(candidate);
    if (!Number.isFinite(value)) {
      return DEFAULT_IMAGE_OUTPUT_COMPRESSION;
    }
    return Math.min(100, Math.max(1, Math.round(value)));
  }
}

