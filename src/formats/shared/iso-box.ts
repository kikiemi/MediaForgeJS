import { MediaForgeError } from '../../core/errors/errors';

/**
 * The box primitives of the ISO base media file format: four-character codes, 32-bit fields, boxes
 * and full boxes. The readers' metadata and colour modules write their boxes with these alone; the
 * box builders of the MP4 writers (iso-boxes) load with the writers.
 */

/** A Latin-1 string (a four-character code) as bytes. */
export function latin1(text: string): Uint8Array {
    const out = new Uint8Array(text.length);
    for (let index = 0; index < text.length; index++) out[index] = text.charCodeAt(index);
    return out;
}

/** Big-endian 32-bit unsigned fields, one after another. */
export function uint32(...values: readonly number[]): Uint8Array {
    const out = new Uint8Array(4 * values.length);
    const view = new DataView(out.buffer);
    values.forEach((value, index) => view.setUint32(4 * index, value >>> 0));
    return out;
}

/** A box: its 32-bit size, four-character type and payloads. */
export function isoBox(type: string, ...payloads: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
    const size = payloads.reduce((total, payload) => total + payload.length, 8);
    if (size > 0xffffffff)
        throw new MediaForgeError(`MP4 '${type}' box exceeds the 4 GiB box size limit`, 'MUX');
    const out = new Uint8Array(size);
    new DataView(out.buffer).setUint32(0, size);
    out.set(latin1(type), 4);
    let at = 8;
    for (const payload of payloads) {
        out.set(payload, at);
        at += payload.length;
    }
    return out;
}

/** A full box: a box whose payload starts with an 8-bit version and 24-bit flags. */
export function isoFullBox(
    type: string,
    version: number,
    flags: number,
    ...payloads: readonly Uint8Array[]
): Uint8Array<ArrayBuffer> {
    return isoBox(type, Uint8Array.of(version, flags >>> 16, flags >>> 8, flags), ...payloads);
}
