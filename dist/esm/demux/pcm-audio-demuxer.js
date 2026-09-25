import { DemuxError, MediaForgeError } from '../core/errors.js';
function requireValue(value, message) {
    if (!value)
        throw new DemuxError(message);
}
function tag(bytes, offset = 0) {
    return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}
export async function indexPcmAudio(context, format, dataOffset, dataLength) {
    const { sampleRate, channels, blockAlign: stride, codec, codecConfig } = format;
    requireValue(dataLength % stride === 0, 'PCM data ends inside a sample frame');
    const frames = dataLength / stride;
    const framesPerPacket = Math.min(4096, Math.floor(context.maxPacketBytes / stride));
    if (framesPerPacket < 1)
        throw new MediaForgeError('One PCM frame exceeds maxPacketBytes', 'OOM');
    context.budget.reserveSamples(Math.ceil(frames / framesPerPacket), 256, 'PCM sample index');
    const samples = [];
    for (let start = 0; start < frames; start += framesPerPacket) {
        if ((samples.length & 4095) === 0)
            await context.checkpoint();
        const count = Math.min(framesPerPacket, frames - start);
        samples.push({
            offset: dataOffset + start * stride,
            size: count * stride,
            timestamp: start / sampleRate,
            decodeTimestamp: start / sampleRate,
            duration: count / sampleRate,
            isKeyframe: true,
        });
    }
    return {
        id: 1,
        codec,
        codecConfig,
        sampleRate,
        channelCount: channels,
        timescale: sampleRate,
        width: 0,
        height: 0,
        duration: frames / sampleRate,
        samples,
    };
}
function sampleRate80(bytes, at) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const exponent = view.getUint16(at) - 16383;
    const mantissa = view.getBigUint64(at + 2);
    requireValue(exponent >= 0 && exponent <= 19 && mantissa >= 1n << 63n, 'AIFF requires a finite positive normalized sample rate in 1..768000');
    const shift = BigInt(63 - exponent);
    const rate = Number(mantissa >> shift);
    requireValue((mantissa & ((1n << shift) - 1n)) === 0n && rate >= 1 && rate <= 768000, 'AIFF requires an exact integer sample rate in 1..768000');
    return rate;
}
function aiffCodec(compression, bits) {
    if (compression === 'NONE' || compression === 'twos') {
        requireValue([8, 16, 24, 32].includes(bits), 'AIFF supports signed integer8/16/24/32');
        return bits === 8 ? 'pcm-s8' : `pcm-s${bits}be`;
    }
    if (compression === 'sowt' && bits === 16)
        return 'pcm-s16le';
    if (compression === 'raw ' && bits === 8)
        return 'pcm-u8';
    if (compression === 'in24' && bits === 24)
        return 'pcm-s24be';
    if (compression === 'in32' && bits === 32)
        return 'pcm-s32be';
    if ((compression === 'fl32' || compression === 'FL32') && bits === 32)
        return 'pcm-f32be';
    if ((compression === 'fl64' || compression === 'FL64') && bits === 64)
        return 'pcm-f64be';
    throw new DemuxError(`Unsupported AIFC compression '${compression}' or sample width`);
}
export async function indexAiff(context) {
    const first = await context.read(0, 12);
    const kind = tag(first, 8);
    requireValue(tag(first) === 'FORM' && (kind === 'AIFF' || kind === 'AIFC'), 'Invalid AIFF/AIFC FORM header');
    const end = new DataView(first.buffer, first.byteOffset, first.byteLength).getUint32(4) + 8;
    requireValue(end >= 12 && end <= context.size, 'AIFF FORM size exceeds input');
    if (end < context.size)
        context.diagnostics.recover({
            code: 'AIFF_TRAILING_BYTES',
            format: 'aiff',
            offset: end,
            message: 'Ignoring bytes after the declared AIFF FORM boundary',
        });
    let format;
    let declaredFrames = 0;
    let dataOffset = -1;
    let dataLength = 0;
    let version = false;
    let position = 12;
    let chunks = 0;
    while (position < end) {
        requireValue(++chunks <= 4096 && end - position >= 8, 'AIFF chunk chain is truncated or exceeds 4096 chunks');
        if ((chunks & 255) === 0)
            await context.checkpoint();
        const head = await context.read(position, 8);
        const id = tag(head);
        const length = new DataView(head.buffer, head.byteOffset, head.byteLength).getUint32(4);
        const body = position + 8;
        requireValue(length <= end - body && (length & 1) <= end - body - length, 'AIFF chunk exceeds its FORM boundary or padding');
        if (id === 'FVER') {
            requireValue(kind === 'AIFC' && !version && length === 4, 'Invalid or repeated AIFC FVER chunk');
            const bytes = await context.read(body, 4);
            requireValue(new DataView(bytes.buffer, bytes.byteOffset).getUint32(0) === 0xa2805140, 'Unsupported AIFC version');
            version = true;
        }
        else if (id === 'COMM') {
            requireValue(!format && (kind === 'AIFF' ? length === 18 : length >= 24 && length <= 278), 'Invalid or repeated AIFF COMM chunk');
            const bytes = await context.read(body, length);
            const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            const channels = view.getUint16(0);
            declaredFrames = view.getUint32(2);
            const bits = view.getUint16(6);
            const sampleRate = sampleRate80(bytes, 8);
            requireValue(channels >= 1 && channels <= 2, 'AIFF packet input currently supports mono/stereo channel layouts');
            if (kind === 'AIFC') {
                const nameBytes = bytes[22] + 1;
                requireValue(length === 22 + nameBytes + (nameBytes & 1), 'Invalid AIFC compression-name extent');
            }
            const codec = aiffCodec(kind === 'AIFF' ? 'NONE' : tag(bytes, 18), bits);
            format = { codec, sampleRate, channels, blockAlign: channels * (bits / 8) };
        }
        else if (id === 'SSND') {
            requireValue(dataOffset < 0 && length >= 8, 'Invalid or repeated AIFF SSND chunk');
            const bytes = await context.read(body, 8);
            const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            const offset = view.getUint32(0);
            requireValue(offset <= length - 8 && view.getUint32(4) === 0, 'AIFF SSND offset exceeds its payload or uses unsupported block organization');
            dataOffset = body + 8 + offset;
            dataLength = length - 8 - offset;
        }
        else if (id === 'CHAN')
            throw new DemuxError('Explicit AIFF CHAN layouts are not supported by this PCM input path');
        position = body + length + (length & 1);
    }
    requireValue(format && dataOffset >= 0, 'AIFF requires one COMM and one SSND chunk');
    requireValue(kind !== 'AIFC' || version, 'AIFC requires its FVER version chunk');
    requireValue(declaredFrames * format.blockAlign === dataLength, 'AIFF sample-frame count disagrees with SSND audio bytes');
    return indexPcmAudio(context, format, dataOffset, dataLength);
}
export async function indexAu(context) {
    const bytes = await context.read(0, 24);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    requireValue(tag(bytes) === '.snd', 'Invalid AU header');
    const dataOffset = view.getUint32(4);
    const declared = view.getUint32(8);
    const encoding = view.getUint32(12);
    const sampleRate = view.getUint32(16);
    const channels = view.getUint32(20);
    requireValue(dataOffset >= 24 && dataOffset <= context.size, 'AU data offset exceeds input or overlaps its header');
    requireValue(declared < 0x80000000 || declared === 0xffffffff, 'AU declared data size uses an unsupported signed extent');
    requireValue(sampleRate >= 1 && sampleRate <= 768000 && channels >= 1 && channels <= 2, 'AU packet input supports mono/stereo and a sample rate in 1..768000');
    const codecs = ['pcm-s8', 'pcm-s16be', 'pcm-s24be', 'pcm-s32be', 'pcm-f32be', 'pcm-f64be'];
    requireValue(encoding >= 2 && encoding <= 7, 'AU packet input supports PCM encodings 2..7');
    const bits = [8, 16, 24, 32, 32, 64][encoding - 2];
    const dataLength = declared === 0xffffffff ? context.size - dataOffset : declared;
    requireValue(dataLength <= context.size - dataOffset, 'AU declared data size exceeds input');
    const end = dataOffset + dataLength;
    if (end < context.size)
        context.diagnostics.recover({
            code: 'AU_TRAILING_BYTES',
            format: 'au',
            offset: end,
            message: 'Ignoring bytes after the declared AU audio extent',
        });
    return indexPcmAudio(context, { codec: codecs[encoding - 2], sampleRate, channels, blockAlign: channels * (bits / 8) }, dataOffset, dataLength);
}
