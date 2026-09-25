import { MediaForgeError } from '../core/errors.js';
import { BinaryWriter } from '../core/binary-writer.js';
import { oggCrc32 } from '../core/ogg-crc.js';
const OGG_CONTINUED_PACKET = 0x01;
const OGG_BOS = 0x02;
const OGG_EOS = 0x04;
const OGG_MAX_SEGMENTS_PER_PAGE = 255;
const OGG_SEGMENT_SIZE = 255;
const OPUS_SAMPLE_RATE = 48000;
const OPUS_PRE_SKIP = 312;
const OPUS_DEFAULT_FRAME_SAMPLES = 960;
const INVALID_GRANULE_POSITION = 0xffffffffffffffffn;
const MAX_GRANULE_POSITION = 0x7fffffffffffffffn;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayTag = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag).get;
const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer').get;
const typedArrayOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset').get;
const typedArrayLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'length').get;
function copyBytes(value, label) {
    try {
        if (!ArrayBuffer.isView(value) || typedArrayTag.call(value) !== 'Uint8Array')
            throw new TypeError();
        return new Uint8Array(new Uint8Array(typedArrayBuffer.call(value), typedArrayOffset.call(value), typedArrayLength.call(value)));
    }
    catch {
        throw new MediaForgeError(`${label} must be an attached Uint8Array`, 'MUX');
    }
}
export class OGGMuxer {
    finalizedFlag = false;
    failed = false;
    failure;
    writing = false;
    validSamples = null;
    setValidSamples(samples) {
        this.assertOpen();
        const normalized = Number.isFinite(samples) ? Math.max(0, Math.round(samples)) : NaN;
        if (!Number.isSafeInteger(normalized)) {
            throw new MediaForgeError('Ogg valid sample count must round to a safe integer', 'MUX');
        }
        this.validSamples = normalized;
    }
    sink;
    channelCount;
    inputSampleRate;
    commentPayload;
    codecConfig;
    serialNumber;
    pendingChunk = null;
    headersWritten = false;
    samplePosition = 0n;
    preSkip = OPUS_PRE_SKIP;
    pageSequenceNumber = 0;
    pageSegments = [];
    pageParts = [];
    pageGranule = INVALID_GRANULE_POSITION;
    writtenGranule = 0n;
    constructor(cfg, sink) {
        const write = sink?.write, close = sink?.close;
        if (typeof write !== 'function' || typeof close !== 'function') {
            throw new MediaForgeError('Ogg output requires sink write() and close() methods', 'MUX');
        }
        if (cfg.video) {
            throw new MediaForgeError('OGG output here is audio-only; a video track cannot be declared', 'FORMAT');
        }
        const audio = cfg.audio;
        const codec = audio?.codec;
        if (typeof codec !== 'string' || !codec.startsWith('opus')) {
            throw new MediaForgeError(`OGG cannot carry audio codec '${String(codec ?? '(none)')}' (supported: opus — vorbis output is not implemented)`, 'FORMAT');
        }
        this.channelCount = audio?.channelCount ?? 2;
        this.inputSampleRate = audio?.sampleRate ?? OPUS_SAMPLE_RATE;
        const codecConfig = audio?.codecConfig, commentPayload = cfg.oggCommentPayload;
        this.codecConfig = codecConfig === undefined ? undefined : this.validateOpusIdHeader(codecConfig);
        this.commentPayload =
            commentPayload === undefined ? undefined : copyBytes(commentPayload, 'Ogg comment payload');
        this.sink = { write: bytes => write.call(sink, bytes), close: () => close.call(sink) };
        this.serialNumber = ((Date.now() & 0xffffffff) ^ 0x6f676753) >>> 0;
    }
    setCodecConfig(codecConfig) {
        this.assertOpen();
        const header = this.validateOpusIdHeader(codecConfig);
        if (this.headersWritten) {
            const current = this.codecConfig;
            if (!current ||
                current.length !== header.length ||
                current.some((value, index) => value !== header[index])) {
                throw new MediaForgeError('Ogg codec configuration cannot change after the first audio chunk', 'MUX');
            }
            return;
        }
        this.codecConfig = header;
    }
    setAudioCodecConfig(codecConfig) {
        this.setCodecConfig(codecConfig);
    }
    addVideoChunk() {
        throw new MediaForgeError('OGG output is audio-only; video chunks are not accepted', 'MUX');
    }
    addAudioChunk(chunk, codecConfig) {
        this.assertOpen();
        const trackType = chunk?.trackType;
        if (trackType === undefined) {
            throw new MediaForgeError(`${'addAudioChunk'} requires chunk.trackType (got a chunk without one)`, 'MUX');
        }
        if (trackType !== 'audio') {
            throw new MediaForgeError(`addAudioChunk received a '${String(trackType)}' chunk`, 'MUX');
        }
        const timestamp = chunk.timestamp, duration = chunk.duration ?? 0;
        if (!Number.isFinite(timestamp) || !Number.isFinite(duration) || duration < 0) {
            throw new MediaForgeError('Ogg audio chunk has invalid timing', 'MUX');
        }
        if (this.pendingChunk && timestamp < this.pendingChunk.timestamp) {
            throw new MediaForgeError('Ogg audio chunks must arrive in timestamp order', 'MUX');
        }
        const owned = {
            timestamp,
            duration,
            data: copyBytes(chunk.data, 'Ogg audio chunk payload'),
        };
        const supplied = codecConfig === undefined ? undefined : this.validateOpusIdHeader(codecConfig);
        if (this.headersWritten && supplied)
            this.setCodecConfig(supplied);
        const idHeader = this.headersWritten
            ? undefined
            : (supplied ?? this.resolveOpusIdHeader(this.channelCount, this.inputSampleRate));
        const pendingSamples = this.pendingChunk ? this.packetSamples(this.pendingChunk, owned.timestamp) : 0n;
        if (this.samplePosition + pendingSamples + this.packetSamples(owned) > MAX_GRANULE_POSITION) {
            throw new MediaForgeError('Ogg audio sample position exceeds the signed 64-bit granule range', 'MUX');
        }
        this.writeHeaders(idHeader);
        if (this.pendingChunk)
            this.writeAudioPacket(this.pendingChunk, false, pendingSamples);
        this.pendingChunk = owned;
    }
    async finalize() {
        this.assertOpen();
        if (!this.pendingChunk) {
            throw new MediaForgeError('finalize with no audio packets', 'MUX');
        }
        const samples = this.packetSamples(this.pendingChunk);
        const finalGranule = this.audioGranule(this.samplePosition + samples, true);
        const pendingSegments = Math.floor(this.pendingChunk.data.length / OGG_SEGMENT_SIZE) + 1;
        const minimumGranule = this.pageSegments.length > 0 && this.pageSegments.length + pendingSegments > OGG_MAX_SEGMENTS_PER_PAGE
            ? this.pageGranule
            : this.writtenGranule;
        if (finalGranule < minimumGranule) {
            throw new MediaForgeError('Ogg valid sample count trims audio before the final page', 'MUX');
        }
        this.finalizedFlag = true;
        this.writeAudioPacket(this.pendingChunk, true, samples);
        this.pendingChunk = null;
        this.flushPage(0);
        try {
            await this.sink.close();
        }
        catch (error) {
            this.fail(error);
        }
    }
    assertOpen() {
        if (this.failed)
            throw this.failure;
        if (this.finalizedFlag)
            throw new MediaForgeError('Muxer already finalized', 'MUX');
        if (this.writing)
            throw new MediaForgeError('Ogg muxer cannot be mutated from a sink write callback', 'MUX');
    }
    fail(error) {
        if (!this.failed) {
            this.failed = true;
            this.failure = error;
        }
        throw this.failure;
    }
    writePage(page, granule) {
        this.writing = true;
        try {
            this.sink.write(page);
            if (granule !== INVALID_GRANULE_POSITION)
                this.writtenGranule = granule;
        }
        catch (error) {
            this.fail(error);
        }
        finally {
            this.writing = false;
        }
    }
    writeHeaders(idHeader) {
        if (this.headersWritten)
            return;
        if (!idHeader)
            throw new MediaForgeError('Ogg identification header is missing', 'MUX');
        const commentHeader = this.buildOpusCommentHeader();
        this.codecConfig = idHeader;
        this.headersWritten = true;
        this.preSkip = idHeader.length >= 12 ? idHeader[10] | (idHeader[11] << 8) : OPUS_PRE_SKIP;
        this.writePacket(idHeader, 0n, OGG_BOS);
        this.writePacket(commentHeader, 0n, 0);
    }
    packetSamples(chunk, nextTimestamp) {
        let durationSeconds = chunk.duration > 0 ? chunk.duration : 0;
        if (durationSeconds <= 0 && nextTimestamp !== undefined) {
            durationSeconds = Math.max(0, nextTimestamp - chunk.timestamp);
        }
        const samples = durationSeconds > 0
            ? Math.max(1, Math.round(durationSeconds * OPUS_SAMPLE_RATE))
            : OPUS_DEFAULT_FRAME_SAMPLES;
        if (!Number.isSafeInteger(samples)) {
            throw new MediaForgeError('Ogg audio duration exceeds safe sample-count precision', 'MUX');
        }
        return BigInt(samples);
    }
    audioGranule(position, isLast) {
        const finalGranule = this.validSamples !== null ? BigInt(this.preSkip) + BigInt(this.validSamples) : null;
        return isLast && finalGranule !== null && finalGranule < position ? finalGranule : position;
    }
    writeAudioPacket(chunk, isLast, samples) {
        this.samplePosition += samples;
        this.queuePacket(chunk.data, this.audioGranule(this.samplePosition, isLast), isLast);
    }
    resolveOpusIdHeader(channelCount, inputSampleRate) {
        const provided = this.codecConfig;
        if (provided)
            return provided;
        return this.buildOpusIdHeader(channelCount, inputSampleRate);
    }
    validateOpusIdHeader(value) {
        const header = copyBytes(value, 'Ogg codec configuration');
        const magic = 'OpusHead';
        if (header.length < 19 ||
            [...magic].some((letter, index) => header[index] !== letter.charCodeAt(0)) ||
            header[8] > 15 ||
            header[9] === 0) {
            throw new MediaForgeError('Ogg codec configuration requires a complete compatible OpusHead', 'MUX');
        }
        const channels = header[9], family = header[18];
        if (family === 0 && channels > 2) {
            throw new MediaForgeError('Ogg OpusHead mapping family zero supports only mono or stereo', 'MUX');
        }
        if (family === 1 || family === 255) {
            const streams = header[19], coupled = header[20];
            if (header.length < 21 + channels ||
                streams === 0 ||
                coupled > streams ||
                streams + coupled > 255 ||
                (family === 1 && channels > 8) ||
                header.subarray(21, 21 + channels).some(channel => channel !== 255 && channel >= streams + coupled)) {
                throw new MediaForgeError('Ogg OpusHead has an invalid channel mapping table', 'MUX');
            }
        }
        return header;
    }
    queuePacket(payload, granulePosition, isLast) {
        const lacing = this.buildLacingValues(payload.length);
        if (lacing.length > OGG_MAX_SEGMENTS_PER_PAGE) {
            this.flushPage(0);
            this.writePacket(payload, granulePosition, isLast ? OGG_EOS : 0);
            return;
        }
        if (this.pageSegments.length + lacing.length > OGG_MAX_SEGMENTS_PER_PAGE) {
            this.flushPage(0);
        }
        for (let i = 0; i < lacing.length; i++)
            this.pageSegments.push(lacing[i]);
        this.pageParts.push(payload);
        this.pageGranule = granulePosition;
        if (isLast)
            this.flushPage(OGG_EOS);
    }
    flushPage(extraFlags) {
        if (this.pageSegments.length === 0)
            return;
        let total = 0;
        for (const part of this.pageParts)
            total += part.length;
        this.writePage(this.buildPage(this.pageParts, total, Uint8Array.from(this.pageSegments), extraFlags, this.pageGranule), this.pageGranule);
        this.pageSegments.length = 0;
        this.pageParts.length = 0;
        this.pageGranule = INVALID_GRANULE_POSITION;
    }
    buildOpusIdHeader(channelCount, inputSampleRate) {
        if (channelCount !== 1 && channelCount !== 2) {
            throw new MediaForgeError('Ogg multichannel audio requires an OpusHead with channel mapping', 'FORMAT');
        }
        if (!Number.isInteger(inputSampleRate) || inputSampleRate < 0 || inputSampleRate > 0xffffffff) {
            throw new MediaForgeError('Ogg input sample rate must fit an unsigned 32-bit field', 'FORMAT');
        }
        const writer = new BinaryWriter();
        writer.writeASCII('OpusHead');
        writer.writeU8(1);
        writer.writeU8(channelCount);
        writer.writeU16LE(OPUS_PRE_SKIP);
        writer.writeU32LE(inputSampleRate);
        writer.writeU16LE(0);
        writer.writeU8(0);
        return writer.toUint8Array();
    }
    buildOpusCommentHeader() {
        const writer = new BinaryWriter();
        writer.writeASCII('OpusTags');
        const carried = this.commentPayload;
        if (carried && carried.length >= 8) {
            writer.writeBytes(carried);
        }
        else {
            const vendor = 'MediaForgeJS';
            writer.writeU32LE(vendor.length);
            writer.writeASCII(vendor);
            writer.writeU32LE(0);
        }
        return writer.toUint8Array();
    }
    writePacket(payload, granulePosition, flags) {
        const lacingValues = this.buildLacingValues(payload.length);
        let payloadOffset = 0;
        const totalPages = Math.max(1, Math.ceil(lacingValues.length / OGG_MAX_SEGMENTS_PER_PAGE));
        for (let pageIndex = 0; pageIndex < totalPages; pageIndex++) {
            const segmentStart = pageIndex * OGG_MAX_SEGMENTS_PER_PAGE;
            const segmentEnd = Math.min(lacingValues.length, segmentStart + OGG_MAX_SEGMENTS_PER_PAGE);
            const segmentTable = lacingValues.subarray(segmentStart, segmentEnd);
            let pagePayloadLength = 0;
            for (let segmentIndex = 0; segmentIndex < segmentTable.length; segmentIndex++) {
                pagePayloadLength += segmentTable[segmentIndex] ?? 0;
            }
            const pagePayload = payload.subarray(payloadOffset, payloadOffset + pagePayloadLength);
            payloadOffset += pagePayloadLength;
            let headerType = 0;
            if (pageIndex > 0)
                headerType |= OGG_CONTINUED_PACKET;
            if (pageIndex === 0 && (flags & OGG_BOS) !== 0)
                headerType |= OGG_BOS;
            if (pageIndex === totalPages - 1 && (flags & OGG_EOS) !== 0)
                headerType |= OGG_EOS;
            const pageGranulePosition = pageIndex === totalPages - 1 ? granulePosition : INVALID_GRANULE_POSITION;
            this.writePage(this.buildPage([pagePayload], pagePayloadLength, segmentTable, headerType, pageGranulePosition), pageGranulePosition);
        }
    }
    buildLacingValues(payloadLength) {
        const fullSegments = Math.floor(payloadLength / OGG_SEGMENT_SIZE);
        const values = new Uint8Array(fullSegments + 1);
        values.fill(OGG_SEGMENT_SIZE, 0, fullSegments);
        values[fullSegments] = payloadLength % OGG_SEGMENT_SIZE;
        return values;
    }
    buildPage(payloadParts, payloadLength, segmentTable, headerType, granulePosition) {
        const page = new Uint8Array(27 + segmentTable.length + payloadLength);
        const view = new DataView(page.buffer);
        view.setUint32(0, 0x4f676753, false);
        page[5] = headerType;
        const granule = granulePosition < 0n ? INVALID_GRANULE_POSITION : granulePosition;
        view.setUint32(6, Number(granule & 0xffffffffn), true);
        view.setUint32(10, Number((granule >> 32n) & 0xffffffffn), true);
        view.setUint32(14, this.serialNumber, true);
        view.setUint32(18, this.pageSequenceNumber++, true);
        page[26] = segmentTable.length;
        page.set(segmentTable, 27);
        let offset = 27 + segmentTable.length;
        for (const part of payloadParts) {
            page.set(part, offset);
            offset += part.length;
        }
        view.setUint32(22, oggCrc32(page), true);
        return page;
    }
}
