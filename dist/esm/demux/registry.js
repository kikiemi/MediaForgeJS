import { DemuxError, MediaForgeError } from '../core/errors.js';
import { awaitWithAbort } from '../core/abort.js';
import { probeTsLayout } from './ts-layout.js';
import { yieldEventLoop } from '../core/demux-guard.js';
const MIME = {
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    webm: 'video/webm',
    mkv: 'video/x-matroska',
    avi: 'video/x-msvideo',
    flv: 'video/x-flv',
    ogg: 'audio/ogg',
    '3gp': 'video/3gpp',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    aiff: 'audio/aiff',
    au: 'audio/basic',
    caf: 'audio/x-caf',
    gif: 'image/gif',
    apng: 'image/apng',
    png: 'image/png',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    bmp: 'image/bmp',
    tiff: 'image/tiff',
    ico: 'image/x-icon',
    flac: 'audio/flac',
    aac: 'audio/aac',
    ts: 'video/mp2t',
    mp2: 'audio/mp2',
    mp1: 'audio/mpeg',
    m4a: 'audio/mp4',
    m4v: 'video/x-m4v',
};
export class DemuxerRegistry {
    static detect(h) {
        if (h.length >= 8 && h[0] === 0x63 && h[1] === 0x61 && h[2] === 0x66 && h[3] === 0x66)
            return 'caf';
        if (h.length >= 12 &&
            h[0] === 0x46 &&
            h[1] === 0x4f &&
            h[2] === 0x52 &&
            h[3] === 0x4d &&
            h[8] === 0x41 &&
            h[9] === 0x49 &&
            h[10] === 0x46 &&
            (h[11] === 0x46 || h[11] === 0x43))
            return 'aiff';
        if (h.length >= 4 && h[0] === 0x2e && h[1] === 0x73 && h[2] === 0x6e && h[3] === 0x64)
            return 'au';
        if (h.length >= 12 && h[0] === 0x52 && h[1] === 0x49 && h[2] === 0x46 && h[3] === 0x46) {
            const sub = String.fromCharCode(h[8], h[9], h[10], h[11]);
            if (sub === 'WAVE')
                return 'wav';
            if (sub === 'WEBP')
                return 'webp';
            if (sub === 'AVI ')
                return 'avi';
        }
        if (h.length >= 12 &&
            String.fromCharCode(h[0], h[1], h[2], h[3]) === 'RF64' &&
            String.fromCharCode(h[8], h[9], h[10], h[11]) === 'WAVE')
            return 'wav';
        if (h.length >= 4 && h[0] === 0x1a && h[1] === 0x45 && h[2] === 0xdf && h[3] === 0xa3) {
            const str = new TextDecoder().decode(h.subarray(0, Math.min(64, h.length)));
            return str.includes('matroska') ? 'mkv' : 'webm';
        }
        if (h.length >= 12 && h[4] === 0x66 && h[5] === 0x74 && h[6] === 0x79 && h[7] === 0x70) {
            const brand = String.fromCharCode(h[8], h[9], h[10], h[11]);
            if (brand.startsWith('qt'))
                return 'mov';
            if (brand.startsWith('3gp') || brand.startsWith('3g2'))
                return '3gp';
            if (brand === 'M4A ' || brand === 'M4B ')
                return 'm4a';
            return 'mp4';
        }
        if (h.length >= 4 && h[0] === 0x46 && h[1] === 0x4c && h[2] === 0x56)
            return 'flv';
        if (h.length >= 4 && h[0] === 0x4f && h[1] === 0x67 && h[2] === 0x67 && h[3] === 0x53)
            return 'ogg';
        const mpegAudio = sniffMpegAudioFormat(h);
        if (mpegAudio)
            return mpegAudio;
        if (h.length >= 2 && h[0] === 0xff && (h[1] & 0xf6) === 0xf0)
            return 'aac';
        if (h.length >= 4 && h[0] === 0x66 && h[1] === 0x4c && h[2] === 0x61 && h[3] === 0x43)
            return 'flac';
        if (h.length >= 4 && h[0] === 0x89 && h[1] === 0x50 && h[2] === 0x4e && h[3] === 0x47) {
            for (let i = 8; i + 8 < h.length;) {
                const len = ((h[i] << 24) | (h[i + 1] << 16) | (h[i + 2] << 8) | h[i + 3]) >>> 0;
                const type = String.fromCharCode(h[i + 4], h[i + 5], h[i + 6], h[i + 7]);
                if (type === 'acTL')
                    return 'apng';
                if (type === 'IDAT')
                    break;
                if (len > h.length)
                    break;
                i += 12 + len;
            }
            return 'png';
        }
        if (h.length >= 3 && h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff)
            return 'jpeg';
        if (h.length >= 4 && h[0] === 0x47 && h[1] === 0x49 && h[2] === 0x46 && h[3] === 0x38)
            return 'gif';
        if (h.length >= 2 && h[0] === 0x42 && h[1] === 0x4d)
            return 'bmp';
        if (h.length >= 4 && h[0] === 0x49 && h[1] === 0x49 && h[2] === 0x2a && h[3] === 0x00)
            return 'tiff';
        if (h.length >= 4 && h[0] === 0x4d && h[1] === 0x4d && h[2] === 0x00 && h[3] === 0x2a)
            return 'tiff';
        if (h.length >= 4 && h[0] === 0x00 && h[1] === 0x00 && h[2] === 0x01 && h[3] === 0x00)
            return 'ico';
        if (probeTsLayout(h))
            return 'ts';
        throw new DemuxError('Unable to detect file format');
    }
    static async detectFromFile(file, signal) {
        const format = await DemuxerRegistry.detectFromSource({
            size: file.size,
            read: async (offset, length) => new Uint8Array(await file.slice(offset, offset + length).arrayBuffer()),
        }, signal);
        if (signal?.aborted)
            throw new MediaForgeError('Aborted', 'ABORT');
        return format;
    }
    static async detectFromSource(source, signal) {
        if (!source || typeof source.read !== 'function' || !Number.isSafeInteger(source.size) || source.size < 0) {
            throw new DemuxError('source must provide read() and a non-negative safe integer size');
        }
        const reader = new SniffWindowReader(source, signal);
        let offset = 0;
        for (let tags = 0; tags < 16; tags++) {
            const header = await reader.read(offset, 10);
            reader.checkAbort();
            if (!isId3v2Header(header))
                break;
            const span = id3v2Span(header);
            if (offset + span > reader.size)
                throw new DemuxError('Truncated ID3v2 tag');
            offset += span;
        }
        const h = await reader.read(offset, SNIFF_PREFIX_BYTES);
        reader.checkAbort();
        let fmt = null;
        try {
            fmt = DemuxerRegistry.detect(h);
        }
        catch (e) {
            reader.useDeepWindow();
            const deep = await sniffMp4FamilyDeep(reader, offset);
            reader.checkAbort();
            if (deep)
                return deep;
            throw e;
        }
        if (fmt === 'png') {
            reader.useDeepWindow();
            const imageFormat = await sniffApngDeep(reader, offset);
            reader.checkAbort();
            return imageFormat;
        }
        return fmt;
    }
    static getMimeType(fmt) {
        return MIME[fmt] ?? 'application/octet-stream';
    }
}
function sniffMpegAudioFormat(h) {
    let off = 0;
    if (h.length >= 10 && h[0] === 0x49 && h[1] === 0x44 && h[2] === 0x33) {
        const size = ((h[6] & 0x7f) << 21) | ((h[7] & 0x7f) << 14) | ((h[8] & 0x7f) << 7) | (h[9] & 0x7f);
        const after = 10 + size + (h[5] & 0x10 ? 10 : 0);
        if (after + 4 > h.length)
            return null;
        off = after;
    }
    if (off + 2 > h.length)
        return null;
    if (off + 3 >= h.length)
        return null;
    if (h[off] !== 0xff || (h[off + 1] & 0xe0) !== 0xe0)
        return null;
    const versionBits = (h[off + 1] >> 3) & 3;
    if (versionBits === 1)
        return null;
    const layerBits = (h[off + 1] >> 1) & 3;
    const bitrateIndex = (h[off + 2] >> 4) & 0x0f;
    const sampleRateIndex = (h[off + 2] >> 2) & 0x03;
    if (bitrateIndex === 0 || bitrateIndex === 0x0f || sampleRateIndex === 0x03)
        return null;
    if (layerBits === 1)
        return 'mp3';
    if (layerBits === 2)
        return 'mp2';
    if (layerBits === 3)
        return 'mp1';
    return null;
}
const MP4_TOP_BOXES = new Set(['free', 'skip', 'wide', 'pdin', 'uuid', 'prft', 'emsg', 'sidx', 'ssix']);
const MP4_DECISIVE = new Set(['moov', 'moof', 'mdat', 'styp']);
const SNIFF_PREFIX_BYTES = 8192;
const SNIFF_WINDOW_BYTES = 1 << 20;
const MAX_MP4_SNIFF_BOXES = 65_536;
const MAX_PNG_SNIFF_CHUNKS = 1_000_000;
class SniffWindowReader {
    source;
    signal;
    start = -1;
    bytes = new Uint8Array(0);
    windowBytes = SNIFF_PREFIX_BYTES;
    size;
    constructor(source, signal) {
        this.source = source;
        this.signal = signal;
        this.size = source.size;
    }
    useDeepWindow() {
        this.windowBytes = SNIFF_WINDOW_BYTES;
    }
    checkAbort() {
        if (this.signal?.aborted)
            throw new MediaForgeError('Aborted', 'ABORT');
    }
    async read(offset, length) {
        this.checkAbort();
        const want = Math.min(length, this.size - offset);
        if (want <= 0)
            return new Uint8Array(0);
        if (offset >= this.start && offset + want <= this.start + this.bytes.length) {
            const relative = offset - this.start;
            return this.bytes.subarray(relative, relative + want);
        }
        const readLength = Math.min(this.size - offset, Math.max(want, this.windowBytes));
        const bytes = await awaitWithAbort(this.source.read(offset, readLength), this.signal);
        this.checkAbort();
        if (bytes.byteLength !== readLength) {
            throw new DemuxError(`short read at ${offset}: expected ${readLength}, got ${bytes.byteLength}`);
        }
        this.bytes = bytes;
        this.start = offset;
        return this.bytes.subarray(0, want);
    }
}
async function sniffMp4FamilyDeep(reader, start) {
    let pos = start;
    for (let boxes = 0; boxes < MAX_MP4_SNIFF_BOXES && pos + 8 <= reader.size; boxes++) {
        if ((boxes & 255) === 0) {
            reader.checkAbort();
            await yieldEventLoop();
        }
        const head = await reader.read(pos, 16);
        reader.checkAbort();
        if (head.length < 8)
            return null;
        let size = ((head[0] << 24) | (head[1] << 16) | (head[2] << 8) | head[3]) >>> 0;
        let headerSize = 8;
        const type = String.fromCharCode(head[4], head[5], head[6], head[7]);
        if (!/^[ -~]{4}$/.test(type))
            return null;
        if (size === 1) {
            if (head.length < 16)
                return null;
            headerSize = 16;
            const hi = ((head[8] << 24) | (head[9] << 16) | (head[10] << 8) | head[11]) >>> 0;
            const lo = ((head[12] << 24) | (head[13] << 16) | (head[14] << 8) | head[15]) >>> 0;
            size = hi * 4294967296 + lo;
        }
        if (type === 'ftyp') {
            const brandBytes = await reader.read(pos + headerSize, 4);
            reader.checkAbort();
            if (brandBytes.length < 4)
                return 'mp4';
            const brand = String.fromCharCode(brandBytes[0], brandBytes[1], brandBytes[2], brandBytes[3]);
            if (brand.startsWith('qt'))
                return 'mov';
            if (brand.startsWith('3gp') || brand.startsWith('3g2'))
                return '3gp';
            if (brand === 'M4A ' || brand === 'M4B ')
                return 'm4a';
            return 'mp4';
        }
        if (MP4_DECISIVE.has(type))
            return 'mp4';
        if (!MP4_TOP_BOXES.has(type))
            return null;
        if (size === 0)
            return null;
        if (size < headerSize || !Number.isSafeInteger(size))
            return null;
        pos += size;
    }
    return null;
}
async function sniffApngDeep(reader, start) {
    let pos = start + 8;
    for (let chunks = 0; chunks < MAX_PNG_SNIFF_CHUNKS && pos + 8 <= reader.size; chunks++) {
        if ((chunks & 255) === 0) {
            reader.checkAbort();
            await yieldEventLoop();
        }
        const head = await reader.read(pos, 8);
        reader.checkAbort();
        if (head.length < 8)
            return 'png';
        const len = ((head[0] << 24) | (head[1] << 16) | (head[2] << 8) | head[3]) >>> 0;
        const type = String.fromCharCode(head[4], head[5], head[6], head[7]);
        if (type === 'acTL')
            return 'apng';
        if (type === 'IDAT' || type === 'IEND')
            return 'png';
        if (len > 0x7fffffff || pos + 12 + len > reader.size + 12)
            return 'png';
        pos += 12 + len;
    }
    return 'png';
}
function isId3v2Header(h) {
    return h.length >= 10 && h[0] === 0x49 && h[1] === 0x44 && h[2] === 0x33;
}
function id3v2Span(h) {
    if (!isId3v2Header(h))
        return 0;
    for (let i = 6; i <= 9; i++) {
        if ((h[i] & 0x80) !== 0)
            throw new DemuxError('Invalid ID3v2 syncsafe size');
    }
    const payload = (h[6] << 21) | (h[7] << 14) | (h[8] << 7) | h[9];
    return 10 + payload + (h[5] & 0x10 ? 10 : 0);
}
