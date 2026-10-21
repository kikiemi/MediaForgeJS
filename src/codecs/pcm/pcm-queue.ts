import { EncodeError } from '../../core/errors/errors';

// The PCM queue of the audio encoders (the aac, mpegAudio and flac plugins).

interface QueuedPcmChunk {
    readonly data: Float32Array;
    offsetSamples: number;
}

/** A FIFO interleaved PCM queue whose retained size is observable in tests. */
export class InterleavedPcmQueue {
    private chunks: Array<QueuedPcmChunk | undefined> = [];
    private headIndex = 0;
    private bufferedSamples = 0;
    private peakBufferedFramesValue = 0;

    constructor(readonly channels: number) {
        if (!Number.isInteger(channels) || channels < 1 || channels > 8) {
            throw new EncodeError('PCM queue channel count must be an integer in 1..8');
        }
    }

    get bufferedFrames(): number {
        return this.bufferedSamples / this.channels;
    }
    get peakBufferedFrames(): number {
        return this.peakBufferedFramesValue;
    }

    pushPlanar(planes: readonly Float32Array[], gain = 1): void {
        if (planes.length !== this.channels) {
            throw new EncodeError(
                `PCM queue expected ${this.channels} channels, got ${planes.length}`,
            );
        }
        const frames = planes[0]?.length ?? 0;
        for (let channel = 1; channel < planes.length; channel++) {
            if (planes[channel]!.length !== frames) {
                throw new EncodeError('PCM queue channel planes have different lengths');
            }
        }
        if (!Number.isFinite(gain)) throw new EncodeError('PCM gain must be finite');
        if (frames === 0) return;
        const interleaved = new Float32Array(frames * this.channels);
        let at = 0;
        for (let frame = 0; frame < frames; frame++) {
            for (let channel = 0; channel < this.channels; channel++) {
                interleaved[at++] = planes[channel]![frame]! * gain;
            }
        }
        this.pushInterleaved(interleaved);
    }

    pushInterleaved(data: Float32Array): void {
        if (data.length % this.channels !== 0) {
            throw new EncodeError('interleaved PCM chunk is not channel-aligned');
        }
        if (data.length === 0) return;
        this.chunks.push({ data, offsetSamples: 0 });
        this.bufferedSamples += data.length;
        this.peakBufferedFramesValue = Math.max(
            this.peakBufferedFramesValue,
            this.bufferedSamples / this.channels,
        );
    }

    /** Copies without consuming. Missing tail samples are zero-filled. */
    copyFrames(startFrame: number, frameCount: number): Float32Array {
        if (
            !Number.isSafeInteger(startFrame) ||
            !Number.isSafeInteger(frameCount) ||
            startFrame < 0 ||
            frameCount < 0
        ) {
            throw new RangeError('PCM queue range must use non-negative safe integers');
        }
        const output = new Float32Array(frameCount * this.channels);
        let skip = startFrame * this.channels;
        let written = 0;
        for (
            let index = this.headIndex;
            index < this.chunks.length && written < output.length;
            index++
        ) {
            const chunk = this.chunks[index]!;
            const available = chunk.data.length - chunk.offsetSamples;
            if (skip >= available) {
                skip -= available;
                continue;
            }
            const from = chunk.offsetSamples + skip;
            const take = Math.min(output.length - written, chunk.data.length - from);
            output.set(chunk.data.subarray(from, from + take), written);
            written += take;
            skip = 0;
            if (written === output.length) break;
        }
        return output;
    }

    takeFrames(frameCount: number, pad = false): Float32Array {
        if (!Number.isSafeInteger(frameCount) || frameCount < 0)
            throw new RangeError('PCM queue frame count must be a non-negative safe integer');
        if (!pad && this.bufferedFrames < frameCount) {
            throw new RangeError(
                `PCM queue underflow: need ${frameCount}, have ${this.bufferedFrames}`,
            );
        }
        const available = Math.min(frameCount, this.bufferedFrames);
        const output = this.copyFrames(0, pad ? frameCount : available);
        this.discardFrames(available);
        return output;
    }

    discardFrames(frameCount: number): void {
        if (
            !Number.isSafeInteger(frameCount) ||
            frameCount < 0 ||
            frameCount > this.bufferedFrames
        ) {
            throw new RangeError(`invalid PCM queue discard ${frameCount}/${this.bufferedFrames}`);
        }
        let samples = frameCount * this.channels;
        this.bufferedSamples -= samples;
        while (samples > 0) {
            const head = this.chunks[this.headIndex]!;
            const available = head.data.length - head.offsetSamples;
            const take = Math.min(samples, available);
            head.offsetSamples += take;
            samples -= take;
            if (head.offsetSamples === head.data.length) this.chunks[this.headIndex++] = undefined;
        }
        if (this.headIndex === this.chunks.length) {
            this.chunks = [];
            this.headIndex = 0;
        } else if (this.headIndex >= 1024 && this.headIndex * 2 >= this.chunks.length) {
            this.chunks = this.chunks.slice(this.headIndex);
            this.headIndex = 0;
        }
    }
}
