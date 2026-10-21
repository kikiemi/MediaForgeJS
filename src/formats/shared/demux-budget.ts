import type { DemuxBudgetOptions } from '../../core/contracts/reader';
import { malformedInput } from '../../core/errors/demux-guard';
import { MediaForgeError } from '../../core/errors/errors';
import { positiveLimit } from '../../core/errors/limits';

// What a reader may index and allocate: the fixed limits of the structures it parses, the sample
// budget of an open input and the base of the demuxers that read packets within it.

export const DEMUX_LIMITS = {
    maxSamplesPerTrack: 1_000_000,
    maxSamplesTotal: 1_000_000,
    maxTracks: 64,
    maxTableEntries: 1_000_000,
    maxBoxesPerRange: 16_384,
    /**
     * Top-level MP4 boxes of one file: ten hours of 0.2-second fragments, each a moof and an mdat,
     * fit.
     */
    maxTopLevelBoxes: 1 << 20,
    maxBoxDepth: 32,
} as const;

export interface ResolvedDemuxBudget {
    readonly maxSamples: number;
    readonly maxIndexBytes: number;
}

export function resolveDemuxBudget(
    options: DemuxBudgetOptions = {},
    defaultMaxSamples: number = DEMUX_LIMITS.maxSamplesTotal,
): ResolvedDemuxBudget {
    if (!options || typeof options !== 'object')
        throw new MediaForgeError('Expected demux budget options', 'INPUT');
    return {
        maxSamples: positiveLimit(options.maxSamples, defaultMaxSamples, 'maxSamples'),
        maxIndexBytes: positiveLimit(options.maxIndexBytes, 128 * 1024 * 1024, 'maxIndexBytes'),
    };
}

/** Conservative allocation estimates, independent of payload compression and file padding. */
export class DemuxIndexBudget {
    private samples = 0;
    private bytes = 0;

    constructor(readonly limits: ResolvedDemuxBudget) {}

    checkSamples(count: number, context = 'sample index'): void {
        if (!(Number.isSafeInteger(count) && count >= 0))
            malformedInput(`${context} has an invalid sample count`);
        if (count > this.limits.maxSamples) {
            throw new MediaForgeError(`${context} exceeds maxSamples`, 'OOM');
        }
    }

    reserveSamples(count: number, estimatedBytesPerSample = 256, context = 'sample index'): void {
        this.checkSamples(count, context);
        if (count > this.limits.maxSamples - this.samples) {
            throw new MediaForgeError(`${context} exceeds maxSamples`, 'OOM');
        }
        this.reserveBytes(count * estimatedBytesPerSample, context);
        this.samples += count;
    }

    reserveBytes(bytes: number, context = 'sample index'): void {
        if (
            !Number.isSafeInteger(bytes) ||
            bytes < 0 ||
            bytes > this.limits.maxIndexBytes - this.bytes
        ) {
            throw new MediaForgeError(`${context} exceeds maxIndexBytes`, 'OOM');
        }
        this.bytes += bytes;
    }
}

/** Refuses a packet (`what`) of `bytes` (with its alpha) larger than the largest packet. */
export function checkPacketBytes(bytes: number, maxPacketBytes: number, what = 'Packet'): void {
    if (bytes > maxPacketBytes) throw new MediaForgeError(`${what} exceeds maxPacketBytes`, 'OOM');
}

/** Options of a demuxer with an index budget and a largest packet. */
export interface PacketDemuxerOptions extends DemuxBudgetOptions {
    readonly signal?: AbortSignal;
    readonly maxPacketBytes?: number;
}

/** The abort signal, index budget and largest packet (64 MiB by default) a demuxer reads with. */
export abstract class PacketDemuxer {
    protected readonly signal?: AbortSignal;
    protected readonly budget: DemuxIndexBudget;
    protected readonly maxPacketBytes: number;

    constructor(options: PacketDemuxerOptions = {}) {
        this.signal = options.signal;
        this.budget = new DemuxIndexBudget(resolveDemuxBudget(options));
        this.maxPacketBytes = positiveLimit(
            options.maxPacketBytes,
            64 * 1024 * 1024,
            'maxPacketBytes',
        );
    }

    /** Refuses a packet (`what`) larger than the largest packet. */
    protected checkPacket(size: number, what: string): void {
        checkPacketBytes(size, this.maxPacketBytes, what);
    }
}
