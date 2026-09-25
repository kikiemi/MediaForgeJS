import { MediaForgeError } from '../core/errors.js';
import { oggCrc32 } from '../core/ogg-crc.js';
import { copyOutputBytes, outputByteLength } from '../io/output-data.js';
import { assertSink, drainSink } from '../io/sink-backpressure.js';
import { awaitWithAbort } from '../core/abort.js';
import { vorbisModes, vorbisPacketBlock } from '../demux/vorbis-headers.js';
import { validateOggComments } from '../demux/ogg-audio-demuxer.js';
function requireValue(condition, message) {
    if (!condition)
        throw new MediaForgeError(message, 'MUX');
}
export class VorbisMuxer {
    sink;
    headers;
    rate;
    modes;
    smallBlock;
    largeBlock;
    sequence = 0;
    serial = 0x4d46564f;
    pending;
    previousEnd;
    granule = 0;
    validSamples;
    started = false;
    finished = false;
    busy = false;
    failure;
    constructor(sink, track) {
        this.sink = sink;
        assertSink(sink);
        const { codec, codecConfig, sampleRate, channelCount } = track;
        requireValue(codec === 'vorbis', 'Vorbis output requires a Vorbis track');
        const configLength = outputByteLength(codecConfig);
        requireValue(configLength >= 4 && configLength <= 4 * 1024 * 1024, 'Invalid Vorbis header configuration');
        const config = copyOutputBytes(codecConfig);
        requireValue(config[0] === 2, 'Invalid Vorbis header configuration');
        let offset = 1;
        const lengths = [];
        for (let header = 0; header < 2; header++) {
            let length = 0;
            let next;
            do {
                requireValue(offset < config.length, 'Truncated Vorbis header lacing');
                next = config[offset++];
                length += next;
            } while (next === 255);
            lengths.push(length);
        }
        lengths.push(config.length - offset - lengths[0] - lengths[1]);
        this.headers = lengths.map((length, index) => {
            requireValue((index === 0 ? length === 30 : length >= 8) && length <= config.length - offset, 'Invalid Vorbis header length');
            const header = config.slice(offset, (offset += length));
            requireValue(header[0] === index * 2 + 1 && String.fromCharCode(...header.subarray(1, 7)) === 'vorbis', 'Invalid Vorbis header signature');
            return header;
        });
        const info = new DataView(this.headers[0].buffer);
        this.rate = info.getUint32(12, true);
        const blocks = this.headers[0][28];
        requireValue(info.getUint32(7, true) === 0 &&
            this.rate === sampleRate &&
            this.rate > 0 &&
            this.headers[0][11] === channelCount &&
            channelCount > 0 &&
            (blocks & 15) >= 6 &&
            blocks >>> 4 <= 13 &&
            (blocks & 15) <= blocks >>> 4 &&
            (this.headers[0][29] & 1) === 1, 'Vorbis identification does not match the track');
        this.smallBlock = 1 << (blocks & 15);
        this.largeBlock = 1 << (blocks >>> 4);
        try {
            validateOggComments(this.headers[1], false);
            this.modes = vorbisModes(this.headers[2], channelCount);
        }
        catch {
            throw new MediaForgeError('Invalid Vorbis comment or setup header', 'MUX');
        }
    }
    setValidSamples(samples) {
        this.assertOpen();
        requireValue(Number.isSafeInteger(samples) && samples >= 0, 'Invalid Vorbis presentation sample count');
        this.validSamples = samples;
    }
    addAudioChunk(chunk) {
        this.assertOpen();
        const { trackType, timestamp, duration, data: source } = chunk;
        this.assertOpen();
        requireValue(trackType === 'audio' && Number.isFinite(timestamp) && Number.isFinite(duration) && duration >= 0, 'Invalid Vorbis packet timing');
        const length = outputByteLength(source);
        requireValue(length > 0 && length <= 64 * 1024 * 1024, 'Invalid Vorbis audio packet');
        const data = copyOutputBytes(source);
        try {
            vorbisPacketBlock(data, this.modes, this.smallBlock, this.largeBlock);
        }
        catch {
            throw new MediaForgeError('Invalid Vorbis audio packet mode', 'MUX');
        }
        const start = Math.round(timestamp * this.rate);
        const end = Math.round((timestamp + duration) * this.rate);
        requireValue(Number.isSafeInteger(start) && Number.isSafeInteger(end) && (end >= 0 || this.previousEnd === undefined), 'Vorbis packet exceeds exact timing range');
        requireValue(this.previousEnd === undefined || Math.abs(start - this.previousEnd) <= 1, 'Ogg Vorbis output requires a continuous packet timeline');
        requireValue(this.previousEnd === undefined || end >= this.previousEnd, 'Vorbis packet end moves backwards');
        this.busy = true;
        try {
            if (!this.started) {
                this.headers.forEach((header, index) => this.writePacket(header, 0n, index === 0 ? 2 : 0));
                this.started = true;
            }
            if (this.pending) {
                this.writePacket(this.pending.data, BigInt(Math.max(0, this.pending.end)), 0);
                this.granule = this.pending.end;
            }
            this.pending = { data, end };
            this.previousEnd = end;
        }
        catch (error) {
            this.failure = { error };
            throw error;
        }
        finally {
            this.busy = false;
        }
    }
    async finalize() {
        this.assertOpen();
        requireValue(this.pending, 'Cannot finalize Vorbis without audio packets');
        const end = this.validSamples ?? this.pending.end;
        requireValue(end >= this.granule && end <= this.pending.end, 'Vorbis trim must lie within the final packet');
        this.busy = true;
        try {
            this.writePacket(this.pending.data, BigInt(end), 4);
            this.pending = undefined;
            this.finished = true;
            await drainSink(this.sink, this.sink.signal);
            this.checkAbort();
            await awaitWithAbort(this.sink.close(), this.sink.signal);
            this.checkAbort();
        }
        catch (error) {
            this.failure = { error };
            throw error;
        }
        finally {
            this.busy = false;
        }
    }
    assertOpen() {
        if (this.failure)
            throw this.failure.error;
        requireValue(!this.finished && !this.busy, 'Vorbis writer is closed or busy');
        this.checkAbort();
    }
    checkAbort() {
        if (this.sink.signal?.aborted)
            throw new MediaForgeError('Aborted', 'ABORT');
    }
    writePacket(data, granule, flags) {
        const count = Math.floor(data.length / 255) + 1;
        let byteOffset = 0;
        for (let first = 0; first < count; first += 255) {
            this.checkAbort();
            requireValue(this.sequence <= 0xffffffff, 'Ogg page sequence overflow');
            const segments = Math.min(255, count - first);
            const last = first + segments === count;
            const size = Math.min(data.length - byteOffset, segments * 255);
            const page = new Uint8Array(27 + segments + size);
            const view = new DataView(page.buffer);
            page.set([79, 103, 103, 83, 0, (first ? 1 : flags & 2) | (last ? flags & 4 : 0)]);
            view.setBigUint64(6, last ? granule : 0xffffffffffffffffn, true);
            view.setUint32(14, this.serial, true);
            view.setUint32(18, this.sequence++, true);
            page[26] = segments;
            page.fill(255, 27, 27 + segments);
            if (last)
                page[26 + segments] = data.length % 255;
            page.set(data.subarray(byteOffset, byteOffset + size), 27 + segments);
            view.setUint32(22, oggCrc32(page), true);
            this.sink.write(page);
            this.checkAbort();
            byteOffset += size;
        }
    }
}
