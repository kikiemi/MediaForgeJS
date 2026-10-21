import type { Mp4CodecConfiguration } from '../../../core/model/track';
import type { Source } from '../../../core/model/types';
import type { ByteReader } from '../../../core/io/sources/chunk-reader';
import type { DemuxIndexBudget } from '../../shared/demux-budget';
import type { DiagnosticContext } from '../../../core/errors/diagnostics';
import { ascii, findBox, readU16, readU32, type Box } from './boxes';
import type { SampleEntry } from './read-types';

/** What the parts of the MP4 reader loaded on demand use of the reader reading an input. */
export interface Mp4ReadContext {
    readonly source: Source;
    /**
     * Top-level box walks: the walk of the input that already happened, else reads that skip media
     * payloads.
     */
    readonly boxes: ByteReader;
    readonly signal: AbortSignal | undefined;
    readonly validation: DiagnosticContext['validation'];
    readonly budget: DemuxIndexBudget;
    /** Whether the track tables of the movie box are kept as compact indexes. */
    readonly compactClassic: boolean;
    recover(diagnostic: Parameters<DiagnosticContext['recover']>[0]): void;
    note(diagnostic: Parameters<DiagnosticContext['warn']>[0]): void;
    fitsMedia(offset: number, size: number): boolean;
    /**
     * A probe's window of the fragments: the top-level walks pass over the boxes from the end of
     * the movie box to the window's first moof, and every fragment is timed by its own tfdt.
     */
    readonly passOver?: { readonly from: number; readonly to: number };
}

/**
 * The frames of compressed sound whose version-0 descriptions leave the frame shape to the codec,
 * as ffmpeg's reader knows them: samples of one channel per frame, and bytes per channel. IMA4
 * packs 64 samples into 34 bytes, MACE 3:1 and 6:1 six samples into two bytes and one.
 */
export const QUICKTIME_SOUND_FRAMES: ReadonlyMap<string, { samples: number; bytes: number }> =
    new Map([
        ['ima4', { samples: 64, bytes: 34 }],
        ['MAC3', { samples: 6, bytes: 2 }],
        ['MAC6', { samples: 6, bytes: 1 }],
    ]);

/**
 * Samples per packet read from chunk-layout sound, as ffmpeg groups them: at most 1024, never
 * across a chunk.
 */
const CHUNK_AUDIO_PACKET_SAMPLES = 1024;

/**
 * Units per packet: codec frames of 160 samples or more (GSM and larger) stay one packet each, as
 * in ffmpeg.
 */
export function chunkAudioUnitsPerPacket(unitSamples: number): number {
    return unitSamples >= 160 ? 1 : Math.floor(CHUNK_AUDIO_PACKET_SAMPLES / unitSamples);
}

const UNCOMPRESSED_AUDIO_ENTRIES = new Set([
    'twos',
    'sowt',
    'raw ',
    'NONE',
    'in24',
    'in32',
    'fl32',
    'fl64',
    'lpcm',
    'ulaw',
    'alaw',
    'ipcm',
    'fpcm',
]);

/**
 * Samples per unit of sound whose sample tables count single samples (one stts run of duration 1):
 * 1 for uncompressed entries, samplesPerPacket for version-1 descriptions of compressed sound, the
 * codec frame of a version-0 description of IMA4 or MACE, undefined otherwise.
 */
export function chunkAudioUnitSamples(
    buf: Uint8Array,
    dv: DataView,
    stblS: number,
    stblE: number,
): number | undefined {
    const stts = findBox(buf, stblS, stblE, 'stts');
    const stsd = findBox(buf, stblS, stblE, 'stsd');
    if (
        !stts ||
        stts.size < 24 ||
        readU32(dv, stts.offset + 12) !== 1 ||
        readU32(dv, stts.offset + 20) !== 1
    )
        return undefined;
    if (!stsd || stsd.size < 16 + 36 || readU32(dv, stsd.offset + 12) < 1) return undefined;
    const entry = stsd.offset + 16;
    if (UNCOMPRESSED_AUDIO_ENTRIES.has(ascii(buf, entry + 4, 4))) return 1;
    if (readU16(dv, entry + 16) === 0)
        return QUICKTIME_SOUND_FRAMES.get(ascii(buf, entry + 4, 4))?.samples;
    if (readU16(dv, entry + 16) !== 1 || stsd.size < 16 + 52) return undefined;
    const samples = readU32(dv, entry + 36);
    return samples > 1 && readU32(dv, entry + 44) > 0 ? samples : undefined;
}

/**
 * Packets of chunk-layout sound: each chunk splits into runs of chunkAudioUnitsPerPacket whole
 * units. Undefined for a layout that is not whole units per chunk, which the per-sample reader then
 * validates. With `budgetOnly` (the sample-budget preflight) a partial unit counts as one and
 * several descriptions are allowed: such tracks are read per sample, where their own count is
 * checked again, or skipped.
 */
export function chunkAudioPacketCount(
    dv: DataView,
    stsc: Box,
    stco: Box,
    unitSamples: number,
    descriptions = 1,
    budgetOnly = false,
): number | undefined {
    const chunkCount = readU32(dv, stco.offset + 12);
    const entries = readU32(dv, stsc.offset + 12);
    if (
        16 + chunkCount * (stco.type === 'co64' ? 8 : 4) > stco.size ||
        entries === 0 ||
        16 + entries * 12 > stsc.size
    )
        return undefined;

    const unitsPerPacket = chunkAudioUnitsPerPacket(unitSamples);
    let packets = 0;
    for (let entry = 0; entry < entries; entry++) {
        const at = stsc.offset + 16 + entry * 12;
        const first = readU32(dv, at);
        const next = entry + 1 < entries ? readU32(dv, at + 12) : chunkCount + 1;
        const samples = readU32(dv, at + 4);
        if (
            (entry === 0 && first !== 1) ||
            next <= first ||
            next > chunkCount + 1 ||
            readU32(dv, at + 8) < 1 ||
            readU32(dv, at + 8) > descriptions ||
            (samples % unitSamples !== 0 && !budgetOnly)
        )
            return undefined;
        packets += (next - first) * Math.ceil(Math.ceil(samples / unitSamples) / unitsPerPacket);
    }

    return Number.isSafeInteger(packets) && packets > 0 ? packets : undefined;
}

/**
 * Reports of sample tables that time or offset more or fewer samples than a track has, or list sync
 * samples out of order.
 */
export function sampleTableNotes(context: Pick<Mp4ReadContext, 'recover'>): {
    compositionExcess(samples: number): void;
    timingExcess(samples: number): void;
    timingShort(samples: number): void;
    syncIgnored(table: string, entries: number): void;
} {
    return {
        compositionExcess: samples =>
            context.recover({
                code: 'MP4_CTTS_EXCESS',
                format: 'mp4',
                message:
                    `Ignored composition offsets for ${samples} samples past the end of the ` +
                    `track`,
            }),
        timingExcess: samples =>
            context.recover({
                code: 'MP4_STTS_EXCESS',
                format: 'mp4',
                message: `Ignored decode times for ${samples} samples past the end of the track`,
            }),
        timingShort: samples =>
            context.recover({
                code: 'MP4_STTS_SHORT',
                format: 'mp4',
                message:
                    `stts leaves the last ${samples} samples untimed; they continue its ` +
                    `last duration`,
            }),
        syncIgnored: (table, entries) =>
            context.recover({
                code: 'MP4_SYNC_TABLE',
                format: 'mp4',
                message:
                    `Ignored ${entries} ${table} entries that do not increase within the ` +
                    `sample count`,
            }),
    };
}

/**
 * Per-sample decoder configurations of sample descriptions that differ only in their configuration.
 */
export function codecConfigurations(
    entries: readonly SampleEntry[],
    video: boolean,
): Mp4CodecConfiguration[] {
    return entries.map(entry => ({
        codec: entry.codec,
        codecConfig: entry.codecConfig!,
        ...(entry.width ? { width: entry.width, height: entry.height } : {}),
        ...(entry.displayWidth
            ? { displayWidth: entry.displayWidth, displayHeight: entry.displayHeight }
            : {}),
        ...(video
            ? {
                  pixelAspectRatioNum: entry.pixelAspectRatioNum,
                  pixelAspectRatioDen: entry.pixelAspectRatioDen,
              }
            : {}),
        ...(entry.sampleRate
            ? { sampleRate: entry.sampleRate, channelCount: entry.channelCount }
            : {}),
    }));
}
