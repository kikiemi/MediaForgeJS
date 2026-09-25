import { MediaForgeError } from '../core/errors.js';
import { drainSink } from '../io/sink-backpressure.js';
import { mp4TrackFlags, mp4HandlerName, mp4TitleBox, mp4TrackMetadataBoxes, snapshotMP4TrackMetadata, } from '../core/mp4-metadata.js';
const MAX_U32 = 0xffffffff;
function ascii(value) {
    const bytes = new Uint8Array(value.length);
    for (let index = 0; index < value.length; index++)
        bytes[index] = value.charCodeAt(index);
    return bytes;
}
function box(type, ...payloads) {
    let total = 8;
    for (const payload of payloads)
        total += payload.length;
    if (!Number.isSafeInteger(total) || total > MAX_U32) {
        throw new MediaForgeError(`${type} box exceeds the 32-bit MP4 box limit`, 'MUX');
    }
    const bytes = new Uint8Array(total);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, total, false);
    bytes.set(ascii(type), 4);
    let offset = 8;
    for (const payload of payloads) {
        bytes.set(payload, offset);
        offset += payload.length;
    }
    return bytes;
}
function fullBox(type, version, flags, payload) {
    const prefix = new Uint8Array(4);
    prefix[0] = version;
    prefix[1] = (flags >>> 16) & 0xff;
    prefix[2] = (flags >>> 8) & 0xff;
    prefix[3] = flags & 0xff;
    return box(type, prefix, payload);
}
export class M4ASampleSizeLedger {
    static PAGE_ENTRIES = 4096;
    pages = [];
    entries = 0;
    bytes = 0;
    get length() {
        return this.entries;
    }
    get totalBytes() {
        return this.bytes;
    }
    get storageBytes() {
        return this.pages.length * M4ASampleSizeLedger.PAGE_ENTRIES * 4;
    }
    push(size) {
        if (!Number.isInteger(size) || size < 1 || size > MAX_U32) {
            throw new MediaForgeError(`AAC access-unit size is invalid (${size})`, 'MUX');
        }
        if (this.entries >= MAX_U32) {
            throw new MediaForgeError('M4A sample count exceeds the 32-bit table limit', 'MUX');
        }
        const nextBytes = this.bytes + size;
        if (!Number.isSafeInteger(nextBytes)) {
            throw new MediaForgeError('M4A media byte count exceeds JavaScript exact-integer range', 'MUX');
        }
        const pageIndex = Math.floor(this.entries / M4ASampleSizeLedger.PAGE_ENTRIES);
        const inPage = this.entries % M4ASampleSizeLedger.PAGE_ENTRIES;
        if (!this.pages[pageIndex]) {
            this.pages[pageIndex] = new Uint32Array(M4ASampleSizeLedger.PAGE_ENTRIES);
        }
        this.pages[pageIndex][inPage] = size;
        this.entries++;
        this.bytes = nextBytes;
    }
    at(index) {
        if (!Number.isInteger(index) || index < 0 || index >= this.entries) {
            throw new MediaForgeError(`M4A sample index is out of range (${index})`, 'MUX');
        }
        return this.pages[Math.floor(index / M4ASampleSizeLedger.PAGE_ENTRIES)][index % M4ASampleSizeLedger.PAGE_ENTRIES];
    }
}
function ftyp() {
    const payload = new Uint8Array(20);
    payload.set(ascii('M4A '), 0);
    new DataView(payload.buffer).setUint32(4, 0x200, false);
    payload.set(ascii('M4A '), 8);
    payload.set(ascii('isom'), 12);
    payload.set(ascii('mp42'), 16);
    return box('ftyp', payload);
}
function mdatHeader(mediaBytes) {
    if (!Number.isSafeInteger(mediaBytes) || mediaBytes < 0) {
        throw new MediaForgeError(`M4A media byte count is invalid (${mediaBytes})`, 'MUX');
    }
    const bytes = new Uint8Array(16);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 1, false);
    bytes.set(ascii('mdat'), 4);
    view.setBigUint64(8, BigInt(mediaBytes) + 16n, false);
    return bytes;
}
function mvhd(duration, timescale) {
    if (duration >= MAX_U32) {
        const payload = new Uint8Array(112);
        const view = new DataView(payload.buffer);
        view.setUint32(16, timescale, false);
        view.setBigUint64(20, BigInt(duration), false);
        view.setUint32(28, 0x00010000, false);
        view.setUint16(32, 0x0100, false);
        view.setUint32(44, 0x00010000, false);
        view.setUint32(60, 0x00010000, false);
        view.setUint32(76, 0x40000000, false);
        view.setUint32(108, 2, false);
        return fullBox('mvhd', 1, 0, payload);
    }
    const payload = new Uint8Array(100);
    const view = new DataView(payload.buffer);
    view.setUint32(8, timescale, false);
    view.setUint32(12, duration, false);
    view.setUint32(16, 0x00010000, false);
    view.setUint16(20, 0x0100, false);
    view.setUint32(32, 0x00010000, false);
    view.setUint32(48, 0x00010000, false);
    view.setUint32(64, 0x40000000, false);
    view.setUint32(96, 2, false);
    return fullBox('mvhd', 0, 0, payload);
}
function tkhd(duration, metadata) {
    if (duration >= MAX_U32) {
        const payload = new Uint8Array(92);
        const view = new DataView(payload.buffer);
        view.setUint32(16, 1, false);
        view.setBigUint64(24, BigInt(duration), false);
        view.setUint16(44, 0x0100, false);
        view.setUint32(48, 0x00010000, false);
        view.setUint32(64, 0x00010000, false);
        view.setUint32(80, 0x40000000, false);
        return fullBox('tkhd', 1, mp4TrackFlags(metadata), payload);
    }
    const payload = new Uint8Array(80);
    const view = new DataView(payload.buffer);
    view.setUint32(8, 1, false);
    view.setUint32(16, duration, false);
    view.setUint16(32, 0x0100, false);
    view.setUint32(36, 0x00010000, false);
    view.setUint32(52, 0x00010000, false);
    view.setUint32(68, 0x40000000, false);
    return fullBox('tkhd', 0, mp4TrackFlags(metadata), payload);
}
function edts(movieDuration, primingSamples) {
    if (movieDuration > MAX_U32 || primingSamples > 0x7fffffff) {
        const payload = new Uint8Array(24);
        const view = new DataView(payload.buffer);
        view.setUint32(0, 1, false);
        view.setBigUint64(4, BigInt(movieDuration), false);
        view.setBigInt64(12, BigInt(primingSamples), false);
        view.setUint32(20, 0x00010000, false);
        return box('edts', fullBox('elst', 1, 0, payload));
    }
    const payload = new Uint8Array(16);
    const view = new DataView(payload.buffer);
    view.setUint32(0, 1, false);
    view.setUint32(4, movieDuration, false);
    view.setInt32(8, primingSamples, false);
    view.setUint32(12, 0x00010000, false);
    return box('edts', fullBox('elst', 0, 0, payload));
}
function mdhd(sampleRate, mediaDuration, language) {
    const tag = language && /^[a-z]{3}$/i.test(language) ? language.toLowerCase() : 'und';
    const languageCode = ((tag.charCodeAt(0) - 0x60) << 10) | ((tag.charCodeAt(1) - 0x60) << 5) | (tag.charCodeAt(2) - 0x60);
    if (mediaDuration >= MAX_U32) {
        const payload = new Uint8Array(32);
        const view = new DataView(payload.buffer);
        view.setUint32(16, sampleRate, false);
        view.setBigUint64(20, BigInt(mediaDuration), false);
        view.setUint16(28, languageCode, false);
        return fullBox('mdhd', 1, 0, payload);
    }
    const payload = new Uint8Array(20);
    const view = new DataView(payload.buffer);
    view.setUint32(8, sampleRate, false);
    view.setUint32(12, mediaDuration, false);
    view.setUint16(16, languageCode, false);
    return fullBox('mdhd', 0, 0, payload);
}
function hdlr(trackName) {
    const name = mp4HandlerName(trackName);
    const payload = new Uint8Array(20 + name.length);
    payload.set(ascii('soun'), 4);
    payload.set(name, 20);
    return fullBox('hdlr', 0, 0, payload);
}
function dinf() {
    const entry = fullBox('url ', 0, 1, new Uint8Array(0));
    const payload = new Uint8Array(4 + entry.length);
    new DataView(payload.buffer).setUint32(0, 1, false);
    payload.set(entry, 4);
    return box('dinf', fullBox('dref', 0, 0, payload));
}
function esds(asc) {
    if (asc.length < 2 || asc.length > 127) {
        throw new MediaForgeError(`AAC AudioSpecificConfig length is invalid (${asc.length})`, 'MUX');
    }
    const dsi = new Uint8Array([0x05, 0x80, 0x80, 0x80, asc.length, ...asc]);
    const decoder = new Uint8Array([
        0x40,
        0x15,
        0x00,
        0x00,
        0x00,
        0x00,
        0x01,
        0xf4,
        0x00,
        0x00,
        0x01,
        0xf4,
        0x00,
        ...dsi,
    ]);
    const decoderDescriptor = new Uint8Array([
        0x04,
        0x80,
        0x80,
        0x80 | (decoder.length >>> 7),
        decoder.length & 0x7f,
        ...decoder,
    ]);
    const sl = new Uint8Array([0x06, 0x80, 0x80, 0x80, 0x01, 0x02]);
    const esPayload = new Uint8Array([0x00, 0x01, 0x00, ...decoderDescriptor, ...sl]);
    const descriptor = new Uint8Array([
        0x03,
        0x80,
        0x80,
        0x80 | (esPayload.length >>> 7),
        esPayload.length & 0x7f,
        ...esPayload,
    ]);
    return fullBox('esds', 0, 0, descriptor);
}
function stsd(sampleRate, channels, asc) {
    const config = esds(asc);
    const entry = new Uint8Array(36 + config.length);
    const view = new DataView(entry.buffer);
    view.setUint32(0, entry.length, false);
    entry.set(ascii('mp4a'), 4);
    view.setUint16(14, 1, false);
    view.setUint16(24, channels, false);
    view.setUint16(26, 16, false);
    view.setUint32(32, Math.min(sampleRate, 0xffff) * 0x10000, false);
    entry.set(config, 36);
    const payload = new Uint8Array(4 + entry.length);
    new DataView(payload.buffer).setUint32(0, 1, false);
    payload.set(entry, 4);
    return fullBox('stsd', 0, 0, payload);
}
function stts(sampleCount, lastDuration) {
    const splitLast = sampleCount > 1 && lastDuration !== 1024;
    const payload = new Uint8Array(4 + (splitLast ? 2 : 1) * 8);
    const view = new DataView(payload.buffer);
    view.setUint32(0, splitLast ? 2 : 1, false);
    view.setUint32(4, splitLast ? sampleCount - 1 : sampleCount, false);
    view.setUint32(8, sampleCount === 1 ? lastDuration : 1024, false);
    if (splitLast) {
        view.setUint32(12, 1, false);
        view.setUint32(16, lastDuration, false);
    }
    return fullBox('stts', 0, 0, payload);
}
function stsc(sampleCount) {
    const payload = new Uint8Array(16);
    const view = new DataView(payload.buffer);
    view.setUint32(0, 1, false);
    view.setUint32(4, 1, false);
    view.setUint32(8, sampleCount, false);
    view.setUint32(12, 1, false);
    return fullBox('stsc', 0, 0, payload);
}
function stsz(sizes, sampleCount = sizes.length) {
    const payloadSize = 8 + sampleCount * 4;
    if (!Number.isSafeInteger(sampleCount) || sampleCount < 0 || payloadSize + 12 > MAX_U32) {
        throw new MediaForgeError('M4A sample-size table exceeds the 32-bit MP4 box limit', 'MUX');
    }
    const payload = new Uint8Array(payloadSize);
    const view = new DataView(payload.buffer);
    view.setUint32(4, sampleCount, false);
    for (let index = 0; index < sampleCount; index++) {
        view.setUint32(8 + index * 4, sizes.at(index), false);
    }
    return fullBox('stsz', 0, 0, payload);
}
function stco(mediaOffset) {
    const payload = new Uint8Array(8);
    const view = new DataView(payload.buffer);
    view.setUint32(0, 1, false);
    view.setUint32(4, mediaOffset, false);
    return fullBox('stco', 0, 0, payload);
}
function moov(sampleRate, channels, asc, sizes, sampleCount, mediaOffset, validSamples, primingSamples, userData, audioLanguage, title, audioTrack) {
    const mediaDuration = primingSamples + validSamples;
    const lastDuration = mediaDuration - (sampleCount - 1) * 1024;
    if (lastDuration < 1 || lastDuration > 1024) {
        throw new MediaForgeError(`AAC packet count cannot represent ${validSamples} valid samples (last duration ${lastDuration})`, 'MUX');
    }
    const movieDuration = validSamples;
    const table = box('stbl', stsd(sampleRate, channels, asc), stts(sampleCount, lastDuration), stsc(sampleCount), stsz(sizes, sampleCount), stco(mediaOffset));
    const minf = box('minf', fullBox('smhd', 0, 0, new Uint8Array(4)), dinf(), table);
    const mdia = box('mdia', mdhd(sampleRate, mediaDuration, audioLanguage), hdlr(audioTrack?.name), minf);
    const trak = box('trak', tkhd(movieDuration, audioTrack), edts(movieDuration, primingSamples), mdia, ...mp4TrackMetadataBoxes(audioTrack));
    return box('moov', mvhd(movieDuration, sampleRate), trak, mp4TitleBox(title), ...(userData ? [userData] : []));
}
export class StreamingM4AMuxer {
    sink;
    header = ftyp();
    sizes;
    mediaOffset;
    options;
    plannedSampleCount;
    plannedMediaBytes;
    frameIndex = 0;
    mediaBytes = 0;
    finalized = false;
    failed = false;
    failure;
    constructor(sink, options) {
        this.sink = sink;
        const resolved = { ...options };
        for (const key of [
            'sampleRate',
            'channels',
            'audioSpecificConfig',
            'primingSamples',
            'moovUserData',
            'audioLanguage',
            'title',
            'audioTrack',
            'plannedSizes',
            'signal',
        ]) {
            if (!Object.prototype.hasOwnProperty.call(resolved, key)) {
                const value = options[key];
                if (value !== undefined)
                    Object.defineProperty(resolved, key, { value, enumerable: true });
            }
        }
        options = resolved;
        resolved.audioTrack = snapshotMP4TrackMetadata(options.audioTrack, 'audio');
        if (options.title !== undefined && typeof options.title !== 'string')
            throw new MediaForgeError('M4A title must be a string', 'FORMAT');
        if (options.audioLanguage !== undefined && typeof options.audioLanguage !== 'string') {
            throw new MediaForgeError('audioLanguage must be a string', 'FORMAT');
        }
        if (!Number.isInteger(options.sampleRate) ||
            options.sampleRate < 1 ||
            options.sampleRate > MAX_U32 ||
            !Number.isInteger(options.channels) ||
            options.channels < 1 ||
            options.channels > 2) {
            throw new MediaForgeError('Streaming M4A requires a valid AAC mono/stereo shape', 'MUX');
        }
        const priming = options.primingSamples ?? 1024;
        if (!Number.isSafeInteger(priming) || priming < 0) {
            throw new MediaForgeError('M4A priming must be a non-negative safe integer', 'MUX');
        }
        if (!ArrayBuffer.isView(options.audioSpecificConfig) ||
            Object.prototype.toString.call(options.audioSpecificConfig) !== '[object Uint8Array]' ||
            options.audioSpecificConfig.length < 2 ||
            options.audioSpecificConfig.length > 127) {
            throw new MediaForgeError('AAC AudioSpecificConfig must contain 2 to 127 bytes', 'MUX');
        }
        if (options.moovUserData !== undefined &&
            (!ArrayBuffer.isView(options.moovUserData) ||
                Object.prototype.toString.call(options.moovUserData) !== '[object Uint8Array]')) {
            throw new MediaForgeError('M4A movie user data must be a Uint8Array', 'MUX');
        }
        if (!sink.patchAt && !options.plannedSizes) {
            throw new MediaForgeError('Non-seekable M4A sink requires a dry sample-size pass', 'OUTPUT');
        }
        this.options = {
            ...options,
            primingSamples: priming,
            audioSpecificConfig: new Uint8Array(options.audioSpecificConfig),
            moovUserData: options.moovUserData === undefined ? undefined : new Uint8Array(options.moovUserData),
        };
        this.sizes = options.plannedSizes ?? new M4ASampleSizeLedger();
        this.plannedSampleCount = options.plannedSizes?.length;
        this.plannedMediaBytes = options.plannedSizes?.totalBytes;
        this.mediaOffset = this.header.length + 16;
        const mediaHeader = mdatHeader(this.plannedMediaBytes ?? 0);
        this.options.signal?.throwIfAborted();
        sink.write(this.header);
        sink.write(mediaHeader);
    }
    assertOpen() {
        if (this.failed)
            throw this.failure;
        if (this.finalized)
            throw new MediaForgeError('M4A muxer already finalized', 'MUX');
    }
    addFrame(frame) {
        this.assertOpen();
        this.options.signal?.throwIfAborted();
        const nextBytes = this.mediaBytes + frame.length;
        if (!Number.isSafeInteger(nextBytes)) {
            throw new MediaForgeError('M4A media byte count exceeds JavaScript exact-integer range', 'MUX');
        }
        if (this.plannedSampleCount !== undefined) {
            if (this.frameIndex >= this.plannedSampleCount || this.sizes.at(this.frameIndex) !== frame.length) {
                throw new MediaForgeError(`AAC replay changed access-unit size at frame ${this.frameIndex}`, 'ENCODE');
            }
        }
        else {
            this.sizes.push(frame.length);
        }
        try {
            this.sink.write(frame);
        }
        catch (error) {
            this.failed = true;
            this.failure = error;
            throw error;
        }
        this.frameIndex++;
        this.mediaBytes = nextBytes;
    }
    async finalize(validSamples) {
        this.assertOpen();
        this.options.signal?.throwIfAborted();
        const priming = this.options.primingSamples;
        if (!Number.isSafeInteger(validSamples) ||
            validSamples < 1 ||
            this.frameIndex !== (this.plannedSampleCount ?? this.sizes.length) ||
            this.mediaBytes !== (this.plannedMediaBytes ?? this.sizes.totalBytes) ||
            priming + validSamples > this.frameIndex * 1024 ||
            priming + validSamples <= (this.frameIndex - 1) * 1024) {
            throw new MediaForgeError(`M4A replay is inconsistent (frames=${this.frameIndex}, bytes=${this.mediaBytes}, valid=${validSamples})`, 'ENCODE');
        }
        const movie = moov(this.options.sampleRate, this.options.channels, this.options.audioSpecificConfig, this.sizes, this.frameIndex, this.mediaOffset, validSamples, priming, this.options.moovUserData, this.options.audioLanguage, this.options.title, this.options.audioTrack);
        this.finalized = true;
        try {
            if (this.sink.patchAt) {
                this.sink.patchAt(this.header.length, mdatHeader(this.mediaBytes));
            }
            this.sink.write(movie);
            await drainSink(this.sink, this.options.signal);
            await this.sink.close();
        }
        catch (error) {
            this.failed = true;
            this.failure = error;
            throw error;
        }
    }
    get planningBytes() {
        return this.sizes.storageBytes;
    }
    get packets() {
        return this.frameIndex;
    }
}
