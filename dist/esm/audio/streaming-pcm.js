import { EncodeError } from '../core/errors.js';
import { downmixChannels } from './audio-buffer-tools.js';
import { StreamingResampler } from './streaming-resampler.js';
export class StreamingPcmTransformer {
    sourceSampleRate;
    sourceChannels;
    targetSampleRate;
    targetChannels;
    consume;
    resampler;
    head;
    validEnd;
    producedFrames = 0;
    emittedFrames = 0;
    sealed = false;
    peakWorkFramesValue = 0;
    constructor(sourceSampleRate, sourceChannels, targetSampleRate, targetChannels, consume, window = {}) {
        this.sourceSampleRate = sourceSampleRate;
        this.sourceChannels = sourceChannels;
        this.targetSampleRate = targetSampleRate;
        this.targetChannels = targetChannels;
        this.consume = consume;
        if (![sourceSampleRate, targetSampleRate].every(rate => Number.isInteger(rate) && rate > 0 && rate <= 768000)) {
            throw new EncodeError('PCM stream sample rates must be integers in 1..768000');
        }
        if (![sourceChannels, targetChannels].every(count => Number.isInteger(count) && count >= 1 && count <= 8)) {
            throw new EncodeError('PCM stream channel counts must be integers in 1..8');
        }
        for (const value of [window.head, window.valid]) {
            if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
                throw new EncodeError('PCM stream window must use non-negative safe integers');
            }
        }
        this.head = Math.max(0, Math.round(window.head ?? 0));
        const valid = Math.max(0, Math.round(window.valid ?? 0));
        this.validEnd = valid > 0 ? this.head + valid : Number.POSITIVE_INFINITY;
        this.resampler =
            sourceSampleRate === targetSampleRate
                ? null
                : new StreamingResampler(sourceSampleRate, targetSampleRate, targetChannels);
    }
    get framesEmitted() {
        return this.emittedFrames;
    }
    get peakWorkFrames() {
        return this.peakWorkFramesValue;
    }
    push(channels) {
        if (this.sealed)
            throw new EncodeError('PCM transformer received data after flush');
        if (channels.length !== this.sourceChannels) {
            throw new EncodeError(`PCM stream channel count changed (${this.sourceChannels} -> ${channels.length})`);
        }
        const frames = channels[0]?.length ?? 0;
        for (let channel = 1; channel < channels.length; channel++) {
            if (channels[channel].length !== frames) {
                throw new EncodeError('PCM stream channel planes have different lengths');
            }
        }
        if (frames === 0)
            return;
        this.peakWorkFramesValue = Math.max(this.peakWorkFramesValue, frames);
        const mapped = this.sourceChannels === this.targetChannels
            ? channels
            : downmixChannels(Array.from(channels), this.sourceChannels, this.targetChannels, frames);
        const transformed = this.resampler ? this.resampler.process(mapped) : mapped;
        this.emit(transformed);
    }
    flush() {
        if (this.sealed)
            return;
        this.sealed = true;
        if (this.resampler)
            this.emit(this.resampler.flush());
    }
    emit(channels) {
        const available = channels[0]?.length ?? 0;
        if (available <= 0)
            return;
        const chunkStart = this.producedFrames;
        const chunkEnd = chunkStart + available;
        this.producedFrames = chunkEnd;
        this.peakWorkFramesValue = Math.max(this.peakWorkFramesValue, available);
        const keepStart = Math.max(chunkStart, this.head);
        const keepEnd = Math.min(chunkEnd, this.validEnd);
        const frames = keepEnd - keepStart;
        if (frames <= 0)
            return;
        const offset = keepStart - chunkStart;
        const views = channels.map(plane => plane.subarray(offset, offset + frames));
        this.consume(views);
        this.emittedFrames += frames;
    }
}
export class InterleavedPcmQueue {
    channels;
    chunks = [];
    headIndex = 0;
    bufferedSamples = 0;
    peakBufferedFramesValue = 0;
    constructor(channels) {
        this.channels = channels;
        if (!Number.isInteger(channels) || channels < 1 || channels > 8) {
            throw new EncodeError('PCM queue channel count must be an integer in 1..8');
        }
    }
    get bufferedFrames() {
        return this.bufferedSamples / this.channels;
    }
    get peakBufferedFrames() {
        return this.peakBufferedFramesValue;
    }
    pushPlanar(planes, gain = 1) {
        if (planes.length !== this.channels) {
            throw new EncodeError(`PCM queue expected ${this.channels} channels, got ${planes.length}`);
        }
        const frames = planes[0]?.length ?? 0;
        for (let channel = 1; channel < planes.length; channel++) {
            if (planes[channel].length !== frames) {
                throw new EncodeError('PCM queue channel planes have different lengths');
            }
        }
        if (!Number.isFinite(gain))
            throw new EncodeError('PCM gain must be finite');
        if (frames === 0)
            return;
        const interleaved = new Float32Array(frames * this.channels);
        let at = 0;
        for (let frame = 0; frame < frames; frame++) {
            for (let channel = 0; channel < this.channels; channel++) {
                interleaved[at++] = planes[channel][frame] * gain;
            }
        }
        this.pushInterleaved(interleaved);
    }
    pushInterleaved(data) {
        if (data.length % this.channels !== 0) {
            throw new EncodeError('interleaved PCM chunk is not channel-aligned');
        }
        if (data.length === 0)
            return;
        this.chunks.push({ data, offsetSamples: 0 });
        this.bufferedSamples += data.length;
        this.peakBufferedFramesValue = Math.max(this.peakBufferedFramesValue, this.bufferedSamples / this.channels);
    }
    copyFrames(startFrame, frameCount) {
        if (!Number.isSafeInteger(startFrame) ||
            !Number.isSafeInteger(frameCount) ||
            startFrame < 0 ||
            frameCount < 0) {
            throw new RangeError('PCM queue range must use non-negative safe integers');
        }
        const output = new Float32Array(frameCount * this.channels);
        let skip = startFrame * this.channels;
        let written = 0;
        for (let index = this.headIndex; index < this.chunks.length && written < output.length; index++) {
            const chunk = this.chunks[index];
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
            if (written === output.length)
                break;
        }
        return output;
    }
    takeFrames(frameCount, pad = false) {
        if (!Number.isSafeInteger(frameCount) || frameCount < 0)
            throw new RangeError('PCM queue frame count must be a non-negative safe integer');
        if (!pad && this.bufferedFrames < frameCount) {
            throw new RangeError(`PCM queue underflow: need ${frameCount}, have ${this.bufferedFrames}`);
        }
        const available = Math.min(frameCount, this.bufferedFrames);
        const output = this.copyFrames(0, pad ? frameCount : available);
        this.discardFrames(available);
        return output;
    }
    discardFrames(frameCount) {
        if (!Number.isSafeInteger(frameCount) || frameCount < 0 || frameCount > this.bufferedFrames) {
            throw new RangeError(`invalid PCM queue discard ${frameCount}/${this.bufferedFrames}`);
        }
        let samples = frameCount * this.channels;
        this.bufferedSamples -= samples;
        while (samples > 0) {
            const head = this.chunks[this.headIndex];
            const available = head.data.length - head.offsetSamples;
            const take = Math.min(samples, available);
            head.offsetSamples += take;
            samples -= take;
            if (head.offsetSamples === head.data.length)
                this.chunks[this.headIndex++] = undefined;
        }
        if (this.headIndex === this.chunks.length) {
            this.chunks = [];
            this.headIndex = 0;
        }
        else if (this.headIndex >= 1024 && this.headIndex * 2 >= this.chunks.length) {
            this.chunks = this.chunks.slice(this.headIndex);
            this.headIndex = 0;
        }
    }
}
