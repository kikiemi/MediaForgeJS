import { splitAnnexBNals } from './annexb';
import { H264BitReader, nalToRbsp, parseHevcSps } from './video-sps';

/** Builds a four-byte-length HevcDecoderConfigurationRecord for a base-layer stream.
 * Returns null when parameter sets are absent, malformed, or incompatible.
 */
export function buildHevcCFromAnnexB(data: Uint8Array): Uint8Array | null {
    const arrays: Uint8Array[][] = [[], [], []];
    for (const nal of splitAnnexBNals(data)) {
        const type = (nal[0]! >>> 1) & 0x3f;
        if (type < 32 || type > 34) continue;

        // Parameter sets require nuh_layer_id=0 and nuh_temporal_id_plus1=1.
        if (nal.length < 3 || nal.length > 0xffff || (nal[0]! & 0x81) !== 0 || nal[1] !== 1)
            return null;
        const list = arrays[type - 32]!;
        if (
            list.some(
                existing =>
                    existing.length === nal.length && existing.every((b, i) => b === nal[i]),
            )
        )
            continue;
        if (list.length === 0xffff) return null;
        list.push(nal);
    }
    if (arrays.some(list => list.length === 0)) return null;
    const sequenceSets = arrays[1]!.map(parseHevcSps);
    if (sequenceSets.some(sps => sps === null)) return null;
    const first = sequenceSets[0]!;
    if (!first) return null;

    // A single record cannot describe contradictory chroma/profile declarations.
    for (const sps of sequenceSets) {
        if (
            !sps ||
            sps.profileSpace !== first.profileSpace ||
            sps.tierFlag !== first.tierFlag ||
            sps.profileIdc !== first.profileIdc ||
            sps.profileCompatibilityFlags !== first.profileCompatibilityFlags ||
            sps.levelIdc !== first.levelIdc ||
            sps.chromaFormatIdc !== first.chromaFormatIdc ||
            sps.bitDepthLumaMinus8 !== first.bitDepthLumaMinus8 ||
            sps.bitDepthChromaMinus8 !== first.bitDepthChromaMinus8 ||
            sps.constraintIndicatorFlags.some((b, i) => b !== first.constraintIndicatorFlags[i])
        )
            return null;
    }
    try {
        const vpsIds = new Set<number>();
        for (const vps of arrays[0]!) {
            const bits = new H264BitReader(nalToRbsp(vps, 2));
            vpsIds.add(bits.readBits(4));
            bits.skipBits(2);
            if (bits.readBits(6) !== 0) return null; // Multilayer configuration is unsupported.
            if (bits.readBits(3) > 6) return null;
            bits.readBit();
            if (bits.readBits(16) !== 0xffff) return null;
            bits.skipBits(96); // general_profile_tier_level must be present.
        }
        for (const sps of sequenceSets) if (!vpsIds.has(sps!.videoParameterSetId)) return null;
        const spsIds = new Set(sequenceSets.map(sps => sps!.sequenceParameterSetId));
        for (const pps of arrays[2]!) {
            const bits = new H264BitReader(nalToRbsp(pps, 2));
            if (bits.readUE() > 63 || !spsIds.has(bits.readUE())) return null;
            bits.skipBits(7); // Initial PPS flags and num_extra_slice_header_bits.
            if (bits.readUE() > 14 || bits.readUE() > 14) return null;
            const initQpMinus26 = bits.readSE();
            if (initQpMinus26 < -(26 + 6 * first.bitDepthLumaMinus8) || initQpMinus26 > 25)
                return null;
        }
    } catch {
        return null;
    }
    let size = 23;
    for (const list of arrays) {
        size += 3;
        for (const nal of list) size += 2 + nal.length;
    }
    const out = new Uint8Array(size);
    const view = new DataView(out.buffer);
    out[0] = 1;
    out[1] = (first.profileSpace << 6) | (first.tierFlag << 5) | first.profileIdc;
    view.setUint32(2, first.profileCompatibilityFlags);
    out.set(first.constraintIndicatorFlags, 6);
    out[12] = first.levelIdc;

    // Zero means unspecified for spatial segmentation, parallelism and average frame rate.
    out[13] = 0xf0;
    out[15] = 0xfc;
    out[16] = 0xfc | first.chromaFormatIdc;
    out[17] = 0xf8 | first.bitDepthLumaMinus8;
    out[18] = 0xf8 | first.bitDepthChromaMinus8;
    const temporalLayers = Math.max(...sequenceSets.map(sps => sps!.maxSubLayersMinus1 + 1));
    const temporalNested = sequenceSets.every(sps => sps!.temporalIdNestingFlag === 1) ? 1 : 0;
    out[21] = (temporalLayers << 3) | (temporalNested << 2) | 3;
    out[22] = arrays.length;
    let pos = 23;
    for (let i = 0; i < arrays.length; i++) {
        const list = arrays[i]!;
        out[pos++] = 0x80 | (32 + i);
        view.setUint16(pos, list.length);
        pos += 2;
        for (const nal of list) {
            view.setUint16(pos, nal.length);
            pos += 2;
            out.set(nal, pos);
            pos += nal.length;
        }
    }
    return out;
}
