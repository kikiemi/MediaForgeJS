import { annexBUnits } from './annexb';

/**
 * RFC 6381 HEVC codec string from an HevcDecoderConfigurationRecord; the entry alone when the
 * record is unusable.
 */
export function hevcCodecString(entry: string, config: Uint8Array | undefined): string {
    if (!config || config.length < 23 || config[0] !== 1) return entry;
    const profile = config[1]!;
    let compatibility = 0;
    // RFC 6381 HEVC compatibility flags are written in reverse bit order.
    for (let bit = 0; bit < 32; bit++)
        compatibility += ((config[2 + (bit >>> 3)]! >>> (7 - (bit & 7))) & 1) * 2 ** bit;
    let end = 12;
    while (end > 7 && config[end - 1] === 0) end--;
    const constraints = Array.from(config.subarray(6, end), byte =>
        byte.toString(16).padStart(2, '0').toUpperCase(),
    ).join('.');
    const space = ['', 'A', 'B', 'C'][profile >>> 6];
    const tier = profile & 32 ? 'H' : 'L';
    const flags = compatibility.toString(16).toUpperCase();
    return `${entry}.${space}${profile & 31}.${flags}.${tier}${config[12]}.${constraints}`;
}

/** NAL length field width of an HevcDecoderConfigurationRecord. */
export function hevcLengthSize(config: Uint8Array | undefined): 1 | 2 | 3 | 4 {
    const byte = config?.[21];
    return (byte === undefined ? 4 : (byte & 3) + 1) as 1 | 2 | 3 | 4;
}

/**
 * Removes VPS/SPS/PPS NAL units from a length-prefixed HEVC sample so an hvc1 entry keeps parameter
 * sets out of band. Returns the input when nothing was removed.
 */
export function stripHevcParameterSets(data: Uint8Array, lengthSize: number): Uint8Array {
    const kept: Uint8Array[] = [];
    let total = 0;
    let removed = false;
    for (let pos = 0; pos + lengthSize <= data.length;) {
        let length = 0;
        for (let index = 0; index < lengthSize; index++) length = length * 256 + data[pos + index]!;
        const end = pos + lengthSize + length;
        if (length < 2 || end > data.length) return data;
        const type = (data[pos + lengthSize]! >> 1) & 63;
        if (type >= 32 && type <= 34) removed = true;
        else {
            kept.push(data.subarray(pos, end));
            total += end - pos;
        }
        pos = end;
    }

    if (!removed || kept.length === 0) return data;
    const out = new Uint8Array(total);
    let at = 0;
    for (const nal of kept) {
        out.set(nal, at);
        at += nal.length;
    }
    return out;
}

/**
 * VPS/SPS/PPS of an HevcDecoderConfigurationRecord as Annex B bytes with the record's NAL length
 * size; null when malformed. A record without arrays (hev1, parameter sets in band) yields empty
 * `paramSets`.
 */
export function hevcConfigToAnnexB(
    record: Uint8Array,
): { lengthSize: number; paramSets: Uint8Array } | null {
    if (record.length < 23 || record[0] !== 1) return null;
    const lengthSize = (record[21]! & 0x03) + 1;
    const sets: Uint8Array[] = [];
    let pos = 23;
    for (let array = 0; array < record[22]!; array++) {
        if (pos + 3 > record.length) return null;
        const count = (record[pos + 1]! << 8) | record[pos + 2]!;
        pos += 3;
        for (let index = 0; index < count; index++) {
            if (pos + 2 > record.length) return null;
            const length = (record[pos]! << 8) | record[pos + 1]!;
            pos += 2;
            if (pos + length > record.length) return null;
            sets.push(record.subarray(pos, pos + length));
            pos += length;
        }
    }

    return { lengthSize, paramSets: annexBUnits(sets) };
}
