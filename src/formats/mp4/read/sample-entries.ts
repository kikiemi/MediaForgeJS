import { DemuxError } from '../../../core/errors/errors';
import { concatBytes } from '../../../core/bytes/bytes';
import { dataView } from '../../../core/bytes/byte-fields';
import type { SpatialVideo, VideoProjection } from '../../../core/model/media';
import { demuxAssert, malformedInput } from '../../../core/errors/demux-guard';
import { carriedAudioCodec, carriedAudioShape, isMpegH } from '../carried-audio';
import { vp9CodecFromConfig } from '../../../core/codec-config/video/vp9-config';
import { av1CodecString, leb128 } from '../../../core/codec-config/video/av1-config';
import { iamfDescription } from '../../../core/codec-config/audio/iamf';
import { hevcCodecString } from '../../../core/codec-config/video/hevc-codec';
import {
    DOLBY_VISION_CONFIG_BYTES,
    dolbyVisionCodecString,
    parseDolbyVisionConfig,
} from '../../../core/codec-config/video/dolby-vision';
import { vvcCodecString } from '../../../core/codec-config/video/vvc';
import { apvCodecString, apvConfigInfo } from '../../../core/codec-config/video/apv';
import { isDtsCodec, mpegVideoFamily, type DtsCodec } from '../../../core/model/codec-strings';
import { mpegVideoCodec, parseMpegVideoConfig } from '../../../core/codec-config/video/mpeg-video';
import { rawVideoCodec, rawVideoCodecForFourcc } from '../../../core/codec-config/video/raw-video';
import { ascii, childBox, findBox, parseEsds, readU16, readU32 } from './boxes';
import { QUICKTIME_SOUND_FRAMES } from './descriptions';
import type { ChunkAudioUnit } from './read-types';

/** QuickTime video FourCCs whose codec has a conventional name. */
const QUICKTIME_VIDEO_NAMES: ReadonlyMap<string, string> = new Map([
    ['jpeg', 'mjpeg'],
    ['mjpa', 'mjpeg'],
    ['AVDJ', 'mjpeg'],
    ['theo', 'theora'],
    ['AVdn', 'dnxhd'],
    ['AVdh', 'dnxhd'],
    ['FFV1', 'ffv1'],
    ['VP80', 'vp8'],
]);

/**
 * QuickTime sample entries of MPEG video that carry no esds: camcorder, HDV, XDCAM, IMX and DivX
 * FourCCs.
 */
const QUICKTIME_MPEG_VIDEO: ReadonlyMap<string, string> = new Map([
    ...'m2v1 mp2v hdv1 hdv2 hdv3 hdv4 hdv5 hdv6 hdv7 hdv8 hdv9 hdva xdhd'
        .split(' ')
        .map(fourcc => [fourcc, 'mp4v.61'] as const),
    ...'123456789abcdef'.split('').map(digit => [`xdv${digit}`, 'mp4v.61'] as const),
    ...'mx3n mx3p mx4n mx4p mx5n mx5p AVmp xdh2'
        .split(' ')
        .map(fourcc => [fourcc, 'mp4v.65'] as const),
    ...'1459abcdef'.split('').map(digit => [`xd5${digit}`, 'mp4v.65'] as const),
    ...['m1v1', 'm1v ', 'mpeg', 'mpg1'].map(fourcc => [fourcc, 'mp4v.6a'] as const),
    ...['DIVX', 'divx', 'XVID', 'FMP4', '3IV2'].map(fourcc => [fourcc, 'mp4v.20.9'] as const),
]);

/**
 * MPEG audio sample entries, the QuickTime 'ms' forms of WAVE format tags 0x55 and 0x50 included.
 */
const MPEG_AUDIO_ENTRIES = new Map([
    ['.mp3', 'mp3'],
    ['ms\u0000U', 'mp3'],
    ['.mp2', 'mp2'],
    ['ms\u0000P', 'mp2'],
    ['.mp1', 'mp1'],
]);
const DTS_SAMPLE_ENTRIES: ReadonlyMap<string, DtsCodec> = new Map([
    ['dtsc', 'dtsc'],
    ['DTS ', 'dtsc'],
    ['dtsh', 'dtsh'],
    ['dtsl', 'dtsl'],
    ['dtse', 'dtse'],
]);

/**
 * Channels of each CICP ChannelConfiguration (ISO/IEC 23091-3) up to 9.1.4, 0 where it states
 * no count.
 */
const CICP_CHANNELS = [0, 1, 2, 3, 4, 5, 6, 8, 2, 3, 4, 7, 8, 24, 8, 12, 10, 12, 14, 12, 14];

/** Codecs of the esds objectTypeIndications other than AAC. */
const ESDS_AUDIO_CODECS: ReadonlyMap<number, string> = new Map([
    [0x69, 'mp3'],
    [0x6b, 'mp3'],
    [0xa5, 'ac-3'],
    [0xa6, 'ec-3'],
    [0xa9, 'dtsc'],
    [0xaa, 'dtsh'],
    [0xab, 'dtsl'],
    [0xac, 'dtse'],
    [0xad, 'opus'],
    [0xdd, 'vorbis'],
]);

/**
 * The codec of a visual sample entry other than AVC, its decoder configuration, and the pixel
 * aspect an MPEG video configuration states where the entry has no pasp (`aspect`).
 */
export function videoEntryCodec(
    buf: Uint8Array,
    dv: DataView,
    entryOffset: number,
    entrySize: number,
    codecFourCC: string,
    hasPasp: boolean,
): {
    codec: string;
    codecConfig?: Uint8Array;
    codecTag?: string;
    dolbyVisionConfig?: Uint8Array;
    aspect?: readonly [number, number];
} {
    const start = entryOffset + 86;
    const end = entryOffset + entrySize;
    let codec: string;
    let codecConfig: Uint8Array | undefined;
    let dolbyVisionConfig: Uint8Array | undefined;

    if (
        codecFourCC === 'hvc1' ||
        codecFourCC === 'hev1' ||
        codecFourCC === 'dvh1' ||
        codecFourCC === 'dvhe'
    ) {
        const hvcC = findBox(buf, start, end, 'hvcC');
        if (hvcC) codecConfig = buf.slice(hvcC.offset + 8, hvcC.offset + hvcC.size);
        const dolby = findBox(buf, start, end, 'dvcC') ?? findBox(buf, start, end, 'dvvC');
        if (dolby && dolby.size >= 8 + DOLBY_VISION_CONFIG_BYTES)
            dolbyVisionConfig = buf.slice(
                dolby.offset + 8,
                dolby.offset + 8 + DOLBY_VISION_CONFIG_BYTES,
            );
        const dolbyVision = parseDolbyVisionConfig(dolbyVisionConfig);
        const hevcEntry = codecFourCC === 'hev1' || codecFourCC === 'dvhe' ? 'hev1' : 'hvc1';
        codec =
            dolbyVision && (codecFourCC === 'dvh1' || codecFourCC === 'dvhe')
                ? dolbyVisionCodecString(codecFourCC, dolbyVision)
                : hevcCodecString(hevcEntry, codecConfig);
    } else if (codecFourCC === 'vvc1' || codecFourCC === 'vvi1') {
        const vvcC = findBox(buf, start, end, 'vvcC');
        if (vvcC && vvcC.size > 12)
            codecConfig = buf.slice(vvcC.offset + 12, vvcC.offset + vvcC.size);
        codec = vvcCodecString(codecFourCC, codecConfig);
    } else if (codecFourCC === 'apv1') {
        const apvC = findBox(buf, start, end, 'apvC');
        if (apvC && apvC.size > 12)
            codecConfig = buf.slice(apvC.offset + 12, apvC.offset + apvC.size);
        codec = apvCodecString(apvConfigInfo(codecConfig));
    } else if (codecFourCC === 'vp08') {
        codec = 'vp8';
    } else if (codecFourCC === 'vp09') {
        const vpcC = findBox(buf, start, end, 'vpcC');
        if (vpcC) codecConfig = buf.slice(vpcC.offset + 8, vpcC.offset + vpcC.size);
        codec = vp9CodecFromConfig('vp09.00.10.08', codecConfig);
    } else if (codecFourCC === 'av01') {
        const av1C = findBox(buf, start, end, 'av1C');
        if (av1C) codecConfig = buf.slice(av1C.offset + 8, av1C.offset + av1C.size);
        codec = av1CodecString(codecConfig) ?? 'av01.0.01M.08';
    } else if (codecFourCC === 'raw ') {
        const depth = readU16(dv, entryOffset + 82);
        if (!(depth === 24 || depth === 32))
            malformedInput(`uncompressed 'raw ' video of depth ${depth} is not supported`);
        codec = rawVideoCodec(depth === 24 ? 'RGB24' : 'XRGB');
    } else if (rawVideoCodecForFourcc(codecFourCC)) {
        codec = rawVideoCodecForFourcc(codecFourCC)!;
    } else if (codecFourCC === 'mp4v') {
        const esds = parseEsds(buf, start, end);
        const objectType = esds?.objectType ?? 0x20;
        codecConfig = esds?.specificInfo;
        codec = mpegVideoCodec(objectType, codecConfig) ?? `mp4v.${objectType.toString(16)}`;
    } else if (QUICKTIME_MPEG_VIDEO.has(codecFourCC)) {
        codec = QUICKTIME_MPEG_VIDEO.get(codecFourCC)!;
        const glbl = findBox(buf, start, end, 'glbl');
        if (glbl && glbl.size > 8) {
            codecConfig = buf.slice(glbl.offset + 8, glbl.offset + glbl.size);
            const family = mpegVideoFamily(codec);
            codec =
                parseMpegVideoConfig(family === 'mpeg4v' ? 'mpeg4' : 'mpeg12', codecConfig)
                    ?.codec ?? codec;
        }
    } else if (codecFourCC === 's263' || codecFourCC === 'h263' || codecFourCC === 'H263') {
        codec = 'h263';
    } else {
        codec = QUICKTIME_VIDEO_NAMES.get(codecFourCC) ?? codecFourCC;
    }

    const mpegFamily = mpegVideoFamily(codec);
    const mpegFormat =
        mpegFamily && codecConfig && !hasPasp
            ? parseMpegVideoConfig(mpegFamily === 'mpeg4v' ? 'mpeg4' : 'mpeg12', codecConfig)
            : null;
    return {
        codec,
        codecConfig,
        dolbyVisionConfig,
        ...(mpegFamily === 'mpeg4v' ? { codecTag: codecFourCC } : {}),
        ...(mpegFormat
            ? { aspect: [mpegFormat.pixelAspectRatioNum, mpegFormat.pixelAspectRatioDen] as const }
            : {}),
    };
}

/** A subtitle sample entry: its codec, configuration and forced flag. */
export function subtitleEntry(
    buf: Uint8Array,
    dv: DataView,
    entryOffset: number,
    entrySize: number,
    codecFourCC: string,
): { codec: string; codecConfig: Uint8Array; forced: boolean } {
    if (!(entrySize >= 16)) malformedInput(`'${codecFourCC}' subtitle sample entry is truncated`);
    let forced = false;
    if (codecFourCC === 'wvtt') {
        const vttC = findBox(buf, entryOffset + 16, entryOffset + entrySize, 'vttC');
        demuxAssert(!!vttC, 'wvtt sample entry has no vttC configuration');
        return {
            codec: codecFourCC,
            codecConfig: buf.slice(vttC.offset + 8, vttC.offset + vttC.size),
            forced,
        };
    }

    if (codecFourCC === 'tx3g') {
        demuxAssert(entrySize >= 38, 'tx3g sample entry is truncated');
        forced = (readU32(dv, entryOffset + 16) & 0x40000000) !== 0;
    }

    if (codecFourCC === 'stpp') {
        let strings = 0;
        for (
            let offset = entryOffset + 16;
            offset < entryOffset + entrySize && strings < 3;
            offset++
        ) {
            if (buf[offset] === 0) strings++;
        }
        demuxAssert(
            strings === 3,
            'stpp sample entry has unterminated namespace/schema/MIME strings',
        );
    }

    return {
        codec: codecFourCC,
        codecConfig: buf.slice(entryOffset + 16, entryOffset + entrySize),
        forced,
    };
}

/**
 * An esds sound description of an object type other than AAC: its codec, configuration and shape.
 */
export function esdsAudioEntry(
    objectType: number,
    specificInfo: Uint8Array | undefined,
    sampleRate: number,
    channelCount: number,
): {
    codec: string;
    codecConfig: Uint8Array | undefined;
    sampleRate: number;
    channelCount: number;
} {
    // An unregistered indication names itself so it is never decoded or copied as AAC.
    const codec = ESDS_AUDIO_CODECS.get(objectType) ?? carriedAudioCodec(objectType);
    let codecConfig: Uint8Array | undefined;
    if (codec === 'vorbis') {
        codecConfig = xiphLacedVorbis(specificInfo);

        // The identification header states the channels and rate; the sample entry's fields may
        // not.
        const info = codecConfig ?? new Uint8Array(0);
        for (let at = 0; at + 16 <= Math.min(info.length, 32); at++)
            if (info[at] === 1 && ascii(info, at + 1, 6) === 'vorbis') {
                channelCount = info[at + 11] || channelCount;
                sampleRate =
                    new DataView(info.buffer, info.byteOffset + at + 12, 4).getUint32(0, true) ||
                    sampleRate;
                break;
            }
    } else if (codec === 'opus' || isDtsCodec(codec)) codecConfig = specificInfo;
    else {
        // Object types copied as stated: their decoder-specific info, and the shape speech codecs
        // fix.
        codecConfig = specificInfo;
        const shape = carriedAudioShape(codec);
        if (shape) ({ sampleRate, channelCount } = shape);
    }
    if (codec === 'opus') sampleRate = 48000;
    return { codec, codecConfig, sampleRate, channelCount };
}

/**
 * A sound description other than mp4a: its codec, configuration, shape and the unit of chunk-layout
 * sound.
 */
export function audioEntry(
    buf: Uint8Array,
    dv: DataView,
    entryOffset: number,
    entrySize: number,
    codecFourCC: string,
    shape: {
        readonly audioVersion: number;
        readonly extStart: number;
        sampleRate: number;
        channelCount: number;
    },
): {
    codec: string;
    codecConfig: Uint8Array | undefined;
    sampleRate: number;
    channelCount: number;
    pcmFrameBytes: number;
    chunkUnit: ChunkAudioUnit | undefined;
} {
    const { audioVersion, extStart } = shape;
    let { sampleRate, channelCount } = shape;
    const end = entryOffset + entrySize;
    let codec: string;
    let codecConfig: Uint8Array | undefined;
    let pcmFrameBytes = 0;
    let chunkUnit: ChunkAudioUnit | undefined;
    if (MPEG_AUDIO_ENTRIES.has(codecFourCC)) {
        codec = MPEG_AUDIO_ENTRIES.get(codecFourCC)!;

        // Version-1 sound descriptions count single samples; their chunks hold whole frames.
        if (audioVersion === 1 && entrySize >= 52) {
            const samples = readU32(dv, entryOffset + 36);
            const bytes = readU32(dv, entryOffset + 44);
            if (samples > 1 && bytes > 0) chunkUnit = { samples, bytes, mpegFrames: true };
        }
    } else if (DTS_SAMPLE_ENTRIES.has(codecFourCC)) {
        codec = DTS_SAMPLE_ENTRIES.get(codecFourCC)!;
        const ddts = findBox(buf, extStart, end, 'ddts');
        if (ddts && ddts.size >= 28) {
            codecConfig = buf.slice(ddts.offset + 8, ddts.offset + ddts.size);
            sampleRate = readU32(dv, ddts.offset + 8) || sampleRate;
        }
    } else if (codecFourCC === 'mlpa') {
        // Dolby TrueHD stores the whole 32-bit rate field as an integer rather than 16.16 fixed
        // point.
        codec = 'mlpa';
        sampleRate = readU32(dv, entryOffset + 32) || sampleRate;
        const dmlp = findBox(buf, extStart, end, 'dmlp');
        if (dmlp) codecConfig = buf.slice(dmlp.offset + 8, dmlp.offset + dmlp.size);
    } else if (isMpegH(codecFourCC)) {
        // MPEG-H 3D audio states its layout in the configuration record (configurationVersion,
        // profile-level, reference channel layout); the entry's channel count is zero. The codec
        // string names the profile-level in hexadecimal: 'mhm1.0x0D'.
        codec = codecFourCC;
        const mhaC = findBox(buf, extStart, end, 'mhaC');
        if (mhaC && mhaC.size > 8)
            codecConfig = buf.slice(mhaC.offset + 8, mhaC.offset + mhaC.size);
        if (codecConfig && codecConfig.length >= 3) {
            codec += `.0x${codecConfig[1]!.toString(16).toUpperCase().padStart(2, '0')}`;
            channelCount = CICP_CHANNELS[codecConfig[2]!] ?? 0;
        }
    } else if (codecFourCC === 'iamf') {
        // IAMF keeps its descriptor OBUs in 'iacb' after a version and their leb128 size; the
        // entry's rate and channel count are zero.
        const iacb = findBox(buf, extStart, end, 'iacb');
        const size = iacb && leb128(buf, iacb.offset + 9, iacb.offset + iacb.size);
        if (size) codecConfig = buf.slice(iacb.offset + 9 + size.length, iacb.offset + iacb.size);
        const description = codecConfig && iamfDescription(codecConfig);
        demuxAssert(description, "'iamf' sample entry has no IA sequence descriptors");
        ({ codec, sampleRate, channelCount } = description);
    } else if (codecFourCC === 'ipcm' || codecFourCC === 'fpcm') {
        // ISO/IEC 23003-5 PCM: the pcmC box gives the byte order and sample size.
        const pcmC = findBox(buf, extStart, end, 'pcmC');
        if (!(!!pcmC && pcmC.size >= 14))
            malformedInput(`'${codecFourCC}' sample entry has no pcmC box`);
        const order = buf[pcmC.offset + 12]! & 1 ? 'le' : 'be';
        const bits = buf[pcmC.offset + 13]!;
        const float = codecFourCC === 'fpcm';
        if (!(float ? bits === 32 || bits === 64 : bits === 16 || bits === 24 || bits === 32))
            malformedInput(`'${codecFourCC}' ${bits}-bit samples are unsupported`);
        codec = `pcm-${float ? 'f' : 's'}${bits}${order}`;
        pcmFrameBytes = (channelCount * bits) / 8;
    } else if (codecFourCC === 'Opus') {
        codec = 'opus';
        const dOps = findBox(buf, extStart, end, 'dOps');
        if (dOps) codecConfig = buf.slice(dOps.offset + 8, dOps.offset + dOps.size);
    } else if (codecFourCC === 'ac-3') {
        codec = 'ac-3';
        const dac3 = findBox(buf, extStart, end, 'dac3');
        if (dac3) codecConfig = buf.slice(dac3.offset + 8, dac3.offset + dac3.size);
    } else if (codecFourCC === 'ec-3') {
        codec = 'ec-3';
        const dec3 = findBox(buf, extStart, end, 'dec3');
        if (dec3) codecConfig = buf.slice(dec3.offset + 8, dec3.offset + dec3.size);
    } else if (codecFourCC === 'alac') {
        codec = 'alac';

        // QuickTime wraps the configuration in a 'wave' atom after a 'frma' atom.
        const wave = findBox(buf, extStart, end, 'wave');
        const alac =
            findBox(buf, extStart, end, 'alac') ?? (wave ? childBox(buf, wave, 'alac') : undefined);

        // The 24-byte AlacSpecificConfig may be followed by an AlacChannelLayoutInfo for
        // multichannel audio.
        demuxAssert(
            !!alac && alac.size >= 36 && readU32(dv, alac.offset + 8) === 0,
            'Invalid ALAC configuration box',
        );
        codecConfig = buf.slice(alac.offset + 12, alac.offset + 36);
        sampleRate = readU32(dv, alac.offset + 32);
        channelCount = buf[alac.offset + 21]!;
        demuxAssert(
            sampleRate > 0 && channelCount >= 1 && channelCount <= 8,
            'Invalid ALAC sample rate or channel count',
        );
    } else if (codecFourCC === 'fLaC') {
        codec = 'flac';
        const dfLa = findBox(buf, extStart, end, 'dfLa');
        if (dfLa) {
            demuxAssert(
                dfLa.size >= 50 && buf[dfLa.offset + 8] === 0,
                'Invalid FLAC configuration box',
            );
            const start = dfLa.offset + 12;
            demuxAssert(
                (buf[start]! & 0x7f) === 0 &&
                    buf[start + 1] === 0 &&
                    buf[start + 2] === 0 &&
                    buf[start + 3] === 34,
                'FLAC configuration omits STREAMINFO',
            );
            codecConfig = buf.slice(start + 4, start + 38);
            sampleRate = codecConfig[10]! * 4096 + codecConfig[11]! * 16 + (codecConfig[12]! >>> 4);
            channelCount = ((codecConfig[12]! >>> 1) & 7) + 1;
            demuxAssert(sampleRate > 0, 'Invalid FLAC STREAMINFO sample rate');
        }
    } else {
        const bits =
            audioVersion === 2 ? readU32(dv, entryOffset + 56) : readU16(dv, entryOffset + 26);
        const enda = findBox(buf, extStart, end, 'wave');
        const endaBox = enda ? childBox(buf, enda, 'enda') : undefined;
        const littleEndian =
            !!endaBox && endaBox.size >= 10 && readU16(dv, endaBox.offset + 8) === 1;
        const flags = audioVersion === 2 ? readU32(dv, entryOffset + 60) : 0;
        const lpcm =
            audioVersion === 2
                ? {
                      float: (flags & 1) !== 0,
                      bigEndian: (flags & 2) !== 0,
                      signed: (flags & 4) !== 0,
                      bits,
                  }
                : undefined;

        // 'ms' + a two-byte WAVE format tag wraps a Windows ACM codec (ADPCM, WMA, ...).
        const waveTag = codecFourCC.startsWith('ms')
            ? (buf[entryOffset + 6]! << 8) | buf[entryOffset + 7]!
            : -1;
        codec =
            quickTimePcmCodec(codecFourCC, bits, littleEndian, lpcm) ??
            (waveTag >= 0 ? `wave-${waveTag.toString(16).padStart(4, '0')}` : codecFourCC);
        const width = /^pcm-[suf](\d+)/.exec(codec);
        if (width) pcmFrameBytes = (channelCount * Number(width[1])) / 8;
        // G.711 stores one byte per sample and channel.
        else if (codec === 'ulaw' || codec === 'alaw') pcmFrameBytes = channelCount;

        // Version-1 sound descriptions of ACM codecs count samples, not packets, in their sample
        // tables.
        if (waveTag >= 0 && audioVersion === 1 && !width)
            throw new DemuxError(
                `QuickTime audio '${codecFourCC.replace(/[^ -~]/g, '.')}' ` +
                    `(Windows ACM format 0x${waveTag.toString(16).padStart(4, '0')}) is not ` +
                    `supported`,
            );
        if (pcmFrameBytes) chunkUnit = { samples: 1, bytes: pcmFrameBytes };
        else if (audioVersion === 1 && entrySize >= 52) {
            // Version-1 sound descriptions: samples per packet and bytes per packet of all
            // channels.
            const samples = readU32(dv, entryOffset + 36);
            const bytes = readU32(dv, entryOffset + 44);
            if (samples > 1 && bytes > 0) chunkUnit = { samples, bytes };
        } else if (audioVersion === 0) {
            const frame = QUICKTIME_SOUND_FRAMES.get(codecFourCC);
            if (frame) chunkUnit = { samples: frame.samples, bytes: frame.bytes * channelCount };
        }
    }
    return { codec, codecConfig, sampleRate, channelCount, pcmFrameBytes, chunkUnit };
}

/**
 * Vorbis headers of an esds DecoderSpecificInfo as Xiph lacing: GPAC stored each of the three
 * header packets after a 16-bit big-endian length, as ffmpeg also reads them; a configuration
 * already laced is kept.
 */
function xiphLacedVorbis(info: Uint8Array | undefined): Uint8Array | undefined {
    if (!info || info.length < 9 || info[2] !== 1 || ascii(info, 3, 6) !== 'vorbis') return info;
    const headers: Uint8Array[] = [];
    for (let at = 0; headers.length < 3;) {
        if (at + 2 > info.length) return info;
        const length = (info[at]! << 8) | info[at + 1]!;
        at += 2;
        if (at + length > info.length) return info;
        headers.push(info.subarray(at, (at += length)));
    }

    const laces: number[] = [2];
    for (const header of headers.slice(0, 2)) {
        for (let remaining = header.length; ; remaining -= 255) {
            laces.push(Math.min(remaining, 255));
            if (remaining < 255) break;
        }
    }

    const laced = new Uint8Array(
        laces.length + headers.reduce((sum, header) => sum + header.length, 0),
    );
    laced.set(laces);
    let offset = laces.length;
    for (const header of headers) {
        laced.set(header, offset);
        offset += header.length;
    }
    return laced;
}

/**
 * QuickTime uncompressed audio sample entries name the storage by FourCC (and, for
 * 'in24'/'in32'/'fl32'/'fl64', an 'enda' atom for byte order, or the version-2 LPCM flags); the
 * explicit 'pcm-*' codec ids describe the same bytes.
 */
function quickTimePcmCodec(
    fourcc: string,
    bits: number,
    littleEndian: boolean,
    lpcm?: { float: boolean; signed: boolean; bigEndian: boolean; bits: number },
): string | undefined {
    if (fourcc === 'lpcm' && lpcm) {
        const width = lpcm.bits;
        if (lpcm.float)
            return width === 32 || width === 64
                ? `pcm-f${width}${lpcm.bigEndian ? 'be' : 'le'}`
                : undefined;
        if (width === 8) return lpcm.signed ? 'pcm-s8' : 'pcm-u8';
        if (width === 16 || width === 24 || width === 32)
            return lpcm.signed ? `pcm-s${width}${lpcm.bigEndian ? 'be' : 'le'}` : undefined;
        return undefined;
    }

    const order = littleEndian ? 'le' : 'be';
    switch (fourcc) {
        case 'sowt':
            return bits === 16 ? 'pcm-s16le' : bits === 8 ? 'pcm-s8' : undefined;
        case 'twos':
            return bits === 16 ? 'pcm-s16be' : bits === 8 ? 'pcm-s8' : undefined;
        // QuickTime's original uncompressed sound is offset-binary at 8 bits, as ffmpeg reads it.
        case 'NONE':
            return bits === 16 ? 'pcm-s16be' : bits === 8 ? 'pcm-u8' : undefined;
        case 'raw ':
            return bits === 8 ? 'pcm-u8' : bits === 16 ? `pcm-s16${order}` : undefined;
        case 'in24':
            return `pcm-s24${order}`;
        case 'in32':
            return `pcm-s32${order}`;
        case 'fl32':
            return `pcm-f32${order}`;
        case 'fl64':
            return `pcm-f64${order}`;
        default:
            return undefined;
    }
}

/** Projection kinds of 'prji' (Apple's Stereo Video ISOBMFF Extensions). */
const PROJECTIONS: Readonly<Record<string, VideoProjection>> = {
    rect: 'rectilinear',
    equi: 'equirectangular',
    hequ: 'half-equirectangular',
    fish: 'fisheye',
    prim: 'parametric',
};

const PACKINGS: Readonly<Record<string, SpatialVideo['views']>> = {
    side: 'side-by-side',
    over: 'over-under',
};

const HERO_EYES = [undefined, 'left', 'right'] as const;

/**
 * The spatial video of a visual sample entry whose child boxes run from `start` to `end`: an
 * MV-HEVC layer ('lhvC'), Apple's video extended usage ('vexu': eyes, hero eye, camera baseline in
 * micrometres, disparity in ten-thousandths of a view's width, projection, packing) and the
 * horizontal field of view in thousandths of a degree ('hfov'), with those boxes as they are.
 */
export function spatialVideoOf(
    buf: Uint8Array,
    start: number,
    end: number,
): { spatial?: SpatialVideo; boxes: Uint8Array } {
    const [layer, usage, fov] = ['lhvC', 'vexu', 'hfov'].map(type =>
        findBox(buf, start, end, type),
    );
    const boxes = concatBytes(
        [layer, usage, fov].flatMap(box =>
            box ? [buf.subarray(box.offset, box.offset + box.size)] : [],
        ),
    );
    if (!layer && !usage) return { boxes };

    // The payload of the full box at `path` in 'vexu', and its first word and four-character code.
    const leaf = (...path: string[]): Uint8Array => {
        let box = usage;
        for (const type of path) box = box && childBox(buf, box, type);
        return box && box.size > 12
            ? buf.subarray(box.offset + 12, box.offset + box.size)
            : new Uint8Array(0);
    };
    const word = (bytes: Uint8Array): number | undefined =>
        bytes.length >= 4 ? readU32(dataView(bytes), 0) : undefined;
    const kind = (bytes: Uint8Array): string => (bytes.length >= 4 ? ascii(bytes, 0, 4) : '');
    const flags = leaf('eyes', 'stri')[0] ?? 0;
    const eyes = (['left', 'right'] as const).filter(
        (_, bit) => !(flags >> 4) && flags & (1 << bit),
    );
    const heroEye = HERO_EYES[leaf('eyes', 'hero')[0] ?? 0];
    const baseline = word(leaf('eyes', 'cams', 'blin'));
    const disparity = word(leaf('eyes', 'cmfy', 'dadj'));
    const projection = PROJECTIONS[kind(leaf('proj', 'prji'))];
    const views = layer ? 'layer' : PACKINGS[kind(leaf('pack', 'pkin'))];
    const degrees = fov && fov.size >= 12 ? readU32(dataView(buf), fov.offset + 8) : undefined;
    const spatial: SpatialVideo = {
        eyes,
        ...(views ? { views } : {}),
        ...(heroEye ? { heroEye } : {}),
        ...(baseline !== undefined ? { baseline: baseline / 1000 } : {}),
        ...(disparity ? { disparityAdjustment: (disparity | 0) / 10000 } : {}),
        ...(projection ? { projection } : {}),
        ...(degrees !== undefined ? { fieldOfView: degrees / 1000 } : {}),
    };
    return { spatial, boxes };
}
