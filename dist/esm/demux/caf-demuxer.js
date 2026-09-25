import { DemuxError } from '../core/errors.js';
import { indexPcmAudio } from './pcm-audio-demuxer.js';
function requireValue(value, message) {
    if (!value)
        throw new DemuxError(message);
}
function tag(bytes, at = 0) {
    return String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
}
export async function indexCaf(context) {
    const first = await context.read(0, 8);
    const header = new DataView(first.buffer, first.byteOffset, first.byteLength);
    requireValue(tag(first) === 'caff' && header.getUint16(4) === 1, 'CAF requires a caff version 1 header');
    if (header.getUint16(6) !== 0)
        context.diagnostics.warn({
            code: 'CAF_HEADER_FLAGS',
            format: 'caf',
            offset: 6,
            message: 'Ignoring reserved CAF file-header flags',
        });
    let format;
    let dataOffset = -1;
    let dataLength = 0;
    let packetFrames;
    let layout = false;
    let position = 8;
    let chunks = 0;
    while (position < context.size) {
        requireValue(++chunks <= 4096 && context.size - position >= 12, 'CAF chunk chain is truncated or exceeds 4096 chunks');
        if ((chunks & 255) === 0)
            await context.checkpoint();
        const bytes = await context.read(position, 12);
        const type = tag(bytes);
        const declared = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigInt64(4);
        const body = position + 12;
        const available = context.size - body;
        requireValue((declared >= 0n && declared <= BigInt(available)) || (declared === -1n && type === 'data'), 'CAF chunk has an invalid signed extent or exceeds input');
        const length = declared === -1n ? available : Number(declared);
        requireValue(chunks !== 1 || type === 'desc', 'CAF requires desc immediately after its file header');
        if (type === 'desc') {
            requireValue(!format && chunks === 1 && length === 32, 'CAF requires one leading 32-byte desc chunk');
            const data = await context.read(body, 32);
            const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
            const sampleRate = view.getFloat64(0);
            const flags = view.getUint32(12);
            const blockAlign = view.getUint32(16);
            const channels = view.getUint32(24);
            const bits = view.getUint32(28);
            const float = !!(flags & 1);
            requireValue(tag(data, 8) === 'lpcm' && (flags & ~3) === 0, 'CAF input supports only LPCM float/little-endian flags');
            requireValue(Number.isInteger(sampleRate) &&
                sampleRate >= 1 &&
                sampleRate <= 768000 &&
                channels >= 1 &&
                channels <= 2, 'CAF PCM requires mono/stereo and an integer rate in 1..768000');
            requireValue((float ? [32, 64] : [8, 16, 24, 32]).includes(bits) &&
                view.getUint32(20) === 1 &&
                blockAlign === channels * (bits / 8), 'CAF PCM requires full-width packed samples and one frame per packet');
            const codec = bits === 8 ? 'pcm-s8' : `pcm-${float ? 'f' : 's'}${bits}${flags & 2 ? 'le' : 'be'}`;
            format = { codec, sampleRate, channels, blockAlign };
        }
        else if (type === 'data') {
            requireValue(format && dataOffset < 0 && length >= 4, 'CAF requires one data chunk with its edit count');
            dataOffset = body + 4;
            dataLength = length - 4;
        }
        else if (type === 'chan') {
            requireValue(format && !layout && length === 12, 'CAF supports one canonical mono/stereo channel layout');
            const data = await context.read(body, 12);
            const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
            const layoutTag = view.getUint32(0);
            const bitmap = view.getUint32(4);
            const canonical = format.channels === 1 ? 0x00640001 : 0x00650002;
            requireValue(view.getUint32(8) === 0 &&
                ((layoutTag === canonical && bitmap === 0) ||
                    (layoutTag === 0x10000 && bitmap === (format.channels === 1 ? 4 : 3))), 'CAF channel layout cannot be preserved as canonical mono/stereo');
            layout = true;
        }
        else if (type === 'pakt') {
            requireValue(packetFrames === undefined && length === 24, 'CAF LPCM supports one fixed packet table without variable entries');
            const data = await context.read(body, 24);
            const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
            packetFrames = view.getBigInt64(0);
            requireValue(packetFrames >= 0n &&
                view.getBigInt64(8) === packetFrames &&
                view.getInt32(16) === 0 &&
                view.getInt32(20) === 0, 'CAF LPCM packet table must have matching counts and no priming or remainder');
        }
        position = body + length;
    }
    requireValue(format && dataOffset >= 0, 'CAF requires desc and data chunks');
    requireValue(dataLength % format.blockAlign === 0, 'CAF audio data ends inside a sample frame');
    if (packetFrames !== undefined)
        requireValue(packetFrames === BigInt(dataLength / format.blockAlign), 'CAF packet table disagrees with its PCM data size');
    return indexPcmAudio(context, format, dataOffset, dataLength);
}
