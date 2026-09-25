import { ChunkReader } from '../io/chunk-reader.js';
import { awaitWithAbort } from '../core/abort.js';
import { DiagnosticContext } from '../core/diagnostics.js';
import { DemuxError, MediaForgeError } from '../core/errors.js';
import { DemuxIndexBudget, resolveDemuxBudget, yieldEventLoop } from '../core/demux-guard.js';
import { flacCrc16, MAX_FLAC_FRAME_HEADER_BYTES, parseFlacFrameHeader } from '../core/flac-frame.js';
import { indexOggAudio } from './ogg-audio-demuxer.js';
import { MAX_WAVE_FORMAT_BYTES, parseWaveFormat } from '../core/wave-format.js';
import { indexAiff, indexAu, indexPcmAudio } from './pcm-audio-demuxer.js';
import { indexCaf } from './caf-demuxer.js';
function tag(bytes, offset = 0) {
    return String.fromCharCode(...bytes.subarray(offset, offset + 4));
}
export async function demuxStandaloneAudio(source, options) {
    const { format, signal, maxSamples: requestedSamples, maxIndexBytes, maxPacketBytes: requestedBytes, validation, onWarning, maxWarnings, } = options;
    const diagnostics = new DiagnosticContext({ validation, onWarning, maxWarnings }, 'compatible');
    if (!['wav', 'aiff', 'aif', 'aifc', 'au', 'caf', 'flac', 'ogg', 'opus'].includes(format))
        throw new DemuxError('Unsupported standalone audio format');
    const budget = new DemuxIndexBudget(resolveDemuxBudget({ maxSamples: requestedSamples, maxIndexBytes }, 2_000_000));
    const maxPacketBytes = requestedBytes ?? 16 * 1024 * 1024;
    if (!Number.isSafeInteger(maxPacketBytes) || maxPacketBytes < 1 || maxPacketBytes > 64 * 1024 * 1024) {
        throw new DemuxError('maxPacketBytes must be an integer in 1..67108864');
    }
    const check = () => {
        if (signal?.aborted)
            throw new MediaForgeError('Aborted', 'ABORT');
    };
    check();
    const reader = new ChunkReader(source);
    const context = {
        size: reader.size,
        budget,
        maxPacketBytes,
        diagnostics,
        async read(offset, length) {
            check();
            if (!Number.isSafeInteger(offset) ||
                !Number.isSafeInteger(length) ||
                offset < 0 ||
                length < 0 ||
                offset > reader.size ||
                length > reader.size - offset)
                throw new DemuxError('Truncated audio structure');
            const bytes = await awaitWithAbort(reader.bytes(offset, length), signal);
            check();
            return bytes;
        },
        async checkpoint() {
            check();
            await awaitWithAbort(yieldEventLoop(), signal);
            check();
        },
    };
    const track = format === 'wav'
        ? await indexWav(context)
        : format === 'aiff' || format === 'aif' || format === 'aifc'
            ? await indexAiff(context)
            : format === 'au'
                ? await indexAu(context)
                : format === 'caf'
                    ? await indexCaf(context)
                    : format === 'flac'
                        ? await indexFlac(context)
                        : await indexOggAudio(context, format === 'opus');
    check();
    return { videoTracks: [], audioTracks: [track] };
}
async function indexWav(context) {
    const first = await context.read(0, 12);
    const kind = tag(first);
    if (kind === 'RIFX')
        throw new DemuxError('Big-endian RIFX requires conversion to little-endian WAVE');
    if ((kind !== 'RIFF' && kind !== 'RF64') || tag(first, 8) !== 'WAVE')
        throw new DemuxError('Invalid RIFF/RF64 WAVE header');
    const initialSize = new DataView(first.buffer, first.byteOffset).getUint32(4, true);
    let end = initialSize + 8;
    let dataSize64 = -1;
    let declaredFrames = 0;
    const extendedSizes = new Map();
    let tableEntries = 0;
    let position = 12;
    if (kind === 'RF64') {
        const head = await context.read(position, 8);
        const length = new DataView(head.buffer, head.byteOffset).getUint32(4, true);
        if (initialSize !== 0xffffffff || tag(head) !== 'ds64' || length < 28 || length > context.size - 20) {
            throw new DemuxError('RF64 requires a leading ds64 chunk and RIFF size sentinel');
        }
        const data = await context.read(20, 28);
        const view = new DataView(data.buffer, data.byteOffset);
        end = Number(view.getBigUint64(0, true)) + 8;
        dataSize64 = Number(view.getBigUint64(8, true));
        declaredFrames = Number(view.getBigUint64(16, true));
        tableEntries = view.getUint32(24, true);
        if (!Number.isSafeInteger(dataSize64) ||
            !Number.isSafeInteger(declaredFrames) ||
            tableEntries > 4096 ||
            tableEntries > Math.floor((length - 28) / 12))
            throw new DemuxError('Invalid RF64 size table');
        const table = await context.read(48, tableEntries * 12);
        const sizes = new DataView(table.buffer, table.byteOffset, table.byteLength);
        for (let entry = 0; entry < tableEntries; entry++) {
            const id = tag(table, entry * 12);
            const size = Number(sizes.getBigUint64(entry * 12 + 4, true));
            if (!Number.isSafeInteger(size))
                throw new DemuxError('RF64 chunk size exceeds exact integer range');
            const queue = extendedSizes.get(id) ?? [];
            queue.push(size);
            extendedSizes.set(id, queue);
        }
        position = 20 + length + (length & 1);
    }
    else if (initialSize === 0xffffffff)
        throw new DemuxError('Unbounded RIFF requires an RF64 ds64 chunk');
    if (!Number.isSafeInteger(end) || end < position || end > context.size)
        throw new DemuxError('WAVE RIFF size exceeds input');
    if (end < context.size)
        context.diagnostics.recover({
            code: 'WAV_TRAILING_BYTES',
            format: 'wav',
            offset: end,
            message: 'Ignoring bytes after the declared WAVE RIFF boundary',
        });
    let format;
    let factFrames;
    let dataOffset = -1;
    let dataLength = 0;
    let chunks = 0;
    while (position < end) {
        if (++chunks > 4096 || end - position < 8)
            throw new DemuxError('WAVE chunk chain is truncated or too long');
        if ((chunks & 255) === 0)
            await context.checkpoint();
        const head = await context.read(position, 8);
        const id = tag(head);
        let length = new DataView(head.buffer, head.byteOffset).getUint32(4, true);
        if (length === 0xffffffff) {
            if (id === 'data' && dataSize64 >= 0)
                length = dataSize64;
            else {
                const extended = extendedSizes.get(id)?.shift();
                if (extended === undefined)
                    throw new DemuxError('RF64 chunk size sentinel has no ds64 table entry');
                length = extended;
                tableEntries--;
            }
        }
        const body = position + 8;
        if (length > end - body || (length & 1) > end - body - length)
            throw new DemuxError('WAVE chunk exceeds RIFF boundary');
        if (id === 'fmt ') {
            if (format || dataOffset >= 0 || length < 16)
                throw new DemuxError('WAVE requires one fmt chunk before data');
            if (length > MAX_WAVE_FORMAT_BYTES)
                throw new DemuxError('WAVE fmt exceeds the 65553-byte format limit');
            format = parseWaveFormat(await context.read(body, length));
        }
        else if (id === 'data') {
            if (!format || dataOffset >= 0 || length % format.blockAlign !== 0) {
                throw new DemuxError('WAVE requires one frame-aligned data chunk after fmt');
            }
            if (kind === 'RF64' && dataSize64 !== length)
                throw new DemuxError('RF64 data size disagrees with ds64');
            dataOffset = body;
            dataLength = length;
        }
        else if (id === 'fact') {
            if (factFrames !== undefined || length < 4)
                throw new DemuxError('WAVE fact chunk is repeated or truncated');
            const bytes = await context.read(body, 4);
            factFrames = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true);
        }
        else if (id === 'ds64')
            throw new DemuxError('Unexpected ds64 chunk in WAVE');
        position = body + length + (length & 1);
    }
    if (!format || dataOffset < 0)
        throw new DemuxError('WAVE is missing PCM format or data');
    if (tableEntries)
        throw new DemuxError('RF64 contains unused ds64 chunk sizes');
    const frames = dataLength / format.blockAlign;
    if (declaredFrames !== 0 && declaredFrames !== frames)
        throw new DemuxError('RF64 sample count disagrees with PCM data');
    if (factFrames !== undefined &&
        factFrames !== 0 &&
        !(kind === 'RF64' && factFrames === 0xffffffff) &&
        factFrames !== frames)
        throw new DemuxError('WAVE fact sample count disagrees with PCM data');
    return indexPcmAudio(context, format, dataOffset, dataLength);
}
async function indexFlac(context) {
    const first = await context.read(0, 42);
    if (tag(first) !== 'fLaC' || (first[4] & 127) !== 0 || first[5] !== 0 || first[6] !== 0 || first[7] !== 34) {
        throw new DemuxError('Native FLAC requires fLaC and a 34-byte STREAMINFO block');
    }
    const info = first.subarray(8);
    const minBlock = info[0] * 256 + info[1];
    const maxBlock = info[2] * 256 + info[3];
    const minFrame = info[4] * 65536 + info[5] * 256 + info[6];
    const maxFrame = info[7] * 65536 + info[8] * 256 + info[9];
    const sampleRate = info[10] * 4096 + info[11] * 16 + (info[12] >> 4);
    const channels = ((info[12] >> 1) & 7) + 1;
    const bits = (((info[12] & 1) << 4) | (info[13] >> 4)) + 1;
    const declaredSamples = (info[13] & 15) * 2 ** 32 + info[14] * 2 ** 24 + info[15] * 65536 + info[16] * 256 + info[17];
    if (minBlock < 16 ||
        maxBlock < minBlock ||
        sampleRate < 1 ||
        sampleRate > 655350 ||
        bits < 4 ||
        (minFrame > 0 && maxFrame > 0 && minFrame > maxFrame))
        throw new DemuxError('Invalid FLAC STREAMINFO audio shape');
    let offset = 4;
    let blocks = 0;
    let singletons = 0;
    const metadata = [];
    let configSize = 42;
    for (;;) {
        if (++blocks > 4096)
            throw new DemuxError('FLAC metadata chain exceeds 4096 blocks');
        const header = await context.read(offset, 4);
        const type = header[0] & 127;
        const length = header[1] * 65536 + header[2] * 256 + header[3];
        if (type === 127 || (blocks > 1 && type === 0) || length > context.size - offset - 4)
            throw new DemuxError('Invalid or truncated FLAC metadata block');
        if (type === 3 || type === 4) {
            const flag = 1 << type;
            if (singletons & flag)
                throw new DemuxError('Repeated singleton FLAC metadata block');
            singletons |= flag;
        }
        if (type === 4 || type === 6) {
            if (length + 4 > 16 * 1024 * 1024 - configSize) {
                context.diagnostics.recover({
                    code: 'FLAC_METADATA_LIMIT',
                    format: 'flac',
                    offset,
                    message: 'FLAC comment or picture exceeds the 16 MiB metadata preservation budget',
                });
            }
            else {
                metadata.push({ offset, size: length + 4, type });
                configSize += length + 4;
            }
        }
        offset += 4 + length;
        if (header[0] & 128)
            break;
        if ((blocks & 255) === 0)
            await context.checkpoint();
    }
    if (offset >= context.size)
        throw new DemuxError('FLAC contains no audio frames');
    const frameLimit = Math.min(context.maxPacketBytes, maxFrame || 4 * 1024 * 1024);
    const windowBytes = Math.min(64 * 1024 * 1024, Math.max(65536, frameLimit + MAX_FLAC_FRAME_HEADER_BYTES));
    let windowStart = -1;
    let window = new Uint8Array(0);
    const slide = async (at) => {
        windowStart = at;
        window = await context.read(at, Math.min(windowBytes, context.size - at));
    };
    const samples = [];
    let frames = 0;
    let strategy = -1;
    let fixedBlock = 0;
    while (offset < context.size) {
        if ((samples.length & 255) === 0)
            await context.checkpoint();
        if (offset < windowStart ||
            Math.min(context.size, offset + frameLimit + MAX_FLAC_FRAME_HEADER_BYTES) > windowStart + window.length)
            await slide(offset);
        const relative = offset - windowStart;
        const header = parseFlacFrameHeader(window, relative);
        if (!header ||
            header.channelCount !== channels ||
            (header.sampleRate ?? sampleRate) !== sampleRate ||
            (header.bitsPerSample ?? bits) !== bits ||
            header.blockSize > maxBlock)
            throw new DemuxError(`Invalid FLAC frame configuration at ${offset}`);
        if (strategy < 0) {
            strategy = header.blockingStrategy;
            fixedBlock = header.blockSize;
        }
        if (header.blockingStrategy !== strategy || header.codedNumber !== (strategy ? frames : samples.length)) {
            throw new DemuxError('FLAC frame numbering is discontinuous');
        }
        let end = -1;
        let candidates = 0;
        for (let cursor = relative + header.headerLen + 2; cursor <= Math.min(window.length - 6, relative + frameLimit); cursor++) {
            if (window[cursor] !== 255 || (window[cursor + 1] & 0xfc) !== 0xf8)
                continue;
            const next = parseFlacFrameHeader(window, cursor);
            if (!next)
                continue;
            if (++candidates > 64)
                throw new DemuxError('FLAC frame boundary exceeds CRC candidate budget');
            if (flacCrc16(window.subarray(relative, cursor - 2)) === window[cursor - 2] * 256 + window[cursor - 1]) {
                end = windowStart + cursor;
                break;
            }
        }
        if (end < 0) {
            const remaining = context.size - offset;
            if (remaining > frameLimit)
                throw new MediaForgeError('FLAC frame exceeds maxPacketBytes or STREAMINFO frame limit', 'OOM');
            if (remaining < header.headerLen + 2)
                throw new DemuxError('Truncated FLAC frame');
            const limit = relative + remaining;
            if (flacCrc16(window.subarray(relative, limit - 2)) !== window[limit - 2] * 256 + window[limit - 1])
                throw new DemuxError('FLAC frame CRC-16 mismatch');
            end = context.size;
        }
        if ((end < context.size && (header.blockSize < minBlock || (!strategy && header.blockSize !== fixedBlock))) ||
            (!strategy && header.blockSize > fixedBlock) ||
            (minFrame && end - offset < minFrame)) {
            throw new DemuxError('FLAC frame size disagrees with STREAMINFO or blocking strategy');
        }
        context.budget.reserveSamples(1, 256, 'FLAC sample index');
        samples.push({
            offset,
            size: end - offset,
            timestamp: frames / sampleRate,
            decodeTimestamp: frames / sampleRate,
            duration: header.blockSize / sampleRate,
            isKeyframe: true,
        });
        frames += header.blockSize;
        if (!Number.isSafeInteger(frames))
            throw new DemuxError('FLAC sample count exceeds exact integer range');
        offset = end;
    }
    if (declaredSamples && declaredSamples !== frames)
        throw new DemuxError('FLAC decoded sample count disagrees with STREAMINFO');
    const config = new Uint8Array(configSize);
    config.set(first);
    config[4] = metadata.length ? 0 : 128;
    let configOffset = 42;
    for (let index = 0; index < metadata.length; index++) {
        const block = metadata[index];
        config.set(await context.read(block.offset, block.size), configOffset);
        config[configOffset] = block.type | (index === metadata.length - 1 ? 128 : 0);
        configOffset += block.size;
    }
    return {
        id: 1,
        codec: 'flac',
        codecConfig: config,
        sampleRate,
        channelCount: channels,
        timescale: sampleRate,
        width: 0,
        height: 0,
        duration: frames / sampleRate,
        samples,
    };
}
