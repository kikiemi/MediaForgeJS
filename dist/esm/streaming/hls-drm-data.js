import { MediaForgeError } from '../core/errors.js';
const widevine = 'edef8ba979d64acea3c827dcd51d21ed';
const playready = '9a04f07998404286ab92e65be0885f95';
export function drmKeyFormats(keySystem) {
    if (keySystem === 'com.widevine.alpha')
        return ['urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed'];
    if (keySystem.startsWith('com.microsoft.playready'))
        return ['com.microsoft.playready', 'urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95'];
    if (keySystem === 'com.apple.fps')
        return ['com.apple.streamingkeydelivery'];
    return [keySystem];
}
function invalid(message) {
    throw new MediaForgeError(`HLS DRM: ${message}`, 'FORMAT');
}
function pssh(bytes, system) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 0;
    let count = 0;
    while (offset < bytes.length) {
        if (++count > 64 || bytes.length - offset < 32)
            invalid('invalid PSSH initialization data');
        const size = view.getUint32(offset);
        if (size < 32 ||
            size > bytes.length - offset ||
            view.getUint32(offset + 4) !== 0x70737368 ||
            bytes[offset + 8] > 1 ||
            (view.getUint32(offset + 8) & 0xffffff) !== 0)
            invalid('invalid PSSH box');
        for (let i = 0; i < 16; i++) {
            if (bytes[offset + 12 + i] !== Number.parseInt(system.slice(i * 2, i * 2 + 2), 16))
                invalid('PSSH system ID does not match KEYFORMAT');
        }
        let dataOffset = offset + 28;
        if (bytes[offset + 8] === 1) {
            const kids = view.getUint32(dataOffset);
            if (kids > Math.floor((size - 36) / 16))
                invalid('PSSH key IDs exceed the box');
            dataOffset += 4 + kids * 16;
        }
        if (dataOffset + 4 > offset + size || view.getUint32(dataOffset) !== offset + size - dataOffset - 4)
            invalid('invalid PSSH data length');
        offset += size;
    }
    if (!count)
        invalid('empty PSSH initialization data');
}
function playReadyPssh(data, limit) {
    if (data.length > limit - 32 || data.length < 6)
        invalid('invalid or oversized PlayReady object');
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (view.getUint32(0, true) !== data.length)
        invalid('invalid PlayReady object size');
    const count = view.getUint16(4, true);
    let offset = 6;
    for (let i = 0; i < count; i++) {
        if (offset > data.length - 4)
            invalid('truncated PlayReady record');
        offset += 4 + view.getUint16(offset + 2, true);
        if (offset > data.length)
            invalid('PlayReady record exceeds the object');
    }
    if (!count || offset !== data.length)
        invalid('invalid PlayReady records');
    const result = new Uint8Array(data.length + 32);
    const output = new DataView(result.buffer);
    output.setUint32(0, result.length);
    output.setUint32(4, 0x70737368);
    for (let i = 0; i < 16; i++)
        result[12 + i] = Number.parseInt(playready.slice(i * 2, i * 2 + 2), 16);
    output.setUint32(28, data.length);
    result.set(data, 32);
    return result;
}
export function drmInitData(key, limit) {
    const format = key.keyFormat;
    const uri = key.uri;
    if (!uri)
        return undefined;
    if (format === 'com.apple.streamingkeydelivery' && uri.startsWith('skd:')) {
        if (uri.length > limit)
            invalid('FairPlay initialization URI exceeds maxInitDataBytes');
        const data = new TextEncoder().encode(uri);
        if (data.length > limit)
            invalid('FairPlay initialization URI exceeds maxInitDataBytes');
        return { type: 'skd', data };
    }
    const system = format === 'urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed'
        ? widevine
        : format === 'com.microsoft.playready' || format === 'urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95'
            ? playready
            : undefined;
    if (!system || !uri.startsWith('data:'))
        return undefined;
    if (uri.length > limit * 4 + 1024)
        invalid('initialization URI exceeds maxInitDataBytes');
    const comma = uri.indexOf(',');
    if (comma < 0 || !/;base64$/i.test(uri.slice(0, comma)))
        invalid('DRM data URI requires base64');
    let encoded;
    try {
        encoded = decodeURIComponent(uri.slice(comma + 1));
    }
    catch {
        invalid('invalid initialization URI encoding');
    }
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded) ||
        encoded.length > Math.ceil(limit / 3) * 4)
        invalid('invalid or oversized base64 initialization data');
    let binary;
    try {
        binary = atob(encoded);
    }
    catch {
        invalid('invalid base64 initialization data');
    }
    if (!binary.length || binary.length > limit)
        invalid('initialization data exceeds maxInitDataBytes');
    const data = Uint8Array.from(binary, character => character.charCodeAt(0));
    if (system === playready && format === 'com.microsoft.playready')
        return { type: 'cenc', data: playReadyPssh(data, limit) };
    pssh(data, system);
    return { type: 'cenc', data };
}
