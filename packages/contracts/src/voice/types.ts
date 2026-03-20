/**
 * @description: Defines the internal voice (tts + realtime) request/response shapes for trusted callers.
 * @footnote-scope: interface
 * @footnote-module: VoiceContracts
 * @footnote-risk: medium - Contract drift can break realtime sessions or audio responses.
 * @footnote-ethics: high - Voice data handling impacts privacy and consent expectations.
 */

import type {
    InternalTtsModelId,
    InternalTtsVoiceId,
    SupportedOpenAIRealtimeModel,
} from '../providers.js';

/**
 * @api.operationId: postInternalVoiceTts
 * @api.path: POST /api/internal/voice/tts
 */
export type InternalVoiceOutputFormat =
    | 'mp3'
    | 'opus'
    | 'aac'
    | 'flac'
    | 'wav'
    | 'pcm';

/**
 * @api.operationId: postInternalVoiceTts
 * @api.path: POST /api/internal/voice/tts
 */
export type InternalTtsModel = InternalTtsModelId;

/**
 * @api.operationId: postInternalVoiceTts
 * @api.path: POST /api/internal/voice/tts
 */
export type InternalTtsVoice = InternalTtsVoiceId;

/**
 * @api.operationId: postInternalVoiceTts
 * @api.path: POST /api/internal/voice/tts
 */
export type InternalVoiceChannelContext = {
    channelId?: string;
    guildId?: string;
};

/**
 * @api.operationId: postInternalVoiceTts
 * @api.path: POST /api/internal/voice/tts
 */
export type InternalTtsOptions = {
    model: InternalTtsModel;
    voice: InternalTtsVoice;
    speed?: 'slow' | 'normal' | 'fast';
    pitch?: 'low' | 'normal' | 'high';
    emphasis?: 'none' | 'moderate' | 'strong';
    style?: string;
    styleDegree?: 'low' | 'normal' | 'high';
    styleNote?: string;
};

/**
 * @api.operationId: postInternalVoiceTts
 * @api.path: POST /api/internal/voice/tts
 */
export type PostInternalVoiceTtsRequest = {
    task: 'synthesize';
    text: string;
    options: InternalTtsOptions;
    outputFormat: InternalVoiceOutputFormat;
    channelContext?: InternalVoiceChannelContext;
};

/**
 * @api.operationId: postInternalVoiceTts
 * @api.path: POST /api/internal/voice/tts
 */
export type InternalTtsUsage = {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
};

/**
 * @api.operationId: postInternalVoiceTts
 * @api.path: POST /api/internal/voice/tts
 */
export type InternalTtsCosts = {
    input: number;
    output: number;
    total: number;
};

/**
 * @api.operationId: postInternalVoiceTts
 * @api.path: POST /api/internal/voice/tts
 */
export type PostInternalVoiceTtsResponse = {
    task: 'synthesize';
    result: {
        audioBase64: string;
        outputFormat: InternalVoiceOutputFormat;
        mimeType: string;
        model: InternalTtsModel;
        voice: InternalTtsVoice;
        usage: InternalTtsUsage;
        costs: InternalTtsCosts;
        generationTimeMs: number;
    };
};

/**
 * @api.operationId: openInternalVoiceRealtime
 * @api.path: GET /api/internal/voice/realtime
 */
export type InternalVoiceParticipant = {
    id: string;
    displayName: string;
    isBot?: boolean;
};

/**
 * @api.operationId: openInternalVoiceRealtime
 * @api.path: GET /api/internal/voice/realtime
 */
export type InternalVoiceSessionContext = {
    participants: InternalVoiceParticipant[];
    transcripts?: string[];
};

/**
 * @api.operationId: openInternalVoiceRealtime
 * @api.path: GET /api/internal/voice/realtime
 */
export type InternalVoiceRealtimeOptions = {
    model?: SupportedOpenAIRealtimeModel;
    voice?: InternalTtsVoice;
    temperature?: number;
    maxResponseOutputTokens?: number;
};

/**
 * @api.operationId: openInternalVoiceRealtime
 * @api.path: GET /api/internal/voice/realtime
 */
export type InternalVoiceRealtimeClientEvent =
    | {
          type: 'session.start';
          context: InternalVoiceSessionContext;
          options?: InternalVoiceRealtimeOptions;
      }
    | {
          type: 'input_text.create';
          text: string;
          speakerLabel?: string;
          speakerId?: string;
      }
    | {
          type: 'input_audio.append';
          audioBase64: string;
          speakerLabel: string;
          speakerId?: string;
      }
    | { type: 'input_audio.commit' }
    | { type: 'input_audio.clear' }
    | { type: 'response.create' }
    | { type: 'session.close' };

/**
 * @api.operationId: openInternalVoiceRealtime
 * @api.path: GET /api/internal/voice/realtime
 */
export type InternalVoiceRealtimeServerEvent =
    | { type: 'session.ready' }
    | {
          type: 'session.closed';
          reason?: string;
          code?: string;
      }
    | {
          type: 'output_audio.delta';
          audioBase64: string;
      }
    | {
          type: 'output_text.delta';
          text: string;
      }
    | {
          type: 'response.completed';
          responseId?: string;
      }
    | {
          type: 'error';
          message: string;
          code?: string;
      };
