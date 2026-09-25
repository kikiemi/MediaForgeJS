import { ChunkReader } from '../io/chunk-reader.js';
import { parseAdtsFrameHeader, buildAacConfig } from '../audio/adts.js';
import { parseMpegAudioHeader, isMpegAudioTrailerHeader } from '../core/mpeg-audio-header.js';
import { DiagnosticContext } from '../core/diagnostics.js';
import { awaitWithAbort } from '../core/abort.js';
import { DemuxError, MediaForgeError } from '../core/errors.js';
import { DemuxIndexBudget, resolveDemuxBudget, yieldEventLoop } from '../core/demux-guard.js';
export class UnsupportedAdtsLayoutError extends DemuxError {
    constructor() {
        super('ADTS program-config channel layouts require an external parser');
    }
}
export async function demuxRawAudio(source, options) {
    const diagnostics = new DiagnosticContext(options, 'compatible');
    if (!['aac', 'mp1', 'mp2', 'mp3'].includes(options.format))
        throw new DemuxError('Unsupported raw audio format');
    const budget = new DemuxIndexBudget(resolveDemuxBudget(options, 2_000_000));
    const reader = new ChunkReader(source);
    const read = async (offset, count) => {
        if (options.signal?.aborted)
            throw new MediaForgeError('Aborted', 'ABORT');
        return awaitWithAbort(reader.bytes(offset, count), options.signal);
    };
    let offset = 0;
    for (let tags = 0; tags < 16; tags++) {
        const head = await read(offset, 10);
        if (head.length < 10 || head[0] !== 73 || head[1] !== 68 || head[2] !== 51)
            break;
        if (head[3] < 2 || head[3] > 4 || head.subarray(6, 10).some(value => value > 127))
            throw new DemuxError('Invalid ID3 header');
        const size = 10 +
            head[6] * 2097152 +
            head[7] * 16384 +
            head[8] * 128 +
            head[9] +
            (head[3] === 4 && (head[5] & 16) !== 0 ? 10 : 0);
        if (size > source.size - offset)
            throw new DemuxError('Truncated ID3 tag');
        offset += size;
    }
    const samples = [];
    let sampleRate = 0;
    let channels = 0;
    let codec = options.format;
    let codecConfig;
    let frameSamples = 0;
    let window = new Uint8Array(0);
    let windowStart = offset;
    while (offset < source.size) {
        if ((samples.length & 1023) === 0)
            await yieldEventLoop();
        if (options.signal?.aborted)
            throw new MediaForgeError('Aborted', 'ABORT');
        if (offset + Math.min(10, source.size - offset) > windowStart + window.length) {
            windowStart = offset;
            window = await read(offset, 65536 + 10);
            if (options.signal?.aborted)
                throw new MediaForgeError('Aborted', 'ABORT');
        }
        const headerOffset = offset - windowStart;
        if (window[headerOffset] !== 255 &&
            isMpegAudioTrailerHeader(window.subarray(headerOffset), source.size - offset))
            break;
        const adts = options.format === 'aac' ? parseAdtsFrameHeader(window, headerOffset) : null;
        const mpeg = options.format !== 'aac' ? parseMpegAudioHeader(window, headerOffset) : null;
        if (adts?.channels === 0)
            throw new UnsupportedAdtsLayoutError();
        if (adts && adts.rawDataBlocks !== 0)
            throw new DemuxError('ADTS multiple raw_data_blocks require an external parser');
        if (mpeg && mpeg.format !== options.format)
            throw new DemuxError('MPEG audio layer changes within the stream');
        const length = adts?.frameLength ?? mpeg?.frameLength ?? 0;
        if ((!adts && !mpeg) || length > source.size - offset) {
            if (diagnostics.validation === 'strict') {
                throw new DemuxError(`${length ? 'Truncated' : 'Invalid'} ${options.format} frame at ${offset}`);
            }
            const next = await findAudioFrameChain(read, source.size, offset + 1, options.format, sampleRate, channels, codec);
            if (next < 0) {
                if (!samples.length)
                    throw new DemuxError('No complete audio frames');
                diagnostics.recover({
                    code: 'AUDIO_TRUNCATED_TAIL',
                    format: options.format,
                    offset,
                    message: `Ignored damaged audio tail at byte ${offset}; retained ${samples.length} complete frames`,
                });
                break;
            }
            diagnostics.recover({
                code: options.format === 'aac' ? 'ADTS_RESYNCHRONIZED' : 'MPEG_RESYNCHRONIZED',
                format: options.format,
                offset,
                message: `Skipped ${next - offset} damaged bytes; resumed a verified ${options.format} frame chain at byte ${next}`,
            });
            offset = next;
            continue;
        }
        const rate = adts?.sampleRate ?? mpeg.sampleRate;
        const channelCount = adts?.channels ?? mpeg.channels;
        const frameCodec = adts ? `mp4a.40.${adts.audioObjectType}` : codec;
        if (samples.length && (sampleRate !== rate || channels !== channelCount || codec !== frameCodec)) {
            throw new DemuxError('Raw audio codec configuration changes within the stream');
        }
        sampleRate = rate;
        channels = channelCount;
        codec = frameCodec;
        if (adts && !codecConfig)
            codecConfig = buildAacConfig(rate, channelCount, adts.audioObjectType);
        const durationSamples = adts ? 1024 : mpeg.samplesPerFrame;
        const skip = adts?.headerLength ?? 0;
        budget.reserveSamples(1, 256, 'Raw audio sample index');
        samples.push({
            offset: offset + skip,
            size: length - skip,
            timestamp: frameSamples / sampleRate,
            decodeTimestamp: frameSamples / sampleRate,
            duration: durationSamples / sampleRate,
            isKeyframe: true,
        });
        frameSamples += durationSamples;
        offset += length;
    }
    if (!samples.length)
        throw new DemuxError('No complete audio frames');
    if (options.format === 'mp3')
        diagnostics.warn({
            code: 'MPEG_GAPLESS_METADATA',
            format: options.format,
            message: 'Packet timing describes coded MPEG audio frames; Xing/LAME gapless trim is not interpreted',
        });
    if (options.signal?.aborted)
        throw new MediaForgeError('Aborted', 'ABORT');
    const track = {
        id: 1,
        codec,
        codecConfig,
        sampleRate,
        channelCount: channels,
        timescale: sampleRate,
        duration: frameSamples / sampleRate,
        width: 0,
        height: 0,
        samples,
    };
    return { videoTracks: [], audioTracks: [track] };
}
function syncFrame(bytes, offset, format) {
    if (format === 'aac') {
        const frame = parseAdtsFrameHeader(bytes, offset);
        if (!frame || frame.rawDataBlocks !== 0 || frame.channels === 0)
            return null;
        return { ...frame, codec: `mp4a.40.${frame.audioObjectType}` };
    }
    const frame = parseMpegAudioHeader(bytes, offset);
    return frame?.format === format ? { ...frame, codec: frame.format } : null;
}
async function findAudioFrameChain(read, size, start, format, sampleRate, channels, codec) {
    const end = Math.min(size, start + 1024 * 1024);
    const matches = (header) => !!header &&
        (!sampleRate || (header.sampleRate === sampleRate && header.codec === codec)) &&
        (!channels || header.channels === channels);
    for (let base = start; base < end; base += 65536) {
        await yieldEventLoop();
        const bytes = await read(base, Math.min(65536 + (format === 'aac' ? 3 * 8191 + 10 : 16384), size - base));
        const count = Math.min(65536, end - base, bytes.length - 3);
        for (let index = 0; index < count; index++) {
            if (bytes[index] !== 255)
                continue;
            const first = syncFrame(bytes, index, format);
            if (!matches(first))
                continue;
            let position = index;
            let verified = 0;
            while (verified < 3) {
                const header = syncFrame(bytes, position, format);
                if (!matches(header) ||
                    header.sampleRate !== first.sampleRate ||
                    header.channels !== first.channels ||
                    header.codec !== first.codec ||
                    header.frameLength > size - base - position)
                    break;
                position += header.frameLength;
                verified++;
                if (verified >= 2 &&
                    (base + position === size ||
                        isMpegAudioTrailerHeader(bytes.subarray(position), size - base - position)))
                    return base + index;
            }
            if (verified === 3)
                return base + index;
        }
    }
    if (end < size)
        throw new DemuxError('Audio resynchronization exceeds the 1 MiB search budget');
    return -1;
}
