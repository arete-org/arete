/**
 * @description: Validates the internal voice (tts + realtime) payloads used by Footnote services.
 * @footnote-scope: interface
 * @footnote-module: VoiceContractSchemas
 * @footnote-risk: medium - Schema drift can reject valid audio traffic or allow malformed events.
 * @footnote-ethics: high - Voice payload validation impacts privacy-sensitive audio handling.
 */

import { z } from 'zod';
import {
    internalTtsModels,
    internalTtsVoices,
    supportedOpenAIRealtimeModels,
    supportedOpenAIRealtimeTurnDetections,
    supportedOpenAIRealtimeVadEagerness,
} from '../providers.js';

/**
 * @api.operationId: postInternalVoiceTts
 * @api.path: POST /api/internal/voice/tts
 */
const InternalVoiceOutputFormatSchema = z.enum([
    'mp3',
    'opus',
    'aac',
    'flac',
    'wav',
    'pcm',
]);

const InternalTtsOptionsSchema = z
    .object({
        model: z.enum(internalTtsModels),
        voice: z.enum(internalTtsVoices),
        speed: z.enum(['slow', 'normal', 'fast']).optional(),
        pitch: z.enum(['low', 'normal', 'high']).optional(),
        emphasis: z.enum(['none', 'moderate', 'strong']).optional(),
        style: z.string().min(1).max(200).optional(),
        styleDegree: z.enum(['low', 'normal', 'high']).optional(),
        styleNote: z.string().min(1).max(500).optional(),
    })
    .strict();

const InternalVoiceChannelContextSchema = z
    .object({
        channelId: z.string().min(1).optional(),
        guildId: z.string().min(1).optional(),
    })
    .strict();

export const PostInternalVoiceTtsRequestSchema = z
    .object({
        task: z.literal('synthesize'),
        text: z.string().min(1).max(8000),
        options: InternalTtsOptionsSchema,
        outputFormat: InternalVoiceOutputFormatSchema,
        channelContext: InternalVoiceChannelContextSchema.optional(),
    })
    .strict();

export const PostInternalVoiceTtsResponseSchema = z
    .object({
        task: z.literal('synthesize'),
        result: z
            .object({
                audioBase64: z.string().min(1),
                outputFormat: InternalVoiceOutputFormatSchema,
                mimeType: z.string().min(1),
                model: z.enum(internalTtsModels),
                voice: z.enum(internalTtsVoices),
                usage: z
                    .object({
                        inputTokens: z.number().int().nonnegative(),
                        outputTokens: z.number().int().nonnegative(),
                        totalTokens: z.number().int().nonnegative(),
                    })
                    .strict(),
                costs: z
                    .object({
                        input: z.number().nonnegative(),
                        output: z.number().nonnegative(),
                        total: z.number().nonnegative(),
                    })
                    .strict(),
                generationTimeMs: z.number().int().nonnegative(),
            })
            .strict(),
    })
    .strict();

/**
 * @api.operationId: openInternalVoiceRealtime
 * @api.path: GET /api/internal/voice/realtime
 */
const InternalVoiceParticipantSchema = z
    .object({
        id: z.string().min(1),
        displayName: z.string().min(1).max(128),
        isBot: z.boolean().optional(),
    })
    .strict();

const InternalVoiceSessionContextSchema = z
    .object({
        participants: z.array(InternalVoiceParticipantSchema),
        transcripts: z.array(z.string().min(1)).optional(),
    })
    .strict();

const InternalVoiceRealtimeOptionsSchema = z
    .object({
        model: z.enum(supportedOpenAIRealtimeModels).optional(),
        voice: z.enum(internalTtsVoices).optional(),
        temperature: z.number().min(0).max(2).optional(),
        maxResponseOutputTokens: z.number().int().min(1).max(4096).optional(),
        turnDetection: z.enum(supportedOpenAIRealtimeTurnDetections).optional(),
        turnDetectionConfig: z
            .object({
                createResponse: z.boolean().optional(),
                interruptResponse: z.boolean().optional(),
                serverVad: z
                    .object({
                        threshold: z.number().min(0).max(1).optional(),
                        silenceDurationMs: z.number().int().min(0).optional(),
                        prefixPaddingMs: z.number().int().min(0).optional(),
                    })
                    .strict()
                    .optional(),
                semanticVad: z
                    .object({
                        eagerness: z
                            .enum(supportedOpenAIRealtimeVadEagerness)
                            .optional(),
                    })
                    .strict()
                    .optional(),
            })
            .strict()
            .optional(),
    })
    .strict();

const InternalVoiceRealtimeUsageSchema = z
    .object({
        tokensPrompt: z.number().int().nonnegative().optional(),
        tokensCompletion: z.number().int().nonnegative().optional(),
        model: z.string().min(1).optional(),
        requestMs: z.number().int().nonnegative().optional(),
        costUsd: z.number().nonnegative().optional(),
    })
    .strict();

export const InternalVoiceRealtimeClientEventSchema = z.discriminatedUnion(
    'type',
    [
        z
            .object({
                type: z.literal('session.start'),
                context: InternalVoiceSessionContextSchema,
                options: InternalVoiceRealtimeOptionsSchema.optional(),
            })
            .strict(),
        z
            .object({
                type: z.literal('input_text.create'),
                text: z.string().min(1),
                speakerLabel: z.string().min(1).max(128).optional(),
                speakerId: z.string().min(1).optional(),
            })
            .strict(),
        z
            .object({
                type: z.literal('input_audio.append'),
                audioBase64: z.string().min(1),
                speakerLabel: z.string().min(1).max(128),
                speakerId: z.string().min(1).optional(),
            })
            .strict(),
        z.object({ type: z.literal('input_audio.commit') }).strict(),
        z.object({ type: z.literal('input_audio.clear') }).strict(),
        z.object({ type: z.literal('response.create') }).strict(),
        z.object({ type: z.literal('session.close') }).strict(),
    ]
);

export const InternalVoiceRealtimeServerEventSchema = z.discriminatedUnion(
    'type',
    [
        z.object({ type: z.literal('session.ready') }).strict(),
        z
            .object({
                type: z.literal('session.closed'),
                reason: z.string().min(1).optional(),
                code: z.string().min(1).optional(),
            })
            .strict(),
        z
            .object({
                type: z.literal('output_audio.delta'),
                audioBase64: z.string().min(1),
            })
            .strict(),
        z
            .object({
                type: z.literal('output_text.delta'),
                text: z.string().min(1),
            })
            .strict(),
        z
            .object({
                type: z.literal('response.done'),
                responseId: z.string().min(1).optional(),
                usage: InternalVoiceRealtimeUsageSchema.optional(),
            })
            .strict(),
        z
            .object({
                type: z.literal('error'),
                message: z.string().min(1),
                code: z.string().min(1).optional(),
            })
            .strict(),
    ]
);
