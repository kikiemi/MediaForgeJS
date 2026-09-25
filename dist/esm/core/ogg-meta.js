import { MediaForgeError } from './errors.js';
import { oggCrc32 } from './ogg-crc.js';
function u32le(bytes, offset) {
    return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}
function startsWith(bytes, text) {
    if (bytes.length < text.length)
        return false;
    for (let index = 0; index < text.length; index++) {
        if (bytes[index] !== text.charCodeAt(index))
            return false;
    }
    return true;
}
function identifyCodec(prefix, size) {
    if (startsWith(prefix, 'OpusHead') && size >= 19 && prefix[8] < 16 && prefix[9] > 0)
        return 'opus';
    if (startsWith(prefix, '\x01vorbis') &&
        size >= 30 &&
        u32le(prefix, 7) === 0 &&
        prefix[11] > 0 &&
        u32le(prefix, 12) > 0 &&
        (prefix[29] & 1) !== 0)
        return 'vorbis';
    return null;
}
function commentPayload(packet, codec) {
    const prefix = codec === 'opus' ? 'OpusTags' : '\x03vorbis';
    if (!startsWith(packet, prefix))
        return null;
    let position = prefix.length;
    if (packet.length - position < 8)
        return null;
    const vendorBytes = u32le(packet, position);
    position += 4;
    if (vendorBytes > packet.length - position - 4)
        return null;
    position += vendorBytes;
    const comments = u32le(packet, position);
    position += 4;
    if (comments > Math.floor((packet.length - position) / 4))
        return null;
    for (let index = 0; index < comments; index++) {
        if (packet.length - position < 4)
            return null;
        const length = u32le(packet, position);
        position += 4;
        if (length > packet.length - position)
            return null;
        position += length;
    }
    if (codec === 'vorbis') {
        if (position >= packet.length || (packet[position] & 1) === 0)
            return null;
        return packet.slice(prefix.length, position);
    }
    return packet.slice(prefix.length);
}
async function readBytes(file, start, length, signal) {
    signal?.throwIfAborted();
    const pending = file.slice(start, start + length).arrayBuffer();
    let onAbort = () => undefined;
    const aborted = new Promise((_resolve, reject) => {
        onAbort = () => reject(signal.reason);
        if (signal?.aborted)
            onAbort();
        else
            signal?.addEventListener('abort', onAbort, { once: true });
    });
    try {
        const buffer = await Promise.race([pending, aborted]);
        signal?.throwIfAborted();
        if (buffer.byteLength !== length)
            throw new MediaForgeError('Ogg metadata read was truncated', 'IO');
        return new Uint8Array(buffer);
    }
    finally {
        signal?.removeEventListener('abort', onAbort);
    }
}
export async function readOggCommentPayload(file, signal, maxPayloadBytes = 4 * 1024 * 1024) {
    signal?.throwIfAborted();
    if (!Number.isSafeInteger(maxPayloadBytes) || maxPayloadBytes < 0) {
        throw new MediaForgeError('Ogg metadata byte limit must be a nonnegative safe integer', 'FORMAT');
    }
    if (!Number.isSafeInteger(file.size) || file.size < 27 || maxPayloadBytes === 0)
        return null;
    const scanLimit = Math.min(file.size, Number.MAX_SAFE_INTEGER, maxPayloadBytes + 65536);
    const streams = new Map();
    const parts = [];
    let selected = null;
    let offset = 0;
    let pages = 0;
    while (scanLimit - offset >= 27 && ++pages <= 4096) {
        signal?.throwIfAborted();
        const header = await readBytes(file, offset, 27, signal);
        if (!startsWith(header, 'OggS') || header[4] !== 0 || (header[5] & 0xf8) !== 0)
            return null;
        const flags = header[5];
        const segmentCount = header[26];
        if (segmentCount > scanLimit - offset - 27)
            return null;
        const lacing = await readBytes(file, offset + 27, segmentCount, signal);
        let payloadBytes = 0;
        for (const length of lacing)
            payloadBytes += length;
        const pageBytes = 27 + segmentCount + payloadBytes;
        if (pageBytes > scanLimit - offset)
            return null;
        const payload = await readBytes(file, offset + 27 + segmentCount, payloadBytes, signal);
        const encoded = new Uint8Array(pageBytes);
        encoded.set(header);
        encoded.set(lacing, 27);
        encoded.set(payload, 27 + segmentCount);
        encoded.fill(0, 22, 26);
        if (oggCrc32(encoded) !== u32le(header, 22))
            return null;
        const serial = u32le(header, 14), sequence = u32le(header, 18);
        let state = streams.get(serial);
        if (!state) {
            if ((flags & 3) !== 2 || sequence !== 0 || streams.size >= 64)
                return null;
            state = {
                sequence,
                packetIndex: 0,
                packetBytes: 0,
                open: false,
                ended: false,
                prefix: new Uint8Array(30),
                codec: null,
            };
            streams.set(serial, state);
        }
        else if (state.ended || (flags & 2) !== 0 || sequence !== (state.sequence + 1) >>> 0) {
            return null;
        }
        state.sequence = sequence;
        if (segmentCount > 0 && ((flags & 1) !== 0) !== state.open)
            return null;
        let bodyOffset = 0;
        let captureStart = null;
        for (let index = 0; index < lacing.length; index++) {
            const length = lacing[index];
            if (state.packetIndex === 0 && state.packetBytes < state.prefix.length) {
                state.prefix.set(payload.subarray(bodyOffset, bodyOffset + Math.min(length, state.prefix.length - state.packetBytes)), state.packetBytes);
            }
            if (state === selected && state.packetIndex === 1)
                captureStart ??= bodyOffset;
            state.packetBytes += length;
            bodyOffset += length;
            state.open = length === 255;
            if (state.packetIndex === 0 && state.packetBytes > 65536)
                return null;
            if (state === selected && state.packetIndex === 1 && state.packetBytes > maxPayloadBytes)
                return null;
            if (state.open)
                continue;
            if (state.packetIndex === 0) {
                state.codec = identifyCodec(state.prefix, state.packetBytes);
                if (state.codec) {
                    if ((flags & 2) === 0 || index !== lacing.length - 1)
                        return null;
                    selected ??= state;
                }
            }
            else if (state === selected && state.packetIndex === 1) {
                if (state.codec === 'opus' && index !== lacing.length - 1)
                    return null;
                parts.push(payload.subarray(captureStart, bodyOffset));
                const packet = new Uint8Array(state.packetBytes);
                let written = 0;
                for (const part of parts) {
                    packet.set(part, written);
                    written += part.length;
                }
                signal?.throwIfAborted();
                return commentPayload(packet, state.codec);
            }
            state.packetIndex++;
            state.packetBytes = 0;
        }
        if (captureStart !== null)
            parts.push(payload.subarray(captureStart, bodyOffset));
        if ((flags & 4) !== 0) {
            if (state.open)
                return null;
            state.ended = true;
        }
        offset += pageBytes;
    }
    return null;
}
