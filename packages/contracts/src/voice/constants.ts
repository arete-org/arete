/**
 * @description: Shared defaults for internal voice TTS requests.
 * @footnote-scope: interface
 * @footnote-module: VoiceDefaults
 * @footnote-risk: low - Defaults here influence voice tone and model selection across runtimes.
 * @footnote-ethics: medium - Voice defaults shape user-facing speech and must remain intentional.
 */
import type { InternalTtsOptions, InternalVoiceOutputFormat } from './types.js';

/**
 * Default output format for backend-owned TTS requests.
 */
export const DEFAULT_INTERNAL_TTS_OUTPUT_FORMAT: InternalVoiceOutputFormat =
    'mp3';

/**
 * Default TTS options shared across callers so speech tone stays consistent
 * when a request does not supply overrides.
 */
export const DEFAULT_INTERNAL_TTS_OPTIONS: InternalTtsOptions = {
    model: 'gpt-4o-mini-tts',
    voice: 'echo',
    speed: 'normal',
    pitch: 'normal',
    emphasis: 'moderate',
    style: 'conversational',
    styleDegree: 'normal',
    styleNote: 'none',
};
