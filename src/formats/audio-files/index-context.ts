import type { DemuxIndexBudget } from '../shared/demux-budget';
import type { DiagnosticContext } from '../../core/errors/diagnostics';
import type { MediaTags } from '../../core/model/media';
import type { Sample, TrackInfo } from '../../core/model/track';
import { SummarizedSampleIndex, type SampleIndex } from '../../core/model/sample-index';

/** What the audio file indexers share while indexing one input. */
export interface AudioIndexContext {
    readonly size: number;
    readonly budget: DemuxIndexBudget;
    readonly maxPacketBytes: number;
    readonly diagnostics: DiagnosticContext;
    /** Container-level descriptive metadata found while indexing; the demux result exposes it. */
    readonly metadata: { title?: string; tags?: MediaTags };
    read(offset: number, length: number): Promise<Uint8Array>;
    checkpoint(): Promise<void>;
    /** Offsets of Ogg pages whose CRC the caller checked over the same bytes. */
    readonly checkedOggPages?: ReadonlySet<number>;
}

/**
 * The size from which an MP3 or FLAC input is described from its header and last frames when
 * inspected; a smaller one is read whole, which takes a few milliseconds and reports damage
 * anywhere in it.
 */
export const DESCRIBED_AUDIO_BYTES = 4 * 1024 * 1024;

/**
 * The one track of an audio file: track 1, timed in its own `samples` at `sampleRate`, without
 * pictures; `fields` add the rest (its packets, trims, damage).
 */
export function audioFileTrack(
    codec: string,
    codecConfig: Uint8Array | undefined,
    sampleRate: number,
    channelCount: number,
    samples: number,
    fields?: Partial<TrackInfo>,
): TrackInfo {
    return {
        id: 1,
        codec,
        codecConfig,
        sampleRate,
        channelCount,
        timescale: sampleRate,
        duration: samples / sampleRate,
        width: 0,
        height: 0,
        samples: [],
        ...fields,
    };
}

/**
 * The frames of an audio stream in typed arrays instead of a record per frame: where each starts
 * in the input and its size. Every frame is a keyframe decoded when it is shown; a stream times
 * its frames (timestampAt), gives their lengths (durationAt) and may keep columns of its own,
 * grown with these.
 */
export abstract class AudioFrameTable extends SummarizedSampleIndex implements SampleIndex {
    protected offsets: Float64Array;

    constructor(
        protected sizes: Uint16Array | Uint32Array,
        capacity: number,
    ) {
        super();
        this.offsets = new Float64Array(capacity);
    }

    abstract get byteLength(): number;
    abstract durationAt(index: number): number;

    /** Appends the frame of `size` bytes at input byte `offset`; its index. */
    protected append(offset: number, size: number): number {
        const index = this.length;
        if (index === this.offsets.length) this.grow(Math.max(1024, index * 2));
        this.offsets[index] = offset;
        this.sizes[index] = size;
        this.length++;
        return index;
    }

    /** Takes the table summary and drops the unused capacity. */
    finish(): void {
        this.summarize(this.sizes, index => this.durationAt(index));
        this.grow(this.length);
    }

    get(index: number): Sample {
        const timestamp = this.timestampAt(index);
        return {
            offset: this.offsets[index]!,
            size: this.sizes[index]!,
            timestamp,
            decodeTimestamp: timestamp,
            duration: this.durationAt(index),
            isKeyframe: true,
        };
    }

    decodeTimeAt(index: number): number {
        return this.timestampAt(index);
    }

    isKeyframeAt(): boolean {
        return true;
    }

    protected grow(capacity: number): void {
        this.offsets = this.resized(this.offsets, capacity);
        this.sizes = this.resized(this.sizes, capacity);
    }
}

/** Thrown into a scan whose batches nobody reads any more. */
class ScanStopped extends Error {}

/**
 * The batches `scan` hands over, as a generator: a handover waits until the batch before it is
 * taken and the next asked for, so the scan reads no further ahead than its caller; a caller that
 * stops reading stops the scan at its next handover, and the scan's error ends the generator.
 */
export async function* scanBatches<T>(
    scan: (handOver: (batch: T[]) => Promise<void>) => Promise<void>,
): AsyncGenerator<T[]> {
    const queue: T[][] = [];
    let ended = false;
    let failure: { readonly error: unknown } | undefined;
    let wake: (() => void) | undefined;
    let resume: ((stop: boolean) => void) | undefined;
    const woken = (): void => {
        const waiting = wake;
        wake = undefined;
        waiting?.();
    };
    const scanning = scan(batch => {
        queue.push(batch);
        woken();
        return new Promise<void>((resolve, reject) => {
            resume = stop => (stop ? reject(new ScanStopped()) : resolve());
        });
    }).then(
        () => undefined,
        (error: unknown) => {
            if (!(error instanceof ScanStopped)) failure = { error };
        },
    );
    void scanning.finally(() => {
        ended = true;
        woken();
    });
    const proceed = (stop: boolean): void => {
        const waiting = resume;
        resume = undefined;
        waiting?.(stop);
    };
    let finished = false;
    try {
        for (;;) {
            while (!queue.length && !ended) await new Promise<void>(resolve => (wake = resolve));
            const batch = queue.shift();
            if (batch) {
                yield batch;
                proceed(false);
                continue;
            }
            finished = true;
            if (failure) throw failure.error;
            return;
        }
    } finally {
        if (!finished) {
            proceed(true);
            await scanning;
        }
    }
}

/** Reports damage of an indexed input read past at `offset`, as a recovery or a warning only. */
export function reportDamage(
    context: AudioIndexContext,
    kind: 'recover' | 'warn',
    format: string,
    code: string,
    offset: number,
    message: string,
): void {
    context.diagnostics[kind]({ code, format, offset, message });
}
