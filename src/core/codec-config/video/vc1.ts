import { findStartCode } from './mpeg-video';

/** SMPTE 421M Annex E start codes of the advanced profile elementary stream. */
export const VC1_FRAME = 0x0d;
const VC1_ENTRY_POINT = 0x0e;
export const VC1_SEQUENCE = 0x0f;

interface Vc1SequenceHeader {
    readonly width: number;
    readonly height: number;
    readonly interlace: boolean;
}

/** Parses an advanced profile sequence header payload (bytes after the 0x0000010F start code). */
export function parseVc1SequenceHeader(payload: Uint8Array): Vc1SequenceHeader | undefined {
    if (payload.length < 6 || payload[0]! >> 6 !== 3) return undefined;
    const bits = (offset: number, count: number): number => {
        let value = 0;
        for (let index = 0; index < count; index++) {
            const at = offset + index;
            value = value * 2 + ((payload[at >> 3]! >> (7 - (at & 7))) & 1);
        }
        return value;
    };
    const width = (bits(16, 12) + 1) * 2;
    const height = (bits(28, 12) + 1) * 2;
    const interlace = bits(41, 1) === 1;
    return { width, height, interlace };
}

/**
 * Sequence and entry point headers preceding the first frame of an advanced profile stream, with
 * start codes, as ASF and Matroska keep them as codec data. Undefined when the bytes carry no
 * sequence header.
 */
export function vc1HeadersOf(data: Uint8Array): Uint8Array | undefined {
    let start = -1;
    for (
        let at = findStartCode(data, 0);
        at >= 0 && at + 3 < data.length;
        at = findStartCode(data, at + 4)
    ) {
        const code = data[at + 3]!;
        if (code === VC1_SEQUENCE && start < 0) start = at;
        else if (start >= 0 && code !== VC1_ENTRY_POINT) return data.slice(start, at);
    }
    return start >= 0 ? data.slice(start) : undefined;
}

/** True when an advanced profile frame (0x0000010D payload or bare frame data) is an I picture. */
export function isVc1IntraFrame(data: Uint8Array, interlace: boolean): boolean {
    let at = 0;
    for (
        let code = findStartCode(data, 0);
        code >= 0 && code + 3 < data.length;
        code = findStartCode(data, code + 4)
    ) {
        if (data[code + 3] === VC1_FRAME) {
            at = code + 4;
            break;
        }
        if (data[code + 3] === VC1_SEQUENCE) return true;
    }
    if (at + 1 >= data.length) return false;
    const first = data[at]!;
    let bit = 0;
    if (interlace) bit = (first & 0x80) === 0 ? 1 : 2;
    const ptype = (((first << 8) | data[at + 1]!) >> (13 - bit)) & 7;
    return (ptype & 6) === 6 && ptype !== 7;
}

/** Whether a VC-1 packet already begins with an Annex E start code. */
export function hasVc1StartCode(data: Uint8Array): boolean {
    return data.length >= 4 && data[0] === 0 && data[1] === 0 && data[2] === 1;
}
