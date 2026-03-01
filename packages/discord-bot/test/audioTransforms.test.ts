/**
 * @description: Tests audio transform resampling behavior and buffer handling.
 * @footnote-scope: test
 * @footnote-module: AudioTransformsTests
 * @footnote-risk: low - Tests validate audio math without affecting runtime behavior.
 * @footnote-ethics: low - No user data is processed in test fixtures.
 */
import test from 'node:test';
import { once } from 'node:events';
import { strict as assert } from 'node:assert';

import { AUDIO_CONSTANTS } from '../src/constants/voice.js';
import { createPlaybackResampler } from '../src/voice/audioTransforms.js';

const BYTES_PER_SAMPLE = 2;

const createRampBuffer = (sampleCount: number): Buffer => {
    const buffer = Buffer.allocUnsafe(sampleCount * BYTES_PER_SAMPLE);
    for (let i = 0; i < sampleCount; i++) {
        const sample = Math.max(-32768, Math.min(32767, i - 32768));
        buffer.writeInt16LE(sample, i * BYTES_PER_SAMPLE);
    }
    return buffer;
};

const collectUpsampledBytes = async (
    chunkSampleCounts: number[]
): Promise<number> => {
    const stream = createPlaybackResampler();
    const emitted: Buffer[] = [];

    stream.on('data', (chunk) => emitted.push(chunk));

    for (const sampleCount of chunkSampleCounts) {
        stream.write(createRampBuffer(sampleCount));
    }

    stream.end();
    await once(stream, 'end');

    return emitted.reduce((total, chunk) => total + chunk.length, 0);
};

const UPSAMPLE_RATIO =
    AUDIO_CONSTANTS.DISCORD_SAMPLE_RATE / AUDIO_CONSTANTS.REALTIME_SAMPLE_RATE;

const expectedUpsampledBytes = (sampleCount: number): number =>
    Math.round(sampleCount * UPSAMPLE_RATIO) * BYTES_PER_SAMPLE;

test('playback resampler flushes the full tail frame', async () => {
    const inputSamples = 480; // 10ms of 24kHz PCM captured by the realtime API
    const upsampled = await collectUpsampledBytes([inputSamples]);

    assert.equal(
        upsampled,
        expectedUpsampledBytes(inputSamples),
        'flush should emit every interpolated 48kHz frame'
    );
});

test('playback resampler combines partial frames across chunks', async () => {
    const chunkSamples = [241, 241]; // forces the final read position to land between samples
    const totalInput = chunkSamples.reduce((sum, count) => sum + count, 0);
    const upsampled = await collectUpsampledBytes(chunkSamples);

    assert.equal(
        upsampled,
        expectedUpsampledBytes(totalInput),
        'chunk boundaries must not drop interpolated samples'
    );
});

