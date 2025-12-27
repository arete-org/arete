/**
 * @arete-module: OpenAIService
 * @arete-risk: high
 * @arete-ethics: high
 * @arete-scope: core
 *
 * @description: Handles all LLM interactions and API calls with high cost/resource impact.
 *
 * @impact
 * Risk: API failures can break AI functionality or cause unexpected costs. Manages all OpenAI API communication including chat completions, embeddings, TTS, and image analysis.
 * Ethics: Manages cost tracking and API usage transparency. Every API call must be logged and cost-tracked to ensure responsible resource consumption and auditability.
 */

import { fileURLToPath } from 'url';
import path, { dirname } from 'path';
import fs from 'fs';
import OpenAI from 'openai';
import type { ResponseCreateParamsNonStreaming } from 'openai/resources/responses/responses.js';
import { logger } from './logger.js';
import { renderPrompt } from './env.js';
import { ActivityOptions } from 'discord.js';
import { estimateTextCost, formatUsd, createCostBreakdown, type GPT5ModelType, type ModelCostBreakdown, type TextModelPricingKey } from './pricing.js';
import type { LLMCostEstimator } from './LLMCostEstimator.js';
import { generateImageDescriptionRequest } from './imageProcessing/imageDescription.js';
import { IMAGE_DESCRIPTION_CONFIG, type ImageDescriptionModelType } from '../constants/imageProcessing.js';

// ====================
// Type Declarations
// ====================

type ResponseCreateParams = ResponseCreateParamsNonStreaming;

export type { GPT5ModelType } from './pricing.js';
export type SupportedModel = GPT5ModelType;
export type EmbeddingModelType = 'text-embedding-3-small'; // Dimensions: 1546

// Defines the structure of a message to be sent to the OpenAI API
export interface OpenAIMessage {
  role: 'user' | 'assistant' | 'system' | 'developer';
  content: string;
}

// Defines the options for text-to-speech
export type TTSOptions = {
  model: 'tts-1' | 'tts-1-hd' | 'gpt-4o-mini-tts';
  voice: 'alloy' | 'ash' | 'ballad' | 'coral' | 'echo' | 'fable' | 'nova' | 'onyx' | 'sage' | 'shimmer';
  speed?: 'slow' | 'normal' | 'fast';
  pitch?: 'low' | 'normal' | 'high';
  emphasis?: 'none' | 'moderate' | 'strong';
  style?: 'casual' | 'narrative' | 'cheerful' | 'sad' | 'angry' | string;
  styleDegree?: 'low' | 'normal' | 'high';
  styleNote?: string;
}

/**
 * Expands on the OpenAIMessage interface to include additional options.
 */ 
export interface OpenAIOptions {
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
  verbosity?: 'low' | 'medium' | 'high';
  webSearch?: {
    query?: string;
    allowedDomains?: string[]; // Up to 20 domains
    searchContextSize?: 'low' | 'medium' | 'high';
    userLocation?: {
      type?: 'approximate' | 'exact';
      country?: string; // ISO country code (e.g., 'US', 'GB')
      city?: string;
      region?: string;
      timezone?: string; // IANA timezone (e.g., 'America/Chicago')
    };
  };
  ttsOptions?: TTSOptions;
  functions?: Array<{
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  }>;
  function_call?: { name: string } | 'auto' | 'none' | 'required' | null;
  tool_choice?: {
    type: 'function' | 'web_search';
    function: { name: string };
  } | 'none' | 'auto' | null;
  channelContext?: {
    channelId: string;
    guildId?: string;
  };
}

/**
 * Expands on the OpenAIResponse interface to include additional options.
 */
export interface OpenAIResponse {
  normalizedText?: string | null;
  message?: {
    role: 'user' | 'assistant' | 'system' | 'developer';
    content: string;
    function_call?: { name: string; arguments?: string } | null;
    citations?: Array<{
      url: string;
      title: string;
      text: string;
    }>;
  };
  finish_reason?: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    cost?: string;
  };
  newPresence?: ActivityOptions;
  metadata?: AssistantMetadataPayload | null; // Parsed footer metadata emitted via <ARETE_METADATA>{...}
}

/**
 * Defines the structure of a citation from the OpenAI API.
 * @interface AssistantMetadataCitation
 * @property {string} title - The human-readable source name
 * @property {URL} url - The normalized URL instance for downstream rendering
 * @property {string} snippet - The optional short excerpt from the cited content
 */
export interface AssistantMetadataCitation {
  title: string;
  url: URL;
  snippet?: string;
}

/**
 * Allowed provenance values for assistant metadata.
 * @type {ProvenanceValue}
 * @property {string} Retrieved - The response was retrieved from a source
 * @property {string} Inferred - The response was inferred from the context
 * @property {string} Speculative - The response was speculative
 */
export type ProvenanceValue = 'Retrieved' | 'Inferred' | 'Speculative';

/**
 * Defines the structure of a payload from the OpenAI API.
 * @interface AssistantMetadataPayload
 * @property {ProvenanceValue} provenance - The provenance of the response
 * @property {number} confidence - The confidence of the response
 * @property {number} tradeoffCount - The number of value tradeoffs the model noted
 * @property {AssistantMetadataCitation[]} citations - The citations from the response
 * @property {unknown} rawPayload - The original JSON blob for diagnostics/fallback handling
 */
export interface AssistantMetadataPayload {
  provenance?: ProvenanceValue;
  confidence?: number;
  tradeoffCount?: number;
  citations: AssistantMetadataCitation[];
  rawPayload: unknown;
}

/**
 * Extended interface for OpenAI Responses output items.
 */
interface ResponseOutputItemExtended {
  type?: string; // "reasoning", "function_call", "message", "image_generation_call", etc.
  role?: 'user' | 'assistant' | 'system' | 'developer';
  name?: string; // present on type "function_call"
  arguments?: string; // present on type "function_call"
  tool_calls?: Array<{ function: { name: string; arguments?: string } }>;
  function_call?: { name: string; arguments?: string };
  tool?: { name: string; arguments?: string };
  content?: Array<{
    type: string;
    text?: string;
    annotations?: Array<{
      type: string;
      url?: string;
      title?: string;
      start_index: number;
      end_index: number;
    }>;
  }>;
  finish_reason?: string;
}

type OpenAIWebSearchTool = {
  type: 'web_search';
  filters?: { allowed_domains?: string[] };
  search_context_size?: 'low' | 'medium' | 'high';
  user_location?: {
    type?: 'approximate' | 'exact';
    country?: string;
    city?: string;
    region?: string;
    timezone?: string;
  };
};

type OpenAIFunctionTool = {
  type: 'function';
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  strict?: boolean;
};

type OpenAITool = OpenAIWebSearchTool | OpenAIFunctionTool;

const isFunctionTool = (tool: OpenAITool): tool is OpenAIFunctionTool => tool.type === 'function';

// ====================
// Constants / Variables
// ====================

const DEFAULT_GPT5_MODEL: SupportedModel = 'gpt-5-mini';
const DEFAULT_MODEL: SupportedModel = DEFAULT_GPT5_MODEL;
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const OUTPUT_PATH = path.resolve(__dirname, '..', 'output');
const TTS_OUTPUT_PATH = path.join(OUTPUT_PATH, 'tts');
export const IMAGE_DESCRIPTION_MODEL: ImageDescriptionModelType = IMAGE_DESCRIPTION_CONFIG.model;
export const DEFAULT_EMBEDDING_MODEL: EmbeddingModelType = 'text-embedding-3-small';
const METADATA_MARKER = '<ARETE_METADATA>'; // Marker appended to chat completions so we can reliably split conversational text and metadata

let isDirectoryInitialized = false; // Tracks if output directories have been initialized

export const TTS_DEFAULT_OPTIONS: TTSOptions = {
  model: 'gpt-4o-mini-tts',
  voice: 'echo',
  speed: 'normal',
  pitch: 'normal',
  emphasis: 'moderate',
  style: 'conversational',
  styleDegree: 'normal'
}

// ====================
// OpenAI Service Class
// ====================

/**
 * Handles LLM interactions and API calls with the OpenAI API.
 * @param {string} apiKey - The API key for the OpenAI API
 * @param {LLMCostEstimator | undefined} costEstimator - The cost estimator to use
 * @returns {OpenAIService} - The OpenAI service instance
 */
export class OpenAIService {
  private openai: OpenAI;
  public defaultModel: SupportedModel = DEFAULT_MODEL;
  private costEstimator: LLMCostEstimator | null = null;

  constructor(apiKey: string, costEstimator?: LLMCostEstimator) {
    this.openai = new OpenAI({ apiKey });
    this.costEstimator = costEstimator ?? null;
    if (this.costEstimator) {
      logger.debug('OpenAIService initialized with cost estimator');
    }
    ensureDirectories();
  }

  /**
   * Generates a response from the OpenAI API.
   * Entry point for unspecified model types.
   * @param {SupportedModel} model - The model to use
   * @param {OpenAIMessage[]} messages - The messages to send to the OpenAI API
   * @param {OpenAIOptions} options - The options for the OpenAI API
   * @returns {Promise<OpenAIResponse>} - The response from the OpenAI API
   */
  public async generateResponse(
    model: SupportedModel = this.defaultModel,
    messages: OpenAIMessage[],
    options: OpenAIOptions = {}
  ): Promise<OpenAIResponse> {
    // Currently only GPT-5 models are supported, as they are the most current and cost-effective.
    //TODO: Add support for other model types
    return this.generateGPT5Response(model as GPT5ModelType, messages, {
      ...options,
      reasoningEffort: this.normalizeReasoningEffort(options.reasoningEffort)
    });
  }

  private normalizeReasoningEffort(value: OpenAIOptions['reasoningEffort']): OpenAIOptions['reasoningEffort'] {
    if (value === 'minimal') {
      // Responses API for gpt-5.x supports none/low/medium/high/xhigh; map minimal to low to stay in-range.
      return 'low';
    }
    return value;
  }

  /**
   * Generates a response from the OpenAI API using GPT-5 models.
   * @param {GPT5ModelType} model - The GPT-5 model to use
   * @param {OpenAIMessage[]} messages - The messages to send to the OpenAI API
   * @param {OpenAIOptions} options - The options for the OpenAI API
   * @returns {Promise<OpenAIResponse>} - The response from the OpenAI API
   */
  private async generateGPT5Response(
    model: GPT5ModelType,
    messagesInput: OpenAIMessage[],
    options: OpenAIOptions
  ): Promise<OpenAIResponse> {
    const { reasoningEffort = 'low', verbosity = 'low' } = options;

    try {
      const buildInputMessage = (role: OpenAIMessage['role'], text: string) => ({
        role,
        type: 'message' as const,
        // Use string content for assistant history to stay within ResponseInput types.
        content: role === 'assistant'
          ? text
          : [{ type: 'input_text' as const, text }]
      });

      // Map messages for the OpenAI Responses API
      const messages = messagesInput.map(msg => buildInputMessage(msg.role, msg.content));

      // Validate messages before sending to OpenAI
      const validMessages = messages.filter(msg => {
        const contentText = typeof msg.content === 'string'
          ? msg.content
          : msg.content?.[0]?.text;
        if (!contentText || typeof contentText !== 'string' || contentText.trim() === '') {
          logger.warn(`Filtering out invalid message: ${JSON.stringify(msg)}`);
          return false;
        }
        return true;
      });

      const tools: OpenAITool[] = []; // Initialize tools array
      const doingWebSearch = typeof options.tool_choice === 'object' && 
                              options.tool_choice !== null && 
                              options.tool_choice.type === 'web_search';
      
      // Add web search tool if enabled
      if (doingWebSearch) {
        const webSearchTool: OpenAIWebSearchTool = {
          type: 'web_search',
        };

        // Add optional web search parameters
        if (options.webSearch?.allowedDomains?.length) {
          webSearchTool.filters = {
            allowed_domains: options.webSearch.allowedDomains
          };
        }

        if (options.webSearch?.searchContextSize) {
          webSearchTool.search_context_size = options.webSearch.searchContextSize;
        }

        if (options.webSearch?.userLocation) {
          webSearchTool.user_location = {
            ...options.webSearch.userLocation
          };
        }

        tools.push(webSearchTool);
      }

      // Add function tools if any (separate from web search tool)
      if (options.functions?.length) {
        tools.push(...options.functions.map(fn => ({
          type: 'function' as const,
          name: fn.name,
          description: fn.description || '',
          parameters: fn.parameters || {},
          strict: false
        })));
      }

      // Create request payload to pass to OpenAI
      const requestPayload: ResponseCreateParams = {
        model,
        input: [
          ...validMessages,
          ...(doingWebSearch ? [{
            role: 'system' as const,
            type: 'message' as const,
            content: [{
              type: 'input_text' as const,
              text: `The planner instructed you to perform a web search for: ${options.webSearch?.query}`
            }]
          }] : []),
          //...(options.ttsOptions ? [{ role: 'system' as const, content: `This message will be read as TTS. If appropriate, add a little emphasis with italics (wrap with *), bold (wrap with **), and/or UPPERCASE (shouting).` }] : []) 
          // TODO: This system message is always appended, even when TTS is not enabled. Consider adding logic to only include it if TTS options are present.
        ],
        ...(reasoningEffort && { reasoning: { effort: reasoningEffort } }),
        ...(verbosity && { text: { verbosity } }),
        ...(tools.length > 0 && { tools: tools as ResponseCreateParams['tools'] })
      };

      const toolNames = tools
        .filter(isFunctionTool)
        .map(tool => tool.name);
      const toolTypes = Array.from(new Set(tools.map(tool => tool?.type).filter(Boolean)));
      const requestMetadata = {
        model,
        messageCount: validMessages.length,
        toolCount: tools.length,
        toolTypes,
        ...(toolNames.length > 0 && { toolNames })
      };

      logger.debug('Generating AI response', requestMetadata);

      // Generate response
      const response = await this.openai.responses.create(requestPayload);

      // Get output items from response
      const outputItems = response.output as ResponseOutputItemExtended[];

      // Find the assistant's message and web search results
      let rawOutputText = '';
      let finishReason = 'stop';
      const annotationCitations: Array<{url: string; title: string; text: string}> = [];

      for (const item of outputItems ?? []) {
        // Handle message with citations
        if (item.type === 'message' && item.role === 'assistant' && item.content) {
          const textContent = item.content.find(c => c.type === 'output_text');
          if (textContent?.text) {
            rawOutputText = textContent.text;
            
            // Extract citations if any
            if (textContent.annotations?.length) {
              for (const annotation of textContent.annotations) {
                if (annotation.type === 'url_citation' && annotation.url) {
                  annotationCitations.push({
                    url: annotation.url,
                    title: annotation.title || 'Source',
                    text: rawOutputText.slice(annotation.start_index, annotation.end_index)
                  });
                }
              }
            }
          }
          finishReason = item.finish_reason || finishReason;
          break;
        }
      }

      // Fall back to output_text if no message found
      if (!rawOutputText) {
        const firstTextItem = outputItems.find(
          i => i.type === 'output_text' && i.content?.[0]?.text?.trim()
        );
        rawOutputText = firstTextItem?.content?.[0]?.text ?? '';
        finishReason = firstTextItem?.finish_reason ?? finishReason;
      }

      // Handle function calls if any
      let parsedFunctionCall: { name: string; arguments: string } | null = null;
      for (const item of outputItems ?? []) {
        if ((item.type === 'function_call' || item.type === 'tool_calls') && item.name) {
          parsedFunctionCall = { 
            name: item.name, 
            arguments: item.arguments || '{}' 
          };
          break;
        }
      }

      // Separate the conversational reply from the metadata JSON appended by the LLM
      const { text: conversationalText, metadata: assistantMetadata } = this.extractTextAndMetadata(rawOutputText);

      // Prefer metadata-provided citations; fall back to annotations when the JSON block is missing or incomplete
      const normalizedCitations = assistantMetadata?.citations?.length
        ? assistantMetadata.citations.map(citation => ({
            url: citation.url.toString(),
            title: citation.title,
            text: citation.snippet ?? ''
          }))
        : annotationCitations;

      const responsePayload: OpenAIResponse = {
        normalizedText: conversationalText,
        message: {
          role: 'assistant',
          content: conversationalText,
          ...(parsedFunctionCall && { function_call: parsedFunctionCall }),
          ...(normalizedCitations.length > 0 && { citations: normalizedCitations })
        },
        finish_reason: finishReason,
        usage: (() => {
          const inputTokens = response.usage?.input_tokens ?? 0;
          const outputTokens = response.usage?.output_tokens ?? 0;
          const cost = estimateTextCost(model, inputTokens, outputTokens);
          return {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            total_tokens: inputTokens + outputTokens,
            cost: formatUsd(cost.totalCost)
          };
        })()
      };

      if (assistantMetadata) {
        responsePayload.metadata = assistantMetadata;
      }

      if (this.costEstimator && response.usage) {
        try {
          const breakdown: ModelCostBreakdown = createCostBreakdown(
            model,
            response.usage.input_tokens ?? 0,
            response.usage.output_tokens ?? 0,
            options.channelContext?.channelId,
            options.channelContext?.guildId
          );
          this.costEstimator.recordCost(breakdown);
        } catch (error) {
          logger.error(
            `Cost estimator failed in generateGPT5Response: ${(error as Error)?.message ?? error}`
          );
        }
      }

      return responsePayload;

    } catch (error) {
      logger.error('Error in generateGPT5Response:', error);
      throw error;
    }
  }

  /**
   * Splits the assistant's raw reply into the human-facing body and the optional `<ARETE_METADATA>{...}` payload.
   * If parsing fails we drop the marker so users never see stray debug text.
   * @param {string} rawOutputText - The raw output text from the OpenAI API
   * @returns {text: string; metadata: AssistantMetadataPayload | null} - The text and metadata from the OpenAI API
   */
  private extractTextAndMetadata(rawOutputText: string): { text: string; metadata: AssistantMetadataPayload | null } {
    if (!rawOutputText) {
      return { text: '', metadata: null };
    }

    const markerIndex = rawOutputText.lastIndexOf(METADATA_MARKER);
    if (markerIndex === -1) {
      logger.warn('No metadata marker detected in assistant response; returning plain-text reply.');
      return { text: rawOutputText.trimEnd(), metadata: null };
    }

    const conversationalPortion = rawOutputText.slice(0, markerIndex).trimEnd();
    let metadataCandidate = rawOutputText.slice(markerIndex + METADATA_MARKER.length).trim();

    // Sanitize common code-fence wrappers, stray backticks, and zero-width spaces
    metadataCandidate = this.stripJsonFences(metadataCandidate);

    if (!metadataCandidate) {
      logger.warn('Metadata marker detected without JSON payload; ignoring metadata block.');
      return { text: conversationalPortion, metadata: null };
    }

    try {
      const parsed = JSON.parse(metadataCandidate);
      const normalized = this.normalizeAssistantMetadata(parsed);
      return { text: conversationalPortion, metadata: normalized };
    } catch (error) {
      logger.warn('Failed to parse assistant metadata payload; returning plain-text reply.', error);
      return { text: conversationalPortion, metadata: null };
    }
  }

  /**
   * Validates the JSON metadata payload.
   * Coerces citation URLs into `URL` objects and discards malformed entries.
   * @param {unknown} candidate - The candidate metadata payload to normalize
   * @returns {AssistantMetadataPayload | null} - The normalized metadata payload
   */
  private normalizeAssistantMetadata(candidate: unknown): AssistantMetadataPayload | null {
    if (!candidate || typeof candidate !== 'object') {
      logger.warn('Assistant metadata payload is not an object; ignoring.');
      return null;
    }

    const record = candidate as Record<string, unknown>;
    const citations: AssistantMetadataCitation[] = [];

    if (Array.isArray(record.citations)) {
      for (const rawCitation of record.citations) {
        if (!rawCitation || typeof rawCitation !== 'object') {
          continue;
        }

        const citationRecord = rawCitation as Record<string, unknown>;
        if (typeof citationRecord.url !== 'string') {
          continue;
        }

        try {
          const normalizedUrl = new URL(citationRecord.url);
          citations.push({
            title: typeof citationRecord.title === 'string' && citationRecord.title.trim()
              ? citationRecord.title.trim()
              : 'Source',
            url: normalizedUrl,
            snippet: typeof citationRecord.snippet === 'string' && citationRecord.snippet.trim()
              ? citationRecord.snippet
              : undefined
          });
        } catch {
          logger.warn(`Skipping invalid citation URL "${citationRecord.url}" from metadata payload.`);
        }
      }
    }

    // Tighten and coerce fields according to verification notes
    // Allowed provenance values
    const allowedProvenance: Set<ProvenanceValue> = new Set(['Retrieved', 'Inferred', 'Speculative']);

    // Provenance: accept only allowed values
    const provenance: ProvenanceValue | undefined = typeof record.provenance === 'string' && allowedProvenance.has(record.provenance as ProvenanceValue)
      ? (record.provenance as ProvenanceValue)
      : undefined;

    // Confidence: clamp numeric values to [0,1]
    let confidence: number | undefined = undefined;
    if (typeof record.confidence === 'number' && !Number.isNaN(record.confidence) && isFinite(record.confidence)) {
      confidence = Math.min(1, Math.max(0, record.confidence));
    }

    // tradeoffCount: coerce to integer >= 0
    let tradeoffCount: number | undefined = undefined;
    if (record.tradeoffCount !== undefined && record.tradeoffCount !== null) {
      const asNumber = typeof record.tradeoffCount === 'number'
        ? record.tradeoffCount
        : typeof record.tradeoffCount === 'string'
          ? Number(record.tradeoffCount)
          : NaN;
      const intVal = Number.isFinite(asNumber) ? Math.trunc(asNumber) : NaN;
      tradeoffCount = Number.isNaN(intVal) || intVal < 0 ? 0 : intVal;
    }

    const metadata: AssistantMetadataPayload = {
      provenance,
      confidence,
      tradeoffCount,
      citations,
      rawPayload: candidate
    };

    // Drop empty payloads so downstream code can rely on `null` to signal "no metadata supplied"
    if (
      metadata.provenance === undefined &&
      metadata.confidence === undefined &&
      metadata.tradeoffCount === undefined &&
      metadata.citations.length === 0
    ) {
      logger.warn('Assistant metadata payload is empty, ignoring: ', candidate);
      return null;
    }

    return metadata;
  }

  /**
   * Remove common code fences and stray backticks/zero-width spaces from a JSON candidate string.
   * This helps defensive parsing when LLMs wrap JSON in ``` or add stray characters.
   */
  private stripJsonFences(input: string): string {
    if (!input || typeof input !== 'string') return input;

    // Remove Unicode zero-width characters that sometimes sneak in
    const ZERO_WIDTH_RE = /[\u200B-\u200D\uFEFF]/g;
    let s = input.replace(ZERO_WIDTH_RE, '').trim();

    // Remove leading/trailing single or double backticks
    s = s.replace(/^`+|`+$/g, '').trim();

    // Remove triple-backtick fenced blocks: ```json ... ``` or ``` ... ```
    // Match optional language after opening fence
    const fenceMatch = s.match(/^```(?:json|js|text)?\s*([\s\S]*?)\s*```$/i);
    if (fenceMatch && fenceMatch[1]) {
      s = fenceMatch[1].trim();
    }

    return s;
  }

  /**
   * Generates a speech file using the OpenAI API.
   * @param {string} input - The input text to convert to speech
   * @param {TTSOptions} instructions - The instructions for the TTS
   * @param {string} filename - The name of the output file
   * @param {string} format - The format of the output file
   * @returns {Promise<string>} - The path to the generated speech file
   */
  public async generateSpeech(
    input: string, 
    instructions: TTSOptions,
    filename: string, 
    format: 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm') {
    //https://platform.openai.com/docs/guides/text-to-speech
    if (!filename || !/^[\w-]+$/.test(filename)) {
      throw new Error('Invalid filename. Only alphanumeric characters, hyphens, and underscores are allowed.');
    }
    
    const outputPath = path.join(TTS_OUTPUT_PATH, `${filename}.${format}`);

    logger.debug(`Generating speech file: ${outputPath}...`);
    logger.debug(`Using TTS options: ${JSON.stringify(instructions)}`);

    try {
      const mp3 = await this.openai.audio.speech.create({
        model: instructions.model,
        voice: instructions.voice,
        input: input,
        instructions: `Speed: ${instructions.speed}, Pitch: ${instructions.pitch}, Emphasis: ${instructions.emphasis}, Style: ${instructions.style}, Style weight: ${instructions.styleDegree}, Other style notes: ${instructions.styleNote}`,
        response_format: format,
      });

      const buffer = Buffer.from(await mp3.arrayBuffer());
      await fs.promises.writeFile(outputPath, buffer);
      logger.debug(`Generated speech file: ${outputPath}`);
      return outputPath;
    } catch (error) {
      // Clean up partially written file if it exists
      try {
        if (fs.existsSync(outputPath)) {
          await fs.promises.unlink(outputPath);
        }
      } catch (cleanupError) {
        logger.error('Failed to clean up file after error:', cleanupError);
      }
      throw error;
    }
  }

  /**
   * Generates a description of an image using the OpenAI API.
   * @param {string} imageUrl - The URL of the image to describe
   * @param {string} context - The context to use for the description
   * @param channelContext - Optional channel attribution for cost tracking
   * @returns {Promise<OpenAIResponse>} - The response from the OpenAI API
   */
  public async generateImageDescription(
    imageUrl: string, // URL from Discord attachment
    context?: string,
    channelContext?: { channelId: string; guildId?: string }
  ): Promise<OpenAIResponse> {
    try {
      const imageDescriptionResult = await generateImageDescriptionRequest(this.openai, {
        imageUrl,
        context,
        model: IMAGE_DESCRIPTION_MODEL
      });

      const imageDescriptionResponse = imageDescriptionResult.response;
      if (imageDescriptionResponse.usage) {
        const inputTokens = imageDescriptionResponse.usage.input_tokens;
        const outputTokens = imageDescriptionResponse.usage.output_tokens;
        const cost = estimateTextCost(IMAGE_DESCRIPTION_MODEL as TextModelPricingKey, inputTokens, outputTokens);
        imageDescriptionResponse.usage.cost = formatUsd(cost.totalCost);
      }

      if (this.costEstimator && imageDescriptionResult.usage) {
        try {
          const breakdown: ModelCostBreakdown = createCostBreakdown(
            IMAGE_DESCRIPTION_MODEL as TextModelPricingKey,
            imageDescriptionResult.usage.promptTokens,
            imageDescriptionResult.usage.completionTokens,
            channelContext?.channelId,
            channelContext?.guildId
          );
          this.costEstimator.recordCost(breakdown);
        } catch (error) {
          logger.error(
            `Cost estimator failed in generateImageDescription: ${(error as Error)?.message ?? error}`
          );
        }
      }
      logger.debug(`Image description generated: ${imageDescriptionResponse.message?.content}${imageDescriptionResponse.usage ? ` (Cost: ${imageDescriptionResponse.usage.cost})` : ''}`);
      return imageDescriptionResponse;
    } catch (error) {
      logger.error('Error generating image description:', error);
      throw new Error(`Failed to process image: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Embeds text using the default embedding model.
   * @param text The text to embed.
   * @returns A Promise that resolves to an array of numbers representing the embedding.
   */
  public async embedText(text: string, dimensions: number = 1024): Promise<number[]> {
    const embedding = await this.openai.embeddings.create({
      model: DEFAULT_EMBEDDING_MODEL,
      input: text,
      dimensions
    });

    if (this.costEstimator) {
      try {
        const promptTokens =
          embedding.usage?.prompt_tokens ??
          Math.max(1, Math.ceil(text.length / 4)); // Rough heuristic when API omits usage; ~4 chars per token.
        const breakdown = createCostBreakdown(
          DEFAULT_EMBEDDING_MODEL as TextModelPricingKey,
          promptTokens,
          0,
          undefined,
          undefined
        );
        this.costEstimator.recordCost(breakdown);
      } catch (error) {
        logger.error(`Cost estimator failed in embedText: ${(error as Error)?.message ?? error}`);
      }
    }

    return embedding.data[0].embedding;
  }

  /**
   * Reduces the provided array of OpenAI messages to minimal summaries.
   * If the input string is sufficiently short, it is returned as-is.
   * Otherwise, it is summarized.
   * @param context The context to reduce.
   * @returns The reduced context.
   */
  public async reduceContext(context: OpenAIMessage[]): Promise<OpenAIMessage[]> {
    /*
    * How it works: 
    * 1. Iterate over the input context. For each string:
    *    a. If the string is less than REDUCE_OVER_N_CHARCTERS, pass it through unchanged
    *    b. Otherwise the string is big and needs summarizing: Store the index of the message to summarize later
    * 2. If there are any messages that need summarizing, summarize them all at once with an LLM call
    * 3. Return the reduced context
    */
   // TODO: Output is inconsistent - We usually get the warning "number of summaries does not match number of messages to summarize". Consider implementing a tool call to get consistent output.

    const REDUCE_OVER_N_CHARCTERS = 999999; //1024; 
    //TODO: reevaluate the threshold for summarization; Discord's message length limit (2048 characters) is too small, so we might need a system for analyzing groups of messages from a single user rather than summarizing each message individually.
    const REDUCTION_MODEL: GPT5ModelType = 'gpt-5-nano';
    const summarizerPrompt = renderPrompt('discord.summarizer.system').content;

    let reducedContext = context; // Set the initial value of reducedContext to the input context; we'll modify it in place
    let messageIndexesToReduce: number[] = []; // We'll store the index of large messages that need summarizing, so we can summarize all at once

    // Iterate over the input context. For each string:
    for (let i = 0; i < context.length; i++) {
      // If the string is less than REDUCE_OVER_N_CHARCTERS, pass it through unchanged
      if (context[i].content.length < REDUCE_OVER_N_CHARCTERS) { continue; }
      else {
        // Otherwise the string is big and needs summarizing: Store the index of the message to summarize later
        messageIndexesToReduce.push(i);
      }
    }

    // If there are any messages that need summarizing, summarize them all at once
    if (messageIndexesToReduce.length > 0) {
      logger.debug(`Reducing context for ${messageIndexesToReduce.length} messages`);

      // Give the LLM a list of strings delimited by newlines, and ask it to summarize each and return it in the same order/format
      const messagesToSummarize = messageIndexesToReduce.map(i => context[i]);
      try {
        const response = await this.openai.chat.completions.create({
          model: REDUCTION_MODEL,
          messages: [
            { role: "system", content: summarizerPrompt },
            { role: "user", content: messagesToSummarize.map(m => m.content).join('\n\n') }
          ]
        });

        // Summaries recieved - replace the original messages with the summaries
        if (response.choices[0].message.content) {
          logger.debug(`Original context: ${JSON.stringify(context)}`);
          logger.debug(`Summaries: ${JSON.stringify(response.choices[0].message.content)}`);

          // Normalize the summarizer output into an array of summaries
          // The LLM is instructed to prefix each summary with markers like "[reduced-0]"
          const summaries = response.choices[0].message.content
            // Split on the full marker pattern so the first element is never empty
            .split(/\[reduced-\d+\]\s*/g)
            // Trim extra whitespace that may occur between summaries
            .map(summary => summary.trim())
            // Remove empty strings in case the model adds trailing whitespace
            .filter(summary => summary.length > 0);

          // Ensure that the number of summaries matches the number of messages to summarize
          if (summaries.length !== messageIndexesToReduce.length) {
            logger.warn(`Number of summaries (${summaries.length}) does not match number of messages to summarize (${messageIndexesToReduce.length})`);
          }
          
          // Replace the original messages with the summaries, preserving the original role, and noting that it was summarized
          for (let i = 0; i < messageIndexesToReduce.length; i++) {
            // If a summary is missing (e.g., malformed response), fall back to the original message
            const summaryContent = summaries[i] ?? context[messageIndexesToReduce[i]].content;
            reducedContext[messageIndexesToReduce[i]] = {
              role: context[messageIndexesToReduce[i]].role,
              content: `<summarized> ${summaryContent}`
            };
          }

          logger.debug(`Reduced context: ${JSON.stringify(reducedContext)}`);

          // Log the estimated cost of the reduction
          const reductionCost = estimateTextCost(
            REDUCTION_MODEL as GPT5ModelType,
            response.usage?.prompt_tokens || 0,
            response.usage?.completion_tokens || 0
          );
          logger.debug(`Estimated cost of reduction: ${formatUsd(reductionCost.totalCost)}`);
          if (this.costEstimator && response.usage) {
            try {
              const breakdown: ModelCostBreakdown = createCostBreakdown(
                REDUCTION_MODEL as GPT5ModelType,
                response.usage.prompt_tokens || 0,
                response.usage.completion_tokens || 0,
                undefined,
                undefined
              );
              this.costEstimator.recordCost(breakdown);
            } catch (error) {
              logger.error(
                `Cost estimator failed in reduceContext: ${(error as Error)?.message ?? error}`
              );
            }
          }
        }
      } catch (error) {
        logger.error('Error reducing context:', error);
      }
    } else {
      logger.debug('No messages to summarize');
    }
    
    return reducedContext;
  }
}

/**
 * Ensures that the output directories exist.
 * @returns {Promise<void>} - A promise that resolves when the directories are created
 */
async function ensureDirectories(): Promise<void> {
  if (isDirectoryInitialized) return;
  
  try {
    await fs.promises.mkdir(OUTPUT_PATH, { recursive: true });
    await fs.promises.mkdir(TTS_OUTPUT_PATH, { recursive: true });
    isDirectoryInitialized = true;
  } catch (error) {
    logger.error('Failed to create output directories:', error);
    throw new Error('Failed to initialize output directories');
  }
}

