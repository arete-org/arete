/**
 * @description: Manages realtime session options and applies runtime updates.
 * @arete-scope: utility
 * @arete-module: RealtimeSessionConfig
 * @arete-risk: moderate - Incorrect options can break realtime sessions or increase costs.
 * @arete-ethics: moderate - Session settings influence audio handling and consent.
 */
import WebSocket from 'ws';
import { RealtimeSessionOptions } from '../utils/realtimeService.js';
import { logger } from '../utils/logger.js';

export class RealtimeSessionConfig {
    private options: RealtimeSessionOptions;

    constructor(options: RealtimeSessionOptions = {}) {
        this.options = {
            model: 'gpt-realtime',
            voice: 'echo',
            ...options
        };
    }

    public getOptions(): RealtimeSessionOptions {
        return { ...this.options };
    }

    public updateOptions(newOptions: Partial<RealtimeSessionOptions>): void {
        this.options = { ...this.options, ...newOptions };
    }

    public getModel(): string {
        return this.options.model || 'gpt-realtime';
    }

    public getVoice(): string {
        return this.options.voice || 'echo';
    }

    public getInstructions(): string | undefined {
        return this.options.instructions;
    }

    public sendSessionConfig(ws: WebSocket): void {
        if (!ws) return;

        const sessionUpdate = {
            type: 'session.update',
            session: {
                type: 'realtime',
                model: this.options.model,
                instructions: this.options.instructions,
                output_modalities: ['audio'],
                audio: {
                    input: {
                        format: {
                            type: 'audio/pcm',
                            rate: 24000,    // OpenAI outputs 24kHz PCM
                            //channels: 1,    // Mono
                            //sample_size: 16 // 16-bit PCM
                        },
                        turn_detection: null
                    },
                    output: {
                        format: {
                            type: 'audio/pcm',
                            rate: 24000,    // Match OpenAI's 24kHz output
                            //channels: 1,    // Mono
                            //sample_size: 16 // 16-bit PCM
                        },
                        voice: this.options.voice,
                    }
                }
            }
        };

        try {
            ws.send(JSON.stringify(sessionUpdate));
            logger.debug('Sent session configuration with 24kHz PCM16 audio settings');
        } catch (error) {
            logger.error('Failed to send session configuration:', error);
            throw error;
        }
    }

    public createResponse(ws: WebSocket): void {
        if (!ws) return;

        logger.debug('Creating response');

        const event: {
            type: 'response.create';
            response: { output_modalities: string[]; instructions?: string };
        } = {
            type: 'response.create',
            response: {
                output_modalities: ['audio'],
                instructions: this.options.instructions
            }
        };

        if (this.options.instructions) {
            event.response.instructions = this.options.instructions;
        }

        logger.debug('Sending response.create event');
        ws.send(JSON.stringify(event));
    }

    public enableVAD(ws: WebSocket): void {
        if (!ws) return;

        const vadUpdate = {
            type: 'session.update',
            session: {
                type: 'realtime',
                audio: {
                    input: {
                        turn_detection: {
                            type: 'semantic_vad'
                        }
                    }
                }
            }
        };

        ws.send(JSON.stringify(vadUpdate));
        logger.debug('Enabled VAD for session');
    }
}
