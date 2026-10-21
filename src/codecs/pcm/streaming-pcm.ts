import { EncodeError } from '../../core/errors/errors';
import { downmixChannels } from './audio-buffer-tools';
import { StreamingResampler } from './streaming-resampler';

export interface PcmStreamWindow {
    /** Target-rate frames discarded before the first emitted frame. */
    readonly head?: number;
    /** Maximum target-rate frames emitted. Zero/undefined means unbounded. */
    readonly valid?: number;
}

type PlanarPcmConsumer = (channels: readonly Float32Array[]) => void;

/** Stateful, duration-independent PCM mapping and resampling. */
export class StreamingPcmTransformer {
    private readonly resampler: StreamingResampler | null;
    private readonly head: number;
    private readonly validEnd: number;
    private producedFrames = 0;
    private emittedFrames = 0;
    private sealed = false;
    private peakWorkFramesValue = 0;

    constructor(
        readonly sourceSampleRate: number,
        readonly sourceChannels: number,
        readonly targetSampleRate: number,
        readonly targetChannels: number,
        private readonly consume: PlanarPcmConsumer,
        window: PcmStreamWindow = {},
        private readonly sourceChannelMask?: number,
    ) {
        if (
            ![sourceSampleRate, targetSampleRate].every(
                rate => Number.isInteger(rate) && rate > 0 && rate <= 768000,
            )
        ) {
            throw new EncodeError('PCM stream sample rates must be integers in 1..768000');
        }

        if (
            ![sourceChannels, targetChannels].every(
                count => Number.isInteger(count) && count >= 1 && count <= 8,
            )
        ) {
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

    get framesEmitted(): number {
        return this.emittedFrames;
    }

    /**
     * True once every frame of a bounded window has been emitted; further input would be discarded.
     */
    get complete(): boolean {
        return this.producedFrames >= this.validEnd;
    }

    push(channels: readonly Float32Array[]): void {
        if (this.sealed) throw new EncodeError('PCM transformer received data after flush');
        if (channels.length !== this.sourceChannels) {
            throw new EncodeError('PCM stream channel count changed');
        }

        const frames = channels[0]?.length ?? 0;
        for (let channel = 1; channel < channels.length; channel++) {
            if (channels[channel]!.length !== frames) {
                throw new EncodeError('PCM stream channel planes have different lengths');
            }
        }

        if (frames === 0) return;
        this.peakWorkFramesValue = Math.max(this.peakWorkFramesValue, frames);
        const mapped =
            this.sourceChannels === this.targetChannels
                ? channels
                : downmixChannels(
                      Array.from(channels),
                      this.sourceChannels,
                      this.targetChannels,
                      frames,
                      this.sourceChannelMask,
                  );

        const transformed = this.resampler ? this.resampler.process(mapped) : mapped;
        this.emit(transformed);
    }

    flush(): void {
        if (this.sealed) return;
        this.sealed = true;
        if (this.resampler) this.emit(this.resampler.flush());
    }

    private emit(channels: readonly Float32Array[]): void {
        const available = channels[0]?.length ?? 0;
        if (available <= 0) return;
        const chunkStart = this.producedFrames;
        const chunkEnd = chunkStart + available;
        this.producedFrames = chunkEnd;
        this.peakWorkFramesValue = Math.max(this.peakWorkFramesValue, available);

        const keepStart = Math.max(chunkStart, this.head);
        const keepEnd = Math.min(chunkEnd, this.validEnd);
        const frames = keepEnd - keepStart;
        if (frames <= 0) return;
        const offset = keepStart - chunkStart;
        const views = channels.map(plane => plane.subarray(offset, offset + frames));
        this.consume(views);
        this.emittedFrames += frames;
    }
}
