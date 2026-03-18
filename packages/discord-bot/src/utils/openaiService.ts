/**
 * @description: Handles all LLM interactions and API calls with high cost/resource impact.
 * @footnote-scope: core
 * @footnote-module: OpenAIService
 * @footnote-risk: high - API failures can break AI functionality or cause unexpected costs. Manages all OpenAI API communication including chat completions, embeddings, TTS, and image analysis.
 * @footnote-ethics: high - Manages cost tracking and API usage transparency. Every API call must be logged and cost-tracked to ensure responsible resource consumption and auditability.
 */

import { fileURLToPath } from 'url';
import path, { dirname } from 'path';
import fs from 'fs';
import OpenAI from 'openai';
import type { ResponseCreateParamsNonStreaming } from 'openai/resources/responses/responses.js';
import { logger } from './logger.js';
import { ActivityOptions } from 'discord.js';
import {
    estimateTextCost,
    formatUsd,
    createCostBreakdown,
    type GPT5ModelType,
    type ModelCostBreakdown,
    type TextModelPricingKey,
} from './pricing.js';
import type { LLMCostEstimator } from './LLMCostEstimator.js';
import { generateImageDescriptionRequest } from './imageProcessing/imageDescription.js';
import {
    IMAGE_DESCRIPTION_CONFIG,
    type ImageDescriptionModelType,
} from '../constants/imageProcessing.js';

// ====================
// Type Declarations
// ====================

type ResponseCreateParams = ResponseCreateParamsNonStreaming;

export type { GPT5ModelType } from './pricing.js';
/**
 * Text generation model identifiers accepted by the Discord bot service layer.
 */
export type SupportedModel = GPT5ModelType;
/**
 * Embedding model identifiers used by the bot for vector-style lookups.
 */
export type EmbeddingModelType = 'text-embedding-3-small'; // Dimensions: 1546
/**
 * Planner hint describing why a web search should run.
 */
export type WebSearchIntent = 'repo_explainer' | 'current_facts';
/**
 * Focus areas used to expand repository-explainer searches with domain terms.
 */
export type RepoSearchHint =
    | 'architecture'
    | 'backend'
    | 'contracts'
    | 'discord'
    | 'images'
    | 'onboarding'
    | 'web'
    | 'observability'
    | 'openapi'
    | 'prompts'
    | 'provenance'
    | 'reflect'
    | 'traces'
    | 'voice';

// Defines the structure of a message to be sent to the OpenAI API
/**
 * Minimal chat message format used by the bot before requests are translated to
 * provider-specific payloads.
 */
export interface OpenAIMessage {
    role: 'user' | 'assistant' | 'system' | 'developer';
    content: string;
}

// Defines the options for text-to-speech
/**
 * Options that shape TTS voice, pacing, and expressive style.
 */
export type TTSOptions = {
    model: 'tts-1' | 'tts-1-hd' | 'gpt-4o-mini-tts';
    voice:
        | 'alloy'
        | 'ash'
        | 'ballad'
        | 'coral'
        | 'echo'
        | 'fable'
        | 'nova'
        | 'onyx'
        | 'sage'
        | 'shimmer';
    speed?: 'slow' | 'normal' | 'fast';
    pitch?: 'low' | 'normal' | 'high';
    emphasis?: 'none' | 'moderate' | 'strong';
    style?: 'casual' | 'narrative' | 'cheerful' | 'sad' | 'angry' | string;
    styleDegree?: 'low' | 'normal' | 'high';
    styleNote?: string;
};

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
        searchIntent?: WebSearchIntent;
        repoHints?: RepoSearchHint[];
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
    tool_choice?:
        | {
              type: 'function';
              function: { name: string };
          }
        | {
              type: 'web_search';
              function?: { name: string };
          }
        | {
              type: 'none';
          }
        | 'none'
        | 'auto'
        | 'web_search'
        | null;
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
};

type OpenAITool = OpenAIWebSearchTool | OpenAIFunctionTool;

const isFunctionTool = (tool: OpenAITool): tool is OpenAIFunctionTool =>
    tool.type === 'function';

const FOOTNOTE_REPO_OWNER = 'footnote-ai';
const FOOTNOTE_REPO_NAME = 'footnote';
const FOOTNOTE_REPO_SLUG = `${FOOTNOTE_REPO_OWNER}/${FOOTNOTE_REPO_NAME}`;
const DEEPWIKI_FOOTNOTE_URL = 'https://deepwiki.com/footnote-ai/footnote';
const REPO_HINT_QUERY_TERMS: Record<RepoSearchHint, string[]> = {
    architecture: ['architecture'],
    backend: ['backend'],
    contracts: ['contracts'],
    discord: ['discord'],
    images: ['image generation'],
    onboarding: ['onboarding', 'getting started'],
    web: ['web'],
    observability: ['observability'],
    openapi: ['openapi'],
    prompts: ['prompts'],
    provenance: ['provenance'],
    reflect: ['reflect'],
    traces: ['traces'],
    voice: ['voice'],
};

function dedupeSearchTerms(terms: string[]): string[] {
    const seen = new Set<string>();
    const uniqueTerms: string[] = [];

    for (const term of terms) {
        const normalizedTerm = term.trim().toLowerCase();
        if (!normalizedTerm || seen.has(normalizedTerm)) {
            continue;
        }

        seen.add(normalizedTerm);
        uniqueTerms.push(term.trim());
    }

    return uniqueTerms;
}

/**
 * Builds a search query tuned for explaining the Footnote repository, including
 * repo identity terms and any planner-supplied focus hints.
 */
export function buildRepoExplainerQuery(
    webSearch: OpenAIOptions['webSearch']
): string {
    const rawQuery = webSearch?.query?.trim() ?? '';
    const hintTerms =
        webSearch?.repoHints?.flatMap(
            (hint) => REPO_HINT_QUERY_TERMS[hint] ?? [hint]
        ) ?? [];

    return dedupeSearchTerms([
        FOOTNOTE_REPO_SLUG,
        FOOTNOTE_REPO_OWNER,
        FOOTNOTE_REPO_NAME,
        'DeepWiki',
        ...hintTerms,
        rawQuery,
    ]).join(' ');
}

/**
 * Produces the system instruction that tells the model how to use web search
 * for the current request.
 */
export function buildWebSearchInstruction(
    webSearch: OpenAIOptions['webSearch']
): string {
    const query = webSearch?.query?.trim() ?? '';

    if (webSearch?.searchIntent === 'repo_explainer') {
        const repoQuery = buildRepoExplainerQuery(webSearch);
        const hintText =
            webSearch.repoHints && webSearch.repoHints.length > 0
                ? ` Focus areas: ${webSearch.repoHints.join(', ')}.`
                : '';

        return [
            'The planner marked this as a Footnote repository explanation lookup.',
            `Treat ${FOOTNOTE_REPO_SLUG} as the canonical repo identity for this search.`,
            `Prefer DeepWiki results from ${DEEPWIKI_FOOTNOTE_URL} when they are relevant.`,
            'If DeepWiki coverage is thin, use broader web context instead of getting stuck.',
            `Search query: ${repoQuery}.${hintText}`.trim(),
            `Original planner query: ${query}.`,
        ].join(' ');
    }

    return `The planner instructed you to perform a web search for: ${query}`;
}

// ====================
// Constants / Variables
// ====================

const DEFAULT_GPT5_MODEL: SupportedModel = 'gpt-5-mini';
const DEFAULT_MODEL: SupportedModel = DEFAULT_GPT5_MODEL;
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const OUTPUT_PATH = path.resolve(__dirname, '..', 'output');
const TTS_OUTPUT_PATH = path.join(OUTPUT_PATH, 'tts');
/**
 * Model used for image-description fallback when attachments need text context.
 */
export const IMAGE_DESCRIPTION_MODEL: ImageDescriptionModelType =
    IMAGE_DESCRIPTION_CONFIG.model;
/**
 * Default embedding model used for text vectorization helpers.
 */
export const DEFAULT_EMBEDDING_MODEL: EmbeddingModelType =
    'text-embedding-3-small';
let isDirectoryInitialized = false; // Tracks if output directories have been initialized

/**
 * Default TTS settings used when callers do not provide voice overrides.
 */
export const TTS_DEFAULT_OPTIONS: TTSOptions = {
    model: 'gpt-4o-mini-tts',
    voice: 'echo',
    speed: 'normal',
    pitch: 'normal',
    emphasis: 'moderate',
    style: 'conversational',
    styleDegree: 'normal',
};

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
            reasoningEffort: this.normalizeReasoningEffort(
                options.reasoningEffort
            ),
        });
    }

    private normalizeReasoningEffort(
        value: OpenAIOptions['reasoningEffort']
    ): OpenAIOptions['reasoningEffort'] {
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
            const buildInputMessage = (
                role: OpenAIMessage['role'],
                text: string
            ) => ({
                role,
                type: 'message' as const,
                // Use string content for assistant history to stay within ResponseInput types.
                content:
                    role === 'assistant'
                        ? text
                        : [{ type: 'input_text' as const, text }],
            });

            // Map messages for the OpenAI Responses API
            const messages = messagesInput.map((msg) =>
                buildInputMessage(msg.role, msg.content)
            );

            // Validate messages before sending to OpenAI
            const validMessages = messages.filter((msg) => {
                const contentText =
                    typeof msg.content === 'string'
                        ? msg.content
                        : msg.content?.[0]?.text;
                if (
                    !contentText ||
                    typeof contentText !== 'string' ||
                    contentText.trim() === ''
                ) {
                    logger.warn(
                        `Filtering out invalid message: ${JSON.stringify(msg)}`
                    );
                    return false;
                }
                return true;
            });

            const tools: OpenAITool[] = []; // Initialize tools array
            const doingWebSearch =
                typeof options.tool_choice === 'object' &&
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
                        allowed_domains: options.webSearch.allowedDomains,
                    };
                }

                if (options.webSearch?.searchContextSize) {
                    webSearchTool.search_context_size =
                        options.webSearch.searchContextSize;
                }

                if (options.webSearch?.userLocation) {
                    webSearchTool.user_location = {
                        ...options.webSearch.userLocation,
                    };
                }

                tools.push(webSearchTool);
            }

            // Add function tools if any (separate from web search tool)
            if (options.functions?.length) {
                tools.push(
                    ...options.functions.map((fn) => ({
                        type: 'function' as const,
                        name: fn.name,
                        description: fn.description || '',
                        parameters: fn.parameters || {},
                    }))
                );
            }

            // Create request payload to pass to OpenAI
            const requestPayload: ResponseCreateParams = {
                model,
                input: [
                    ...validMessages,
                    ...(doingWebSearch
                        ? [
                              {
                                  role: 'system' as const,
                                  type: 'message' as const,
                                  content: [
                                      {
                                          type: 'input_text' as const,
                                          text: buildWebSearchInstruction(
                                              options.webSearch
                                          ),
                                      },
                                  ],
                              },
                          ]
                        : []),
                    //...(options.ttsOptions ? [{ role: 'system' as const, content: `This message will be read as TTS. If appropriate, add a little emphasis with italics (wrap with *), bold (wrap with **), and/or UPPERCASE (shouting).` }] : [])
                    // TODO: This system message is always appended, even when TTS is not enabled. Consider adding logic to only include it if TTS options are present.
                ],
                ...(reasoningEffort && {
                    reasoning: { effort: reasoningEffort },
                }),
                ...(verbosity && { text: { verbosity } }),
                ...(tools.length > 0 && {
                    tools: tools as ResponseCreateParams['tools'],
                }),
            };

            const toolNames = tools
                .filter(isFunctionTool)
                .map((tool) => tool.name);
            const toolTypes = Array.from(
                new Set(tools.map((tool) => tool?.type).filter(Boolean))
            );
            const requestMetadata = {
                model,
                messageCount: validMessages.length,
                toolCount: tools.length,
                toolTypes,
                ...(toolNames.length > 0 && { toolNames }),
            };

            logger.debug('Generating AI response', requestMetadata);

            // Generate response
            const response = await this.openai.responses.create(requestPayload);

            // Get output items from response
            const outputItems = response.output as ResponseOutputItemExtended[];

            // Find the assistant's message and web search results
            let rawOutputText = '';
            let finishReason = 'stop';
            const annotationCitations: Array<{
                url: string;
                title: string;
                text: string;
            }> = [];

            for (const item of outputItems ?? []) {
                // Handle message with citations
                if (
                    item.type === 'message' &&
                    item.role === 'assistant' &&
                    item.content
                ) {
                    const textContent = item.content.find(
                        (c) => c.type === 'output_text'
                    );
                    if (textContent?.text) {
                        rawOutputText = textContent.text;

                        // Extract citations if any
                        if (textContent.annotations?.length) {
                            for (const annotation of textContent.annotations) {
                                if (
                                    annotation.type === 'url_citation' &&
                                    annotation.url
                                ) {
                                    annotationCitations.push({
                                        url: annotation.url,
                                        title: annotation.title || 'Source',
                                        text: rawOutputText.slice(
                                            annotation.start_index,
                                            annotation.end_index
                                        ),
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
                    (i) =>
                        i.type === 'output_text' && i.content?.[0]?.text?.trim()
                );
                rawOutputText = firstTextItem?.content?.[0]?.text ?? '';
                finishReason = firstTextItem?.finish_reason ?? finishReason;
            }

            // Handle function calls if any
            let parsedFunctionCall: { name: string; arguments: string } | null =
                null;
            for (const item of outputItems ?? []) {
                if (
                    (item.type === 'function_call' ||
                        item.type === 'tool_calls') &&
                    item.name
                ) {
                    parsedFunctionCall = {
                        name: item.name,
                        arguments: item.arguments || '{}',
                    };
                    break;
                }
            }

            const conversationalText = rawOutputText.trimEnd();
            const normalizedCitations = annotationCitations;

            const responsePayload: OpenAIResponse = {
                normalizedText: conversationalText,
                message: {
                    role: 'assistant',
                    content: conversationalText,
                    ...(parsedFunctionCall && {
                        function_call: parsedFunctionCall,
                    }),
                    ...(normalizedCitations.length > 0 && {
                        citations: normalizedCitations,
                    }),
                },
                finish_reason: finishReason,
                usage: (() => {
                    const inputTokens = response.usage?.input_tokens ?? 0;
                    const outputTokens = response.usage?.output_tokens ?? 0;
                    const cost = estimateTextCost(
                        model,
                        inputTokens,
                        outputTokens
                    );
                    return {
                        input_tokens: inputTokens,
                        output_tokens: outputTokens,
                        total_tokens: inputTokens + outputTokens,
                        cost: formatUsd(cost.totalCost),
                    };
                })(),
            };

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
        format: 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm'
    ) {
        //https://platform.openai.com/docs/guides/text-to-speech
        if (!filename || !/^[\w-]+$/.test(filename)) {
            throw new Error(
                'Invalid filename. Only alphanumeric characters, hyphens, and underscores are allowed.'
            );
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
                logger.error(
                    'Failed to clean up file after error:',
                    cleanupError
                );
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
            const imageDescriptionResult =
                await generateImageDescriptionRequest(this.openai, {
                    imageUrl,
                    context,
                    model: IMAGE_DESCRIPTION_MODEL,
                });

            const imageDescriptionResponse = imageDescriptionResult.response;
            if (imageDescriptionResponse.usage) {
                const inputTokens = imageDescriptionResponse.usage.input_tokens;
                const outputTokens =
                    imageDescriptionResponse.usage.output_tokens;
                const cost = estimateTextCost(
                    IMAGE_DESCRIPTION_MODEL as TextModelPricingKey,
                    inputTokens,
                    outputTokens
                );
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
            logger.debug(
                `Image description generated: ${imageDescriptionResponse.message?.content}${imageDescriptionResponse.usage ? ` (Cost: ${imageDescriptionResponse.usage.cost})` : ''}`
            );
            return imageDescriptionResponse;
        } catch (error) {
            logger.error('Error generating image description:', error);
            throw new Error(
                `Failed to process image: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }

    /**
     * Embeds text using the default embedding model.
     * @param text The text to embed.
     * @returns A Promise that resolves to an array of numbers representing the embedding.
     */
    public async embedText(
        text: string,
        dimensions: number = 1024
    ): Promise<number[]> {
        const embedding = await this.openai.embeddings.create({
            model: DEFAULT_EMBEDDING_MODEL,
            input: text,
            dimensions,
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
                logger.error(
                    `Cost estimator failed in embedText: ${(error as Error)?.message ?? error}`
                );
            }
        }

        return embedding.data[0].embedding;
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
