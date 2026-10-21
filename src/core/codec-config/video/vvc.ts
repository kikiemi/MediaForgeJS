import { H264BitReader, nalToRbsp } from './video-sps';
import { splitAnnexBNals } from './annexb';

/** H.266 NAL unit types (7.4.2.2). */
export const VVC_NAL = Object.freeze({
    IDR_W_RADL: 7,
    IDR_N_LP: 8,
    CRA: 9,
    GDR: 10,
    OPI: 12,
    DCI: 13,
    VPS: 14,
    SPS: 15,
    PPS: 16,
    PREFIX_APS: 17,
    SUFFIX_APS: 18,
    PH: 19,
    AUD: 20,
    EOS: 21,
    EOB: 22,
    PREFIX_SEI: 23,
    SUFFIX_SEI: 24,
    FD: 25,
});

export function vvcNalType(nal: Uint8Array): number {
    return (nal[1]! >> 3) & 31;
}

export function isVvcCodec(codec: string): boolean {
    return /^(vvc1|vvi1)/i.test(codec);
}

/** Random access points: IRAP pictures and gradual decoding refresh pictures. */
export function isVvcRandomAccessNal(type: number): boolean {
    return type >= VVC_NAL.IDR_W_RADL && type <= VVC_NAL.GDR;
}

interface VvcSps {
    readonly profile: number;
    readonly tier: number;
    readonly level: number;
    /**
     * ptl_frame_only_constraint_flag, ptl_multilayer_enabled_flag and general_constraint_info, byte
     * aligned.
     */
    readonly constraintInfo: Uint8Array;
    readonly sublayers: number;
    readonly sublayerLevelPresent: readonly boolean[];
    readonly sublayerLevels: readonly number[];
    readonly subProfiles: readonly number[];
    readonly chromaFormatIdc: number;
    readonly bitDepthMinus8: number;
    readonly width: number;
    readonly height: number;
    readonly ptlPresent: boolean;
}

/**
 * Parses the fields of an SPS NAL unit up to sps_bitdepth_minus8; null when the syntax does not
 * parse.
 */
export function parseVvcSps(nal: Uint8Array): VvcSps | null {
    try {
        const rbsp = nalToRbsp(nal, 2);
        const bits = new H264BitReader(rbsp);
        bits.skipBits(8);
        const maxSublayersMinus1 = bits.readBits(3);
        const chromaFormatIdc = bits.readBits(2);
        const ctuLog2 = bits.readBits(2) + 5;
        const ptlPresent = bits.readBit() === 1;
        let profile = 0;
        let tier = 0;
        let level = 0;
        let constraintInfo = new Uint8Array(0);
        const sublayerLevelPresent: boolean[] = [];
        const sublayerLevels: number[] = [];
        const subProfiles: number[] = [];
        if (ptlPresent) {
            profile = bits.readBits(7);
            tier = bits.readBit();
            level = bits.readBits(8);

            // The ids, profile/tier and level fill the first four RBSP bytes; the constraint flags
            // start byte-aligned.
            const constraintStart = 4;
            bits.readBit();
            bits.readBit();
            if (bits.readBit()) {
                bits.skipBits(71);
                const additional = bits.readBits(8);
                bits.skipBits(additional);
            }
            bits.alignToByte();
            constraintInfo = rbsp.slice(constraintStart, bits.byteOffset);
            for (let index = maxSublayersMinus1 - 1; index >= 0; index--)
                sublayerLevelPresent[index] = bits.readBit() === 1;
            bits.alignToByte();
            for (let index = maxSublayersMinus1 - 1; index >= 0; index--)
                sublayerLevels[index] = sublayerLevelPresent[index] ? bits.readBits(8) : 0;
            const count = bits.readBits(8);
            for (let index = 0; index < count; index++) subProfiles.push(bits.readBits(32));
        }
        bits.readBit();
        if (bits.readBit()) bits.readBit();
        const width = bits.readUE();
        const height = bits.readUE();
        if (bits.readBit()) {
            bits.readUE();
            bits.readUE();
            bits.readUE();
            bits.readUE();
        }
        if (bits.readBit()) {
            const subpicsMinus1 = bits.readUE();
            let independent = true;
            let sameSize = false;
            if (subpicsMinus1 > 0) {
                independent = bits.readBit() === 1;
                sameSize = bits.readBit() === 1;
            }
            const ctuSize = 1 << ctuLog2;
            const xBits = Math.ceil(Math.log2(Math.ceil(width / ctuSize) || 1));
            const yBits = Math.ceil(Math.log2(Math.ceil(height / ctuSize) || 1));
            for (let index = 0; subpicsMinus1 > 0 && index <= subpicsMinus1; index++) {
                if (!sameSize || index === 0) {
                    if (index > 0 && width > ctuSize) bits.skipBits(xBits);
                    if (index > 0 && height > ctuSize) bits.skipBits(yBits);
                    if (index < subpicsMinus1 && width > ctuSize) bits.skipBits(xBits);
                    if (index < subpicsMinus1 && height > ctuSize) bits.skipBits(yBits);
                }
                if (!independent) bits.skipBits(2);
            }
            const idLength = bits.readUE() + 1;
            if (bits.readBit() && bits.readBit()) {
                for (let index = 0; index <= subpicsMinus1; index++) bits.skipBits(idLength);
            }
        }
        const bitDepthMinus8 = bits.readUE();
        if (width <= 0 || height <= 0 || bitDepthMinus8 > 8) return null;
        return {
            profile,
            tier,
            level,
            constraintInfo,
            sublayers: maxSublayersMinus1 + 1,
            sublayerLevelPresent,
            sublayerLevels,
            subProfiles,
            chromaFormatIdc,
            bitDepthMinus8,
            width,
            height,
            ptlPresent,
        };
    } catch {
        return null;
    }
}

interface ParsedVvcC {
    readonly lengthSize: 1 | 2 | 3 | 4;
    readonly ptlPresent: boolean;
    readonly olsIdx: number;
    readonly sublayers: number;
    readonly chromaFormatIdc: number;
    readonly bitDepthMinus8: number;
    readonly profile: number;
    readonly tier: number;
    readonly level: number;
    readonly constraintInfo: Uint8Array;
    readonly width: number;
    readonly height: number;
    /** Parameter set NAL units without start codes, in record order. */
    readonly nalUnits: readonly Uint8Array[];
}

/** Reads a VvcDecoderConfigurationRecord (ISO/IEC 14496-15 11.2.4.2.2); null when malformed. */
export function parseVvcC(record: Uint8Array): ParsedVvcC | null {
    try {
        const bits = new H264BitReader(record);
        if (bits.readBits(5) !== 31) return null;
        const lengthSize = (bits.readBits(2) + 1) as 1 | 2 | 3 | 4;
        if (lengthSize === 3) return null;
        const ptlPresent = bits.readBit() === 1;

        let olsIdx = 0;
        let sublayers = 1;
        let chromaFormatIdc = 1;
        let bitDepthMinus8 = 0;
        let profile = 0;
        let tier = 0;
        let level = 0;
        let constraintInfo = new Uint8Array(0);
        let width = 0;
        let height = 0;

        if (ptlPresent) {
            olsIdx = bits.readBits(9);
            sublayers = bits.readBits(3);
            bits.readBits(2);
            chromaFormatIdc = bits.readBits(2);
            bitDepthMinus8 = bits.readBits(3);
            bits.readBits(5);
            bits.readBits(2);
            const constraintBytes = bits.readBits(6);
            profile = bits.readBits(7);
            tier = bits.readBit();
            level = bits.readBits(8);

            const constraintStart = bits.byteOffset;
            bits.skipBits(constraintBytes * 8);
            constraintInfo = record.slice(constraintStart, constraintStart + constraintBytes);

            const present: boolean[] = [];
            for (let index = sublayers - 2; index >= 0; index--)
                present[index] = bits.readBit() === 1;
            for (let index = sublayers; index <= 8 && sublayers > 1; index++) bits.readBit();
            for (let index = sublayers - 2; index >= 0; index--)
                if (present[index]) bits.readBits(8);

            const subProfiles = bits.readBits(8);
            bits.skipBits(32 * subProfiles);
            width = bits.readBits(16);
            height = bits.readBits(16);
            bits.readBits(16);
        }

        const arrays = bits.readBits(8);
        const nalUnits: Uint8Array[] = [];
        for (let array = 0; array < arrays; array++) {
            bits.readBits(3);
            const type = bits.readBits(5);
            const count = type === VVC_NAL.DCI || type === VVC_NAL.OPI ? 1 : bits.readBits(16);
            for (let index = 0; index < count; index++) {
                const length = bits.readBits(16);
                const start = bits.byteOffset;
                if (start + length > record.length) return null;
                nalUnits.push(record.subarray(start, start + length));
                bits.skipBits(length * 8);
            }
        }

        return {
            lengthSize,
            ptlPresent,
            olsIdx,
            sublayers,
            chromaFormatIdc,
            bitDepthMinus8,
            profile,
            tier,
            level,
            constraintInfo,
            width,
            height,
            nalUnits,
        };
    } catch {
        return null;
    }
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32(bytes: Uint8Array): string {
    let out = '';
    let buffer = 0;
    let count = 0;
    for (const byte of bytes) {
        buffer = (buffer << 8) | byte;
        count += 8;
        while (count >= 5) {
            out += BASE32[(buffer >> (count - 5)) & 31];
            count -= 5;
        }
    }
    if (count > 0) out += BASE32[(buffer << (5 - count)) & 31];
    return out;
}

/**
 * vvc1.<profile>.<tier><level>.C<constraints>.O<ols>+<sublayers>, as ISO/IEC 14496-15 Annex E
 * spells VVC.
 */
export function vvcCodecString(entry: 'vvc1' | 'vvi1', record: Uint8Array | undefined): string {
    const parsed = record ? parseVvcC(record) : null;
    if (!parsed || !parsed.ptlPresent) return entry;
    let constraints = parsed.constraintInfo;
    let end = constraints.length;
    while (end > 0 && constraints[end - 1] === 0) end--;
    constraints = constraints.subarray(0, end);
    const parts = [entry, String(parsed.profile), `${parsed.tier ? 'H' : 'L'}${parsed.level}`];
    if (constraints.length) parts.push(`C${base32(constraints)}`);
    parts.push(`O${parsed.olsIdx}+${parsed.sublayers}`);
    return parts.join('.');
}

/**
 * Builds a four-byte-length VvcDecoderConfigurationRecord from the VPS/SPS/PPS (and DCI/OPI/prefix
 * APS) NAL units of Annex B bytes. Returns null without an SPS and PPS.
 */
export function buildVvcCFromAnnexB(data: Uint8Array): Uint8Array | null {
    const groups = new Map<number, Uint8Array[]>();
    let sps: VvcSps | null = null;
    for (const nal of splitAnnexBNals(data)) {
        if (nal.length < 3 || nal.length > 0xffff || (nal[0]! & 0x80) !== 0) continue;
        const type = vvcNalType(nal);
        if (
            type !== VVC_NAL.VPS &&
            type !== VVC_NAL.SPS &&
            type !== VVC_NAL.PPS &&
            type !== VVC_NAL.DCI &&
            type !== VVC_NAL.OPI &&
            type !== VVC_NAL.PREFIX_APS
        )
            continue;
        const list = groups.get(type) ?? [];
        if (
            list.some(
                existing =>
                    existing.length === nal.length && existing.every((b, i) => b === nal[i]),
            )
        )
            continue;
        if ((type === VVC_NAL.DCI || type === VVC_NAL.OPI) && list.length) continue;
        if (list.length === 0xffff) return null;
        list.push(nal);
        groups.set(type, list);
        if (type === VVC_NAL.SPS && !sps) sps = parseVvcSps(nal);
    }

    if (!groups.has(VVC_NAL.SPS) || !groups.has(VVC_NAL.PPS) || !sps) return null;
    const ptlPresent = sps.ptlPresent;
    const constraint = sps.constraintInfo;

    let size = 1;
    if (ptlPresent) {
        size += 4 + 2 + constraint.length;
        const sublayerBits = sps.sublayers > 1 ? sps.sublayers - 1 + (9 - sps.sublayers) : 0;
        size += sublayerBits / 8;
        size += sps.sublayerLevels.filter((_, index) => sps!.sublayerLevelPresent[index]).length;
        size += 1 + 4 * sps.subProfiles.length;
        size += 6;
    }
    size += 1;

    const order = [
        VVC_NAL.DCI,
        VVC_NAL.OPI,
        VVC_NAL.VPS,
        VVC_NAL.SPS,
        VVC_NAL.PPS,
        VVC_NAL.PREFIX_APS,
    ];
    for (const type of order) {
        const list = groups.get(type);
        if (!list) continue;
        size += 1 + (type === VVC_NAL.DCI || type === VVC_NAL.OPI ? 0 : 2);
        for (const nal of list) size += 2 + nal.length;
    }

    const out = new Uint8Array(size);
    const view = new DataView(out.buffer);
    let pos = 0;
    out[pos++] = 0xf8 | (3 << 1) | (ptlPresent ? 1 : 0);
    if (ptlPresent) {
        view.setUint16(pos, (0 << 7) | (sps.sublayers << 4) | (0 << 2) | sps.chromaFormatIdc);
        pos += 2;
        out[pos++] = (sps.bitDepthMinus8 << 5) | 0x1f;
        out[pos++] = constraint.length & 0x3f;
        out[pos++] = (sps.profile << 1) | sps.tier;
        out[pos++] = sps.level;
        out.set(constraint, pos);
        pos += constraint.length;

        if (sps.sublayers > 1) {
            let byte = 0;
            let bit = 7;
            for (let index = sps.sublayers - 2; index >= 0; index--) {
                if (sps.sublayerLevelPresent[index]) byte |= 1 << bit;
                bit--;
            }
            out[pos++] = byte;
            for (let index = sps.sublayers - 2; index >= 0; index--)
                if (sps.sublayerLevelPresent[index]) out[pos++] = sps.sublayerLevels[index]!;
        }

        out[pos++] = sps.subProfiles.length;
        for (const value of sps.subProfiles) {
            view.setUint32(pos, value);
            pos += 4;
        }

        view.setUint16(pos, Math.min(sps.width, 0xffff));
        view.setUint16(pos + 2, Math.min(sps.height, 0xffff));
        view.setUint16(pos + 4, 0);
        pos += 6;
    }

    const arrays = order.filter(type => groups.has(type));
    out[pos++] = arrays.length;
    for (const type of arrays) {
        const list = groups.get(type)!;
        out[pos++] = 0x80 | type;
        if (type !== VVC_NAL.DCI && type !== VVC_NAL.OPI) {
            view.setUint16(pos, list.length);
            pos += 2;
        }
        for (const nal of list) {
            view.setUint16(pos, nal.length);
            pos += 2;
            out.set(nal, pos);
            pos += nal.length;
        }
    }
    return out;
}
