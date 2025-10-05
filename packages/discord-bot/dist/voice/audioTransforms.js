import { Transform } from 'stream';
import { AUDIO_CONSTANTS } from '../constants/voice.js';
const BYTES_PER_SAMPLE = 2; // 16-bit PCM
const clampSample = (value) => {
    if (value > 32767)
        return 32767;
    if (value < -32768)
        return -32768;
    return value;
};
/**
 * Resamples 16-bit mono PCM audio between sample rates using linear interpolation.
 * The implementation avoids the need for an external FFmpeg binary which proved
 * unreliable in some deployment environments and resulted in empty capture buffers.
 */
export const resamplePCM = (buffer, fromRate, toRate) => {
    if (buffer.length === 0 || fromRate === toRate) {
        return Buffer.from(buffer);
    }
    const inputSampleCount = Math.floor(buffer.length / BYTES_PER_SAMPLE);
    if (inputSampleCount === 0) {
        return Buffer.alloc(0);
    }
    const resampleRatio = toRate / fromRate;
    const outputSampleCount = Math.max(1, Math.floor(inputSampleCount * resampleRatio));
    const outputBuffer = Buffer.allocUnsafe(outputSampleCount * BYTES_PER_SAMPLE);
    for (let i = 0; i < outputSampleCount; i++) {
        const sourceIndex = i / resampleRatio;
        const lowerIndex = Math.floor(sourceIndex);
        const upperIndex = Math.min(lowerIndex + 1, inputSampleCount - 1);
        const interpolation = sourceIndex - lowerIndex;
        const lowerSample = buffer.readInt16LE(lowerIndex * BYTES_PER_SAMPLE);
        const upperSample = buffer.readInt16LE(upperIndex * BYTES_PER_SAMPLE);
        const sampleValue = lowerSample + (upperSample - lowerSample) * interpolation;
        outputBuffer.writeInt16LE(clampSample(Math.round(sampleValue)), i * BYTES_PER_SAMPLE);
    }
    return outputBuffer;
};
class PCMResamplerStream extends Transform {
    pendingInput = Buffer.alloc(0);
    step;
    position = 0;
    constructor({ fromRate, toRate }) {
        super({ readableObjectMode: false, writableObjectMode: false });
        this.step = fromRate / toRate;
    }
    processChunks() {
        const inputSampleCount = Math.floor(this.pendingInput.length / BYTES_PER_SAMPLE);
        if (inputSampleCount < 2) {
            return;
        }
        const outputSamples = [];
        while (this.position + 1 < inputSampleCount) {
            const lowerIndex = Math.floor(this.position);
            const upperIndex = lowerIndex + 1;
            const interpolation = this.position - lowerIndex;
            const lowerSample = this.pendingInput.readInt16LE(lowerIndex * BYTES_PER_SAMPLE);
            const upperSample = this.pendingInput.readInt16LE(upperIndex * BYTES_PER_SAMPLE);
            const sampleValue = lowerSample + (upperSample - lowerSample) * interpolation;
            outputSamples.push(clampSample(Math.round(sampleValue)));
            this.position += this.step;
        }
        const consumedSamples = Math.max(0, Math.floor(this.position));
        if (consumedSamples > 0) {
            this.pendingInput = this.pendingInput.subarray(consumedSamples * BYTES_PER_SAMPLE);
            this.position -= consumedSamples;
        }
        if (outputSamples.length > 0) {
            const outputBuffer = Buffer.allocUnsafe(outputSamples.length * BYTES_PER_SAMPLE);
            for (let i = 0; i < outputSamples.length; i++) {
                outputBuffer.writeInt16LE(outputSamples[i], i * BYTES_PER_SAMPLE);
            }
            this.push(outputBuffer);
        }
    }
    _transform(chunk, _encoding, callback) {
        if (chunk.length > 0) {
            this.pendingInput = Buffer.concat([this.pendingInput, chunk]);
        }
        this.processChunks();
        callback();
    }
    _flush(callback) {
        if (this.pendingInput.length >= BYTES_PER_SAMPLE) {
            const lastSample = this.pendingInput.subarray(this.pendingInput.length - BYTES_PER_SAMPLE);
            // Duplicate the final sample so the interpolation loop can emit any
            // remaining fractional outputs implied by the current read position.
            this.pendingInput = Buffer.concat([this.pendingInput, lastSample]);
            this.processChunks();
        }
        this.pendingInput = Buffer.alloc(0);
        this.position = 0;
        callback();
    }
}
export const createCaptureResampler = () => new PCMResamplerStream({
    fromRate: AUDIO_CONSTANTS.DISCORD_SAMPLE_RATE,
    toRate: AUDIO_CONSTANTS.REALTIME_SAMPLE_RATE,
});
export const createPlaybackResampler = () => new PCMResamplerStream({
    fromRate: AUDIO_CONSTANTS.REALTIME_SAMPLE_RATE,
    toRate: AUDIO_CONSTANTS.DISCORD_SAMPLE_RATE,
});
export const downsampleToRealtime = (buffer) => resamplePCM(buffer, AUDIO_CONSTANTS.DISCORD_SAMPLE_RATE, AUDIO_CONSTANTS.REALTIME_SAMPLE_RATE);
export const upsampleToDiscord = (buffer) => resamplePCM(buffer, AUDIO_CONSTANTS.REALTIME_SAMPLE_RATE, AUDIO_CONSTANTS.DISCORD_SAMPLE_RATE);
//# sourceMappingURL=audioTransforms.js.map