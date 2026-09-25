import { DemuxError, MediaForgeError } from '../core/errors.js';
import { demuxAssert, DEMUX_LIMITS, DemuxIndexBudget, resolveDemuxBudget } from '../core/demux-guard.js';
import { BlobSource } from '../io/sources.js';
import { ChunkReader, CHUNK_BYTES } from '../io/chunk-reader.js';
import { parseAacAudioSpecificConfig } from '../audio/adts.js';
import { parseMpegAudioHeader } from '../core/mpeg-audio-header.js';
import { isProResCodec, readProResFourCC, proResFrameError, hasProResFrameHeader } from '../core/prores.js';
import { opusPacketFrames } from '../core/opus-packet.js';
import { parseFlacFrameHeader } from '../core/flac-frame.js';
import { matroskaPcmCodec } from '../core/matroska-pcm.js';
import { describePcmTrack } from '../core/pcm-format.js';
import { readMatroskaTrackTitles } from '../core/matroska-track-titles.js';
import { MATROSKA_METADATA_LIMIT, matroskaScopedUids, matroskaTagsElement, matroskaUid, parseMatroskaTags, } from '../core/matroska-tags.js';
const ID = {
    EBML: 0x1a45dfa3,
    Segment: 0x18538067,
    Info: 0x1549a966,
    TimestampScale: 0x2ad7b1,
    Title: 0x7ba9,
    Tags: 0x1254c367,
    Tracks: 0x1654ae6b,
    TrackEntry: 0xae,
    TrackNumber: 0xd7,
    TrackUID: 0x73c5,
    TrackType: 0x83,
    FlagDefault: 0x88,
    FlagForced: 0x55aa,
    FlagCommentary: 0x55af,
    Name: 0x536e,
    AlphaMode: 0x53c0,
    BlockAdditions: 0x75a1,
    BlockMore: 0xa6,
    BlockAddID: 0xee,
    BlockAdditional: 0xa5,
    Language: 0x22b59c,
    LanguageIETF: 0x22b59d,
    CodecID: 0x86,
    CodecPrivate: 0x63a2,
    CodecDelay: 0x56aa,
    TrackTimestampScale: 0x23314f,
    DefaultDuration: 0x23e383,
    Video: 0xe0,
    PixelWidth: 0xb0,
    PixelHeight: 0xba,
    DisplayWidth: 0x54b0,
    DisplayHeight: 0x54ba,
    DisplayUnit: 0x54b2,
    Colour: 0x55b0,
    MatrixCoefficients: 0x55b1,
    Range: 0x55b9,
    TransferCharacteristics: 0x55ba,
    Primaries: 0x55bb,
    Audio: 0xe1,
    SamplingFrequency: 0xb5,
    Channels: 0x9f,
    BitDepth: 0x6264,
    Cluster: 0x1f43b675,
    ClusterTimestamp: 0xe7,
    SimpleBlock: 0xa3,
    BlockGroup: 0xa0,
    Block: 0xa1,
    ReferenceBlock: 0xfb,
    BlockDuration: 0x9b,
    DiscardPadding: 0x75a2,
    Chapters: 0x1043a770,
    Attachments: 0x1941a469,
};
const SEGMENT_CHILD_IDS = new Set([
    ID.Info,
    ID.Tracks,
    ID.Cluster,
    ID.Chapters,
    ID.Attachments,
    0x114d9b74,
    0x1c53bb6b,
    ID.Tags,
    0xec,
    0xbf,
]);
const CLUSTER_CHILD_IDS = new Set([
    ID.ClusterTimestamp,
    ID.SimpleBlock,
    ID.BlockGroup,
    0xa7,
    0xab,
    0x5854,
    0xec,
    0xbf,
]);
const HEADER_PEEK = 24;
function readVint(buf, pos, kind) {
    demuxAssert(pos < buf.length, 'EBML vint past EOF');
    const first = buf[pos];
    demuxAssert(first !== 0, 'invalid EBML vint (zero lead byte)');
    let length = 1;
    let mask = 0x80;
    while ((first & mask) === 0) {
        length++;
        mask >>= 1;
    }
    demuxAssert(length <= 8 && pos + length <= buf.length, 'EBML vint truncated');
    demuxAssert(kind !== 'id' || length <= 4, 'Matroska element ID exceeds four bytes');
    if (kind === 'size' && isUnknownSizeBytes(buf, pos, length))
        return { value: 0, length };
    if (kind === 'signed' && length === 8) {
        let wide = 0n;
        for (let i = 1; i < length; i++)
            wide = wide * 256n + BigInt(buf[pos + i]);
        wide -= (1n << 55n) - 1n;
        demuxAssert(wide >= BigInt(Number.MIN_SAFE_INTEGER) && wide <= BigInt(Number.MAX_SAFE_INTEGER), 'EBML lace delta exceeds the safe integer range');
        return { value: Number(wide), length };
    }
    let value = kind === 'id' ? first : first & (mask - 1);
    for (let i = 1; i < length; i++)
        value = value * 256 + buf[pos + i];
    if (kind === 'signed')
        value -= 2 ** (length * 7 - 1) - 1;
    demuxAssert(Number.isSafeInteger(value), 'EBML vint exceeds the safe integer range');
    return { value, length };
}
function isUnknownSizeBytes(buf, pos, length) {
    const first = buf[pos];
    const mask = 0x80 >> (length - 1);
    if ((first & (mask - 1)) !== mask - 1)
        return false;
    for (let i = 1; i < length; i++)
        if (buf[pos + i] !== 0xff)
            return false;
    return true;
}
function readHeaderLocal(buf, pos, parentEnd) {
    const id = readVint(buf, pos, 'id');
    const size = readVint(buf, pos + id.length, 'size');
    const dataStart = pos + id.length + size.length;
    const unknown = isUnknownSizeBytes(buf, pos + id.length, size.length);
    const dataEnd = unknown ? parentEnd : dataStart + size.value;
    demuxAssert(dataEnd <= parentEnd, `EBML element 0x${id.value.toString(16)} exceeds its parent`);
    return { id: id.value, dataStart, dataEnd, unknown, headerLen: id.length + size.length };
}
function* elements(buf, start, end) {
    let pos = start;
    let count = 0;
    while (pos < end) {
        const h = readHeaderLocal(buf, pos, end);
        demuxAssert(!h.unknown, `unknown-size EBML element 0x${h.id.toString(16)} inside a sized container`);
        yield { id: h.id, dataStart: h.dataStart, dataEnd: h.dataEnd };
        demuxAssert(++count <= DEMUX_LIMITS.maxTableEntries, 'EBML element count exceeds limit');
        pos = h.dataEnd;
    }
}
function uintOf(buf, el, defaultValue = 0) {
    const len = el.dataEnd - el.dataStart;
    demuxAssert(len <= 8, 'EBML unsigned integer exceeds eight bytes');
    if (len === 0)
        return defaultValue;
    let v = 0;
    for (let i = el.dataStart; i < el.dataEnd; i++)
        v = v * 256 + buf[i];
    demuxAssert(Number.isSafeInteger(v), 'EBML unsigned integer exceeds the safe integer range');
    return v;
}
function floatOf(buf, el, defaultValue = 0) {
    const len = el.dataEnd - el.dataStart;
    demuxAssert(len === 0 || len === 4 || len === 8, 'EBML float has an invalid byte length');
    if (len === 0)
        return defaultValue;
    const dv = new DataView(buf.buffer, buf.byteOffset + el.dataStart);
    const value = len === 4 ? dv.getFloat32(0, false) : dv.getFloat64(0, false);
    demuxAssert(Number.isFinite(value), 'EBML float exceeds the finite range');
    return value;
}
function asciiOf(buf, el) {
    let s = '';
    for (let i = el.dataStart; i < el.dataEnd; i++) {
        const c = buf[i];
        if (c === 0)
            break;
        s += String.fromCharCode(c);
    }
    return s;
}
const MAX_METADATA_BYTES = MATROSKA_METADATA_LIMIT;
const UTF8 = new TextDecoder('utf-8', { fatal: true });
function utf8Of(buf, el) {
    demuxAssert(el.dataEnd - el.dataStart <= MAX_METADATA_BYTES, 'Matroska text exceeds the metadata byte limit');
    try {
        const text = UTF8.decode(buf.subarray(el.dataStart, el.dataEnd)).replace(/\0+$/, '');
        demuxAssert(!text.includes('\0'), 'Matroska text contains an embedded NUL');
        return text;
    }
    catch (error) {
        if (error instanceof MediaForgeError)
            throw error;
        throw new DemuxError('Malformed input: Matroska text is not valid UTF-8');
    }
}
const CODEC_MAP = {
    V_VP8: 'vp8',
    V_VP9: 'vp09.00.10.08',
    V_AV1: 'av01.0.04M.08',
    'V_MPEG4/ISO/AVC': 'avc1.42C01E',
    'V_MPEGH/ISO/HEVC': 'hvc1.1.6.L93.B0',
    A_OPUS: 'opus',
    A_VORBIS: 'vorbis',
    A_AAC: 'mp4a.40.2',
    'A_MPEG/L1': 'mp1',
    'A_MPEG/L2': 'mp2',
    'A_MPEG/L3': 'mp3',
    A_AC3: 'ac-3',
    A_EAC3: 'ec-3',
    A_FLAC: 'flac',
};
function videoCodecFromPrivate(codecId, config) {
    if (!config?.length)
        return undefined;
    if (codecId === 'V_MPEG4/ISO/AVC' && config.length >= 4 && config[0] === 1) {
        return `avc1.${Array.from(config.subarray(1, 4), byte => byte.toString(16).padStart(2, '0')).join('')}`;
    }
    if (codecId === 'V_MPEGH/ISO/HEVC' && config.length >= 23 && config[0] === 1) {
        const profile = config[1];
        let compatibility = 0;
        for (let bit = 0; bit < 32; bit++)
            compatibility += ((config[2 + (bit >>> 3)] >>> (7 - (bit & 7))) & 1) * 2 ** bit;
        let end = 12;
        while (end > 7 && config[end - 1] === 0)
            end--;
        const constraints = Array.from(config.subarray(6, end), byte => byte.toString(16).padStart(2, '0').toUpperCase()).join('.');
        return `hvc1.${['', 'A', 'B', 'C'][profile >>> 6]}${profile & 31}.${compatibility.toString(16).toUpperCase()}.${profile & 32 ? 'H' : 'L'}${config[12]}.${constraints}`;
    }
    if (codecId === 'V_AV1' && config.length >= 4 && config[0] === 0x81) {
        const profile = config[1] >>> 5;
        const highBitdepth = (config[2] & 0x40) !== 0;
        const twelveBit = (config[2] & 0x20) !== 0;
        if (profile > 2 || (twelveBit && (!highBitdepth || profile !== 2)))
            return undefined;
        const depth = highBitdepth ? (twelveBit ? 12 : 10) : 8;
        return `av01.${profile}.${String(config[1] & 31).padStart(2, '0')}${config[2] & 0x80 ? 'H' : 'M'}.${String(depth).padStart(2, '0')}`;
    }
    if (codecId === 'V_VP9') {
        const features = new Map();
        for (let offset = 0; offset < config.length;) {
            if (offset + 2 > config.length)
                return undefined;
            const id = config[offset++];
            const length = config[offset++];
            if (length > config.length - offset)
                return undefined;
            if (id >= 1 && id <= 4) {
                if (length !== 1 || (features.has(id) && features.get(id) !== config[offset]))
                    return undefined;
                features.set(id, config[offset]);
            }
            offset += length;
        }
        const profile = features.get(1);
        const level = features.get(2);
        const depth = features.get(3);
        if (profile === undefined ||
            profile > 3 ||
            level === undefined ||
            ![10, 11, 20, 21, 30, 31, 40, 41, 50, 51, 52, 60, 61, 62].includes(level) ||
            depth === undefined ||
            ![8, 10, 12].includes(depth))
            return undefined;
        return `vp09.${[profile, level, depth].map(value => String(value).padStart(2, '0')).join('.')}`;
    }
    return undefined;
}
const SUBTITLE_CODEC_MAP = {
    'S_TEXT/UTF8': 'text/utf8',
    'S_TEXT/ASS': 'text/ass',
    'S_TEXT/SSA': 'text/ssa',
    'S_TEXT/WEBVTT': 'text/webvtt',
    'D_WEBVTT/SUBTITLES': 'text/webvtt',
    'D_WEBVTT/CAPTIONS': 'text/webvtt',
    'D_WEBVTT/DESCRIPTIONS': 'text/webvtt',
    'D_WEBVTT/METADATA': 'text/webvtt',
};
function setDisplayGeometry(track, width, height, unit) {
    if (width === undefined && height === undefined && unit === 0)
        return;
    if (unit > 3)
        throw new MediaForgeError(`Unsupported Matroska DisplayUnit ${unit}`, 'FORMAT');
    demuxAssert(track.width > 0 && track.height > 0, 'Matroska display geometry requires positive coded dimensions');
    const displayWidth = width ?? (unit === 0 ? track.width : 0);
    const displayHeight = height ?? (unit === 0 ? track.height : 0);
    demuxAssert(displayWidth > 0 && displayHeight > 0, 'Matroska display dimensions must be positive');
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
    demuxAssert(numerator <= BigInt(Number.MAX_SAFE_INTEGER) && denominator <= BigInt(Number.MAX_SAFE_INTEGER), 'Matroska pixel aspect ratio exceeds the safe integer range');
    track.pixelAspectRatioNum = Number(numerator);
    track.pixelAspectRatioDen = Number(denominator);
    track.displayWidth = unit === 0 ? displayWidth : track.height * (displayWidth / displayHeight);
    track.displayHeight = unit === 0 ? displayHeight : track.height;
}
class SoftLimitExceeded extends Error {
}
function colourOf(buf, parent) {
    let matrix = 2;
    let transfer = 2;
    let primaries = 2;
    let range = 0;
    for (const field of elements(buf, parent.dataStart, parent.dataEnd)) {
        if (field.id === ID.MatrixCoefficients)
            matrix = uintOf(buf, field, 2);
        else if (field.id === ID.TransferCharacteristics)
            transfer = uintOf(buf, field, 2);
        else if (field.id === ID.Primaries)
            primaries = uintOf(buf, field, 2);
        else if (field.id === ID.Range)
            range = uintOf(buf, field);
    }
    if ((range !== 1 && range !== 2) ||
        matrix > 14 ||
        matrix === 3 ||
        transfer < 1 ||
        transfer > 18 ||
        transfer === 3 ||
        primaries < 1 ||
        primaries === 3 ||
        (primaries > 12 && primaries !== 22))
        return undefined;
    return { primaries, transfer, matrix, fullRange: range === 2 };
}
const SOFT_SAMPLE_BUDGET = 65536;
export class WebMDemuxer {
    isWorker = false;
    reader;
    totalSamples = 0;
    signal;
    materialize = true;
    metadataDropped = false;
    metadataWarned = false;
    diagnostics;
    externalFailure;
    inputUidCounts = new Map();
    sampleBudget = Number.POSITIVE_INFINITY;
    limits;
    indexBudget;
    constructor(options = {}) {
        this.limits = resolveDemuxBudget(options);
    }
    async demux(input, signal, diagnostics) {
        if (signal?.aborted)
            throw new MediaForgeError('Aborted', 'ABORT');
        if (!this.isWorker) {
            const worker = new WebMDemuxer(this.limits);
            worker.isWorker = true;
            return worker.demux(input, signal, diagnostics);
        }
        const source = input instanceof Blob ? new BlobSource(input) : input;
        this.reader = new ChunkReader(source);
        this.signal = signal;
        this.diagnostics = diagnostics;
        try {
            try {
                this.totalSamples = 0;
                this.materialize = true;
                this.sampleBudget = SOFT_SAMPLE_BUDGET;
                return await this.walk();
            }
            catch (soft) {
                if (!(soft instanceof SoftLimitExceeded))
                    throw soft;
            }
            this.totalSamples = 0;
            this.materialize = false;
            this.sampleBudget = Number.POSITIVE_INFINITY;
            await this.walk();
            this.totalSamples = 0;
            this.materialize = true;
            return await this.walk();
        }
        catch (e) {
            if (this.externalFailure && Object.is(this.externalFailure.error, e))
                throw e;
            if (e instanceof MediaForgeError && e.code === 'ABORT')
                throw e;
            if (e instanceof RangeError && /call stack/i.test(e.message)) {
                throw new DemuxError('Malformed input: EBML nesting too deep');
            }
            if (e instanceof RangeError) {
                throw new DemuxError(`Malformed input: structure reads out of bounds (${e.message})`);
            }
            throw e;
        }
    }
    async headerAt(pos, fileEnd) {
        const peek = await this.reader.bytes(pos, HEADER_PEEK);
        const h = readHeaderLocal(peek, 0, Number.MAX_SAFE_INTEGER);
        const dataStart = pos + h.headerLen;
        const dataEnd = h.unknown ? fileEnd : dataStart + (h.dataEnd - h.dataStart);
        demuxAssert(dataEnd <= fileEnd, `EBML element 0x${h.id.toString(16)} exceeds the file`);
        return { id: h.id, dataStart, dataEnd, unknown: h.unknown, headerLen: h.headerLen };
    }
    async walk() {
        this.indexBudget = new DemuxIndexBudget(this.limits);
        this.metadataDropped = false;
        this.inputUidCounts.clear();
        const fileEnd = this.reader.size;
        let pos = 0;
        let sawEbml = false;
        let segment = null;
        while (pos < fileEnd) {
            const h = await this.headerAt(pos, fileEnd);
            if (h.id === ID.EBML) {
                sawEbml = true;
                pos = h.dataEnd;
                continue;
            }
            if (h.id === ID.Segment) {
                segment = h;
                break;
            }
            demuxAssert(sawEbml, 'not an EBML/Matroska stream');
            pos = h.dataEnd;
        }
        demuxAssert(!!segment, 'no Matroska Segment found');
        const segEnd = segment.unknown ? fileEnd : segment.dataEnd;
        let timestampScaleNs = 1_000_000;
        const tracks = new Map();
        let chaptersRaw;
        let attachmentsRaw;
        let title;
        const parsedTags = [];
        let metadataBytes = 0;
        let unsupportedTags = false;
        pos = segment.dataStart;
        let l1Count = 0;
        while (pos < segEnd) {
            demuxAssert(++l1Count <= DEMUX_LIMITS.maxTableEntries, 'EBML element count exceeds limit');
            if (this.signal?.aborted)
                throw new MediaForgeError('Aborted', 'ABORT');
            const h = await this.headerAt(pos, segEnd);
            if (segment.unknown && !SEGMENT_CHILD_IDS.has(h.id))
                break;
            if (h.id === ID.Info) {
                const buf = await this.reader.bytes(h.dataStart, h.dataEnd - h.dataStart);
                for (const inf of elements(buf, 0, buf.length)) {
                    if (inf.id === ID.TimestampScale) {
                        timestampScaleNs = uintOf(buf, inf, 1_000_000);
                        demuxAssert(timestampScaleNs > 0, 'Matroska TimestampScale must be positive');
                    }
                    else if (inf.id === ID.Title) {
                        try {
                            title = utf8Of(buf, inf);
                        }
                        catch (error) {
                            this.optionalMetadataError(error);
                        }
                    }
                }
                pos = h.dataEnd;
            }
            else if (h.id === ID.Tracks) {
                const buf = await this.reader.bytes(h.dataStart, h.dataEnd - h.dataStart);
                this.parseTracks(buf, tracks);
                pos = h.dataEnd;
            }
            else if (h.id === ID.Chapters || h.id === ID.Attachments || h.id === ID.Tags) {
                demuxAssert(!h.unknown, 'unknown-size Matroska metadata is not supported');
                metadataBytes += h.dataEnd - pos;
                if (metadataBytes > MAX_METADATA_BYTES) {
                    this.metadataDropped = true;
                    this.warnMetadataLoss('Matroska metadata exceeds the byte limit and was omitted');
                }
                else if (this.materialize) {
                    const bytes = new Uint8Array(await this.reader.bytes(pos, h.dataEnd - pos));
                    if (h.id === ID.Tags) {
                        const parsed = parseMatroskaTags(bytes);
                        for (const tag of parsed.tags)
                            parsedTags.push(tag);
                        unsupportedTags ||= parsed.unsupported;
                        if (parsed.unsupported)
                            this.warnMetadataLoss('Malformed or unsupported Matroska tags were omitted');
                    }
                    else {
                        try {
                            matroskaScopedUids(bytes, h.id === ID.Chapters ? 'chapters' : 'attachments');
                            if (h.id === ID.Chapters)
                                chaptersRaw = bytes;
                            else
                                attachmentsRaw = bytes;
                        }
                        catch (error) {
                            this.optionalMetadataError(error);
                        }
                    }
                }
                pos = h.dataEnd;
            }
            else if (h.id === ID.Cluster) {
                pos = await this.parseClusterAt(h, segEnd, tracks, timestampScaleNs);
            }
            else {
                demuxAssert(!h.unknown, `unknown-size EBML element 0x${h.id.toString(16)} is not supported`);
                pos = h.dataEnd;
            }
        }
        demuxAssert(tracks.size > 0, 'no decodable tracks');
        const result = { videoTracks: [], audioTracks: [] };
        for (const t of tracks.values()) {
            if (t.type !== 2 || !t.positiveDiscardSeen)
                continue;
            demuxAssert(t.positiveDiscardBlockIndex === t.audioBlockCount - 1, `audio track ${t.number} has positive DiscardPadding before its final BlockGroup`);
        }
        if (!this.materialize)
            return result;
        for (const t of tracks.values()) {
            if (t.uid !== undefined && this.inputUidCounts.get(t.uid) !== 1) {
                t.uid = undefined;
                this.metadataDropped = true;
                this.warnMetadataLoss('Ambiguous duplicate Matroska TrackUID was omitted');
            }
            demuxAssert(t.samples.length > 0, `Matroska '${t.codec}' track declares no blocks`);
            if (t.type === 1)
                this.reconstructVideoDts(t);
            this.fillDurations(t);
            const info = {
                id: t.number,
                matroskaTrackUid: t.uid,
                language: t.languageIetf ?? t.language ?? 'eng',
                colour: t.colour,
                default: t.default,
                forced: t.forced,
                name: t.name,
                commentary: t.commentary,
                alphaMode: t.alphaMode,
                codec: t.codec,
                codecConfig: t.codecConfig,
                timescale: 1000,
                timestampResolutionSeconds: (timestampScaleNs * t.timestampScale) / 1e9,
                duration: t.samples.length > 0
                    ? t.samples[t.samples.length - 1].timestamp + t.samples[t.samples.length - 1].duration
                    : 0,
                width: t.width,
                height: t.height,
                displayWidth: t.displayWidth,
                displayHeight: t.displayHeight,
                pixelAspectRatioNum: t.pixelAspectRatioNum,
                pixelAspectRatioDen: t.pixelAspectRatioDen,
                sampleRate: t.sampleRate,
                channelCount: t.channelCount,
                samples: t.samples,
                ...(t.codec === 'opus' && t.trailingDiscardPadNs > 0
                    ? { opusTrailingPaddingSamples: Math.round((t.trailingDiscardPadNs * 48000) / 1e9) }
                    : {}),
                ...(t.type === 2 && t.codec !== 'opus' && t.trailingDiscardPadNs > 0 && t.sampleRate > 0
                    ? {
                        audioTrailingPaddingSamples: Math.round((t.trailingDiscardPadNs * t.sampleRate) / 1e9),
                    }
                    : {}),
                ...(t.type === 2 && t.codecDelayNs > 0 ? { matroskaCodecDelaySeconds: t.codecDelayNs / 1e9 } : {}),
                ...(t.type === 2 && t.leadingDiscardPadNs > 0
                    ? {
                        editMediaTimeSeconds: t.leadingDiscardPadNs / 1e9,
                    }
                    : {}),
            };
            if (t.type === 1)
                result.videoTracks.push(info);
            else if (t.type === 2)
                result.audioTracks.push(info);
            else {
                result.subtitleTracks ??= [];
                result.subtitleTracks.push(info);
            }
        }
        const tags = matroskaTagsElement(parsedTags);
        const trackTitles = readMatroskaTrackTitles(tags);
        for (const track of [...result.videoTracks, ...result.audioTracks, ...(result.subtitleTracks ?? [])]) {
            if (track.matroskaTrackUid !== undefined)
                track.title = trackTitles.get(track.matroskaTrackUid);
        }
        if (chaptersRaw || attachmentsRaw || title !== undefined || tags) {
            result.matroskaPassThrough = {
                ...(chaptersRaw ? { chapters: chaptersRaw } : {}),
                ...(attachmentsRaw ? { attachments: attachmentsRaw } : {}),
                ...(title !== undefined ? { title } : {}),
                ...(tags ? { tags } : {}),
            };
        }
        if (unsupportedTags || this.metadataDropped)
            result.matroskaUnsupportedTags = true;
        if (this.signal?.aborted)
            throw new MediaForgeError('Aborted', 'ABORT');
        return result;
    }
    optionalMetadataError(error) {
        if (!(error instanceof DemuxError))
            throw error;
        this.metadataDropped = true;
        this.warnMetadataLoss(`Optional Matroska metadata was omitted: ${error.message}`);
    }
    warnMetadataLoss(message) {
        if (this.metadataWarned || !this.diagnostics)
            return;
        this.metadataWarned = true;
        try {
            this.diagnostics.metadata({ code: 'MATROSKA_METADATA_LOSS', message });
        }
        catch (error) {
            this.externalFailure = { error };
            throw error;
        }
        if (this.signal?.aborted)
            throw new MediaForgeError('Aborted', 'ABORT');
    }
    parseTracks(buf, tracks) {
        for (const te of elements(buf, 0, buf.length)) {
            if (te.id !== ID.TrackEntry)
                continue;
            const t = {
                number: 0,
                type: 0,
                codec: '',
                defaultDurationNs: 0,
                default: true,
                forced: false,
                width: 0,
                height: 0,
                sampleRate: 0,
                channelCount: 0,
                samples: [],
                leadingDiscardPadNs: 0,
                trailingDiscardPadNs: 0,
                codecDelayNs: 0,
                timestampScale: 1,
                audioBlockCount: 0,
                negativeDiscardSeen: false,
                positiveDiscardSeen: false,
                positiveDiscardBlockIndex: -1,
            };
            let codecIdRaw = '';
            let bitsPerSample = 0;
            let uidSeen = false;
            let invalidUid = false;
            for (const f of elements(buf, te.dataStart, te.dataEnd)) {
                if (f.id === ID.TrackNumber)
                    t.number = uintOf(buf, f);
                else if (f.id === ID.TrackType)
                    t.type = uintOf(buf, f);
                else if (f.id === ID.TrackUID ||
                    f.id === ID.FlagDefault ||
                    f.id === ID.FlagForced ||
                    f.id === ID.FlagCommentary ||
                    f.id === ID.Name ||
                    f.id === ID.Language ||
                    f.id === ID.LanguageIETF) {
                    try {
                        if (f.id === ID.TrackUID) {
                            const uid = matroskaUid(buf, f.dataStart, f.dataEnd);
                            if (uid > 0n)
                                this.inputUidCounts.set(uid, (this.inputUidCounts.get(uid) ?? 0) + 1);
                            demuxAssert(uid > 0n && !uidSeen, 'Matroska TrackUID must be unique and positive');
                            uidSeen = true;
                            t.uid = uid;
                        }
                        else if (f.id === ID.FlagDefault || f.id === ID.FlagForced || f.id === ID.FlagCommentary) {
                            const flag = uintOf(buf, f, f.id === ID.FlagDefault ? 1 : 0);
                            demuxAssert(flag === 0 || flag === 1, 'Matroska track disposition must be 0 or 1');
                            if (f.id === ID.FlagDefault)
                                t.default = flag === 1;
                            else if (f.id === ID.FlagForced)
                                t.forced = flag === 1;
                            else
                                t.commentary = flag === 1;
                        }
                        else if (f.id === ID.Name)
                            t.name = utf8Of(buf, f);
                        else {
                            demuxAssert(f.dataEnd > f.dataStart && f.dataEnd - f.dataStart <= 255, 'Matroska track language must contain 1..255 ASCII bytes');
                            const language = String.fromCharCode(...buf.subarray(f.dataStart, f.dataEnd));
                            demuxAssert(/^(?:[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*|[iIxX](?:-[A-Za-z0-9]{1,8})+)$/.test(language), 'Matroska track language contains an invalid character');
                            if (f.id === ID.LanguageIETF)
                                t.languageIetf = language;
                            else
                                t.language = language;
                        }
                    }
                    catch (error) {
                        if (f.id === ID.TrackUID)
                            invalidUid = true;
                        this.optionalMetadataError(error);
                    }
                }
                else if (f.id === ID.CodecID)
                    codecIdRaw = asciiOf(buf, f);
                else if (f.id === ID.CodecPrivate)
                    t.codecConfig = buf.slice(f.dataStart, f.dataEnd);
                else if (f.id === ID.CodecDelay)
                    t.codecDelayNs = uintOf(buf, f);
                else if (f.id === ID.TrackTimestampScale) {
                    t.timestampScale = floatOf(buf, f, 1);
                }
                else if (f.id === ID.DefaultDuration)
                    t.defaultDurationNs = uintOf(buf, f);
                else if (f.id === ID.Video) {
                    let displayWidth;
                    let displayHeight;
                    let displayUnit = 0;
                    for (const v of elements(buf, f.dataStart, f.dataEnd)) {
                        if (v.id === ID.PixelWidth)
                            t.width = uintOf(buf, v);
                        else if (v.id === ID.PixelHeight)
                            t.height = uintOf(buf, v);
                        else if (v.id === ID.DisplayWidth)
                            displayWidth = uintOf(buf, v);
                        else if (v.id === ID.DisplayHeight)
                            displayHeight = uintOf(buf, v);
                        else if (v.id === ID.DisplayUnit)
                            displayUnit = uintOf(buf, v);
                        else if (v.id === ID.Colour)
                            t.colour = colourOf(buf, v);
                        else if (v.id === ID.AlphaMode) {
                            const mode = uintOf(buf, v);
                            if (mode !== 0 && mode !== 1)
                                throw new MediaForgeError('Unsupported Matroska AlphaMode', 'FORMAT');
                            t.alphaMode = mode === 1;
                        }
                    }
                    setDisplayGeometry(t, displayWidth, displayHeight, displayUnit);
                }
                else if (f.id === ID.Audio) {
                    t.sampleRate = 8000;
                    t.channelCount = 1;
                    for (const a of elements(buf, f.dataStart, f.dataEnd)) {
                        if (a.id === ID.SamplingFrequency) {
                            t.sampleRate = Math.round(floatOf(buf, a, 8000));
                            demuxAssert(Number.isSafeInteger(t.sampleRate) && t.sampleRate > 0, `track ${t.number || '?'} has invalid SamplingFrequency`);
                        }
                        else if (a.id === ID.Channels) {
                            t.channelCount = uintOf(buf, a, 1);
                            demuxAssert(t.channelCount > 0, `track ${t.number || '?'} has invalid Channels`);
                        }
                        else if (a.id === ID.BitDepth)
                            bitsPerSample = uintOf(buf, a);
                    }
                }
            }
            if (invalidUid)
                t.uid = undefined;
            if (t.number <= 0)
                continue;
            demuxAssert(Number.isFinite(t.timestampScale) && t.timestampScale > 0, `track ${t.number} has invalid TrackTimestampScale`);
            if (t.type === 1 || t.type === 2) {
                if (codecIdRaw === 'V_PRORES') {
                    demuxAssert(t.type === 1, 'Matroska ProRes requires a video track');
                    const codec = readProResFourCC(t.codecConfig);
                    demuxAssert(codec, 'Matroska ProRes CodecPrivate must contain a supported four-byte FourCC');
                    t.codec = codec;
                    t.codecConfig = undefined;
                }
                else
                    t.codec = matroskaPcmCodec(codecIdRaw, bitsPerSample) ?? CODEC_MAP[codecIdRaw] ?? '';
                if (!t.codec)
                    throw new DemuxError(`Unsupported Matroska codec '${codecIdRaw}'`);
                if (t.type === 1)
                    t.codec = videoCodecFromPrivate(codecIdRaw, t.codecConfig) ?? t.codec;
                if (t.codec.startsWith('pcm-')) {
                    demuxAssert(t.type === 2 && !t.codecConfig?.length, 'Matroska PCM requires an audio track without CodecPrivate');
                    t.codecConfig = undefined;
                    t.pcm = describePcmTrack(t);
                }
                if (codecIdRaw === 'A_AAC' && t.codecConfig) {
                    const asc = parseAacAudioSpecificConfig(t.codecConfig);
                    if (asc) {
                        t.codec = `mp4a.40.${asc.audioObjectType}`;
                        if (asc.sampleRate > 0)
                            t.sampleRate = asc.sampleRate;
                        if (asc.channelCount > 0)
                            t.channelCount = asc.channelCount;
                    }
                }
            }
            else if (t.type === 17) {
                const sub = SUBTITLE_CODEC_MAP[codecIdRaw];
                if (!sub)
                    continue;
                t.codec = sub;
            }
            else {
                continue;
            }
            if (t.alphaMode && (t.type !== 1 || (t.codec !== 'vp8' && !t.codec.startsWith('vp09')))) {
                throw new MediaForgeError('Matroska alpha is only supported for VP8/VP9 video', 'FORMAT');
            }
            demuxAssert(tracks.size < DEMUX_LIMITS.maxTracks, 'track count exceeds limit');
            tracks.set(t.number, t);
        }
    }
    async parseClusterAt(h, parentEnd, tracks, tsScaleNs) {
        let clusterTs = 0;
        let p = h.dataStart;
        const clusterEnd = h.unknown ? parentEnd : h.dataEnd;
        let childCount = 0;
        let pageStart = p;
        let page = new Uint8Array(0);
        while (p < clusterEnd) {
            demuxAssert(++childCount <= DEMUX_LIMITS.maxTableEntries, 'EBML element count exceeds limit');
            if ((childCount & 0x0fff) === 0)
                await Promise.resolve();
            if (this.signal?.aborted)
                throw new MediaForgeError('Aborted', 'ABORT');
            if (p >= pageStart + page.length) {
                pageStart = p;
                page = await this.reader.bytes(p, Math.min(clusterEnd - p, CHUNK_BYTES - (p % CHUNK_BYTES)));
            }
            let c;
            if (p - pageStart + Math.min(HEADER_PEEK, clusterEnd - p) <= page.length) {
                c = readHeaderLocal(page, p - pageStart, clusterEnd - pageStart);
                c.dataStart += pageStart;
                c.dataEnd += pageStart;
            }
            else
                c = await this.headerAt(p, clusterEnd);
            if (!CLUSTER_CHILD_IDS.has(c.id)) {
                demuxAssert(h.unknown, `EBML element 0x${c.id.toString(16)} inside a sized cluster`);
                return p;
            }
            demuxAssert(!c.unknown, 'unknown-size cluster child is not supported');
            if (c.id !== ID.ClusterTimestamp && c.id !== ID.SimpleBlock && c.id !== ID.BlockGroup) {
                p = c.dataEnd;
                continue;
            }
            const size = c.dataEnd - c.dataStart;
            const buf = c.dataEnd <= pageStart + page.length
                ? page.subarray(c.dataStart - pageStart, c.dataEnd - pageStart)
                : await this.reader.bytes(c.dataStart, size);
            if (c.id === ID.ClusterTimestamp) {
                clusterTs = uintOf(buf, { id: c.id, dataStart: 0, dataEnd: buf.length });
            }
            else if (c.id === ID.SimpleBlock) {
                this.parseBlock(buf, { id: c.id, dataStart: 0, dataEnd: buf.length }, c.dataStart, tracks, clusterTs, tsScaleNs, null, 0, 0);
            }
            else if (c.id === ID.BlockGroup) {
                let block = null;
                let hasReference = false;
                let discardPadNs = 0;
                let discardPaddingElements = 0;
                let blockDurationTicks = 0;
                let alpha;
                let sawAdditions = false;
                for (const g of elements(buf, 0, buf.length)) {
                    if (g.id === ID.Block)
                        block = g;
                    else if (g.id === ID.ReferenceBlock)
                        hasReference = true;
                    else if (g.id === ID.BlockDuration)
                        blockDurationTicks = uintOf(buf, g);
                    else if (g.id === ID.BlockAdditions) {
                        demuxAssert(!sawAdditions, 'BlockGroup contains multiple BlockAdditions elements');
                        sawAdditions = true;
                        for (const more of elements(buf, g.dataStart, g.dataEnd)) {
                            if (more.id !== ID.BlockMore || alpha) {
                                throw new MediaForgeError('Unsupported Matroska BlockAdditions', 'FORMAT');
                            }
                            let addId = 1;
                            let payload;
                            let sawId = false;
                            for (const field of elements(buf, more.dataStart, more.dataEnd)) {
                                if (field.id === ID.BlockAddID) {
                                    demuxAssert(!sawId, 'Duplicate BlockAddID');
                                    sawId = true;
                                    addId = uintOf(buf, field, 1);
                                }
                                else if (field.id === ID.BlockAdditional) {
                                    demuxAssert(!payload, 'Duplicate BlockAdditional');
                                    payload = field;
                                }
                                else
                                    throw new MediaForgeError('Unsupported Matroska BlockAdditions side data', 'FORMAT');
                            }
                            if (addId !== 1)
                                throw new MediaForgeError('Unsupported Matroska BlockAdditional side data', 'FORMAT');
                            demuxAssert(!!payload && payload.dataEnd > payload.dataStart, 'Empty Matroska BlockAdditional');
                            alpha = payload;
                        }
                        demuxAssert(!!alpha, 'Empty Matroska BlockAdditions');
                    }
                    else if (g.id === ID.DiscardPadding) {
                        demuxAssert(++discardPaddingElements === 1, 'BlockGroup contains multiple DiscardPadding elements');
                        const byteLength = g.dataEnd - g.dataStart;
                        demuxAssert(byteLength > 0 && byteLength <= 8, 'DiscardPadding integer has an invalid byte length');
                        let value = 0n;
                        for (let i = g.dataStart; i < g.dataEnd; i++) {
                            value = value * 256n + BigInt(buf[i]);
                        }
                        const bits = BigInt(byteLength * 8);
                        if (value >= 1n << (bits - 1n))
                            value -= 1n << bits;
                        demuxAssert(value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER), 'DiscardPadding integer exceeds the safe range');
                        discardPadNs = Number(value);
                    }
                }
                demuxAssert(discardPaddingElements === 0 || !!block, 'BlockGroup has DiscardPadding without a Block');
                demuxAssert(!sawAdditions || !!block, 'BlockAdditions without a Block');
                if (block) {
                    this.parseBlock(buf, block, c.dataStart, tracks, clusterTs, tsScaleNs, !hasReference, discardPadNs, blockDurationTicks, alpha);
                }
            }
            p = c.dataEnd;
        }
        return clusterEnd;
    }
    parseBlock(buf, el, absBase, tracks, clusterTs, tsScaleNs, groupKey, discardPadNs, blockDurationTicks, alpha) {
        let pos = el.dataStart;
        const tn = readVint(buf, pos, 'unsigned');
        pos += tn.length;
        const track = tracks.get(tn.value);
        demuxAssert(pos + 3 <= el.dataEnd, 'Matroska block header truncated');
        const rel = new DataView(buf.buffer, buf.byteOffset + pos).getInt16(0, false);
        const flags = buf[pos + 2];
        pos += 3;
        if (!track)
            return;
        const isKey = groupKey ?? ((flags & 0x80) !== 0 || track.type !== 1);
        const lacing = (flags >> 1) & 0x03;
        if (alpha && (track.type !== 1 || track.alphaMode !== true || lacing !== 0)) {
            throw new MediaForgeError('Unsupported Matroska BlockAdditional: only non-laced VP8/VP9 alpha is supported', 'FORMAT');
        }
        const codedTsSeconds = ((clusterTs + rel * track.timestampScale) * tsScaleNs) / 1e9;
        demuxAssert(Number.isFinite(codedTsSeconds), `track ${track.number} timestamp exceeds the finite range`);
        const tsSeconds = codedTsSeconds - track.codecDelayNs / 1e9;
        const frames = [];
        if (lacing === 0) {
            frames.push({ offset: pos, size: el.dataEnd - pos });
        }
        else {
            demuxAssert(pos < el.dataEnd, 'laced block truncated');
            const count = buf[pos] + 1;
            pos += 1;
            const sizes = [];
            if (lacing === 2) {
                const total = el.dataEnd - pos;
                demuxAssert(total % count === 0, 'fixed lacing size mismatch');
                for (let i = 0; i < count; i++)
                    sizes.push(total / count);
            }
            else if (lacing === 1) {
                let total = 0;
                for (let i = 0; i < count - 1; i++) {
                    let size = 0;
                    for (;;) {
                        demuxAssert(pos < el.dataEnd, 'Xiph lacing truncated');
                        const b = buf[pos];
                        pos += 1;
                        size += b;
                        if (b !== 255)
                            break;
                    }
                    sizes.push(size);
                    total += size;
                }
                sizes.push(el.dataEnd - pos - total);
            }
            else {
                const first = readVint(buf, pos, 'unsigned');
                pos += first.length;
                sizes.push(first.value);
                let prev = first.value;
                let total = first.value;
                for (let i = 1; i < count - 1; i++) {
                    const d = readVint(buf, pos, 'signed');
                    pos += d.length;
                    prev += d.value;
                    demuxAssert(Number.isSafeInteger(prev) && prev >= 0, 'EBML lacing invalid size');
                    sizes.push(prev);
                    total += prev;
                }
                sizes.push(el.dataEnd - pos - total);
            }
            for (const size of sizes) {
                demuxAssert(size >= 0 && pos + size <= el.dataEnd, 'laced frame exceeds block');
                frames.push({ offset: pos, size });
                pos += size;
            }
        }
        if (track.type === 2) {
            const blockIndex = track.audioBlockCount++;
            if (discardPadNs > 0) {
                demuxAssert(groupKey !== null, `audio track ${track.number} has DiscardPadding outside a BlockGroup`);
                demuxAssert(!track.positiveDiscardSeen, `audio track ${track.number} has more than one positive DiscardPadding`);
                track.positiveDiscardSeen = true;
                track.positiveDiscardBlockIndex = blockIndex;
                track.trailingDiscardPadNs = discardPadNs;
            }
            else if (discardPadNs < 0) {
                demuxAssert(groupKey !== null, `audio track ${track.number} has DiscardPadding outside a BlockGroup`);
                demuxAssert(!track.negativeDiscardSeen, `audio track ${track.number} has more than one negative DiscardPadding`);
                demuxAssert(blockIndex === 0, `audio track ${track.number} has negative DiscardPadding after its first BlockGroup`);
                track.negativeDiscardSeen = true;
                track.leadingDiscardPadNs = -discardPadNs;
            }
        }
        const blockDurationNs = blockDurationTicks > 0
            ? blockDurationTicks * track.timestampScale * tsScaleNs
            : track.defaultDurationNs > 0
                ? track.defaultDurationNs * frames.length
                : 0;
        demuxAssert(Number.isFinite(blockDurationNs), `track ${track.number} BlockDuration exceeds the finite range`);
        if (discardPadNs !== 0 && blockDurationNs > 0) {
            demuxAssert(Math.abs(discardPadNs) <= blockDurationNs + 1, `audio track ${track.number} DiscardPadding exceeds its Block duration`);
        }
        const frameDur = blockDurationTicks > 0
            ? blockDurationNs / frames.length / 1e9
            : track.defaultDurationNs > 0
                ? track.defaultDurationNs / 1e9
                : 0;
        const inferredDurations = frameDur > 0 && !track.pcm
            ? []
            : frames.map(frame => this.encodedAudioFrameDuration(track, buf.subarray(frame.offset, frame.offset + frame.size)));
        this.indexBudget.reserveSamples(frames.length, 256, 'Matroska sample index');
        if (this.materialize && this.totalSamples + frames.length > this.sampleBudget) {
            throw new SoftLimitExceeded();
        }
        let elapsed = 0;
        for (let i = 0; i < frames.length; i++) {
            const f = frames[i];
            let proResHeaderless = false;
            if (isProResCodec(track.codec)) {
                const packet = buf.subarray(f.offset, f.offset + f.size);
                proResHeaderless = true;
                let error = proResFrameError(packet, track, true);
                if (error && hasProResFrameHeader(packet)) {
                    proResHeaderless = false;
                    error = proResFrameError(packet, track);
                }
                if (error)
                    throw new DemuxError(error);
            }
            this.totalSamples++;
            if ((this.totalSamples & 0x0fff) === 0 && this.signal?.aborted) {
                throw new MediaForgeError('Aborted', 'ABORT');
            }
            if (!this.materialize)
                continue;
            const duration = track.pcm ? inferredDurations[i] : frameDur || inferredDurations[i] || 0;
            const ts = tsSeconds + elapsed;
            track.samples.push({
                ...(proResHeaderless ? { proResHeaderless: true } : {}),
                ...(alpha
                    ? { alphaOffset: absBase + alpha.dataStart, alphaSize: alpha.dataEnd - alpha.dataStart }
                    : {}),
                offset: absBase + f.offset,
                size: f.size,
                timestamp: ts,
                decodeTimestamp: ts,
                compositionTimeOffset: 0,
                duration,
                isKeyframe: isProResCodec(track.codec) || (i === 0 ? isKey : track.type !== 1),
            });
            elapsed += duration;
        }
    }
    encodedAudioFrameDuration(track, packet) {
        if (track.pcm) {
            demuxAssert(packet.length > 0 && packet.length % track.pcm.blockAlign === 0, 'Matroska PCM blocks must contain complete channel frames');
            return packet.length / track.pcm.blockAlign / track.pcm.sampleRate;
        }
        if (track.type !== 2 || packet.length === 0)
            return 0;
        if (track.codec === 'mp1' || track.codec === 'mp2' || track.codec === 'mp3') {
            const header = parseMpegAudioHeader(packet, 0);
            return header?.format === track.codec && header.frameLength === packet.length
                ? header.samplesPerFrame / header.sampleRate
                : 0;
        }
        if (track.codec.startsWith('mp4a')) {
            const config = track.codecConfig ? parseAacAudioSpecificConfig(track.codecConfig) : null;
            return config && config.sampleRate > 0 ? config.samplesPerAccessUnit / config.sampleRate : 0;
        }
        if (track.codec === 'opus') {
            try {
                return opusPacketFrames(packet, packet.length) / 48000;
            }
            catch {
                throw new DemuxError('Malformed Matroska Opus packet duration');
            }
        }
        if (track.codec === 'ac-3')
            return track.sampleRate > 0 ? 1536 / track.sampleRate : 0;
        if (track.codec === 'flac') {
            const header = parseFlacFrameHeader(packet, 0);
            const rate = header?.sampleRate ?? track.sampleRate;
            return header && rate > 0 ? header.blockSize / rate : 0;
        }
        return 0;
    }
    reconstructVideoDts(t) {
        const n = t.samples.length;
        let reordered = false;
        for (let i = 1; i < n; i++) {
            if (t.samples[i].timestamp < t.samples[i - 1].timestamp) {
                reordered = true;
                break;
            }
        }
        if (!reordered)
            return;
        const sorted = new Float64Array(n);
        for (let i = 0; i < n; i++)
            sorted[i] = t.samples[i].timestamp;
        sorted.sort();
        let maxShift = 0;
        for (let i = 0; i < n; i++) {
            maxShift = Math.max(maxShift, sorted[i] - t.samples[i].timestamp);
        }
        for (let i = 0; i < n; i++) {
            const dts = sorted[i] - maxShift;
            const smp = t.samples[i];
            smp.decodeTimestamp = dts;
            smp.compositionTimeOffset = smp.timestamp - dts;
        }
        for (let i = 0; i < n; i++) {
            const cur = t.samples[i];
            const next = t.samples[i + 1];
            if (next)
                cur.duration = Math.max(1 / 1e6, next.decodeTimestamp - cur.decodeTimestamp);
        }
    }
    fillDurations(t) {
        for (let i = 0; i < t.samples.length;) {
            const cur = t.samples[i];
            if (cur.duration > 0) {
                i++;
                continue;
            }
            let end = i + 1;
            while (end < t.samples.length &&
                t.samples[end].duration <= 0 &&
                t.samples[end].timestamp === cur.timestamp)
                end++;
            const next = t.samples[end];
            const count = end - i;
            let duration = next && next.timestamp > cur.timestamp ? (next.timestamp - cur.timestamp) / count : 0;
            if (!(duration > 0)) {
                const previous = t.samples[i - 1];
                const following = next?.duration;
                duration =
                    previous && previous.duration > 0
                        ? previous.duration
                        : following && following > 0
                            ? following
                            : 1 / 1000;
            }
            for (let index = i; index < end; index++) {
                const sample = t.samples[index];
                sample.timestamp = cur.timestamp + (index - i) * duration;
                sample.decodeTimestamp = sample.timestamp;
                sample.duration = duration;
            }
            i = end;
        }
    }
}
