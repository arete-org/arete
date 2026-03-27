/**
 * @description: Manages AI-generated audio playback to Discord voice channels.
 * @footnote-scope: core
 * @footnote-module: AudioPlaybackHandler
 * @footnote-risk: high - Handles audio queuing, pipeline management, and playback coordination. Failures can cause audio glitches, dropped responses, or channel disruption.
 * @footnote-ethics: high - Controls how and when AI-generated speech is delivered to users in voice channels, affecting the quality and timing of AI participation.
 */

import {
    AudioPlayer,
    VoiceConnection,
    AudioPlayerStatus,
    AudioPlayerError,
    createAudioResource,
    StreamType,
} from '@discordjs/voice';
import { logger } from '../utils/logger.js';
import { GuildAudioPipeline } from './GuildAudioPipeline.js';
import { upsampleToDiscord } from './audioTransforms.js';

// Keep the playback pipeline around between turns so streamed model responses
// do not get clipped by a too-aggressive cleanup window.
const PIPELINE_IDLE_CLEANUP_DELAY_MS = 30000;
const QUEUE_RETRY_DELAY_MS = 100;

export class AudioPlaybackHandler {
    private pipelines: Map<string, GuildAudioPipeline> = new Map();
    private audioQueues: Map<string, Buffer[]> = new Map();
    private isProcessingQueue: Map<string, boolean> = new Map();
    private pipelineCleanupTimers: Map<string, NodeJS.Timeout> = new Map();
    private pipelineDisposing: Set<string> = new Set();
    private pipelineErrorHandlers: Map<string, (error: Error) => void> =
        new Map();

    public async playAudioToChannel(
        connection: VoiceConnection,
        audioData: Buffer
    ): Promise<void> {
        const guildId = connection.joinConfig.guildId;

        this.clearPipelineCleanupTimer(guildId);

        if (!this.audioQueues.has(guildId)) {
            this.audioQueues.set(guildId, []);
        }

        const queue = this.audioQueues.get(guildId)!;
        queue.push(audioData);

        this.ensurePipeline(connection);

        if (this.isProcessingQueue.get(guildId)) {
            return;
        }

        await this.processAudioQueue(connection);
    }

    private ensurePipeline(connection: VoiceConnection): GuildAudioPipeline {
        const guildId = connection.joinConfig.guildId;

        if (this.pipelines.has(guildId)) {
            return this.pipelines.get(guildId)!;
        }

        logger.debug(
            `[AudioPlayback] Creating new audio pipeline for guild ${guildId}`
        );
        const pipeline = new GuildAudioPipeline();
        this.pipelines.set(guildId, pipeline);

        const player = pipeline.getPlayer();
        const handleOpusEncoderError = (error: Error) => {
            if (this.pipelineDisposing.has(guildId)) {
                return;
            }
            logger.error(
                `[AudioPlayback] Opus encoder error for guild ${guildId}:`,
                error
            );
            const queue = this.audioQueues.get(guildId);
            this.cleanupPipeline(guildId);
            if (queue && queue.length > 0) {
                this.retryProcessingQueue(connection);
            }
        };
        this.pipelineErrorHandlers.set(guildId, handleOpusEncoderError);
        pipeline.getOpusEncoder().once('error', handleOpusEncoderError);

        player.on(AudioPlayerStatus.Idle, () => {
            this.processAudioQueue(connection)
                .catch((error: Error) => {
                    logger.error(
                        `[AudioPlayback] Error processing next item in queue:`,
                        error
                    );
                })
                .finally(() => {
                    const queue = this.audioQueues.get(guildId);
                    if (!queue || queue.length === 0) {
                        this.schedulePipelineCleanup(guildId);
                    }
                });
        });

        player.on('error', (error: AudioPlayerError) => {
            logger.error(
                `[AudioPlayback] Player error for guild ${guildId}:`,
                error
            );
            this.cleanupPipeline(guildId);
            this.retryProcessingQueue(connection);
        });

        try {
            if (connection.state.status !== 'destroyed') {
                connection.subscribe(player);
            }
        } catch (error) {
            logger.error(
                `[AudioPlayback] Error subscribing connection for guild ${guildId}:`,
                error
            );
            this.cleanupPipeline(guildId);
            throw error;
        }

        return pipeline;
    }

    private async processAudioQueue(
        connection: VoiceConnection
    ): Promise<void> {
        const guildId = connection.joinConfig.guildId;
        const queue = this.audioQueues.get(guildId);

        if (!queue || queue.length === 0) {
            return;
        }

        if (this.isProcessingQueue.get(guildId)) {
            return;
        }

        this.isProcessingQueue.set(guildId, true);
        this.clearPipelineCleanupTimer(guildId);

        let encounteredError = false;

        try {
            const pipeline =
                this.pipelines.get(guildId) ?? this.ensurePipeline(connection);
            const player = pipeline.getPlayer();

            if (!pipeline.hasResource()) {
                const opusStream = pipeline
                    .getPCMStream()
                    .pipe(pipeline.getOpusEncoder());
                const resource = createAudioResource(opusStream, {
                    inputType: StreamType.Opus,
                    inlineVolume: true,
                });
                player.play(resource);
                pipeline.markResourceCreated();
            }

            while (queue.length > 0) {
                const audioData = queue.shift();
                if (!audioData || audioData.length === 0) {
                    continue;
                }

                try {
                    const pcmChunk = upsampleToDiscord(audioData);
                    if (pcmChunk.length === 0) {
                        continue;
                    }

                    await pipeline.writePCM(pcmChunk);
                } catch (error) {
                    logger.error(
                        '[AudioPlayback] Error writing audio data to pipeline:',
                        error
                    );
                    if (audioData) {
                        queue.unshift(audioData);
                    }
                    encounteredError = true;
                    this.cleanupPipeline(guildId);
                    break;
                }
            }

            if (!encounteredError) {
                await pipeline.flushResidualBuffer();
            }
        } catch (error) {
            encounteredError = true;
            logger.error('[AudioPlayback] Error in processAudioQueue:', error);
            this.cleanupPipeline(guildId);
        } finally {
            this.isProcessingQueue.set(guildId, false);
        }

        if (encounteredError) {
            this.retryProcessingQueue(connection);
        }
    }

    public getPlayer(guildId: string): AudioPlayer | undefined {
        return this.pipelines.get(guildId)?.getPlayer();
    }

    public stopPlayback(guildId?: string): void {
        if (guildId) {
            this.cleanupPipeline(guildId);
            this.audioQueues.delete(guildId);
            this.isProcessingQueue.delete(guildId);
        } else {
            for (const gId of this.pipelines.keys()) {
                this.cleanupPipeline(gId);
                this.audioQueues.delete(gId);
                this.isProcessingQueue.delete(gId);
            }
        }
    }

    private clearPipelineCleanupTimer(guildId: string): void {
        const timer = this.pipelineCleanupTimers.get(guildId);
        if (timer) {
            clearTimeout(timer);
            this.pipelineCleanupTimers.delete(guildId);
        }
    }

    private schedulePipelineCleanup(guildId: string): void {
        if (
            !this.pipelines.has(guildId) ||
            this.pipelineCleanupTimers.has(guildId)
        ) {
            return;
        }

        const timer = setTimeout(() => {
            this.pipelineCleanupTimers.delete(guildId);
            const queue = this.audioQueues.get(guildId);
            if (queue && queue.length > 0) {
                return;
            }
            this.cleanupPipeline(guildId);
        }, PIPELINE_IDLE_CLEANUP_DELAY_MS);

        if (typeof timer.unref === 'function') {
            timer.unref();
        }

        this.pipelineCleanupTimers.set(guildId, timer);
    }

    private retryProcessingQueue(connection: VoiceConnection): void {
        const guildId = connection.joinConfig.guildId;

        const timer = setTimeout(() => {
            const queue = this.audioQueues.get(guildId);
            if (!queue || queue.length === 0) {
                return;
            }

            if (this.isProcessingQueue.get(guildId)) {
                return;
            }

            if (connection.state.status === 'destroyed') {
                return;
            }

            void this.processAudioQueue(connection);
        }, QUEUE_RETRY_DELAY_MS);

        if (typeof timer.unref === 'function') {
            timer.unref();
        }
    }

    private cleanupPipeline(guildId: string): void {
        const pipeline = this.pipelines.get(guildId);
        if (pipeline) {
            this.pipelineDisposing.add(guildId);
            const handleError = this.pipelineErrorHandlers.get(guildId);
            if (handleError) {
                pipeline.getOpusEncoder().off('error', handleError);
                this.pipelineErrorHandlers.delete(guildId);
            }

            void pipeline
                .destroy()
                .catch((error: Error) => {
                    logger.error(
                        `[AudioPlayback] Error cleaning up pipeline for guild ${guildId}:`,
                        error
                    );
                })
                .finally(() => {
                    this.pipelineDisposing.delete(guildId);
                });
            this.pipelines.delete(guildId);
        }
        this.clearPipelineCleanupTimer(guildId);
    }

    public cleanupGuild(guildId: string): void {
        this.cleanupPipeline(guildId);
        this.audioQueues.delete(guildId);
        this.isProcessingQueue.delete(guildId);
    }

    public cleanupAll(): void {
        for (const guildId of this.pipelines.keys()) {
            this.cleanupPipeline(guildId);
        }
        this.audioQueues.clear();
        this.isProcessingQueue.clear();
        this.pipelineCleanupTimers.forEach((timer) => clearTimeout(timer));
        this.pipelineCleanupTimers.clear();
        this.pipelineErrorHandlers.clear();
        this.pipelineDisposing.clear();
    }
}
