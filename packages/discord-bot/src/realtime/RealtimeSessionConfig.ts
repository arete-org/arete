/**
 * @description: Builds the options payload Discord sends when opening a backend realtime session.
 * @footnote-scope: utility
 * @footnote-module: RealtimeSessionConfig
 * @footnote-risk: medium - Incorrect options can break realtime sessions or change live voice behavior.
 * @footnote-ethics: medium - Session settings influence voice output and user expectations.
 */
import type { InternalVoiceRealtimeOptions } from '@footnote/contracts/voice';
import type { RealtimeSessionOptions } from '../utils/realtimeService.js';

export class RealtimeSessionConfig {
    private options: InternalVoiceRealtimeOptions;

    constructor(options: RealtimeSessionOptions = {}) {
        const { context: _context, ...runtimeOptions } = options;
        this.options = {
            ...runtimeOptions,
        };
    }

    public getOptions(): InternalVoiceRealtimeOptions {
        return { ...this.options };
    }
}

