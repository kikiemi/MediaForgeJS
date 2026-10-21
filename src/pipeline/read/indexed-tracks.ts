import type { CueWindow } from '../media-types';
import type { CountedTrack } from '../../core/model/media';
import { snapshotTrack } from './track-snapshot';
import { PacketHeap, lowerBound } from './packet-index';
import type { Source } from '../../core/model/types';
import type { SpatialVideo, TrackType } from '../../core/model/media';
import type { DemuxResult, TrackInfo, Sample } from '../../core/model/track';
import { assertSourceBytes } from '../../core/io/sources/source-read';
import { copyOutputBytes } from '../../core/bytes/output-data';
import { DemuxError, MediaForgeError } from '../../core/errors/errors';
import { isProResCodec } from '../../core/model/codec-strings';
import {
    getCompactSampleIndex,
    packetizedReaderOf,
    type PacketizedSampleReader,
    type SampleIndex,
} from '../../core/model/sample-index';
import { decodeTime } from '../../core/model/media-time';
import { checkPacketBytes } from '../../formats/shared/demux-budget';

export type SampleOrder = readonly number[] | Uint32Array;

/** A track of a media file with the orders its samples are read in. */
export interface IndexedTrack {
    readonly description: CountedTrack;
    readonly info: TrackInfo;
    readonly type: TrackType;
    readonly order?: SampleOrder;
    readonly presentationSorted: boolean;
    readonly allKeyframes: boolean;
    readonly sampleIndex?: SampleIndex;
    /** Reads samples whose bytes are spread over transport packets. */
    readonly packetized?: PacketizedSampleReader;
    presentationOrder?: SampleOrder;
    keyframeOrder?: SampleOrder;
    decodeKeyframeOrder?: SampleOrder;
}

interface ScheduledTrack {
    readonly track: IndexedTrack;
    readonly order?: SampleOrder;
    readonly length: number;
    /** Decode times this track starts and stops at instead of the schedule's bounds. */
    readonly start?: number;
    readonly end?: number;
    /** Presentation time samples shown earlier are skipped at (TrimCut.shownFrom). */
    readonly shownFrom?: number;
    readonly cueWindow?: CueWindow;
}

interface ScheduledSample {
    readonly track: IndexedTrack;
    readonly index: number;
    /** The window the sample, a subtitle cue of a trimmed copy, is clipped to. */
    readonly cueWindow: CueWindow | undefined;
}

/**
 * Merges per-track cursors by decode time; `next()` is synchronous so callers decide when to read
 * bytes.
 */
export class PacketSchedule {
    private readonly heap = new PacketHeap();
    private readonly step: {
        track: IndexedTrack;
        index: number;
        cueWindow: CueWindow | undefined;
    } = {
        track: undefined!,
        index: 0,
        cueWindow: undefined,
    };

    constructor(
        private readonly tracks: readonly ScheduledTrack[],
        start: number,
        private readonly end: number,
    ) {
        if (start === end) return;
        tracks.forEach((item, index) => {
            const position = lowerBound(item.length, item.start ?? start, i =>
                this.timeAt(item, i),
            );
            if (position < item.length)
                this.heap.push({ track: index, position, time: this.timeAt(item, position) });
        });
    }

    private timeAt(item: ScheduledTrack, position: number): number {
        const index = item.order?.[position] ?? position;
        return (
            item.track.sampleIndex?.decodeTimeAt(index) ??
            decodeTime(item.track.info.samples[index]!)
        );
    }

    /** The returned record is reused by the next call; a track past its end leaves the merge. */
    next(): ScheduledSample | undefined {
        for (;;) {
            let cursor = this.heap.pop();
            while (cursor && cursor.time >= (this.tracks[cursor.track]!.end ?? this.end))
                cursor = this.heap.pop();
            if (!cursor) return undefined;
            const item = this.tracks[cursor.track]!;
            const index = item.order?.[cursor.position] ?? cursor.position;
            cursor.position++;
            if (cursor.position < item.length) {
                // A track stops at its own end or the schedule's: one track with neither needs no
                // time to be merged or stopped by.
                cursor.time =
                    this.end === Infinity && this.tracks.length === 1 && item.end === undefined
                        ? cursor.time
                        : this.timeAt(item, cursor.position);
                this.heap.push(cursor);
            }

            if (item.shownFrom !== undefined && this.shownAt(item, index) < item.shownFrom)
                continue;
            this.step.track = item.track;
            this.step.index = index;
            this.step.cueWindow = item.cueWindow;
            return this.step;
        }
    }

    private shownAt(item: ScheduledTrack, index: number): number {
        return (
            item.track.sampleIndex?.timestampAt(index) ?? item.track.info.samples[index]!.timestamp
        );
    }
}

/** Limits on what a file's tracks may hold. */
interface TrackLimits {
    readonly source: Source;
    readonly maxSamples: number;
    readonly maxPacketBytes: number;
    readonly maxIndexBytes: number;
    /**
     * The reader handed the tracks over (its capabilities' handsOver): their compact indexes,
     * packet readers and samples are the file's to keep.
     */
    readonly ownsSamples: boolean;
}

/**
 * The demuxed tracks checked and snapshotted, with unique IDs, and the bytes their indexes hold;
 * every sample is validated against the source unless a compact index holds the samples.
 */
export function indexTracks(
    result: DemuxResult,
    { source, maxSamples, maxPacketBytes, maxIndexBytes, ownsSamples }: TrackLimits,
): { readonly tracks: IndexedTrack[]; readonly indexBytes: number } {
    const requestedGroups: readonly [TrackType, readonly TrackInfo[]][] = [
        ['video', result.videoTracks],
        ['audio', result.audioTracks],
        ['subtitle', result.subtitleTracks ?? []],
    ];
    const groups: [TrackType, TrackInfo[]][] = [];
    let trackCount = 0;
    for (const [type, tracks] of requestedGroups) {
        if (!Array.isArray(tracks)) throw new DemuxError('Expected a media track array');
        const length = tracks.length;
        trackCount += length;
        if (trackCount > 128) throw new DemuxError('Too many media tracks');
        const snapshots: TrackInfo[] = [];
        for (let index = 0; index < length; index++)
            snapshots.push(snapshotTrack(tracks[index]!, ownsSamples));
        groups.push([type, snapshots]);
    }
    const list: IndexedTrack[] = [];
    const reserved = new Set<number>();
    for (const [, tracks] of groups)
        for (const track of tracks) {
            if (Number.isSafeInteger(track.id) && track.id! > 0) reserved.add(track.id!);
        }
    const used = new Set<number>();
    let nextId = 1;
    let totalSampleCount = 0;
    let indexBytes = 0;
    for (const [type, tracks] of groups)
        for (const raw of tracks) {
            if (
                typeof raw.codec !== 'string' ||
                !raw.codec ||
                !Number.isFinite(raw.duration) ||
                raw.duration < 0
            ) {
                throw new DemuxError('Invalid media track description');
            }
            for (const value of [raw.default, raw.forced, raw.commentary, raw.alphaMode]) {
                if (value !== undefined && typeof value !== 'boolean')
                    throw new DemuxError(
                        'Track default, forced, commentary and alphaMode must be booleans',
                    );
            }
            for (const field of ['name', 'title'] as const)
                if (raw[field] !== undefined && typeof raw[field] !== 'string')
                    throw new DemuxError(`Track ${field} must be a string`);
            const compact = ownsSamples ? getCompactSampleIndex(raw) : undefined;
            const packetized = ownsSamples ? packetizedReaderOf(raw) : undefined;
            const rawSamples = compact ? [] : raw.samples;
            if (!Array.isArray(rawSamples)) throw new DemuxError('Expected a media sample array');
            const length = compact?.length ?? rawSamples.length;
            totalSampleCount += length;
            indexBytes += compact?.byteLength ?? length * 256;
            if (totalSampleCount > maxSamples)
                throw new MediaForgeError('Sample index exceeds maxSamples', 'OOM');
            if (indexBytes > maxIndexBytes)
                throw new MediaForgeError('Sample index exceeds maxIndexBytes', 'OOM');
            if (compact) checkPacketBytes(compact.maxSampleSize, maxPacketBytes);
            let id = raw.id;
            if (!Number.isSafeInteger(id) || id! < 1 || used.has(id!)) {
                while (reserved.has(nextId) || used.has(nextId)) nextId++;
                id = nextId++;
            }
            let ordered = compact?.decodeSorted ?? true;
            let presentationSorted = compact?.presentationSorted ?? true;
            let allKeyframes = compact?.allKeyframes ?? true;
            let previousDts = -Infinity;
            let previousPts = -Infinity;
            const samples: Sample[] = ownsSamples ? rawSamples : new Array(length);
            for (let sampleIndex = 0; !compact && sampleIndex < length; sampleIndex++) {
                const input = rawSamples[sampleIndex];
                if (!input || typeof input !== 'object')
                    throw new DemuxError(`Invalid sample in track ${id}`);
                const sample = ownsSamples ? input : copiedSample(input);
                if (!validSample(sample, raw, type, source, packetized))
                    throw new DemuxError(`Invalid sample in track ${id}`);
                if (
                    (sample.alphaOffset !== undefined || sample.alphaSize !== undefined) &&
                    !validAlpha(sample, raw, type, source)
                )
                    throw new DemuxError(`Invalid alpha sample in track ${id}`);
                checkPacketBytes(sample.size + (sample.alphaSize ?? 0), maxPacketBytes);
                if (sample.data) assertSourceBytes(sample.data, sample.size, 'sample');
                const dts = decodeTime(sample);
                if (dts < previousDts) ordered = false;
                if (sample.timestamp < previousPts) presentationSorted = false;
                if (!sample.isKeyframe) allKeyframes = false;
                previousDts = dts;
                previousPts = sample.timestamp;

                // Inline bytes can still alias source storage even when the ledger is owned.
                if (sample.data) sample.data = copyOutputBytes(sample.data);
                samples[sampleIndex] = sample;
            }
            const defaultConfig =
                raw.codecConfig ??
                (raw.codecConfigurations?.length === 1
                    ? raw.codecConfigurations[0]!.codecConfig
                    : undefined);

            // The snapshot takes copies of its configuration bytes: the reader may reuse its own.
            raw.id = id!;
            if (!compact) raw.samples = samples;
            raw.colour = raw.colour ? { ...raw.colour } : undefined;
            raw.codecConfig = defaultConfig ? copyOutputBytes(defaultConfig) : undefined;
            raw.dolbyVisionConfig = raw.dolbyVisionConfig
                ? copyOutputBytes(raw.dolbyVisionConfig)
                : undefined;
            if (raw.spatialBoxes) raw.spatialBoxes = copyOutputBytes(raw.spatialBoxes);
            if (raw.spatial) raw.spatial = spatialSnapshot(raw.spatial);
            raw.codecConfigurations = raw.codecConfigurations?.map(value => ({
                ...value,
                codecConfig: copyOutputBytes(value.codecConfig),
            }));
            let order: SampleOrder | undefined;
            if (!ordered && compact) {
                indexBytes += length * 4;
                if (indexBytes > maxIndexBytes)
                    throw new MediaForgeError('Sample order exceeds maxIndexBytes', 'OOM');
                const indices = new Uint32Array(length);
                for (let position = 0; position < length; position++) indices[position] = position;
                indices.sort((a, b) => compact.decodeTimeAt(a) - compact.decodeTimeAt(b) || a - b);
                order = indices;
            } else if (!ordered) {
                order = samples
                    .map((_, i) => i)
                    .sort((a, b) => decodeTime(samples[a]!) - decodeTime(samples[b]!) || a - b);
            }
            used.add(id!);
            list.push({
                description: trackDescription(raw, type, id!, length),
                info: raw,
                type,
                order,
                presentationSorted,
                allKeyframes,
                sampleIndex: compact,
                packetized,
            });
        }
    if (list.length === 0) throw new DemuxError('No media tracks');
    return { tracks: list, indexBytes };
}

/** A sample with only the fields of Sample, copied from one the caller keeps. */
function copiedSample(input: Sample): Sample {
    const {
        offset,
        size,
        timestamp,
        duration,
        isKeyframe,
        decodeTimestamp,
        compositionTimeOffset,
        codecConfigIndex,
        data,
        leadingDiscard,
        trailingDiscard,
        decodeOnly,
        alphaOffset,
        alphaSize,
        nalUnitFormat,
        proResHeaderless,
        aes3,
    } = input;

    const sample: Sample = { offset, size, timestamp, duration, isKeyframe };
    if (decodeTimestamp !== undefined) sample.decodeTimestamp = decodeTimestamp;
    if (compositionTimeOffset !== undefined) sample.compositionTimeOffset = compositionTimeOffset;
    if (codecConfigIndex !== undefined) sample.codecConfigIndex = codecConfigIndex;
    if (leadingDiscard !== undefined) sample.leadingDiscard = leadingDiscard;
    if (trailingDiscard !== undefined) sample.trailingDiscard = trailingDiscard;
    if (decodeOnly !== undefined) sample.decodeOnly = decodeOnly;
    sample.data = data;
    if (alphaOffset !== undefined) sample.alphaOffset = alphaOffset;
    if (alphaSize !== undefined) sample.alphaSize = alphaSize;
    if (nalUnitFormat !== undefined) sample.nalUnitFormat = nalUnitFormat;
    if (proResHeaderless !== undefined) sample.proResHeaderless = proResHeaderless;
    if (aes3 !== undefined)
        sample.aes3 = { channels: aes3.channels, bytesPerSample: aes3.bytesPerSample };
    return sample;
}

/** Whether a sample's timing, flags and bytes are consistent with its track and the source. */
function validSample(
    sample: Sample,
    raw: TrackInfo,
    type: TrackType,
    source: Source,
    packetized: PacketizedSampleReader | undefined,
): boolean {
    return !(
        !Number.isFinite(sample.timestamp) ||
        !Number.isFinite(sample.duration) ||
        sample.duration < 0 ||
        !Number.isFinite(decodeTime(sample)) ||
        typeof sample.isKeyframe !== 'boolean' ||
        !Number.isSafeInteger(sample.size) ||
        sample.size < 0 ||
        !Number.isSafeInteger(sample.offset) ||
        sample.offset < 0 ||
        (sample.compositionTimeOffset !== undefined &&
            !Number.isFinite(sample.compositionTimeOffset)) ||
        (sample.leadingDiscard !== undefined && typeof sample.leadingDiscard !== 'boolean') ||
        (sample.trailingDiscard !== undefined &&
            (type !== 'audio' ||
                !Number.isSafeInteger(sample.trailingDiscard) ||
                sample.trailingDiscard < 1)) ||
        (sample.decodeOnly !== undefined && typeof sample.decodeOnly !== 'boolean') ||
        (sample.proResHeaderless !== undefined &&
            (typeof sample.proResHeaderless !== 'boolean' ||
                type !== 'video' ||
                !isProResCodec(raw.codec))) ||
        (sample.nalUnitFormat !== undefined &&
            (type !== 'video' ||
                !/^(avc|hev1|hvc1|dvh1|dvhe|vvc1|vvi1)/.test(raw.codec) ||
                (sample.nalUnitFormat !== 'annexb' && sample.nalUnitFormat !== 'avcc'))) ||
        (sample.aes3 !== undefined &&
            (type !== 'audio' ||
                !/^pcm-s(16|24)le$/.test(raw.codec) ||
                !Number.isInteger(sample.aes3.channels) ||
                sample.aes3.channels < 1 ||
                sample.aes3.channels > 8 ||
                (sample.aes3.bytesPerSample !== 2 && sample.aes3.bytesPerSample !== 3))) ||
        (sample.codecConfigIndex !== undefined &&
            (!Number.isInteger(sample.codecConfigIndex) ||
                sample.codecConfigIndex < 0 ||
                sample.codecConfigIndex >= (raw.codecConfigurations?.length ?? 0))) ||
        (!sample.data &&
            (sample.packetSkip === undefined
                ? sample.size > source.size - sample.offset
                : !packetized ||
                  !Number.isSafeInteger(sample.packetSkip) ||
                  sample.packetSkip < 0 ||
                  sample.offset >= source.size))
    );
}

/**
 * Whether a sample's alpha bytes (a VP8/VP9 alpha channel) are in the source of a track that has
 * alpha.
 */
function validAlpha(sample: Sample, raw: TrackInfo, type: TrackType, source: Source): boolean {
    return !(
        type !== 'video' ||
        raw.alphaMode !== true ||
        !Number.isSafeInteger(sample.alphaOffset) ||
        sample.alphaOffset! < 0 ||
        !Number.isSafeInteger(sample.alphaSize) ||
        sample.alphaSize! < 1 ||
        sample.alphaSize! > source.size - sample.alphaOffset!
    );
}

/** A frozen copy of a track's spatial video. */
function spatialSnapshot(spatial: SpatialVideo): SpatialVideo {
    return Object.freeze({ ...spatial, eyes: Object.freeze([...spatial.eyes]) });
}

/** The public description of a snapshotted track. */
function trackDescription(
    raw: TrackInfo,
    type: TrackType,
    id: number,
    length: number,
): CountedTrack {
    return Object.freeze({
        id,
        type,
        codec: raw.codec,
        matroskaTrackUid: raw.matroskaTrackUid,
        width: raw.width || undefined,
        height: raw.height || undefined,
        displayWidth: raw.displayWidth,
        displayHeight: raw.displayHeight,
        pixelAspectRatioNum: raw.pixelAspectRatioNum,
        pixelAspectRatioDen: raw.pixelAspectRatioDen,
        ...(raw.rotation ? { rotation: raw.rotation } : {}),
        ...(raw.spatial ? { spatial: raw.spatial } : {}),
        sampleRate: raw.sampleRate || undefined,
        channelCount: raw.channelCount || undefined,
        language: raw.language,
        default: raw.default,
        forced: raw.forced,
        name: raw.name,
        title: raw.title,
        commentary: raw.commentary,
        alphaMode: raw.alphaMode,
        incomplete: raw.incomplete,
        timescale: raw.timescale,
        duration: raw.duration,
        sampleCount: length,
        codecConfig: raw.codecConfig,
    });
}
