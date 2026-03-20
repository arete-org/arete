/**
 * @description: Manages realtime session options and applies runtime updates.
 * @footnote-scope: utility
 * @footnote-module: RealtimeSessionConfig
 * @footnote-risk: medium - Incorrect options can break realtime sessions or increase costs.
 * @footnote-ethics: medium - Session settings influence audio handling and consent.
 */
import type { InternalVoiceRealtimeOptions } from '@footnote/contracts/voice';
import { runtimeConfig } from '../config.js';
import type { RealtimeSessionOptions } from '../utils/realtimeService.js';

export class RealtimeSessionConfig {
    private options: InternalVoiceRealtimeOptions;

    constructor(options: RealtimeSessionOptions = {}) {
        const { context: _context, ...runtimeOptions } = options;
        this.options = {
            model: runtimeConfig.realtime.defaultModel,
            voice: runtimeConfig.realtime.defaultVoice,
            ...runtimeOptions,
        };
    }

    public getOptions(): InternalVoiceRealtimeOptions {
        return { ...this.options };
    }

    public updateOptions(newOptions: Partial<InternalVoiceRealtimeOptions>): void {
        this.options = { ...this.options, ...newOptions };
    }
}

