import type { EncodedPacket, TrackType } from '../../core/model/media';
import type { CmafSample } from '../../formats/mp4/write/cmaf';
import type { CmafTrack } from '../../formats/mp4/write/cmaf-boxes';
import { MediaForgeError } from '../../core/errors/errors';
import { parseAacAudioSpecificConfig } from '../../core/codec-config/audio/adts';
import { opusPacketFrames } from '../../core/codec-config/audio/opus-packet';
import { opusDopsPayload } from '../../core/codec-config/audio/opus-head';
import {
    annexBToAvcc,
    isAnnexB,
    isLengthPrefixed,
    nalLengthSizeOf,
} from '../../core/codec-config/video/annexb';
import { codecFamily } from '../../core/model/codec-strings';
import { vpcCFor } from '../../core/codec-config/video/vp9-config';
import { parseMpegAudioHeader } from '../../core/codec-config/audio/mpeg-audio-header';
import { parseDolbyFrameHeader } from '../../core/codec-config/audio/dolby-audio-header';
import { gcd } from '../../core/bytes/gcd';
import { decodeTime, secondsToTicks } from '../../core/model/media-time';
import { sampleAt } from '../../core/model/sample-index';
import type { RemuxTrack } from '../media-types';

const MPEG_AUDIO = new Set(['mp1', 'mp2', 'mp3']);
const DOLBY_AUDIO = new Set(['ac-3', 'ec-3']);

/**
 * Source formats whose timestamps are rounded to a coarse clock: Matroska's timecode scale and FLV
 * milliseconds.
 */
const MILLISECOND_CLOCKS = new Set(['mkv', 'webm', 'flv']);

function fail(message: string): never {
    throw new MediaForgeError(message, 'MUX');
}

/** What CmafTiming names a time it cannot state in ticks. */
export const FMP4_TIMING = 'fMP4 timing';

/**
 * `origin` moved down to the nearest time every track's timescale represents exactly, so
 * subtracting it shifts all tracks by the same whole number of ticks and keeps them aligned; the
 * start moves by less than one common tick.
 */
export function commonTick(origin: number, tracks: readonly CmafTrack[]): number {
    const common = tracks.reduce(
        (value, track) => gcd(value, track.timescale),
        tracks[0]?.timescale ?? 1,
    );
    return Math.floor(origin * common + 1e-6) / common;
}

/**
 * Ticks the fragmented MP4 writer's edit list removes from the start of `track`: its edit's media
 * time (AAC priming) or the Opus pre-skip. Copied packets are timed as presented, so their decode
 * times move later by this much.
 */
export function cmafEditTicks(track: CmafTrack): number {
    const config = track.codecConfig;
    const opus = (track.codec === 'opus' || track.codec === 'Opus') && config && config.length >= 4;
    if (track.edit) return track.edit.mediaTime;
    return opus ? config[2]! * 256 + config[3]! : 0;
}

/**
 * Where a fragmented MP4's zero lies on the input's clock: the earliest a track's edit list starts
 * to present it, its first decode time past what that edit hides (a reorder delay, priming, an
 * Opus pre-skip, what the input's own edit list hid). The first packet presented lands at zero
 * and what the input's edit lists hid stays hidden, in files and packages alike. `first` gives a
 * track's first decode time in seconds, by default its first sample's. Subtitle cues keep their
 * times.
 */
export function fragmentedStart(
    tracks: readonly RemuxTrack[],
    configs: readonly CmafTrack[],
    first = (track: RemuxTrack): number | undefined => {
        const sample = sampleAt(track.info, track.order?.[0] ?? 0);
        return sample && decodeTime(sample);
    },
): number {
    let start = Infinity;
    tracks.forEach((track, index) => {
        const at = track.type === 'subtitle' ? undefined : first(track);
        const config = configs[index]!;
        if (at !== undefined)
            start = Math.min(start, at + cmafEditTicks(config) / config.timescale);
    });
    return start;
}

export function cmafTrackConfig(track: CmafTrack): CmafTrack {
    let codecConfig = track.codecConfig?.slice();
    // An OpusHead (WebM, Ogg) becomes the dOps payload of the 'Opus' entry.
    if (track.codec === 'opus' && codecConfig && codecConfig[0] !== 0)
        codecConfig = opusDopsPayload(codecConfig, track.channelCount ?? 0);

    if (
        track.codec === 'flac' &&
        codecConfig &&
        codecConfig.length >= 42 &&
        String.fromCharCode(...codecConfig.subarray(0, 4)) === 'fLaC'
    ) {
        if (
            (codecConfig[4]! & 0x7f) !== 0 ||
            codecConfig[5] !== 0 ||
            codecConfig[6] !== 0 ||
            codecConfig[7] !== 34
        ) {
            fail('FLAC CodecPrivate must start with STREAMINFO');
        }
        codecConfig = codecConfig.slice(8, 42);
    }

    if (track.type === 'video' && codecFamily(track.codec) === 'vp09') {
        codecConfig = vpcCFor(track.codec, codecConfig, track.colour) ?? codecConfig;
    }

    return {
        ...track,
        codecConfig,
        ...(track.codec === 'opus'
            ? { sampleRate: 48000, timescale: 48000 }
            : track.type === 'audio' &&
                (track.codec.startsWith('mp4a') ||
                    MPEG_AUDIO.has(track.codec) ||
                    DOLBY_AUDIO.has(track.codec))
              ? { timescale: track.sampleRate! }
              : {}),
    };
}

/**
 * Diagnostic reported once when a Matroska track's timestamps were aligned to their coded
 * durations.
 */
export function cmafClockDiagnostic(
    track: { readonly type: TrackType; readonly id: number },
    format: 'fmp4' | 'ts',
): { code: string; message: string; trackId: number; format: 'fmp4' | 'ts' } {
    return track.type === 'audio'
        ? {
              code: 'FMP4_AUDIO_CLOCK',
              message: 'Audio timestamps were rounded to the coded durations',
              trackId: track.id,
              format,
          }
        : {
              code: 'FMP4_VIDEO_CLOCK',
              message: 'Video timestamps were rounded to the frame durations',
              trackId: track.id,
              format,
          };
}

/** Diagnostic reported once when overlapping source decode times were made monotonic for fMP4. */
export function cmafDecodeTimeDiagnostic(
    track: { readonly type: TrackType; readonly id: number },
    format: 'fmp4' | 'ts',
): { code: string; message: string; trackId: number; format: 'fmp4' | 'ts' } {
    return {
        code: 'FMP4_DECODE_TIME_REPAIRED',
        message: 'Overlapping decode times were moved apart',
        trackId: track.id,
        format,
    };
}

/**
 * Matroska stores timestamps rounded to its timecode scale while coded durations are nominal, so a
 * difference of at most one tick between a packet and the previous packet's end is rounding, not a
 * gap or an overlap. The timestamps are authoritative: the previous sample is stretched or
 * shortened to end where this one starts while it is still buffered (amend), and only a sample that
 * was already flushed makes this one snap to its end instead.
 */
/** How CmafTiming maps a track's packets onto its fMP4 timeline. */
interface CmafTimingOptions {
    /** The input's container: Matroska clocks are rounded to milliseconds. */
    readonly format: string;
    /** Seconds per tick of the source track's clock. */
    readonly timestampResolution: number;
    /** Seconds where the output timeline starts. */
    readonly origin: number;
    /** Reports timestamps aligned to their coded durations, once. */
    readonly onAligned: () => void;
    /**
     * Changes the duration of the track's last buffered sample; undefined when it was already
     * written.
     */
    readonly amend?: (trackId: number, duration: number) => number | undefined;
    /**
     * Reports decode times moved to keep them monotonic; without it overlapping decode times are an
     * error.
     */
    readonly onRepaired?: () => void;
    /** Ticks added to every decode time, see `cmafEditTicks`. */
    readonly editTicks?: number;
    /** Rewrites each packet's payload for the track's codec (text cues as 3GPP timed text). */
    readonly convert?: (data: Uint8Array) => Uint8Array;
    /**
     * The sample (`sampleIndex`) the track's edit starts inside (editStartSample): it is presented
     * from the edit's start.
     */
    readonly shownAtEdit?: number;
}

export class CmafTiming {
    private end?: number;
    private lastDuration = 0;
    private warned = false;
    private repaired = false;
    private readonly quantized: boolean;
    private readonly quantizedAudio: boolean;
    /**
     * Samples per AAC access unit, read from the track's AudioSpecificConfig with the first packet
     * that needs it.
     */
    private aacFrameSamples?: number;
    /** NAL length size of an AVC or HEVC track; 0 for other codecs. */
    private readonly nalLengthSize: 0 | 1 | 2 | 4;

    private readonly timestampResolution: number;
    private readonly origin: number;
    private readonly onAligned: () => void;
    private readonly amend?: (trackId: number, duration: number) => number | undefined;
    private readonly onRepaired?: () => void;
    private readonly editTicks: number;
    private readonly convert?: (data: Uint8Array) => Uint8Array;
    private readonly shownAtEdit?: number;

    constructor(
        private readonly track: CmafTrack,
        {
            format,
            timestampResolution,
            origin,
            onAligned,
            amend,
            onRepaired,
            editTicks = 0,
            convert,
            shownAtEdit,
        }: CmafTimingOptions,
    ) {
        this.timestampResolution = timestampResolution;
        this.origin = origin;
        this.onAligned = onAligned;
        this.amend = amend;
        this.onRepaired = onRepaired;
        this.editTicks = editTicks;
        this.convert = convert;
        this.shownAtEdit = shownAtEdit;
        this.quantizedAudio =
            MILLISECOND_CLOCKS.has(format) &&
            track.type === 'audio' &&
            (track.codec.startsWith('mp4a') ||
                track.codec === 'opus' ||
                MPEG_AUDIO.has(track.codec) ||
                DOLBY_AUDIO.has(track.codec));
        this.quantized =
            this.quantizedAudio || (MILLISECOND_CLOCKS.has(format) && track.type === 'video');
        this.nalLengthSize = nalLengthSizeOf(track);
        if (!Number.isFinite(timestampResolution) || timestampResolution <= 0)
            fail('Invalid source timestamp resolution');
    }

    prepare(packet: EncodedPacket & { readonly sampleIndex?: number }): {
        sample: CmafSample;
        discontinuity: boolean;
        time: number;
    } {
        const scale = this.track.timescale;

        // Rounding the origin separately shifts every packet by the same whole number of ticks.
        let dts =
            secondsToTicks(decodeTime(packet), scale, FMP4_TIMING) -
            secondsToTicks(this.origin, scale, FMP4_TIMING) +
            this.editTicks;
        let duration = secondsToTicks(packet.duration, scale, FMP4_TIMING);
        const originalDts = dts;
        const originalDuration = duration;
        let discontinuity = false;
        /**
         * Ticks a repaired decode time moved later (negative); the composition offset shrinks to
         * keep PTS.
         */
        let shifted = 0;
        if (this.quantizedAudio) {
            duration =
                this.track.codec === 'opus'
                    ? opusPacketFrames(packet.data, packet.data.length)
                    : MPEG_AUDIO.has(this.track.codec)
                      ? (parseMpegAudioHeader(packet.data, 0)?.samplesPerFrame ?? duration)
                      : DOLBY_AUDIO.has(this.track.codec)
                        ? (parseDolbyFrameHeader(packet.data, 0)?.samples ?? duration)
                        : (this.aacFrameSamples ??= parseAacAudioSpecificConfig(
                              this.track.codecConfig!,
                          )!.samplesPerAccessUnit);
        }
        if (this.end !== undefined) {
            const difference = dts - this.end;
            const tolerance = this.quantized ? Math.ceil(scale * this.timestampResolution) : 0;
            if (difference !== 0 && Math.abs(difference) <= tolerance) {
                const previous = this.lastDuration + difference;
                if (previous < 1 || this.amend?.(this.track.id, previous) === undefined)
                    dts = this.end;
            }
            // The decode time, the previous one and its duration are rounded to the timescale
            // separately, so a frame that starts where the previous one ends can land one tick
            // early.
            else if (difference === -1) dts = this.end;
            else if (difference < 0) {
                if (!this.onRepaired) fail(`fMP4 track ${this.track.id} decode timestamps overlap`);

                // The previous sample ends where this one starts; when it cannot, this one starts
                // where it ends.
                const previous = this.lastDuration + difference;
                if (previous < 1 || this.amend?.(this.track.id, previous) === undefined) {
                    shifted = originalDts - this.end;
                    dts = this.end;
                }
                if (!this.repaired) this.onRepaired();
                this.repaired = true;
            }
            // The writer fills a gap between timed-text cues with an empty sample; other tracks
            // start a fragment.
            else if (
                difference > 0 &&
                (this.track.type !== 'subtitle' || this.track.codec === 'stpp')
            )
                discontinuity = true;
        }
        if (
            this.quantized &&
            !this.warned &&
            (dts !== originalDts || duration !== originalDuration)
        ) {
            this.onAligned();
            this.warned = true;
        }
        this.end = dts + duration;
        this.lastDuration = duration;
        if (!Number.isSafeInteger(this.end))
            fail('fMP4 decode end exceeds the exact integer range');
        let data = packet.data;
        if (this.convert) data = this.convert(data);
        const width = this.nalLengthSize;
        if (width && !isLengthPrefixed(data, width) && isAnnexB(data))
            data = annexBToAvcc(data, width);
        const sourceOffset = secondsToTicks(
            packet.compositionTimeOffset ?? packet.timestamp - decodeTime(packet),
            scale,
            FMP4_TIMING,
        );

        // A moved sample keeps its PTS only while that leaves a non-negative offset, which readers
        // agree on.
        const compositionTimeOffset =
            this.shownAtEdit !== undefined &&
            packet.sampleIndex === this.shownAtEdit &&
            dts <= this.editTicks
                ? this.editTicks - dts
                : shifted < 0
                  ? Math.max(0, sourceOffset + shifted)
                  : sourceOffset;
        return {
            sample: {
                trackId: this.track.id,
                data,
                decodeTimestamp: dts,
                duration,
                compositionTimeOffset,
                isKeyframe: packet.isKeyframe,
            },
            discontinuity,
            time: dts / scale,
        };
    }
}
