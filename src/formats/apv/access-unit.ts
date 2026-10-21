import type { ApvFrameInfo } from '../../core/codec-config/video/apv';

/** 'aPv1', the first four bytes of every access unit. */
export const APV_SIGNATURE = 0x61507631;

/** The primitive bitstream unit type of a primary frame. */
export const APV_PRIMARY_FRAME = 1;

const word = (bytes: Uint8Array, at: number): number =>
    ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0;

/** The frame_info() at `at`: profile, level, band, 24-bit size, chroma format and bit depth. */
export function frameInfoAt(bytes: Uint8Array, at: number): ApvFrameInfo {
    return {
        profile: bytes[at]!,
        level: bytes[at + 1]!,
        band: bytes[at + 2]! >> 5,
        width: word(bytes, at + 2) & 0xffffff,
        height: word(bytes, at + 5) & 0xffffff,
        chromaFormat: bytes[at + 9]! >> 4,
        bitDepth: (bytes[at + 9]! & 15) + 8,
    };
}

/**
 * The primitive bitstream units of an access unit (its bytes from the signature on): each unit's
 * type and the range of its bytes after the pbu header, or undefined when the unit is malformed.
 */
export function apvUnits(
    unit: Uint8Array,
): { type: number; start: number; end: number }[] | undefined {
    if (unit.length < 4 || word(unit, 0) !== APV_SIGNATURE) return undefined;
    const units = [];
    for (let at = 4; at < unit.length;) {
        const size = at + 8 <= unit.length ? word(unit, at) : 0;
        if (size < 4 || size > unit.length - at - 4) return undefined;
        units.push({ type: unit[at + 4]!, start: at + 8, end: at + 4 + size });
        at += 4 + size;
    }
    return units;
}

/** The frame info of the primary frame of an access unit, or undefined when it has none. */
export function apvFrameInfo(unit: Uint8Array): ApvFrameInfo | undefined {
    const primary = apvUnits(unit)?.find(part => part.type === APV_PRIMARY_FRAME);
    return primary && primary.end - primary.start >= 12
        ? frameInfoAt(unit, primary.start)
        : undefined;
}

/**
 * The 'apvC' record of a stream whose primary frames have `info`: one entry for primary frames,
 * without colour description and with capture_time_distance_ignored set, as FFmpeg writes it.
 */
export function apvConfigRecord(info: ApvFrameInfo): Uint8Array {
    const record = new Uint8Array(18);
    const view = new DataView(record.buffer);
    record.set([1, 1, APV_PRIMARY_FRAME, 1, 1, info.profile, info.level, info.band]);
    view.setUint32(8, info.width);
    view.setUint32(12, info.height);
    record[16] = (info.chromaFormat << 4) | (info.bitDepth - 8);
    return record;
}
