/**
 * @description: Calls the OpenAI TTS API behind Footnote's shared voice runtime boundary.
 * @footnote-scope: core
 * @footnote-module: OpenAiTtsRuntime
 * @footnote-risk: high - Incorrect request or result mapping here can break audio delivery or cost accounting.
 * @footnote-ethics: high - Speech synthesis touches user content and must preserve Footnote-owned controls.
 */
import OpenAI from 'openai';
import { estimateOpenAITtsCost } from '@footnote/contracts/pricing';
import type {
    InternalTtsOptions,
    InternalVoiceOutputFormat,
} from '@footnote/contracts/voice';
import type {
    TextToSpeechRequest,
    TextToSpeechResult,
    TextToSpeechRuntime,
} from './index.js';

type OpenAiSpeechResponse = {
    arrayBuffer: () => Promise<ArrayBuffer>;
};

type OpenAiTtsClient = {
    createSpeech: (
        request: {
            model: string;
            voice: string;
            input: string;
            instructions?: string;
            response_format?: InternalVoiceOutputFormat;
        },
        options?: { signal?: AbortSignal }
    ) => Promise<OpenAiSpeechResponse>;
};

type OpenAiTtsRuntimeDebugData = Record<string, unknown>;

export interface OpenAiTtsRuntimeLogger {
    debug?: (message: string, data?: OpenAiTtsRuntimeDebugData) => void;
    warn?: (message: string, data?: OpenAiTtsRuntimeDebugData) => void;
    error?: (message: string, data?: OpenAiTtsRuntimeDebugData) => void;
}

export interface CreateOpenAiTtsRuntimeOptions {
    apiKey?: string;
    client?: OpenAiTtsClient;
    logger?: OpenAiTtsRuntimeLogger;
    kind?: string;
    requestTimeoutMs?: number;
}

// Defaults ensure a stable voice style even when callers omit optional fields.
const DEFAULT_TTS_OPTIONS: Required<
    Pick<
        InternalTtsOptions,
        'speed' | 'pitch' | 'emphasis' | 'style' | 'styleDegree'
    >
> = {
    speed: 'normal',
    pitch: 'normal',
    emphasis: 'moderate',
    style: 'conversational',
    styleDegree: 'normal',
};

const resolveMimeType = (format: InternalVoiceOutputFormat): string => {
    switch (format) {
        case 'mp3':
            return 'audio/mpeg';
        case 'opus':
            return 'audio/ogg; codecs=opus';
        case 'aac':
            return 'audio/aac';
        case 'flac':
            return 'audio/flac';
        case 'wav':
            return 'audio/wav';
        case 'pcm':
            return 'audio/pcm';
        default:
            return 'application/octet-stream';
    }
};

// TTS usage reporting uses a simple token estimate so cost math stays available
// even when the provider response omits usage details.
const estimateTokenCount = (value: string): number =>
    Math.max(1, Math.ceil((value ?? '').length / 4));

// OpenAI TTS accepts a single instructions string, so keep the composition in
// one place to ensure consistent style control across callers.
const buildInstructionsText = (options: InternalTtsOptions): string => {
    const speed = options.speed ?? DEFAULT_TTS_OPTIONS.speed;
    const pitch = options.pitch ?? DEFAULT_TTS_OPTIONS.pitch;
    const emphasis = options.emphasis ?? DEFAULT_TTS_OPTIONS.emphasis;
    const style = options.style ?? DEFAULT_TTS_OPTIONS.style;
    const styleDegree = options.styleDegree ?? DEFAULT_TTS_OPTIONS.styleDegree;
    const styleNote = options.styleNote ?? 'none';

    return [
        `Speed: ${speed}`,
        `Pitch: ${pitch}`,
        `Emphasis: ${emphasis}`,
        `Style: ${style}`,
        `Style weight: ${styleDegree}`,
        `Other style notes: ${styleNote}`,
    ].join(', ');
};

const createDefaultClient = (apiKey: string): OpenAiTtsClient => {
    const openai = new OpenAI({ apiKey });

    return {
        createSpeech: (request, options) =>
            openai.audio.speech.create(
                {
                    model: request.model,
                    voice: request.voice,
                    input: request.input,
                    instructions: request.instructions,
                    response_format: request.response_format,
                },
                options
            ),
    };
};

const createRequestAbortContext = (
    requestSignal: AbortSignal | undefined,
    requestTimeoutMs: number | undefined
): {
    signal?: AbortSignal;
    cleanup: () => void;
    didTimeout: () => boolean;
} => {
    if (
        requestTimeoutMs === undefined ||
        !Number.isFinite(requestTimeoutMs) ||
        requestTimeoutMs <= 0
    ) {
        return {
            signal: requestSignal,
            cleanup: () => undefined,
            didTimeout: () => false,
        };
    }

    const controller = new AbortController();
    let timedOut = false;
    const timeoutHandle = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, requestTimeoutMs);

    let abortListener: (() => void) | null = null;
    if (requestSignal) {
        if (requestSignal.aborted) {
            controller.abort(requestSignal.reason);
        } else {
            abortListener = () => controller.abort(requestSignal.reason);
            requestSignal.addEventListener('abort', abortListener, {
                once: true,
            });
        }
    }

    return {
        signal: controller.signal,
        cleanup: () => {
            clearTimeout(timeoutHandle);
            if (requestSignal && abortListener) {
                requestSignal.removeEventListener('abort', abortListener);
            }
        },
        didTimeout: () => timedOut,
    };
};

export const createOpenAiTtsRuntime = ({
    apiKey,
    client,
    logger,
    kind = 'openai-tts',
    requestTimeoutMs,
}: CreateOpenAiTtsRuntimeOptions): TextToSpeechRuntime => {
    const speechClient =
        client ??
        (apiKey
            ? createDefaultClient(apiKey)
            : (() => {
                  throw new Error(
                      'OpenAI TTS runtime requires either apiKey or client.'
                  );
              })());

    return {
        kind,
        async synthesize(
            request: TextToSpeechRequest
        ): Promise<TextToSpeechResult> {
            const startedAt = Date.now();
            const instructionsText = buildInstructionsText(request.options);
            const abortContext = createRequestAbortContext(
                request.signal,
                requestTimeoutMs
            );

            logger?.debug?.('TTS runtime request prepared.', {
                model: request.options.model,
                voice: request.options.voice,
                outputFormat: request.outputFormat,
                textLength: request.text.length,
            });

            try {
                const response = await speechClient.createSpeech(
                    {
                        model: request.options.model,
                        voice: request.options.voice,
                        input: request.text,
                        instructions: instructionsText,
                        response_format: request.outputFormat,
                    },
                    { signal: abortContext.signal }
                );

                // Base64 keeps the backend transport JSON-only and matches the
                // internal contract shape used by trusted callers.
                const audioBase64 = Buffer.from(
                    await response.arrayBuffer()
                ).toString('base64');
                const promptTokens = estimateTokenCount(
                    `${request.text}\n${instructionsText}`
                );
                const cost = estimateOpenAITtsCost(
                    request.options.model,
                    promptTokens
                );

                return {
                    audioBase64,
                    outputFormat: request.outputFormat,
                    mimeType: resolveMimeType(request.outputFormat),
                    model: request.options.model,
                    voice: request.options.voice,
                    usage: {
                        inputTokens: cost.inputTokens,
                        outputTokens: 0,
                        totalTokens: cost.inputTokens,
                    },
                    costs: {
                        input: cost.inputCost,
                        output: cost.outputCost,
                        total: cost.totalCost,
                    },
                    generationTimeMs: Date.now() - startedAt,
                };
            } catch (error) {
                if (
                    abortContext.didTimeout() &&
                    error instanceof Error &&
                    error.name === 'AbortError'
                ) {
                    throw new Error(
                        `TTS request timed out after ${requestTimeoutMs}ms`,
                        { cause: error }
                    );
                }

                throw error;
            } finally {
                abortContext.cleanup();
            }
        },
    };
};
