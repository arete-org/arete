/**
 * @description: Buffers, frames, and encodes PCM audio for Discord voice playback.
 * @arete-scope: core
 * @arete-module: GuildAudioPipeline
 * @arete-risk: high - Audio pipeline failures disrupt voice output or leak resources.
 * @arete-ethics: high - Voice content requires careful handling and privacy safeguards.
 */
import { PassThrough } from 'stream';
import { opus } from 'prism-media';
import {
    AudioPlayer,
    createAudioPlayer,
    AudioPlayerStatus,
    NoSubscriberBehavior,
} from '@discordjs/voice';
import { once } from 'events';
import { AUDIO_CONSTANTS } from '../constants/voice.js';
import { logger } from '../utils/logger.js';

export class GuildAudioPipeline {
    private readonly player: AudioPlayer;
    private readonly pcmStream: PassThrough;
    private readonly opusEncoder: opus.Encoder;
    private pcmBuffer: Buffer = Buffer.alloc(0);
    private isDestroyed: boolean = false;
    private readonly frameSize: number = AUDIO_CONSTANTS.DISCORD_FRAME_SIZE; // 48kHz * 0.02s = 960
    private resourceCreated = false;

    constructor() {
        // Create a PassThrough stream for PCM data
        this.pcmStream = new PassThrough();

        // Create Opus encoder (48kHz, mono)
        this.opusEncoder = new opus.Encoder({
            frameSize: this.frameSize,
            channels: 1,
            rate: AUDIO_CONSTANTS.DISCORD_SAMPLE_RATE,
        });

        // Create audio player
        this.player = createAudioPlayer({
            behaviors: {
                noSubscriber: NoSubscriberBehavior.Play,
            },
        });

        // Increase max listeners to prevent warnings
        this.pcmStream.setMaxListeners(20);
        this.opusEncoder.setMaxListeners(20);
    }

    public async writePCM(pcmData: Buffer): Promise<void> {
        if (this.isDestroyed) {
            throw new Error('Cannot write to destroyed pipeline');
        }

        // Add new data to buffer
        this.pcmBuffer = Buffer.concat([this.pcmBuffer, pcmData]);

        // Process complete frames
        const frameSizeInBytes = this.frameSize * 2; // 2 bytes per sample (16-bit PCM)
        while (this.pcmBuffer.length >= frameSizeInBytes) {
            const frame = this.pcmBuffer.subarray(0, frameSizeInBytes);
            this.pcmBuffer = this.pcmBuffer.subarray(frameSizeInBytes);

            // Write the frame to the PCM stream
            if (!this.pcmStream.write(frame)) {
                await once(this.pcmStream, 'drain');
            }
        }
    }
    public async flushResidualBuffer(): Promise<void> {
        if (this.isDestroyed) {
            this.pcmBuffer = Buffer.alloc(0);
            return;
        }

        if (this.pcmBuffer.length === 0) {
            return;
        }

        const frameSizeInBytes = this.frameSize * 2;
        const remainder = this.pcmBuffer.length % frameSizeInBytes;
        if (remainder === 0) {
            return;
        }

        const padding = Buffer.alloc(frameSizeInBytes - remainder);
        await this.writePCM(padding);
    }

    public getPlayer(): AudioPlayer {
        return this.player;
    }

    public async destroy(): Promise<void> {
        if (this.isDestroyed) return;
        this.isDestroyed = true;

        // Drain remaining PCM data
        if (this.pcmBuffer.length > 0) {
            try {
                await this.writePCM(Buffer.alloc(0)); // flush remaining frames
            } catch {
                // Ignore errors during cleanup
            }
        }

        try {
            this.player.stop();
            this.pcmStream.end();
            this.opusEncoder.end();
        } catch (error) {
            logger.error('[AudioPipeline] Error ending streams:', error);
        }
    }

    public isIdle(): boolean {
        return this.player.state.status === AudioPlayerStatus.Idle;
    }

    public hasResource(): boolean {
        return this.resourceCreated;
    }

    public getPCMStream(): PassThrough {
        return this.pcmStream;
    }

    public getOpusEncoder(): opus.Encoder {
        return this.opusEncoder;
    }

    public markResourceCreated(): void {
        this.resourceCreated = true;
    }
}
