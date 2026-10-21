import { DemuxError } from '../../../core/errors/errors';
import { demuxAssert } from '../../../core/errors/demux-guard';
import type { TrackInfo } from '../../../core/model/track';
import type { FieldOrder, MasteringDisplay, TrackDispositions } from '../../../core/model/media';
import { MatroskaSampleIndexBuilder } from './sample-index';
import { type PcmFormat } from '../../../core/codec-config/audio/pcm-format';
import { parseWebmVp9Features, vp9CodecString } from '../../../core/codec-config/video/vp9-config';
import { av1CodecString } from '../../../core/codec-config/video/av1-config';
import { hevcCodecString } from '../../../core/codec-config/video/hevc-codec';
import { vvcCodecString } from '../../../core/codec-config/video/vvc';
import {
    dolbyVisionCodecString,
    dolbyVisionSampleEntry,
    parseDolbyVisionConfig,
} from '../../../core/codec-config/video/dolby-vision';

import { mpegVideoFamily } from '../../../core/model/codec-strings';
import { parseMpegVideoConfig } from '../../../core/codec-config/video/mpeg-video';
import { avcCodecString } from '../../../core/codec-config/video/video-sps';
import { vorbisModes, xiphHeaders } from '../../../core/codec-config/audio/vorbis-headers';
import { ID, type Element, elements, uintOf, floatOf } from '../ebml';
import { AAC_SAMPLE_RATES } from '../../../core/codec-config/audio/aac-sample-rates';

export const CODEC_MAP: Record<string, string> = {
    V_VP8: 'vp8',
    V_VP9: 'vp09.00.10.08',
    V_AV1: 'av01.0.04M.08',
    'V_MPEG4/ISO/AVC': 'avc1.42C01E',
    'V_MPEGH/ISO/HEVC': 'hvc1.1.6.L93.B0',
    'V_MPEGI/ISO/VVC': 'vvc1',
    V_THEORA: 'theora',
    V_MJPEG: 'mjpeg',
    V_MPEG1: 'mp4v.6a',
    V_MPEG2: 'mp4v.61',
    'V_MPEG4/ISO/SP': 'mp4v.20.9',
    'V_MPEG4/ISO/ASP': 'mp4v.20.9',
    'V_MPEG4/ISO/AP': 'mp4v.20.9',
    A_OPUS: 'opus',
    A_VORBIS: 'vorbis',
    A_AAC: 'mp4a.40.2',
    'A_MPEG/L1': 'mp1',
    'A_MPEG/L2': 'mp2',
    'A_MPEG/L3': 'mp3',
    A_AC3: 'ac-3',
    A_EAC3: 'ec-3',
    A_FLAC: 'flac',
    A_ALAC: 'alac',
    A_DTS: 'dtsc',
    'A_DTS/EXPRESS': 'dtse',
    'A_DTS/LOSSLESS': 'dtsl',
    A_TRUEHD: 'mlpa',
};

/** Matroska AVC/HEVC/AV1 store configuration records; VP9 uses WebM feature TLVs. */
export function videoCodecFromPrivate(
    codecId: string,
    config: Uint8Array | undefined,
    dolbyVisionConfig?: Uint8Array,
): string | undefined {
    if (!config?.length) return undefined;
    const mpeg = mpegVideoFamily(CODEC_MAP[codecId] ?? '');
    if (mpeg) return parseMpegVideoConfig(mpeg === 'mpeg4v' ? 'mpeg4' : 'mpeg12', config)?.codec;
    if (codecId === 'V_MPEG4/ISO/AVC' && config.length >= 4 && config[0] === 1) {
        return avcCodecString(config);
    }

    if (codecId === 'V_MPEGH/ISO/HEVC' && config.length >= 23 && config[0] === 1) {
        const dolby = parseDolbyVisionConfig(dolbyVisionConfig);
        const entry = dolby ? dolbyVisionSampleEntry(dolby, 'hvc1') : 'hvc1';
        return entry === 'dvh1'
            ? dolbyVisionCodecString(entry, dolby!)
            : hevcCodecString('hvc1', config);
    }

    if (codecId === 'V_MPEGI/ISO/VVC') return vvcCodecString('vvc1', config);
    if (codecId === 'V_AV1') return av1CodecString(config);
    if (codecId === 'V_VP9') {
        const features = parseWebmVp9Features(config);
        return features ? vp9CodecString(features) : undefined;
    }

    return undefined;
}

export const SUBTITLE_CODEC_MAP: Record<string, string> = {
    'S_TEXT/UTF8': 'text/utf8',
    'S_TEXT/ASS': 'text/ass',
    'S_TEXT/SSA': 'text/ssa',
    // Early Matroska writers named SubStation tracks without the TEXT level; ASCII text is UTF-8.
    S_ASS: 'text/ass',
    S_SSA: 'text/ssa',
    'S_TEXT/ASCII': 'text/utf8',
    'S_TEXT/WEBVTT': 'text/webvtt',
    'D_WEBVTT/SUBTITLES': 'text/webvtt',
    'D_WEBVTT/CAPTIONS': 'text/webvtt',
    'D_WEBVTT/DESCRIPTIONS': 'text/webvtt',
    'D_WEBVTT/METADATA': 'text/webvtt',
};

export interface WebMTrack {
    number: number;
    uid?: bigint;
    type: number;
    codec: string;
    codecTag?: string;
    /** H.264 of a V_MS/VFW/FOURCC track, whose block times are decode times as in AVI. */
    vfwAvc?: { readonly extradata: Uint8Array | undefined };
    /** WMV9 or VC-1 of a V_MS/VFW/FOURCC track, whose block times are decode times as in AVI. */
    vfwWindowsMedia?: boolean;
    /**
     * Absent when the track has no Language element: the spec's default 'eng' would invent a
     * language.
     */
    language?: string;
    default: boolean;
    forced: boolean;
    name?: string;
    commentary?: boolean;
    dispositions?: TrackDispositions;
    alphaMode?: boolean;
    languageIetf?: string;
    colour?: TrackInfo['colour'];
    fieldOrder?: FieldOrder;
    rotation?: number;
    codecConfig?: Uint8Array;
    dolbyVisionConfig?: Uint8Array;
    defaultDurationNs: number;
    width: number;
    height: number;
    displayWidth?: number;
    displayHeight?: number;
    pixelAspectRatioNum?: number;
    pixelAspectRatioDen?: number;
    sampleRate: number;
    channelCount: number;
    pcm?: PcmFormat;
    index: MatroskaSampleIndexBuilder;
    proRes: boolean;
    aacFrameDuration: number;
    /** Bytes header-stripping ContentCompression removed from the start of every frame. */
    framePrefix?: Uint8Array;
    /**
     * Block sizes of a Vorbis track and the size of its latest packet: a packet lasts a quarter of
     * its own and the previous packet's block, which times the frames laced into one block.
     */
    vorbis?: {
        readonly modes: readonly boolean[];
        readonly small: number;
        readonly large: number;
        previous: number;
    };
    /**
     * Blocks of MPEG audio that do not hold whole frames; when they are common (blocks cut at byte
     * counts), the frames are reassembled.
     */
    mpegUnaligned?: number;
    /**
     * Set after damage inside a cluster: the track's frames are skipped until its next keyframe.
     */
    awaitKeyframe?: boolean;
    /**
     * Audio whose frames say whether they are keyframes (xHE-AAC), which the reader decides from
     * the frame; set with the first block.
     */
    keyedAudio?: boolean;
    /** zlib or LZO1X ContentCompression of every frame, undone while the blocks are indexed. */
    frameCompression?: ContentCompression;
    leadingDiscardPadNs: number;
    trailingDiscardPadNs: number;
    codecDelayNs: number;
    timestampScale: number;
    audioBlockCount: number;
    /**
     * Most channels an AC-3 syncframe of the track codes; decoders output the frames' own layout,
     * not Channels.
     */
    ac3FrameChannels?: number;
    negativeDiscardSeen: boolean;
    positiveDiscardSeen: boolean;
    positiveDiscardBlockIndex: number;
    /** The frame the latest positive DiscardPadding trims, or -1. */
    positiveDiscardFrame: number;
}

export function setDisplayGeometry(
    track: WebMTrack,
    width: number | undefined,
    height: number | undefined,
    unit: number,
): void {
    // DisplayUnit 4 (unknown) leaves the display size without a meaning.
    if ((width === undefined && height === undefined && unit === 0) || unit === 4) return;
    if (unit > 4) throw new DemuxError(`Matroska DisplayUnit ${unit} is not supported`);
    demuxAssert(
        track.width > 0 && track.height > 0,
        'Matroska display geometry requires positive coded dimensions',
    );
    const displayWidth = width ?? (unit === 0 ? track.width : 0);
    const displayHeight = height ?? (unit === 0 ? track.height : 0);
    demuxAssert(
        displayWidth > 0 && displayHeight > 0,
        'Matroska display dimensions must be positive',
    );
    let numerator = BigInt(displayWidth) * BigInt(track.height);
    let denominator = BigInt(displayHeight) * BigInt(track.width);
    let a = numerator;
    let b = denominator;
    while (b !== 0n) {
        const remainder = a % b;
        a = b;
        b = remainder;
    }

    numerator /= a;
    denominator /= a;
    demuxAssert(
        numerator <= BigInt(Number.MAX_SAFE_INTEGER) &&
            denominator <= BigInt(Number.MAX_SAFE_INTEGER),
        'Matroska pixel aspect ratio exceeds the safe integer range',
    );
    track.pixelAspectRatioNum = Number(numerator);
    track.pixelAspectRatioDen = Number(denominator);
    track.displayWidth = unit === 0 ? displayWidth : track.height * (displayWidth / displayHeight);
    track.displayHeight = unit === 0 ? displayHeight : track.height;
}

/**
 * Mastering display chromaticities (R, G, B, white point x/y) and luminance, in MasteringMetadata
 * child order.
 */
const MASTERING_IDS = [
    0x55d1, 0x55d2, 0x55d3, 0x55d4, 0x55d5, 0x55d6, 0x55d7, 0x55d8, 0x55d9, 0x55da,
];

function masteringOf(buf: Uint8Array, parent: Element): MasteringDisplay | undefined {
    const values: number[] = [];
    for (const field of elements(buf, parent.dataStart, parent.dataEnd)) {
        const at = MASTERING_IDS.indexOf(field.id);
        if (at >= 0) values[at] = floatOf(buf, field, NaN);
    }

    // A mastering display is described only in full: every chromaticity within 0..1 and both
    // luminances.
    if (MASTERING_IDS.some((_, at) => !Number.isFinite(values[at]) || values[at]! < 0))
        return undefined;
    if (values.slice(0, 8).some(value => value > 1)) return undefined;
    const pair = (at: number): [number, number] => [values[at]!, values[at + 1]!];
    return {
        red: pair(0),
        green: pair(2),
        blue: pair(4),
        whitePoint: pair(6),
        maxLuminance: values[8]!,
        minLuminance: values[9]!,
    };
}

export function colourOf(buf: Uint8Array, parent: Element): TrackInfo['colour'] {
    let matrix = 2;
    let transfer = 2;
    let primaries = 2;
    let range = 0;
    let maxContent: number | undefined;
    let maxAverage: number | undefined;
    let mastering: MasteringDisplay | undefined;
    for (const field of elements(buf, parent.dataStart, parent.dataEnd)) {
        if (field.id === ID.MatrixCoefficients) matrix = uintOf(buf, field, 2);
        else if (field.id === ID.TransferCharacteristics) transfer = uintOf(buf, field, 2);
        else if (field.id === ID.Primaries) primaries = uintOf(buf, field, 2);
        else if (field.id === ID.Range) range = uintOf(buf, field);
        else if (field.id === ID.MaxCLL) maxContent = uintOf(buf, field);
        else if (field.id === ID.MaxFALL) maxAverage = uintOf(buf, field);
        else if (field.id === ID.MasteringMetadata) mastering = masteringOf(buf, field);
    }

    // Matroska defaults to unspecified (2); range 0 (unspecified) and 3 (derived from the matrix)
    // leave it unknown.
    if (
        range > 3 ||
        matrix > 14 ||
        matrix === 3 ||
        transfer < 1 ||
        transfer > 18 ||
        transfer === 3 ||
        primaries < 1 ||
        primaries === 3 ||
        (primaries > 12 && primaries !== 22)
    )
        return undefined;
    const light =
        maxContent !== undefined &&
        maxAverage !== undefined &&
        maxContent <= 0xffff &&
        maxAverage <= 0xffff
            ? { maxContent, maxAverage }
            : undefined;

    if (
        range !== 1 &&
        range !== 2 &&
        matrix === 2 &&
        transfer === 2 &&
        primaries === 2 &&
        !light &&
        !mastering
    )
        return undefined;
    return {
        primaries,
        transfer,
        matrix,
        ...(range === 1 || range === 2 ? { fullRange: range === 2 } : {}),
        ...(mastering ? { mastering } : {}),
        ...(light ? { contentLight: light } : {}),
    };
}

/** The accessibility and origin flags of a TrackEntry and their TrackDispositions names. */
export const DISPOSITION_FLAGS: ReadonlyMap<number, keyof TrackDispositions> = new Map([
    [0x55ab, 'hearingImpaired'],
    [0x55ac, 'visualImpaired'],
    [0x55ad, 'textDescriptions'],
    [0x55ae, 'original'],
]);

/**
 * FieldOrder codes when FlagInterlaced marks the track interlaced; they are the fiel box's field
 * details.
 */
export const MATROSKA_FIELD_ORDERS: Readonly<Record<number, FieldOrder>> = {
    1: 'tt',
    6: 'bb',
    9: 'tb',
    14: 'bt',
};

/** ContentCompAlgo values read: zlib, LZO1X and header stripping (bzlib is not). */
export const COMPRESSION_ZLIB = 0;
export const COMPRESSION_LZO = 2;
export const COMPRESSION_HEADER_STRIP = 3;

/** Largest frame or CodecPrivate a zlib or LZO ContentCompression may expand to. */
export const MAX_DECOMPRESSED_BYTES = 64 * 1024 * 1024;

export interface ContentCompression {
    readonly algorithm: number;
    readonly settings: Uint8Array;
    /** ContentEncodingScope bits: 1 the frames, 2 the CodecPrivate. */
    readonly scope: number;
}

/**
 * The compression of a track's only ContentEncoding when it is zlib, LZO1X or header stripping of
 * the frames and/or the CodecPrivate; undefined for encryption, other algorithms, several encodings
 * or other scopes.
 */
export function contentCompression(
    buf: Uint8Array,
    parent: Element,
): ContentCompression | undefined {
    const encodings = [...elements(buf, parent.dataStart, parent.dataEnd)].filter(
        el => el.id === ID.ContentEncoding,
    );
    if (encodings.length !== 1) return undefined;
    let type = 0;
    let scope = 1;
    let algorithm = -1;
    let settings = new Uint8Array(0);
    for (const field of elements(buf, encodings[0]!.dataStart, encodings[0]!.dataEnd)) {
        if (field.id === ID.ContentEncodingType) type = uintOf(buf, field);
        else if (field.id === ID.ContentEncodingScope) scope = uintOf(buf, field, 1);
        else if (field.id === ID.ContentCompression) {
            algorithm = 0;
            for (const item of elements(buf, field.dataStart, field.dataEnd)) {
                if (item.id === ID.ContentCompAlgo) algorithm = uintOf(buf, item);
                else if (item.id === ID.ContentCompSettings)
                    settings = buf.slice(item.dataStart, item.dataEnd);
            }
        }
    }

    const supported =
        algorithm === COMPRESSION_ZLIB ||
        algorithm === COMPRESSION_LZO ||
        algorithm === COMPRESSION_HEADER_STRIP;
    return type === 0 && scope >= 1 && scope <= 3 && supported
        ? { algorithm, settings, scope }
        : undefined;
}

/**
 * Counter-clockwise display rotation of a rectangular projection whose roll is a multiple of 90
 * degrees; yaw or pitch (mirroring or 3D poses) and other rolls leave the picture unrotated and
 * return null.
 */
export function projectionRotation(buf: Uint8Array, parent: Element): number | null | undefined {
    let type = 0;
    let yaw = 0;
    let pitch = 0;
    let roll = 0;
    for (const field of elements(buf, parent.dataStart, parent.dataEnd)) {
        if (field.id === ID.ProjectionType) type = uintOf(buf, field);
        else if (field.id === ID.ProjectionPoseYaw) yaw = floatOf(buf, field);
        else if (field.id === ID.ProjectionPosePitch) pitch = floatOf(buf, field);
        else if (field.id === ID.ProjectionPoseRoll) roll = floatOf(buf, field);
    }

    if (
        type !== 0 ||
        yaw !== 0 ||
        pitch !== 0 ||
        Math.abs(roll / 90 - Math.round(roll / 90)) > 1e-6
    )
        return type === 0 && (yaw !== 0 || pitch !== 0 || roll !== 0) ? null : undefined;
    const rotation = (((Math.round(roll / 90) * 90) % 360) + 360) % 360;
    return rotation || undefined;
}

/** Modes and block sizes of Xiph-laced Vorbis headers; undefined when they cannot be read. */
export function vorbisBlocks(config: Uint8Array): WebMTrack['vorbis'] {
    const headers = xiphHeaders(config);
    const identification = headers?.[0];
    if (!headers || !identification || identification.length < 30) return undefined;
    try {
        const small = 1 << (identification[28]! & 15);
        const large = 1 << (identification[28]! >> 4);
        return {
            modes: vorbisModes(headers[2]!, identification[11]!),
            small,
            large,
            previous: small,
        };
    } catch {
        return undefined;
    }
}

/**
 * The AudioSpecificConfig of an early Matroska AAC track (A_AAC/MPEG4/LC and the like), which
 * states its profile in the codec ID and carries no CodecPrivate, built as ffmpeg builds it: the
 * profile, the sampling frequency index of the track's rate and its channels, and for SBR the
 * explicit extension with the output rate.
 */
export function legacyAacConfig(
    codecId: string,
    sampleRate: number,
    channels: number,
    outputRate: number,
): Uint8Array {
    const profile = ['MAIN', 'LC', 'SSR'].findIndex(name => codecId.includes(name)) + 1 || 2;
    const index = (rate: number): number => {
        const found = AAC_SAMPLE_RATES.findIndex(known => known <= rate);
        return found < 0 ? 13 : found;
    };
    const rate = index(sampleRate);
    const config = [
        (profile << 3) | ((rate & 0x0e) >> 1),
        ((rate & 1) << 7) | ((channels & 0x0f) << 3),
    ];
    if (codecId.includes('SBR'))
        config.push(0x56, 0xe5, 0x80 | (index(outputRate || sampleRate * 2) << 3));
    return Uint8Array.from(config);
}
