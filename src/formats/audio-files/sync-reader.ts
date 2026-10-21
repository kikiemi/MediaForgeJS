import type { Source } from '../../core/model/types';
import type { DemuxResult, Sample, TrackInfo } from '../../core/model/track';
import { ChunkReader } from '../../core/io/sources/chunk-reader';
import { DiagnosticContext, type DiagnosticOptions } from '../../core/errors/diagnostics';
import { awaitWithAbort } from '../../core/io/abort';
import { DemuxError, MediaForgeError, throwIfAborted } from '../../core/errors/errors';
import { DemuxIndexBudget, resolveDemuxBudget } from '../shared/demux-budget';
import type { DemuxBudgetOptions } from '../../core/contracts/reader';
import { yieldEventLoop } from '../../core/io/event-loop';
import { dolbyLocationChannels } from '../../core/codec-config/audio/dolby-audio-header';
import {
    dtsStoredBytes,
    dtsStreamForm,
    dtsToBigEndian16,
    parseDtsFrame,
    type DtsStreamForm,
} from '../../core/codec-config/audio/dts-header';
import { syncAudioFrame, type SyncAudioKind } from './sync-frame';

export interface SyncAudioDemuxOptions extends DiagnosticOptions, DemuxBudgetOptions {
    readonly format: 'ac3' | 'eac3' | 'dts' | 'truehd';
    readonly signal?: AbortSignal;
}

interface SyncAudioIndex {
    readonly codec: string;
    readonly sampleRate: number;
    readonly channels: number;
    readonly samples: Sample[];
    /** PCM samples per channel across all access units. */
    readonly frames: number;
}

const WINDOW = 1 << 16;
const MAX_FRAME = 1 << 16;

/** Bytes searched for the first frame and after damage before the stream is declared unreadable. */
const RESYNC_BYTES = 1 << 20;

/**
 * Indexes the access units of a sync-framed stream between `start` and `end`. DTS stored as 14-bit
 * or little-endian words is converted to the 16-bit big-endian form and carried as packet data;
 * every other stream is addressed in place. Damaged bytes are skipped to the next header that
 * agrees with the stream under compatible validation.
 */
export async function indexSyncAudio(
    readSource: (offset: number, count: number) => Promise<Uint8Array>,
    start: number,
    end: number,
    kind: SyncAudioKind,
    budget: DemuxIndexBudget,
    diagnostics: DiagnosticContext,
): Promise<SyncAudioIndex> {
    const read = (offset: number, count: number): Promise<Uint8Array> =>
        readSource(offset, Math.min(count, end - offset));

    let form: DtsStreamForm = 'be16';
    let offset = start;
    if (kind === 'dts') {
        const head = await read(start, Math.min(RESYNC_BYTES, end - start));
        let found = -1;
        for (let index = 0; index + 6 <= head.length && found < 0; index++)
            if (dtsStreamForm(head, index)) found = index;
        if (found < 0) throw new DemuxError('No DTS sync word found');
        form = dtsStreamForm(head, found)!;
        offset = start + found;
    }

    if (form !== 'be16') return indexConvertedDts(read, offset, end, form, budget);

    const samples: Sample[] = [];
    let codec = '';
    let sampleRate = 0;
    let channels = 0;
    let unitSamples = 0;
    let frames = 0;
    let unitLocations = 0;
    /** E-AC-3 dependent substreams extend AC-3 frames, which makes the stream E-AC-3 as a whole. */
    let extended = false;
    let window: Uint8Array = new Uint8Array(0);
    let windowStart = offset;
    while (offset < end) {
        if ((samples.length & 1023) === 0) await yieldEventLoop();
        if (offset + MAX_FRAME > windowStart + window.length && windowStart + window.length < end) {
            windowStart = offset;
            window = await read(offset, WINDOW + MAX_FRAME);
        }

        const frame = syncAudioFrame(kind, window, offset - windowStart);
        const agrees =
            frame !== null &&
            frame.bytes <= end - offset &&
            (!codec || frame.continuation || kind === 'truehd' || frame.codec === codec) &&
            (!sampleRate ||
                !frame.sampleRate ||
                frame.sampleRate === sampleRate ||
                !!frame.continuation);
        if (!agrees) {
            const next = await resync(kind, read, offset + 1, end, codec, sampleRate);
            if (next < 0) {
                if (!samples.length) throw new DemuxError(`No complete ${kind} frames`);
                diagnostics.recover({
                    code: 'AUDIO_TRUNCATED_TAIL',
                    format: kind,
                    offset,
                    message: `Ignored a damaged audio tail at byte ${offset}`,
                });
                break;
            }
            diagnostics.recover({
                code: 'AUDIO_RESYNCHRONIZED',
                format: kind,
                offset,
                message: `Skipped ${next - offset} damaged bytes; resumed at byte ${next}`,
            });
            offset = next;
            continue;
        }

        const previous = samples[samples.length - 1];
        if (frame.continuation && previous && previous.offset + previous.size === offset) {
            previous.size += frame.bytes;
            extended ||= frame.codec === 'ec-3';
            unitLocations |= frame.locations ?? 0;
        } else if (frame.sampleRate || sampleRate) {
            if (frame.sampleRate) {
                codec ||= frame.codec;
                sampleRate = frame.sampleRate;
                if (frame.locations === undefined)
                    channels = Math.max(channels, frame.channels ?? 0);
                unitSamples = frame.samples ?? unitSamples;
            }
            budget.reserveSamples(1, 256, 'Sync audio sample index');
            samples.push({
                offset,
                size: frame.bytes,
                timestamp: frames / sampleRate,
                decodeTimestamp: frames / sampleRate,
                duration: unitSamples / sampleRate,
                isKeyframe: kind !== 'truehd' || frame.sampleRate !== undefined,
            });
            frames += unitSamples;
            unitLocations = frame.locations ?? 0;
        }

        if (frame.locations !== undefined)
            channels = Math.max(channels, dolbyLocationChannels(unitLocations));
        offset += frame.bytes;
    }

    if (!samples.length) throw new DemuxError(`No complete ${kind} frames`);
    if (extended) codec = 'ec-3';
    return { codec, sampleRate, channels, samples, frames };
}

/**
 * DTS stored as little-endian or 14-bit words: each frame is converted to the 16-bit big-endian
 * form and carried as packet data. A 14-bit frame occupies 16 stored bits per 14 payload bits,
 * rounded up to whole words.
 */
async function indexConvertedDts(
    read: (offset: number, count: number) => Promise<Uint8Array>,
    start: number,
    end: number,
    form: DtsStreamForm,
    budget: DemuxIndexBudget,
): Promise<SyncAudioIndex> {
    const samples: Sample[] = [];
    let frames = 0;
    let first: ReturnType<typeof parseDtsFrame> = null;
    let window: Uint8Array = new Uint8Array(0);
    let windowStart = start;

    for (let offset = start; offset + 16 <= end;) {
        if ((samples.length & 1023) === 0) await yieldEventLoop();
        if (offset + MAX_FRAME > windowStart + window.length && windowStart + window.length < end) {
            windowStart = offset;
            window = await read(offset, WINDOW + MAX_FRAME);
        }

        const at = offset - windowStart;
        if (dtsStreamForm(window, at) !== form) {
            offset += 2;
            continue;
        }

        const head = dtsToBigEndian16(window.subarray(at, at + dtsStoredBytes(16, form)), form);
        const bytes = (((head[5]! & 3) << 12) | (head[6]! << 4) | (head[7]! >> 4)) + 1;
        const storedBytes = dtsStoredBytes(bytes, form);
        if (storedBytes > end - offset) break;
        const data = dtsToBigEndian16(window.subarray(at, at + storedBytes), form).slice(0, bytes);
        const frame = parseDtsFrame(data, 0);
        if (!frame || (first && frame.sampleRate !== first.sampleRate)) {
            offset += 2;
            continue;
        }

        first ??= frame;
        budget.reserveSamples(1, 256 + bytes, 'DTS sample index');
        samples.push({
            offset: 0,
            size: bytes,
            timestamp: frames / first.sampleRate,
            decodeTimestamp: frames / first.sampleRate,
            duration: frame.samples / first.sampleRate,
            isKeyframe: true,
            data,
        });
        frames += frame.samples;
        offset += storedBytes;
    }
    if (!first) throw new DemuxError('No complete dts frames');
    return {
        codec: first.codec,
        sampleRate: first.sampleRate,
        channels: first.channels,
        samples,
        frames,
    };
}

async function resync(
    kind: SyncAudioKind,
    read: (offset: number, count: number) => Promise<Uint8Array>,
    from: number,
    end: number,
    codec: string,
    sampleRate: number,
): Promise<number> {
    const limit = Math.min(end, from + RESYNC_BYTES);
    for (let base = from; base < limit; base += WINDOW) {
        await yieldEventLoop();
        const bytes = await read(base, WINDOW + 2 * MAX_FRAME);
        for (let index = 0; index < WINDOW && base + index < limit; index++) {
            let at = index;
            let verified = 0;
            while (verified < 2) {
                const frame = syncAudioFrame(kind, bytes, at);
                if (
                    !frame ||
                    (kind !== 'truehd' &&
                        (!frame.sampleRate || (sampleRate && frame.sampleRate !== sampleRate))) ||
                    (codec && kind !== 'truehd' && !frame.continuation && frame.codec !== codec)
                )
                    break;
                verified++;
                at += frame.bytes;
                if (base + at === end) verified = 2;
            }

            if (verified === 2) return base + index;
        }
    }
    return -1;
}

/** Raw AC-3, E-AC-3, DTS and TrueHD elementary stream files. */
export async function demuxSyncAudio(
    source: Source,
    options: SyncAudioDemuxOptions,
): Promise<DemuxResult> {
    const diagnostics = new DiagnosticContext(options, 'compatible');
    const kind = options.format;
    if (!['ac3', 'eac3', 'dts', 'truehd'].includes(kind))
        throw new MediaForgeError(`Sync audio format '${kind}' is not supported`, 'FORMAT');
    const budget = new DemuxIndexBudget(resolveDemuxBudget(options, 2_000_000));
    const reader = new ChunkReader(source);
    const read = (offset: number, count: number): Promise<Uint8Array> => {
        throwIfAborted(options.signal);
        return awaitWithAbort(reader.bytes(offset, count), options.signal);
    };
    const index = await indexSyncAudio(read, 0, source.size, kind, budget, diagnostics);
    throwIfAborted(options.signal);
    return { videoTracks: [], audioTracks: [syncAudioTrack(index)] };
}

export function syncAudioTrack(index: SyncAudioIndex): TrackInfo {
    return {
        id: 1,
        codec: index.codec,
        sampleRate: index.sampleRate,
        channelCount: index.channels,
        timescale: index.sampleRate,
        duration: index.frames / index.sampleRate,
        width: 0,
        height: 0,
        samples: index.samples,
    };
}
