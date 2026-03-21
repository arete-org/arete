/**
 * @description: Re-exports the internal voice contracts and validation schemas used by Footnote services.
 * @footnote-scope: interface
 * @footnote-module: VoiceContractsIndex
 * @footnote-risk: low - Incorrect exports can cause contract mismatches.
 * @footnote-ethics: low - Export surface only; no runtime behavior.
 */

/**
 * @api.operationId: postInternalVoiceTts
 * @api.path: POST /api/internal/voice/tts
 * @api.operationId: openInternalVoiceRealtime
 * @api.path: GET /api/internal/voice/realtime
 */
export type {
    InternalTtsCosts,
    InternalTtsModel,
    InternalTtsOptions,
    InternalTtsUsage,
    InternalTtsVoice,
    InternalVoiceChannelContext,
    InternalVoiceOutputFormat,
    InternalVoiceParticipant,
    InternalVoiceRealtimeClientEvent,
    InternalVoiceRealtimeOptions,
    InternalVoiceRealtimeServerEvent,
    InternalVoiceRealtimeUsage,
    InternalVoiceSessionContext,
    PostInternalVoiceTtsRequest,
    PostInternalVoiceTtsResponse,
} from './types.js';

export {
    DEFAULT_INTERNAL_TTS_OPTIONS,
    DEFAULT_INTERNAL_TTS_OUTPUT_FORMAT,
} from './constants.js';

// Runtime validation schemas for internal voice contracts.
export {
    PostInternalVoiceTtsRequestSchema,
    PostInternalVoiceTtsResponseSchema,
    InternalVoiceRealtimeClientEventSchema,
    InternalVoiceRealtimeServerEventSchema,
} from './schemas.js';
