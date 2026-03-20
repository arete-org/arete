/**
 * @description: Handles the OpenAI calls that still intentionally stay inside the Discord bot process.
 * @footnote-scope: core
 * @footnote-module: OpenAIService
 * @footnote-risk: high - TTS or embedding failures here can break local bot features or hide cleanup regressions if this service grows again.
 * @footnote-ethics: high - This service still touches user content directly, so it should stay narrow and predictable.
 */

import { fileURLToPath } from 'url';
import path, { dirname } from 'path';
import fs from 'fs';
import OpenAI from 'openai';

import { logger } from './logger.js';
import { estimateTextCost } from './pricing.js';
import type { LLMUsageRecord } from '../state/ChannelContextManager.js';
import { DEFAULT_INTERNAL_TTS_OPTIONS } from '@footnote/contracts/voice';

/**
 * Minimal chat message format used by context-building helpers.
 * The bot no longer sends direct text generations through this service,
 * but other utilities still use the shared message shape.
 */
export interface OpenAIMessage {
    role: 'user' | 'assistant' | 'system' | 'developer';
    content: string;
}

/**
 * Embedding model identifiers used by the bot for local vector helpers.
 */
export type EmbeddingModelType = 'text-embedding-3-small';

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

export interface LLMUsageRecorder {
    recordLLMUsage(record: LLMUsageRecord): void;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const OUTPUT_PATH = path.resolve(__dirname, '..', 'output');
const TTS_OUTPUT_PATH = path.join(OUTPUT_PATH, 'tts');

/**
 * Default embedding model used for text vectorization helpers.
 */
export const DEFAULT_EMBEDDING_MODEL: EmbeddingModelType =
    'text-embedding-3-small';

/**
 * Default TTS settings used when callers do not provide voice overrides.
 */
export const TTS_DEFAULT_OPTIONS: TTSOptions = DEFAULT_INTERNAL_TTS_OPTIONS;

let isDirectoryInitialized = false;
const TTS_INPUT_TOKEN_PRICING_PER_MILLION: Record<TTSOptions['model'], number> =
    {
        'tts-1': 15,
        'tts-1-hd': 30,
        'gpt-4o-mini-tts': 0.6,
    };

const estimateTokenCount = (value: string): number =>
    Math.max(1, Math.ceil((value ?? '').length / 4));

/**
 * Handles the remaining Discord-local OpenAI helpers.
 * Backend now owns text generation, image generation, and accounting for
 * user-facing helper flows, so this service stays limited to TTS and embeddings.
 */
export class OpenAIService {
    private openai: OpenAI;
    private readonly usageRecorder: LLMUsageRecorder | null;

    constructor(apiKey: string, usageRecorder: LLMUsageRecorder | null = null) {
        this.openai = new OpenAI({ apiKey });
        this.usageRecorder = usageRecorder;
        ensureDirectories();
    }

    /**
     * Generates a speech file using the OpenAI API.
     */
    public async generateSpeech(
        input: string,
        instructions: TTSOptions,
        filename: string,
        format: 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm'
    ): Promise<string> {
        if (!filename || !/^[\w-]+$/.test(filename)) {
            throw new Error(
                'Invalid filename. Only alphanumeric characters, hyphens, and underscores are allowed.'
            );
        }

        const outputPath = path.join(TTS_OUTPUT_PATH, `${filename}.${format}`);

        logger.debug(`Generating speech file: ${outputPath}...`);
        logger.debug(`Using TTS options: ${JSON.stringify(instructions)}`);

        try {
            const instructionsText = `Speed: ${instructions.speed}, Pitch: ${instructions.pitch}, Emphasis: ${instructions.emphasis}, Style: ${instructions.style}, Style weight: ${instructions.styleDegree}, Other style notes: ${instructions.styleNote}`;
            const audioResponse = await this.openai.audio.speech.create({
                model: instructions.model,
                voice: instructions.voice,
                input,
                instructions: instructionsText,
                response_format: format,
            });

            const buffer = Buffer.from(await audioResponse.arrayBuffer());
            await fs.promises.writeFile(outputPath, buffer);
            const promptTokens = estimateTokenCount(
                `${input}\n${instructionsText}`
            );
            const inputCostUsd =
                (promptTokens / 1_000_000) *
                TTS_INPUT_TOKEN_PRICING_PER_MILLION[instructions.model];
            this.usageRecorder?.recordLLMUsage({
                feature: 'tts',
                model: instructions.model,
                promptTokens,
                completionTokens: 0,
                totalTokens: promptTokens,
                inputCostUsd,
                outputCostUsd: 0,
                totalCostUsd: inputCostUsd,
                estimated: true,
                timestamp: Date.now(),
            });
            logger.debug(`Generated speech file: ${outputPath}`);
            return outputPath;
        } catch (error) {
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
     * Embeds text using the default embedding model.
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

        const promptTokens =
            embedding.usage?.prompt_tokens ?? estimateTokenCount(text);
        const totalTokens = embedding.usage?.total_tokens ?? promptTokens;
        const costBreakdown = estimateTextCost(
            DEFAULT_EMBEDDING_MODEL,
            promptTokens,
            0
        );
        this.usageRecorder?.recordLLMUsage({
            feature: 'embedding',
            model: DEFAULT_EMBEDDING_MODEL,
            promptTokens,
            completionTokens: 0,
            totalTokens,
            inputCostUsd: costBreakdown.inputCost,
            outputCostUsd: costBreakdown.outputCost,
            totalCostUsd: costBreakdown.totalCost,
            estimated: embedding.usage?.prompt_tokens === undefined,
            timestamp: Date.now(),
        });

        return embedding.data[0].embedding;
    }
}

/**
 * Creates local output folders on first use so TTS writes do not fail later.
 */
async function ensureDirectories(): Promise<void> {
    if (isDirectoryInitialized) {
        return;
    }

    try {
        await fs.promises.mkdir(OUTPUT_PATH, { recursive: true });
        await fs.promises.mkdir(TTS_OUTPUT_PATH, { recursive: true });
        isDirectoryInitialized = true;
    } catch (error) {
        logger.error('Failed to create output directories:', error);
        throw new Error('Failed to initialize output directories');
    }
}
