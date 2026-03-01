/**
 * @description: Defines voice processing and timeout constants for audio workflows.
 * @footnote-scope: utility
 * @footnote-module: VoiceConstants
 * @footnote-risk: moderate - Incorrect constants can destabilize audio buffers or retries.
 * @footnote-ethics: moderate - Voice timing affects capture boundaries and consent.
 */
// Audio processing constants
export const AUDIO_CONSTANTS = {
    // Minimum audio buffer size for processing (100ms at 24kHz, 16-bit mono)
    MIN_AUDIO_BUFFER_SIZE: 4800,
    // Audio sample rate provided by Discord's voice gateway (48kHz PCM16 mono)
    DISCORD_SAMPLE_RATE: 48000,
    DISCORD_FRAME_SIZE: 960,
    // Resampled realtime rate expected by the OpenAI Realtime API (24kHz PCM16 mono)
    REALTIME_SAMPLE_RATE: 24000,
    REALTIME_FRAME_SIZE: 480,
    // Audio channels (mono)
    CHANNELS: 1,
} as const;

// Timeout constants
export const TIMEOUT_CONSTANTS = {
    // Maximum time to wait for previous response (30 seconds)
    MAX_RESPONSE_WAIT_TIME: 30000,
    // Polling interval for waiting (50ms)
    RESPONSE_POLLING_INTERVAL: 50,
    // Session config delay (500ms)
    SESSION_CONFIG_DELAY: 500,
    // Audio commit delay (500ms - balance between responsiveness and reliability)
    AUDIO_COMMIT_DELAY: 500,
    // Silence duration before ending audio capture (300ms)
    SILENCE_DURATION: 300,
} as const;

// Reconnection constants
export const RECONNECTION_CONSTANTS = {
    // Maximum reconnection attempts
    MAX_RECONNECT_ATTEMPTS: 3,
    // Initial reconnection delay (1 second)
    INITIAL_RECONNECT_DELAY: 1000,
    // Maximum reconnection delay (30 seconds)
    MAX_RECONNECT_DELAY: 30000,
    // Exponential backoff multiplier
    RECONNECT_BACKOFF_MULTIPLIER: 2,
} as const;

