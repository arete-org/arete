/**
 * @description: Builds the options payload Discord sends when opening a backend realtime session.
 * @footnote-scope: utility
 * @footnote-module: RealtimeSessionConfig
 * @footnote-risk: medium - Incorrect options can break realtime sessions or change live voice behavior.
 * @footnote-ethics: medium - Session settings influence voice output and user expectations.
 */
import type { InternalVoiceRealtimeOptions } from '@footnote/contracts/voice';
import { runtimeConfig } from '../config.js';
import type { RealtimeSessionOptions } from '../utils/realtimeService.js';

export class RealtimeSessionConfig {
    private options: InternalVoiceRealtimeOptions;

    constructor(options: RealtimeSessionOptions = {}) {
        const { context: _context, ...runtimeOptions } = options;
        const defaultOptions: InternalVoiceRealtimeOptions = {};
        if (runtimeConfig.realtime.defaultModel) {
            defaultOptions.model = runtimeConfig.realtime.defaultModel;
        }
        if (runtimeConfig.realtime.defaultVoice) {
            defaultOptions.voice = runtimeConfig.realtime.defaultVoice;
        }
        this.options = {
            ...defaultOptions,
            ...runtimeOptions,
        };
    }

    public getOptions(): InternalVoiceRealtimeOptions {
        return { ...this.options };
    }
}

