import { DemuxError, MediaForgeError } from '../core/errors.js';
import { awaitWithAbort } from '../core/abort.js';
import { objectSampleLedgerEntryLimit } from '../core/demux-guard.js';
import { flacCrc16, MAX_FLAC_FRAME_HEADER_BYTES, parseFlacFrameHeader } from '../core/flac-frame.js';
import { BlobSource } from '../io/sources.js';
import { ChunkReader } from '../io/chunk-reader.js';
import { createWebCodecsTrackPcmSource } from './webcodecs-pcm-source.js';
function isFlac(bytes) {
    return bytes[0] === 0x66 && bytes[1] === 0x4c && bytes[2] === 0x61 && bytes[3] === 0x43;
}
function checkAbort(signal) {
    if (signal?.aborted)
        throw new MediaForgeError('Aborted', 'ABORT');
}
async function readBytes(reader, offset, count, signal) {
    checkAbort(signal);
    const bytes = await awaitWithAbort(reader.bytes(offset, count), signal);
    checkAbort(signal);
    return bytes;
}
async function readStreamInfo(reader, signal) {
    if (reader.size < 42)
        throw new DemuxError('FLAC is too small for STREAMINFO');
    const first = await readBytes(reader, 0, 42, signal);
    if (!isFlac(first))
        throw new DemuxError('FLAC marker is missing');
    if ((first[4] & 0x7f) !== 0 || ((first[5] << 16) | (first[6] << 8) | first[7]) !== 34) {
        throw new DemuxError('FLAC first metadata block is not a 34-byte STREAMINFO');
    }
    const info = first.subarray(8, 42);
    const minBlock = (info[0] << 8) | info[1];
    const maxBlock = (info[2] << 8) | info[3];
    const sampleRate = (info[10] << 12) | (info[11] << 4) | (info[12] >> 4);
    const channels = ((info[12] >> 1) & 0x07) + 1;
    const bits = (((info[12] & 0x01) << 4) | (info[13] >> 4)) + 1;
    const declaredSamples = (info[13] & 0x0f) * 2 ** 32 + ((info[14] << 24) >>> 0) + (info[15] << 16) + (info[16] << 8) + info[17];
    if (sampleRate < 1 ||
        sampleRate > 655350 ||
        channels < 1 ||
        channels > 8 ||
        bits < 4 ||
        bits > 32 ||
        minBlock < 16 ||
        maxBlock < minBlock ||
        maxBlock > 65535) {
        throw new DemuxError('FLAC STREAMINFO has an invalid audio shape');
    }
    let position = 4;
    let firstBlock = true;
    let last = false;
    let blocks = 0;
    while (!last) {
        if (++blocks > 4096 || position + 4 > reader.size) {
            throw new DemuxError('FLAC metadata chain is invalid or truncated');
        }
        const header = await readBytes(reader, position, 4, signal);
        last = (header[0] & 0x80) !== 0;
        const type = header[0] & 0x7f;
        const length = (header[1] << 16) | (header[2] << 8) | header[3];
        if (firstBlock && (type !== 0 || length !== 34)) {
            throw new DemuxError('FLAC first metadata block is not STREAMINFO');
        }
        if (position + 4 + length > reader.size) {
            throw new DemuxError(`FLAC metadata block ${blocks - 1} is truncated`);
        }
        position += 4 + length;
        firstBlock = false;
    }
    if (position >= reader.size)
        throw new DemuxError('FLAC contains no audio frames');
    const description = first.slice();
    description[4] = 0x80;
    return { sampleRate, channels, declaredSamples, description, audioOffset: position };
}
async function scanFrames(reader, stream, signal) {
    const MAX_FRAME_BYTES = 4 * 1024 * 1024;
    const WINDOW = MAX_FRAME_BYTES + MAX_FLAC_FRAME_HEADER_BYTES;
    const ledgerLimit = objectSampleLedgerEntryLimit(reader.size);
    const samples = [];
    let windowStart = stream.audioOffset;
    let window = await readBytes(reader, windowStart, Math.min(WINDOW, reader.size - windowStart), signal);
    const slideTo = async (offset) => {
        windowStart = offset;
        window = await readBytes(reader, windowStart, Math.min(WINDOW, reader.size - windowStart), signal);
    };
    if (!parseFlacFrameHeader(window, 0)) {
        throw new DemuxError('FLAC audio does not start with a valid frame header');
    }
    let offset = stream.audioOffset;
    let decodedFrames = 0;
    while (offset < reader.size) {
        checkAbort(signal);
        if (offset < windowStart || offset > windowStart + window.length - MAX_FLAC_FRAME_HEADER_BYTES)
            await slideTo(offset);
        const relative = offset - windowStart;
        const frameHeader = parseFlacFrameHeader(window, relative);
        if (!frameHeader)
            throw new DemuxError(`FLAC frame header is invalid at byte ${offset}`);
        let cursor = relative + frameHeader.headerLen;
        let nextOffset = -1;
        let candidates = 0;
        while (windowStart + cursor + 6 <= reader.size &&
            windowStart + cursor - offset <= MAX_FRAME_BYTES &&
            candidates < 64) {
            if (cursor + MAX_FLAC_FRAME_HEADER_BYTES > window.length && windowStart + window.length < reader.size) {
                if (offset === windowStart) {
                    throw new DemuxError(`FLAC frame at byte ${offset} exceeds the 4 MiB safety window`);
                }
                const shift = offset - windowStart;
                await slideTo(offset);
                cursor -= shift;
                continue;
            }
            if (window[cursor] === 0xff &&
                (window[cursor + 1] & 0xfc) === 0xf8 &&
                windowStart + cursor - offset >= frameHeader.headerLen + 2 &&
                parseFlacFrameHeader(window, cursor)) {
                candidates++;
                const given = (window[cursor - 2] << 8) | window[cursor - 1];
                if (flacCrc16(window.subarray(offset - windowStart, cursor - 2)) === given) {
                    nextOffset = windowStart + cursor;
                    break;
                }
            }
            cursor++;
        }
        if (nextOffset < 0) {
            if (reader.size - offset < frameHeader.headerLen + 2) {
                throw new DemuxError('FLAC final frame is truncated');
            }
            if (windowStart + window.length < reader.size)
                await slideTo(offset);
            const start = offset - windowStart;
            const end = reader.size - windowStart;
            if (end - start > MAX_FRAME_BYTES || end > window.length) {
                throw new DemuxError(`FLAC frame at byte ${offset} exceeds the 4 MiB safety window`);
            }
            const given = (window[end - 2] << 8) | window[end - 1];
            if (flacCrc16(window.subarray(start, end - 2)) !== given) {
                throw new DemuxError('FLAC final frame fails CRC-16');
            }
            nextOffset = reader.size;
        }
        if (samples.length >= ledgerLimit) {
            throw new DemuxError(`FLAC frame ledger exceeds the ${ledgerLimit}-entry memory budget`);
        }
        const duration = frameHeader.blockSize / stream.sampleRate;
        samples.push({
            offset,
            size: nextOffset - offset,
            timestamp: decodedFrames / stream.sampleRate,
            duration,
            isKeyframe: true,
        });
        decodedFrames += frameHeader.blockSize;
        offset = nextOffset;
        if ((samples.length & 1023) === 0) {
            await awaitWithAbort(new Promise(resolve => setTimeout(resolve, 0)), signal);
        }
    }
    if (stream.declaredSamples > 0 && decodedFrames !== stream.declaredSamples) {
        throw new DemuxError(`FLAC frames contain ${decodedFrames} samples but STREAMINFO declares ${stream.declaredSamples}`);
    }
    return { samples, frames: decodedFrames };
}
export async function createRawFlacPcmSource(file, signal) {
    checkAbort(signal);
    if (typeof AudioDecoder === 'undefined')
        return null;
    const blobSource = new BlobSource(file);
    const reader = new ChunkReader(blobSource);
    const stream = await readStreamInfo(reader, signal);
    const scanned = await scanFrames(reader, stream, signal);
    if (scanned.samples.length === 0 || scanned.frames === 0)
        return null;
    const track = {
        codec: 'flac',
        codecConfig: stream.description,
        width: 0,
        height: 0,
        sampleRate: stream.sampleRate,
        channelCount: stream.channels,
        duration: scanned.frames / stream.sampleRate,
        samples: scanned.samples,
    };
    return createWebCodecsTrackPcmSource(track, async (sample) => blobSource.read(sample.offset, sample.size), signal);
}
