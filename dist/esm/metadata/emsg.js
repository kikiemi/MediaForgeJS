import { MediaForgeError } from '../core/errors.js';
const MAX_BYTES = 16 * 1024 * 1024;
const encoder = new TextEncoder();
function uint32(value, name) {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
        throw new MediaForgeError(`${name} must be an unsigned 32-bit integer`, 'INPUT');
    }
    return value;
}
export function encodeEventMessage(event) {
    if (event.version !== 0 && event.version !== 1)
        throw new MediaForgeError('Unsupported emsg version', 'INPUT');
    if (!event.timescale)
        throw new MediaForgeError('emsg timescale must be positive', 'INPUT');
    uint32(event.timescale, 'timescale');
    uint32(event.eventDuration, 'eventDuration');
    uint32(event.id, 'id');
    if (typeof event.schemeIdUri !== 'string' ||
        typeof event.value !== 'string' ||
        event.schemeIdUri.includes('\0') ||
        event.value.includes('\0')) {
        throw new MediaForgeError('emsg strings cannot contain NUL', 'INPUT');
    }
    if (!(event.messageData instanceof Uint8Array) ||
        event.messageData.length > MAX_BYTES ||
        event.schemeIdUri.length > MAX_BYTES ||
        event.value.length > MAX_BYTES) {
        throw new MediaForgeError('emsg exceeds its byte budget', 'INPUT');
    }
    const scheme = encoder.encode(event.schemeIdUri);
    const value = encoder.encode(event.value);
    const length = 12 + (event.version === 1 ? 20 : 16) + scheme.length + value.length + 2 + event.messageData.length;
    if (length > MAX_BYTES)
        throw new MediaForgeError('emsg exceeds its byte budget', 'INPUT');
    const bytes = new Uint8Array(length);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, length);
    bytes.set(encoder.encode('emsg'), 4);
    bytes[8] = event.version;
    let offset = 12;
    const strings = () => {
        bytes.set(scheme, offset);
        offset += scheme.length + 1;
        bytes.set(value, offset);
        offset += value.length + 1;
    };
    if (event.version === 0)
        strings();
    view.setUint32(offset, event.timescale);
    offset += 4;
    if (event.version === 1) {
        if (typeof event.presentationTime !== 'bigint' ||
            event.presentationTime < 0n ||
            event.presentationTime > 0xffffffffffffffffn) {
            throw new MediaForgeError('emsg presentationTime must fit an unsigned 64-bit integer', 'INPUT');
        }
        view.setBigUint64(offset, event.presentationTime);
        offset += 8;
    }
    else {
        view.setUint32(offset, uint32(event.presentationTimeDelta, 'presentationTimeDelta'));
        offset += 4;
    }
    view.setUint32(offset, event.eventDuration);
    offset += 4;
    view.setUint32(offset, event.id);
    offset += 4;
    if (event.version === 1)
        strings();
    bytes.set(event.messageData, offset);
    return bytes;
}
export function decodeEventMessage(bytes) {
    if (bytes.length < 12 || bytes.length > MAX_BYTES)
        throw new MediaForgeError('Invalid emsg size', 'DEMUX');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let header = 8;
    let size = view.getUint32(0);
    if (size === 1) {
        if (bytes.length < 20)
            throw new MediaForgeError('Truncated extended emsg box', 'DEMUX');
        const extended = view.getBigUint64(8);
        if (extended > BigInt(MAX_BYTES))
            throw new MediaForgeError('emsg size exceeds budget', 'DEMUX');
        size = Number(extended);
        header = 16;
    }
    else if (size === 0)
        size = bytes.length;
    if (size !== bytes.length || String.fromCharCode(...bytes.subarray(4, 8)) !== 'emsg') {
        throw new MediaForgeError('Expected one complete emsg box', 'DEMUX');
    }
    const version = bytes[header];
    if ((version !== 0 && version !== 1) || bytes[header + 1] || bytes[header + 2] || bytes[header + 3]) {
        throw new MediaForgeError('Unsupported emsg version or flags', 'DEMUX');
    }
    let offset = header + 4;
    const need = (length) => {
        if (length > bytes.length - offset)
            throw new MediaForgeError('Truncated emsg payload', 'DEMUX');
    };
    const readString = () => {
        const end = bytes.indexOf(0, offset);
        if (end < 0)
            throw new MediaForgeError('Unterminated emsg string', 'DEMUX');
        let result;
        try {
            result = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(offset, end));
        }
        catch {
            throw new MediaForgeError('Invalid UTF-8 emsg string', 'DEMUX');
        }
        offset = end + 1;
        return result;
    };
    let schemeIdUri = '';
    let value = '';
    if (version === 0) {
        schemeIdUri = readString();
        value = readString();
    }
    need(version === 0 ? 16 : 20);
    const timescale = view.getUint32(offset);
    offset += 4;
    if (!timescale)
        throw new MediaForgeError('emsg timescale must be positive', 'DEMUX');
    const presentationTime = version === 1 ? view.getBigUint64(offset) : BigInt(view.getUint32(offset));
    offset += version === 1 ? 8 : 4;
    const eventDuration = view.getUint32(offset);
    offset += 4;
    const id = view.getUint32(offset);
    offset += 4;
    if (version === 1) {
        schemeIdUri = readString();
        value = readString();
    }
    const common = {
        schemeIdUri,
        value,
        timescale,
        eventDuration,
        id,
        messageData: new Uint8Array(bytes.subarray(offset)),
    };
    return version === 1
        ? { ...common, version, presentationTime }
        : { ...common, version, presentationTimeDelta: Number(presentationTime) };
}
export function eventMessageTime(event, segmentStartTime) {
    uint32(event.timescale, 'timescale');
    if (!event.timescale)
        throw new MediaForgeError('emsg timescale must be positive', 'INPUT');
    if (event.version === 0) {
        uint32(event.presentationTimeDelta, 'presentationTimeDelta');
        if (!Number.isFinite(segmentStartTime))
            throw new MediaForgeError('Version 0 emsg needs a segment presentation start', 'INPUT');
        return segmentStartTime + event.presentationTimeDelta / event.timescale;
    }
    if (event.version !== 1 || typeof event.presentationTime !== 'bigint' || event.presentationTime < 0n) {
        throw new MediaForgeError('Invalid emsg version or presentation time', 'INPUT');
    }
    if (event.presentationTime > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new MediaForgeError('emsg timestamp exceeds exact Number precision; use presentationTime bigint', 'INPUT');
    }
    return Number(event.presentationTime) / event.timescale;
}
