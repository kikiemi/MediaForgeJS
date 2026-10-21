import { throwIfAborted } from '../../../core/errors/errors';
import type { CmafTrack } from './cmaf-boxes';
import type { EncodedPacket } from '../../../core/model/media';
import { secondsToTicks } from '../../../core/model/media-time';
import type { Sink } from '../../../core/model/types';
import { assertSink, drainSink } from '../../../core/io/sinks/sink-backpressure';
import { linkAbortSignals } from '../../../core/io/abort';
import { assertSourceBytes } from '../../../core/io/sources/source-read';
import { retainedBytes } from '../../../core/bytes/output-data';
import { releaseBytes } from '../../../core/bytes/byte-holds';
import { encodeEventMessage } from '../../metadata/emsg';
import type { EventMessage } from '../../metadata/emsg';
import { u32, join, integer, cmafAssert, buildCmafInit } from './cmaf-boxes';
import { isoFullBox as fullBox } from '../../shared/iso-box';
import { isLengthPrefixed, nalLengthSizeOf } from '../../../core/codec-config/video/annexb';
import { validateMp4TrackMetadata } from '../metadata';
import { checkedFieldOrder, snapshotVideoColour } from '../../shared/video-colour';
import type { MediaTags } from '../../../core/model/media';
import { dataView } from '../../../core/bytes/byte-fields';
import { typedArrayByteLength as byteLengthOf } from '../../../core/bytes/typed-array';
import { audioHasKeyframes } from '../../../core/model/codec-strings';

export interface CmafWriterOptions {
    readonly tracks: readonly CmafTrack[];
    readonly title?: string;
    /** Movie tags, chapters and cover art for the initialization segment. */
    readonly tags?: MediaTags;
    readonly maxBufferedBytes?: number;
    readonly maxBufferedSamples?: number;
    /**
     * Defaults to 1000; zero disables events. Encoded event bytes also count against
     * maxBufferedBytes.
     */
    readonly maxBufferedEvents?: number;
    readonly sequenceNumber?: number;
}

export interface CmafSample {
    readonly trackId: number;
    readonly data: Uint8Array;
    /** Exact nonnegative decode timestamp in this track's timescale. */
    readonly decodeTimestamp: bigint | number;
    readonly duration: number;
    readonly compositionTimeOffset?: number;
    readonly isKeyframe: boolean;
}

export interface CmafFlushOptions {
    /** Defaults to true. False permits dependent chunks within a segment. */
    readonly requireKeyframe?: boolean;
    readonly producerReferenceTime?: CmafProducerReferenceTime;
}

export interface CmafProducerReferenceTime {
    readonly trackId: number;
    /**
     * Unsigned NTP timestamp: seconds since 1900 in the high 32 bits, fractional seconds in the low
     * 32 bits.
     */
    readonly ntpTimestamp: bigint;
    /** Presentation time in the referenced track's timescale. */
    readonly mediaTime: bigint | number;
}

export interface CmafSegmentTrack {
    readonly trackId: number;
    readonly timescale: number;
    readonly baseDecodeTime: bigint;
    readonly duration: bigint;
    readonly sampleCount: number;
    readonly independent: boolean;
}

export interface CmafSegmentInfo {
    readonly sequenceNumber: number;
    readonly byteLength: number;
    readonly independent: boolean;
    readonly tracks: readonly CmafSegmentTrack[];
}

export interface CmafSegment extends CmafSegmentInfo {
    readonly data: Uint8Array;
}

interface StoredSample {
    readonly data: Uint8Array;
    readonly decodeTimestamp: bigint;
    duration: number;
    readonly compositionTimeOffset: number;
    readonly isKeyframe: boolean;
}

interface TrackState {
    readonly track: CmafTrack;
    samples: StoredSample[];
    decodeEnd?: bigint;
    negativeOffsets?: boolean;
    largeOffsets?: boolean;
}

interface FragmentPlan {
    readonly states: readonly TrackState[];
    readonly prefix: readonly Uint8Array[];
    readonly moof: Uint8Array;
    readonly mdatHeader: Uint8Array;
    readonly info: CmafSegmentInfo;
}

const MAX_U64 = 0xffffffffffffffffn;

/** An empty 3GPP timed-text sample, which ends the cue before it. */
const TX3G_EMPTY = Uint8Array.of(0, 0);

/** An empty WebVTT sample (vtte box). */
const VTT_EMPTY = Uint8Array.of(0, 0, 0, 8, 0x76, 0x74, 0x74, 0x65);

function byteCount(data: Uint8Array): number {
    let count: number;
    try {
        count = byteLengthOf.call(data);
    } catch {
        cmafAssert(false, 'sample/configuration bytes must be Uint8Array');
    }
    assertSourceBytes(data, count, 'fMP4');
    return count;
}

function timestamp(value: bigint | number, label = 'decode timestamp'): bigint {
    if (typeof value === 'number') integer(value, label, 0, Number.MAX_SAFE_INTEGER);
    cmafAssert(
        typeof value === 'bigint' || typeof value === 'number',
        `${label} must be bigint or number`,
    );
    const result = BigInt(value);
    cmafAssert(result >= 0n && result <= MAX_U64, `${label} is outside the unsigned 64-bit range`);
    return result;
}

function validatePayload(track: CmafTrack, data: Uint8Array): void {
    const kind = track.codec.split('.')[0]!;
    const width = nalLengthSizeOf(track);
    if (width) {
        cmafAssert(
            data.length === 0 || isLengthPrefixed(data, width),
            'samples must use the configured NAL length prefix, not Annex B',
        );
    } else if (kind === 'mp4a') {
        cmafAssert(
            data.length < 2 || data[0] !== 0xff || (data[1]! & 0xf6) !== 0xf0,
            'AAC samples must be raw access units, not ADTS',
        );
    } else if (kind === 'wvtt') {
        let offset = 0;
        const view = dataView(data);
        while (offset < data.length) {
            cmafAssert(offset + 8 <= data.length, 'truncated WebVTT sample box');
            const size = view.getUint32(offset);
            const type = String.fromCharCode(...data.subarray(offset + 4, offset + 8));
            cmafAssert(
                size >= 8 &&
                    size <= data.length - offset &&
                    ['vttc', 'vtte', 'vtta'].includes(type),
                'wvtt samples must contain MP4 WebVTT cue boxes',
            );
            offset += size;
        }
    }
}

/**
 * Bounded fragmented MP4 writer for CMAF-oriented packaging; codec/profile conformance remains
 * caller-owned.
 */
export class CmafWriter {
    private readonly states = new Map<number, TrackState>();
    private readonly init: Uint8Array;
    private readonly maxBytes: number;
    private readonly maxSamples: number;
    private readonly maxEvents: number;
    private events: Uint8Array[] = [];
    private eventBytes = 0;
    private bytes = 0;
    private samples = 0;
    private sequence: number;
    private writing = false;
    private failure: unknown;
    private failed = false;

    constructor(options: CmafWriterOptions) {
        cmafAssert(options && typeof options === 'object', 'invalid writer options');
        const {
            tracks,
            title,
            tags,
            maxBufferedBytes,
            maxBufferedSamples,
            maxBufferedEvents,
            sequenceNumber,
        } = options;

        cmafAssert(
            Array.isArray(tracks) && tracks.length > 0 && tracks.length <= 256,
            'provide between 1 and 256 tracks',
        );
        this.maxBytes = integer(
            maxBufferedBytes ?? 16 * 1024 * 1024,
            'maxBufferedBytes',
            1,
            0x7f000000,
        );
        this.maxSamples = integer(
            maxBufferedSamples ?? 100_000,
            'maxBufferedSamples',
            1,
            1_000_000,
        );
        this.maxEvents = integer(maxBufferedEvents ?? 1000, 'maxBufferedEvents', 0, 100_000);
        this.sequence = integer(sequenceNumber ?? 1, 'sequenceNumber', 1);
        for (const source of tracks.slice()) {
            cmafAssert(source && typeof source === 'object', 'invalid track configuration');
            const {
                id,
                type,
                codec,
                timescale,
                width,
                height,
                rotation,
                pixelAspectRatioNum,
                pixelAspectRatioDen,
                sampleRate,
                channelCount,
                codecConfig,
                language,
                default: defaultTrack,
                forced,
                commentary,
                name,
                title: trackTitle,
                namespace,
                schemaLocation,
                auxiliaryMimeTypes,
                edit,
                colour,
                fieldOrder,
                spatialBoxes,
            } = source;

            integer(id, 'track ID', 1, 0xfffffffe);
            integer(timescale, 'timescale', 1);
            cmafAssert(['video', 'audio', 'subtitle'].includes(type), 'invalid track type');
            cmafAssert(typeof codec === 'string' && codec.length > 0, 'missing track codec');
            cmafAssert(!this.states.has(id), `duplicate track ID ${id}`);
            cmafAssert(
                rotation === undefined ||
                    (type === 'video' && [0, 90, 180, 270].includes(rotation)),
                'rotation must be 0, 90, 180 or 270 on a video track',
            );
            cmafAssert(
                codecConfig === undefined || byteCount(codecConfig) <= 1024 * 1024,
                'decoder configuration must be at most 1 MiB',
            );
            if (edit !== undefined) {
                integer(edit.mediaTime, 'edit media time', 0, 0xffffffff);
                if (edit.duration !== undefined)
                    integer(edit.duration, 'edit duration', 0, 0xffffffff);
            }

            const track: CmafTrack = {
                id,
                type,
                codec,
                timescale,
                width,
                height,
                rotation,
                pixelAspectRatioNum,
                pixelAspectRatioDen,
                sampleRate,
                channelCount,
                codecConfig: codecConfig === undefined ? undefined : new Uint8Array(codecConfig),
                language,
                default: defaultTrack,
                forced,
                commentary,
                name,
                title: trackTitle,
                namespace,
                schemaLocation,
                auxiliaryMimeTypes,
                edit: edit && { mediaTime: edit.mediaTime, duration: edit.duration },
                ...(type === 'video' && colour !== undefined
                    ? { colour: snapshotVideoColour(colour) }
                    : {}),
                ...(type === 'video' && fieldOrder !== undefined
                    ? { fieldOrder: checkedFieldOrder(fieldOrder) }
                    : {}),
                ...(type === 'video' && spatialBoxes !== undefined
                    ? { spatialBoxes: spatialBoxes.slice() }
                    : {}),
            };

            validateMp4TrackMetadata(track);
            this.states.set(track.id, { track, samples: [] });
        }

        this.init = buildCmafInit(
            [...this.states.values()].map(state => state.track),
            title,
            tags,
        );
    }

    /**
     * Retained sample payload and encoded emsg bytes; excludes initialization and fragment headers.
     */
    get bufferedBytes(): number {
        return this.bytes + this.eventBytes;
    }
    get bufferedSamples(): number {
        return this.samples;
    }
    get bufferedEvents(): number {
        return this.events.length;
    }

    createInitSegment(): Uint8Array {
        this.assertReady();
        return this.init.slice();
    }

    async writeInitSegment(sink: Sink, signal?: AbortSignal): Promise<void> {
        this.assertReady();
        assertSink(sink);
        const linked = linkAbortSignals(signal, sink.signal);
        let started = false;
        let acquired = false;
        try {
            this.assertReady();
            this.writing = true;
            acquired = true;
            throwIfAborted(linked.signal);
            const data = this.init.slice();
            started = true;
            sink.write(data);
            await drainSink(sink, linked.signal);
            throwIfAborted(linked.signal);
        } catch (error) {
            if (started) {
                this.failed = true;
                this.failure = error;
            }
            throw error;
        } finally {
            linked.dispose();
            if (acquired) this.writing = false;
        }
    }

    /**
     * Copies an emsg for the next nonempty fragment; version-0 deltas are relative to that
     * fragment's presentation start.
     */
    addEvent(event: EventMessage): void {
        this.assertReady();
        cmafAssert(event && typeof event === 'object', 'invalid event message');
        const { version, schemeIdUri, value, timescale, eventDuration, id, messageData } = event;
        const time =
            version === 0
                ? { version, presentationTimeDelta: event.presentationTimeDelta }
                : version === 1
                  ? { version, presentationTime: event.presentationTime }
                  : undefined;

        this.assertReady();
        cmafAssert(time, 'unsupported emsg version');
        const length = byteCount(messageData);
        const remaining = this.maxBytes - this.bufferedBytes;
        cmafAssert(
            this.events.length < this.maxEvents && length <= remaining,
            'event buffer is full; flush the fragment first',
        );
        cmafAssert(
            typeof schemeIdUri === 'string' && typeof value === 'string',
            'invalid emsg strings',
        );
        cmafAssert(
            30 + (version === 1 ? 4 : 0) + schemeIdUri.length + value.length + length <= remaining,
            'event buffer is full; flush the fragment first',
        );
        const encoded = encodeEventMessage({
            ...time,
            schemeIdUri,
            value,
            timescale,
            eventDuration,
            id,
            messageData: new Uint8Array(messageData),
        });

        cmafAssert(encoded.length <= remaining, 'event buffer is full; flush the fragment first');
        this.events.push(encoded);
        this.eventBytes += encoded.length;
    }

    addChunk(trackId: number, chunk: EncodedPacket): void {
        this.assertReady();
        cmafAssert(
            chunk.alphaData === undefined,
            'VP8/VP9 alpha side data requires Matroska output',
        );
        const {
            data,
            trackType,
            timestamp: pts,
            decodeTimestamp,
            compositionTimeOffset,
            duration,
            isKeyframe,
        } = chunk;

        const state = this.getTrack(trackId);
        cmafAssert(trackType === state.track.type, 'chunk type does not match track');
        const scale = state.track.timescale;
        const dts = decodeTimestamp ?? pts;
        const ptsUnits = secondsToTicks(pts, scale, 'Fragmented MP4 presentation timestamp');
        const dtsUnits = secondsToTicks(dts, scale, 'Fragmented MP4 decode timestamp');
        const cto =
            compositionTimeOffset === undefined
                ? ptsUnits - dtsUnits
                : secondsToTicks(compositionTimeOffset, scale, 'Fragmented MP4 composition offset');
        cmafAssert(
            compositionTimeOffset === undefined || Math.abs(ptsUnits - dtsUnits - cto) <= 1,
            'composition offset disagrees with presentation timestamp',
        );
        this.addSample({
            trackId,
            data,
            decodeTimestamp: dtsUnits,
            duration: secondsToTicks(duration, scale, 'Fragmented MP4 duration'),
            compositionTimeOffset: cto,
            isKeyframe,
        });
    }

    addSample(sample: CmafSample): void {
        this.assertReady();
        const state = this.getTrack(sample.trackId);

        // Timed text has no gaps: a cue that starts after the previous one ended follows an empty
        // sample.
        const empty =
            state.track.codec === 'tx3g'
                ? TX3G_EMPTY
                : state.track.codec === 'wvtt'
                  ? VTT_EMPTY
                  : undefined;

        // A text sample of no duration (the empty one a movie ends its last cue with) adds nothing
        // to fragments, where the sample before it ends the cue.
        if (empty && sample.duration === 0) return;

        const dts = empty && state.samples.length ? timestamp(sample.decodeTimestamp) : undefined;
        if (dts !== undefined && state.decodeEnd !== undefined && dts > state.decodeEnd)
            this.store(state, {
                trackId: sample.trackId,
                data: empty!,
                decodeTimestamp: state.decodeEnd,
                duration: Number(dts - state.decodeEnd),
                compositionTimeOffset: 0,
                isKeyframe: true,
            });

        this.store(state, sample);
    }

    private store(state: TrackState, sample: CmafSample): void {
        const {
            data,
            decodeTimestamp,
            duration: rawDuration,
            compositionTimeOffset,
            isKeyframe,
        } = sample;

        const dts = timestamp(decodeTimestamp);
        const duration = integer(rawDuration, 'duration', 1);
        const cto = integer(
            compositionTimeOffset ?? 0,
            'composition offset',
            -0x80000000,
            0xffffffff,
        );

        cmafAssert(
            !(cto < 0 && state.largeOffsets) && !(cto > 0x7fffffff && state.negativeOffsets),
            'flush before mixing negative and large unsigned composition offsets',
        );
        cmafAssert(typeof isKeyframe === 'boolean', 'isKeyframe must be boolean');
        const length = byteCount(data);
        cmafAssert(length > 0, 'sample bytes must be nonempty');
        const end = dts + BigInt(duration);
        cmafAssert(
            end <= MAX_U64 &&
                dts + BigInt(cto) >= -0x8000000000000000n &&
                end + BigInt(cto) <= MAX_U64,
            'sample timeline exceeds 64-bit range',
        );
        if (state.decodeEnd !== undefined) {
            cmafAssert(dts >= state.decodeEnd, 'decode timestamps must not overlap or regress');
            cmafAssert(
                state.samples.length === 0 || dts === state.decodeEnd,
                'flush before a decode timeline gap',
            );
        }

        cmafAssert(
            this.bufferedBytes + length <= this.maxBytes && this.samples < this.maxSamples,
            'sample buffer is full; flush the fragment first',
        );
        const copied = retainedBytes(data);
        validatePayload(state.track, copied);
        state.samples.push({
            data: copied,
            decodeTimestamp: dts,
            duration,
            compositionTimeOffset: cto,
            isKeyframe,
        });
        state.decodeEnd = end;
        state.negativeOffsets ||= cto < 0;
        state.largeOffsets ||= cto > 0x7fffffff;
        this.bytes += length;
        this.samples++;
    }

    /**
     * Replaces the duration of a track's most recently added sample while it is still buffered, so
     * a source whose timestamps are authoritative can end each sample where the next one starts.
     * Returns the replaced duration, or undefined once the sample was flushed.
     */
    amendLastSampleDuration(trackId: number, duration: number): number | undefined {
        this.assertReady();
        const state = this.getTrack(trackId);
        const last = state.samples[state.samples.length - 1];
        if (!last) return undefined;
        const value = integer(duration, 'duration', 1);
        const end = last.decodeTimestamp + BigInt(value);
        cmafAssert(
            end <= MAX_U64 && end + BigInt(last.compositionTimeOffset) <= MAX_U64,
            'sample timeline exceeds 64-bit range',
        );
        const previous = last.duration;
        last.duration = value;
        state.decodeEnd = end;
        return previous;
    }

    flush(options: CmafFlushOptions = {}): CmafSegment {
        this.assertReady();
        const plan = this.plan(options);
        const parts = [...plan.prefix, plan.moof, plan.mdatHeader];
        for (const state of plan.states)
            for (const sample of state.samples) parts.push(sample.data);
        const data = join(parts);
        this.commit();
        return { ...plan.info, data };
    }

    /**
     * Writes owned byte arrays with per-write backpressure. Preflight rejection is retryable;
     * failure after a write is terminal. Does not close the sink.
     */
    async flushTo(
        sink: Sink,
        options: CmafFlushOptions = {},
        signal?: AbortSignal,
    ): Promise<CmafSegmentInfo> {
        this.assertReady();
        assertSink(sink);
        const linked = linkAbortSignals(signal, sink.signal);
        let started = false;
        let acquired = false;
        try {
            const plan = this.plan(options);
            this.writing = true;
            acquired = true;
            const write = async (data: Uint8Array): Promise<void> => {
                throwIfAborted(linked.signal);
                started = true;
                sink.write(data);
                await drainSink(sink, linked.signal);
                throwIfAborted(linked.signal);
            };

            for (const bytes of plan.prefix) await write(bytes);
            await write(plan.moof);
            await write(plan.mdatHeader);
            for (const state of plan.states)
                for (const sample of state.samples) await write(sample.data);
            this.commit();
            return plan.info;
        } catch (error) {
            if (started) {
                this.failed = true;
                this.failure = error;
            }
            throw error;
        } finally {
            linked.dispose();
            if (acquired) this.writing = false;
        }
    }

    private assertReady(): void {
        if (this.failed) throw this.failure;
        cmafAssert(!this.writing, 'await the pending sink write before mutating the writer');
        cmafAssert(this.sequence <= 0xffffffff, 'fragment sequence number exhausted');
    }

    private getTrack(id: number): TrackState {
        const state = this.states.get(id);
        cmafAssert(state, `unknown track ID ${id}`);
        return state;
    }

    private plan(options: CmafFlushOptions): FragmentPlan {
        cmafAssert(options && typeof options === 'object', 'invalid flush options');
        const { requireKeyframe = true, producerReferenceTime } = options;
        let referenceTime: CmafProducerReferenceTime | undefined;
        if (producerReferenceTime !== undefined) {
            cmafAssert(
                producerReferenceTime && typeof producerReferenceTime === 'object',
                'invalid producer reference time',
            );
            const { trackId, ntpTimestamp, mediaTime } = producerReferenceTime;
            referenceTime = { trackId, ntpTimestamp, mediaTime };
        }

        this.assertReady();
        cmafAssert(typeof requireKeyframe === 'boolean', 'requireKeyframe must be boolean');
        cmafAssert(this.samples > 0, 'cannot flush an empty fragment');
        integer(this.sequence, 'fragment sequence number', 1);
        const states = [...this.states.values()].filter(state => state.samples.length > 0);
        const tracks = states.map((state): CmafSegmentTrack => {
            const first = state.samples[0]!;
            const last = state.samples[state.samples.length - 1]!;
            const independent = state.track.type !== 'video' || first.isKeyframe;
            cmafAssert(
                !requireKeyframe || independent,
                `track ${state.track.id} must start on a keyframe`,
            );
            return {
                trackId: state.track.id,
                timescale: state.track.timescale,
                baseDecodeTime: first.decodeTimestamp,
                duration: last.decodeTimestamp + BigInt(last.duration) - first.decodeTimestamp,
                sampleCount: state.samples.length,
                independent: independent && !['opus', 'Opus'].includes(state.track.codec),
            };
        });

        const prefix = this.events.slice();
        let prefixBytes = this.eventBytes;
        if (referenceTime !== undefined) {
            const { trackId, ntpTimestamp, mediaTime } = referenceTime;
            const state = this.getTrack(trackId);
            cmafAssert(
                state.samples.length > 0,
                'producer reference track must have samples in this fragment',
            );
            cmafAssert(typeof ntpTimestamp === 'bigint', 'NTP timestamp must be bigint');
            const payload = new Uint8Array(20);
            const reference = new DataView(payload.buffer);
            reference.setUint32(0, trackId);
            reference.setBigUint64(4, timestamp(ntpTimestamp, 'NTP timestamp'));
            reference.setBigUint64(12, timestamp(mediaTime, 'producer media time'));
            const prft = fullBox('prft', 1, 0, payload);
            prefix.push(prft);
            prefixBytes += prft.length;
        }

        const size = 24 + states.reduce((sum, state) => sum + 64 + state.samples.length * 16, 0);
        const byteLength = integer(
            prefixBytes + size + 8 + this.bytes,
            'fragment size',
            1,
            0x7fffffff,
        );

        const moof = new Uint8Array(size);
        const view = new DataView(moof.buffer);
        let cursor = 0;
        const header = (type: string, length: number, version?: number, flags = 0): void => {
            view.setUint32(cursor, length);
            for (let index = 0; index < 4; index++)
                moof[cursor + 4 + index] = type.charCodeAt(index);
            cursor += 8;
            if (version !== undefined) {
                view.setUint32(cursor, version * 0x1000000 + flags);
                cursor += 4;
            }
        };

        header('moof', size);
        header('mfhd', 16, 0);
        view.setUint32(cursor, this.sequence);
        cursor += 4;
        let dataOffset = size + 8;
        for (const state of states) {
            const count = state.samples.length;
            header('traf', 64 + count * 16);
            header('tfhd', 16, 0, 0x020000);
            view.setUint32(cursor, state.track.id);
            cursor += 4;
            header('tfdt', 20, 1);
            view.setBigUint64(cursor, state.samples[0]!.decodeTimestamp);
            cursor += 8;
            const signed = state.negativeOffsets === true;
            header('trun', 20 + count * 16, signed ? 1 : 0, 0x000f01);
            view.setUint32(cursor, count);
            view.setInt32(cursor + 4, dataOffset);
            cursor += 8;
            const keyed = state.track.type === 'video' || audioHasKeyframes(state.track.codec);
            for (const sample of state.samples) {
                view.setUint32(cursor, sample.duration);
                view.setUint32(cursor + 4, sample.data.length);
                view.setUint32(cursor + 8, !keyed || sample.isKeyframe ? 0x02000000 : 0x01010000);
                if (signed) view.setInt32(cursor + 12, sample.compositionTimeOffset);
                else view.setUint32(cursor + 12, sample.compositionTimeOffset);
                cursor += 16;
                dataOffset += sample.data.length;
            }
        }

        const mdatHeader = join([u32(this.bytes + 8), Uint8Array.of(109, 100, 97, 116)]);
        return {
            states,
            prefix,
            moof,
            mdatHeader,
            info: {
                sequenceNumber: this.sequence,
                byteLength,
                independent: tracks.every(track => track.independent),
                tracks,
            },
        };
    }

    private commit(): void {
        for (const state of this.states.values()) {
            for (const sample of state.samples) releaseBytes(sample.data);
            state.samples = [];
            state.negativeOffsets = false;
            state.largeOffsets = false;
        }
        this.bytes = 0;
        this.samples = 0;
        this.events = [];
        this.eventBytes = 0;
        this.sequence++;
    }
}
