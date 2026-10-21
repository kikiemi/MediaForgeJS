/**
 * Windows Media video and audio identification shared by the ASF, AVI and Matroska readers and
 * writers.
 */
import { findStartCode } from './video/mpeg-video';
import { VC1_SEQUENCE, isVc1IntraFrame, parseVc1SequenceHeader } from './video/vc1';
import { u32be, dataView } from '../bytes/byte-fields';

const VIDEO_FOURCC: ReadonlyMap<string, string> = new Map([
    ['WMV1', 'wmv1'],
    ['WMV2', 'wmv2'],
    ['WMV3', 'wmv3'],
    ['WMVA', 'vc1'],
    ['WVC1', 'vc1'],
]);

const VIDEO_WRITE_FOURCC: Readonly<Record<string, string>> = {
    wmv1: 'WMV1',
    wmv2: 'WMV2',
    wmv3: 'WMV3',
    vc1: 'WVC1',
};

const AUDIO_TAGS: ReadonlyMap<number, string> = new Map([
    [0x000a, 'wmavoice'],
    [0x0160, 'wmav1'],
    [0x0161, 'wmav2'],
    [0x0162, 'wmapro'],
    [0x0163, 'wmalossless'],
]);

export const WINDOWS_MEDIA_VIDEO_CODECS: readonly string[] = Object.freeze([
    'wmv1',
    'wmv2',
    'wmv3',
    'vc1',
]);
export const WINDOWS_MEDIA_AUDIO_CODECS: readonly string[] = Object.freeze([
    'wmav1',
    'wmav2',
    'wmapro',
    'wmalossless',
    'wmavoice',
]);

/** Codec id of a Windows Media video FourCC (WMV7-9 and VC-1), matched case-insensitively. */
export function windowsMediaVideoCodec(fourcc: string): string | undefined {
    return VIDEO_FOURCC.get(fourcc.toUpperCase());
}

/** The FourCC written for a Windows Media video codec id. */
export function windowsMediaVideoFourcc(codec: string): string | undefined {
    return VIDEO_WRITE_FOURCC[codec];
}

export function isWindowsMediaVideo(codec: string): boolean {
    return codec in VIDEO_WRITE_FOURCC;
}

/**
 * Whether a Windows Media video frame is an I picture, read from its picture header: WMV7 codes the
 * picture type in two bits, WMV8 in one, and WMV9 (VC-1 simple/main) after the optional INTERPFRM,
 * FRMCNT and RANGEREDFRM fields that its four-byte sequence header (STRUCT_C) enables; VC-1
 * advanced profile frames need the interlace flag of the sequence header carried in `config`.
 */
export function isWindowsMediaIntraFrame(
    codec: string,
    frame: Uint8Array,
    config: Uint8Array | undefined,
): boolean {
    if (frame.length < 1) return false;
    if (codec === 'wmv1') return frame[0]! >> 6 === 0;
    if (codec === 'wmv2') return frame[0]! >> 7 === 0;
    if (codec === 'wmv3') {
        if (!config || config.length < 4 || frame.length < 2) return false;
        const sequence = u32be(config, 0);
        const rangeRed = (sequence >>> 7) & 1;
        const maxBFrames = (sequence >>> 4) & 7;
        const frameInterpolation = (sequence >>> 1) & 1;
        const header = (frame[0]! << 8) | frame[1]!;
        const at = frameInterpolation + 2 + rangeRed;
        if ((header >> (15 - at)) & 1) return false;
        return maxBFrames === 0 || ((header >> (14 - at)) & 1) === 1;
    }

    if (codec === 'vc1') {
        const at = config ? findStartCode(config, 0) : -1;
        const sequence =
            at >= 0 && config![at + 3] === VC1_SEQUENCE
                ? parseVc1SequenceHeader(config!.subarray(at + 4))
                : undefined;
        return isVc1IntraFrame(frame, sequence?.interlace ?? false);
    }
    return false;
}

/** Codec id of a WAVEFORMATEX format tag of the Windows Media audio family. */
export function windowsMediaAudioCodec(tag: number): string | undefined {
    return AUDIO_TAGS.get(tag);
}

export function isWindowsMediaAudio(codec: string): boolean {
    return WINDOWS_MEDIA_AUDIO_CODECS.includes(codec);
}

interface BitmapInfoHeader {
    readonly width: number;
    readonly height: number;
    readonly fourcc: string;
    readonly bitCount: number;
    /** Codec bytes after the 40-byte header. */
    readonly extradata: Uint8Array;
}

/**
 * Reads a BITMAPINFOHEADER (40 bytes) with its trailing codec data; undefined when the bytes are
 * too short.
 */
export function parseBitmapInfoHeader(bytes: Uint8Array): BitmapInfoHeader | undefined {
    if (bytes.length < 40) return undefined;
    const view = dataView(bytes);
    const declared = view.getUint32(0, true);
    const end = declared >= 40 && declared <= bytes.length ? declared : bytes.length;
    return {
        width: Math.abs(view.getInt32(4, true)),
        height: Math.abs(view.getInt32(8, true)),
        bitCount: view.getUint16(14, true),
        fourcc: String.fromCharCode(bytes[16]!, bytes[17]!, bytes[18]!, bytes[19]!),
        extradata: bytes.slice(40, end),
    };
}

/**
 * Builds a BITMAPINFOHEADER whose biSize covers the trailing codec data, as AVI strf and Matroska
 * VFW store it.
 */
export function buildBitmapInfoHeader(
    fourcc: string,
    width: number,
    height: number,
    extradata: Uint8Array | undefined,
): Uint8Array {
    const bitCount = 24;
    const extra = extradata ?? new Uint8Array(0);
    const out = new Uint8Array(40 + extra.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, out.length, true);
    view.setInt32(4, width, true);
    view.setInt32(8, height, true);
    view.setUint16(12, 1, true);
    view.setUint16(14, bitCount, true);
    for (let index = 0; index < 4; index++) out[16 + index] = fourcc.charCodeAt(index) & 0xff;
    view.setUint32(20, Math.ceil((width * height * bitCount) / 8), true);
    out.set(extra, 40);
    return out;
}

export interface WaveFormatEx {
    readonly tag: number;
    readonly channels: number;
    readonly sampleRate: number;
    readonly averageBytesPerSecond: number;
    readonly blockAlign: number;
    readonly bitsPerSample: number;
    /** Format-specific bytes after cbSize. */
    readonly extra: Uint8Array;
}

/** Reads a WAVEFORMAT/WAVEFORMATEX; the 16-byte PCM form has no cbSize. */
export function parseWaveFormatEx(bytes: Uint8Array): WaveFormatEx | undefined {
    if (bytes.length < 16) return undefined;
    const view = dataView(bytes);
    const cbSize = bytes.length >= 18 ? view.getUint16(16, true) : 0;
    return {
        tag: view.getUint16(0, true),
        channels: view.getUint16(2, true),
        sampleRate: view.getUint32(4, true),
        averageBytesPerSecond: view.getUint32(8, true),
        blockAlign: view.getUint16(12, true),
        bitsPerSample: view.getUint16(14, true),
        extra: bytes.slice(18, 18 + Math.min(cbSize, Math.max(0, bytes.length - 18))),
    };
}

/** A WAVEFORMATEX whose cbSize covers `extra`. */
function buildWaveFormatEx(format: Omit<WaveFormatEx, 'extra'>, extra: Uint8Array): Uint8Array {
    const out = new Uint8Array(18 + extra.length);
    const view = new DataView(out.buffer);
    view.setUint16(0, format.tag, true);
    view.setUint16(2, format.channels, true);
    view.setUint32(4, format.sampleRate, true);
    view.setUint32(8, format.averageBytesPerSecond, true);
    view.setUint16(12, format.blockAlign, true);
    view.setUint16(14, format.bitsPerSample, true);
    view.setUint16(16, extra.length, true);
    out.set(extra, 18);
    return out;
}

/**
 * The complete WAVEFORMATEX a Windows Media audio track keeps as its codec configuration, sized by
 * cbSize.
 */
export function normalizedWaveFormatEx(bytes: Uint8Array): Uint8Array | undefined {
    const parsed = parseWaveFormatEx(bytes);
    if (!parsed) return undefined;
    return buildWaveFormatEx(parsed, parsed.extra);
}
