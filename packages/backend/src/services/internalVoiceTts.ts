/**
 * @description: Runs the trusted internal voice TTS task through the shared backend voice runtime.
 * @footnote-scope: core
 * @footnote-module: InternalVoiceTtsService
 * @footnote-risk: high - Incorrect task wiring here can break audio delivery or produce malformed artifacts.
 * @footnote-ethics: high - Backend-owned speech synthesis handles user content and requires careful accountability.
 */
import type {
    TextToSpeechResult,
    TextToSpeechRuntime,
} from '@footnote/agent-runtime';
import type {
    PostInternalVoiceTtsRequest,
    PostInternalVoiceTtsResponse,
} from '@footnote/contracts/voice';
import { PostInternalVoiceTtsResponseSchema } from '@footnote/contracts/voice';
import {
    recordBackendLLMUsage,
    type BackendLLMCostRecord,
} from './llmCostRecorder.js';
import { logger } from '../utils/logger.js';

export type CreateInternalVoiceTtsServiceOptions = {
    ttsRuntime: TextToSpeechRuntime;
    recordUsage?: (record: BackendLLMCostRecord) => void;
};

export type InternalVoiceTtsService = {
    runTtsTask(
        request: PostInternalVoiceTtsRequest
    ): Promise<PostInternalVoiceTtsResponse>;
};

const toInternalVoiceTtsResponse = (
    result: TextToSpeechResult
): PostInternalVoiceTtsResponse => ({
    task: 'synthesize',
    result: {
        audioBase64: result.audioBase64,
        outputFormat: result.outputFormat,
        mimeType: result.mimeType,
        model: result.model,
        voice: result.voice,
        usage: result.usage,
        costs: result.costs,
        generationTimeMs: result.generationTimeMs,
    },
});

export const createInternalVoiceTtsService = ({
    ttsRuntime,
    recordUsage = recordBackendLLMUsage,
}: CreateInternalVoiceTtsServiceOptions): InternalVoiceTtsService => {
    const runTtsTask = async (
        request: PostInternalVoiceTtsRequest
    ): Promise<PostInternalVoiceTtsResponse> => {
        const result = await ttsRuntime.synthesize({
            text: request.text,
            options: request.options,
            outputFormat: request.outputFormat,
        });

        try {
            recordUsage({
                feature: 'tts',
                model: result.model,
                promptTokens: result.usage.inputTokens,
                completionTokens: result.usage.outputTokens,
                totalTokens: result.usage.totalTokens,
                inputCostUsd: result.costs.input,
                outputCostUsd: result.costs.output,
                totalCostUsd: result.costs.total,
                timestamp: Date.now(),
            });
        } catch (error) {
            logger.warn(
                `Internal voice TTS usage recording failed: ${
                    error instanceof Error ? error.message : String(error)
                }`
            );
        }

        const response = toInternalVoiceTtsResponse(result);
        const parsed = PostInternalVoiceTtsResponseSchema.safeParse(response);
        if (!parsed.success) {
            const firstIssue = parsed.error.issues[0];
            throw new Error(
                `Internal voice TTS returned invalid output: ${
                    firstIssue?.path.join('.') ?? 'body'
                } ${firstIssue?.message ?? 'Invalid response'}`
            );
        }

        return parsed.data;
    };

    return {
        runTtsTask,
    };
};
