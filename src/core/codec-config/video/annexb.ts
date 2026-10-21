import { MuxError } from '../../errors/errors';

/**
 * Walks the NAL units of `data` after `lengthSize`-byte lengths, handing each unit's offset and
 * length to `unit`: true when `unit` accepts all of them and they tile `data` exactly, at least
 * one.
 */
function walkLengthPrefixed(
    data: Uint8Array,
    lengthSize: number,
    unit: (at: number, length: number) => boolean,
): boolean {
    if (!Number.isInteger(lengthSize) || lengthSize < 1 || lengthSize > 4) return false;
    let pos = 0;
    while (pos + lengthSize <= data.length) {
        let length = 0;
        for (let i = 0; i < lengthSize; i++) length = length * 256 + data[pos + i]!;
        pos += lengthSize;
        if (length > data.length - pos || !unit(pos, length)) return false;
        pos += length;
    }
    return pos === data.length && pos > 0;
}

/**
 * The NAL length size of an AVC or HEVC track from its decoder configuration (avcC or hvcC); 0 for
 * other codecs.
 */
export function nalLengthSizeOf(track: {
    readonly codec: string;
    readonly codecConfig?: Uint8Array;
}): 0 | 1 | 2 | 4 {
    const kind = track.codec.split('.')[0]!;
    if (!['avc1', 'avc3', 'hvc1', 'hev1'].includes(kind)) return 0;
    return ((track.codecConfig![kind.startsWith('avc') ? 4 : 21]! & 3) + 1) as 1 | 2 | 4;
}

/** Whether `data` is whole NAL units after `lengthSize`-byte lengths. */
export function isLengthPrefixed(data: Uint8Array, lengthSize: 1 | 2 | 3 | 4): boolean {
    return walkLengthPrefixed(data, lengthSize, (_, length) => length > 0);
}

/** Validates length-prefixed H.264: no forbidden bit, no NAL unit type 0. */
export function isValidAvccWalk(data: Uint8Array, lengthSize: 1 | 2 | 3 | 4 = 4): boolean {
    return walkLengthPrefixed(
        data,
        lengthSize,
        (at, length) => length > 0 && data[at]! < 0x80 && (data[at]! & 0x1f) > 0,
    );
}

/**
 * Validates length-prefixed HEVC, including type 0 slices (valid in HEVC): no forbidden bit, a
 * temporal id.
 */
export function isValidHevcWalk(data: Uint8Array, lengthSize: 1 | 2 | 3 | 4 = 4): boolean {
    return walkLengthPrefixed(
        data,
        lengthSize,
        (at, length) => length > 1 && data[at]! < 0x80 && (data[at + 1]! & 7) > 0,
    );
}

/**
 * NAL units of a length-prefixed sample, or null when the lengths do not tile the sample exactly.
 */
export function splitLengthPrefixedNals(
    data: Uint8Array,
    lengthSize: 1 | 2 | 3 | 4,
): Uint8Array[] | null {
    const nals: Uint8Array[] = [];
    const unit = (at: number, length: number): boolean =>
        length > 0 && nals.push(data.subarray(at, at + length)) > 0;
    return walkLengthPrefixed(data, lengthSize, unit) ? nals : null;
}

export function isAnnexB(data: Uint8Array): boolean {
    if (data.length < 4) return false;
    if (data[0] !== 0 || data[1] !== 0) return false;
    let pos = 2;
    while (pos < data.length && data[pos] === 0) pos++;
    return pos < data.length && data[pos] === 1;
}

/**
 * NAL units between 00 00 01 start codes (a leading zero of a 4-byte code is trimmed with the
 * trailing zeros).
 */
export function splitAnnexBNals(data: Uint8Array): Uint8Array[] {
    const nals: Uint8Array[] = [];
    let nalStart = -1;
    const flush = (end: number) => {
        if (nalStart < 0) return;
        let trimmed = end;
        while (trimmed > nalStart && data[trimmed - 1] === 0) trimmed--;
        if (trimmed > nalStart) nals.push(data.subarray(nalStart, trimmed));
        nalStart = -1;
    };
    // Every start code ends in a 1 byte, which the native search finds; codes may not overlap the
    // previous one.
    for (let one = data.indexOf(1, 2); one >= 0; one = data.indexOf(1, one + 1)) {
        if (data[one - 1] !== 0 || data[one - 2] !== 0 || one - 2 < Math.max(0, nalStart)) continue;
        flush(one - 2);
        nalStart = one + 1;
    }
    flush(data.length);
    return nals;
}

/**
 * H.264 NAL unit types that start an access unit after a picture: SEI, SPS, PPS, delimiter and
 * types 14-18.
 */
const H264_UNIT_PREFIX = new Set([6, 7, 8, 9, 14, 15, 16, 17, 18]);

/**
 * Offsets of the start codes that begin the access units of an Annex B H.264 or H.265 stream (H.264
 * 7.4.1.2.3, H.265 7.4.2.4.4): after a picture, a delimiter, parameter set, prefix SEI or reserved
 * prefix type, or the first slice of the next picture unless `splitAtFirstSlice` is false: the
 * second field of an H.264 frame also starts at first_mb_in_slice 0, and where delimiters are
 * mandatory (MPEG-TS) it stays in the frame's unit, as ffmpeg keeps it. The first unit starts at
 * the first NAL unit. `nals` are the NAL units of `data` when already split.
 */
export function annexBAccessUnitStarts(
    data: Uint8Array,
    codec: 'h264' | 'hevc',
    splitAtFirstSlice = true,
    nals: readonly Uint8Array[] = splitAnnexBNals(data),
): number[] {
    const starts: number[] = [];
    const header = codec === 'h264' ? 1 : 2;
    let picture = false;
    for (const nal of nals) {
        let at = nal.byteOffset - data.byteOffset - 3;
        if (at > 0 && data[at - 1] === 0) at--;
        const type = codec === 'h264' ? nal[0]! & 0x1f : (nal[0]! >> 1) & 0x3f;
        const vcl = codec === 'h264' ? type >= 1 && type <= 5 : type <= 31;
        const prefix =
            codec === 'h264'
                ? H264_UNIT_PREFIX.has(type)
                : (type >= 32 && type <= 35) ||
                  type === 39 ||
                  (type >= 41 && type <= 44) ||
                  (type >= 48 && type <= 55);

        // first_mb_in_slice 0 or first_slice_segment_in_pic_flag: the first bit after the NAL unit
        // header.
        const firstSlice =
            splitAtFirstSlice && vcl && nal.length > header && (nal[header]! & 0x80) !== 0;
        if (!starts.length || (picture && (prefix || firstSlice))) {
            starts.push(at);
            picture = false;
        }
        if (vcl) picture = true;
    }
    return starts;
}

export function annexBToAvcc(data: Uint8Array, lengthSize: 1 | 2 | 3 | 4 = 4): Uint8Array {
    if (!Number.isInteger(lengthSize) || lengthSize < 1 || lengthSize > 4) {
        throw new MuxError('AVCC NAL length size must be an integer from 1 through 4');
    }

    const nals = splitAnnexBNals(data);
    const maxLength = 2 ** (lengthSize * 8) - 1;
    let total = 0;
    for (const nal of nals) {
        if (nal.length > maxLength) {
            throw new MuxError(
                `NAL length ${nal.length} exceeds the ${lengthSize}-byte AVCC length field`,
            );
        }
        total += lengthSize + nal.length;
    }

    const out = new Uint8Array(total);
    let pos = 0;
    for (const nal of nals) {
        let length = nal.length;
        for (let byte = lengthSize - 1; byte >= 0; byte--) {
            out[pos + byte] = length & 0xff;
            length = Math.floor(length / 256);
        }
        out.set(nal, pos + lengthSize);
        pos += lengthSize + nal.length;
    }
    return out;
}

export function buildAvcCFromAnnexB(data: Uint8Array): Uint8Array | null {
    const spsList: Uint8Array[] = [];
    const ppsList: Uint8Array[] = [];
    for (const nal of splitAnnexBNals(data)) {
        const type = nal[0]! & 0x1f;
        if (type !== 7 && type !== 8) continue;
        if ((nal[0]! & 0x80) !== 0 || nal.length > 0xffff) return null;
        if (type === 7) {
            if (spsList.length === 31) return null;
            spsList.push(nal);
        } else {
            if (ppsList.length === 255) return null;
            ppsList.push(nal);
        }
    }

    if (spsList.length === 0 || ppsList.length === 0) return null;
    const sps = spsList[0]!;
    if (sps.length < 4) return null;

    let total = 7;
    for (const s of spsList) total += 2 + s.length;
    for (const p of ppsList) total += 2 + p.length;

    const out = new Uint8Array(total);
    out[0] = 1;
    out[1] = sps[1]!;
    out[2] = sps[2]!;
    out[3] = sps[3]!;
    out[4] = 0xff;
    out[5] = 0xe0 | spsList.length;

    let pos = 6;
    for (const s of spsList) {
        out[pos] = (s.length >>> 8) & 0xff;
        out[pos + 1] = s.length & 0xff;
        out.set(s, pos + 2);
        pos += 2 + s.length;
    }

    out[pos++] = ppsList.length;
    for (const p of ppsList) {
        out[pos] = (p.length >>> 8) & 0xff;
        out[pos + 1] = p.length & 0xff;
        out.set(p, pos + 2);
        pos += 2 + p.length;
    }
    return out;
}

/** NAL units one after another, each after a four-byte start code. */
export function annexBUnits(nals: readonly Uint8Array[]): Uint8Array {
    const out = new Uint8Array(nals.reduce((sum, nal) => sum + 4 + nal.length, 0));
    let at = 0;
    for (const nal of nals) {
        out[at + 3] = 1;
        out.set(nal, at + 4);
        at += 4 + nal.length;
    }
    return out;
}

/**
 * The SPS and PPS of an AVCDecoderConfigurationRecord as Annex B units, with the record's NAL
 * length size; null when malformed (a unit that is empty or of another type, or a list that runs
 * past the record). An 'avc3' record (`inBand`) may hold neither: its samples carry them.
 */
export function avcConfigToAnnexB(
    record: Uint8Array,
    inBand = false,
): { lengthSize: number; paramSets: Uint8Array } | null {
    if (record.length < 7 || record[0] !== 1) return null;
    const lengthSize = (record[4]! & 0x03) + 1;
    const sets: Uint8Array[] = [];
    let pos = 5;
    for (const type of [7, 8]) {
        if (pos >= record.length) return null;
        const count = type === 7 ? record[pos++]! & 0x1f : record[pos++]!;
        if (count === 0 && !inBand) return null;
        for (let index = 0; index < count; index++) {
            if (pos + 2 > record.length) return null;
            const length = (record[pos]! << 8) | record[pos + 1]!;
            pos += 2;
            if (length === 0 || pos + length > record.length) return null;
            if ((record[pos]! & 0x9f) !== type) return null;
            sets.push(record.subarray(pos, pos + length));
            pos += length;
        }
    }
    return { lengthSize, paramSets: annexBUnits(sets) };
}

export function avcConfigToSamplePrefix(avcC: Uint8Array): Uint8Array | null {
    if (avcC.length < 7 || avcC[0] !== 1) return null;
    const lengthSize = (avcC[4]! & 0x03) + 1;
    if (lengthSize < 1 || lengthSize > 4) return null;

    const parameterSets: Uint8Array[] = [];
    let pos = 6;
    const numSps = avcC[5]! & 0x1f;
    if (numSps === 0) return null;
    for (let i = 0; i < numSps; i++) {
        if (pos + 2 > avcC.length) return null;
        const length = (avcC[pos]! << 8) | avcC[pos + 1]!;
        pos += 2;
        if (length <= 0 || pos + length > avcC.length) return null;
        if ((avcC[pos]! & 0x9f) !== 7) return null;
        parameterSets.push(avcC.subarray(pos, pos + length));
        pos += length;
    }
    if (pos >= avcC.length) return null;
    const numPps = avcC[pos++]!;
    if (numPps === 0) return null;
    for (let i = 0; i < numPps; i++) {
        if (pos + 2 > avcC.length) return null;
        const length = (avcC[pos]! << 8) | avcC[pos + 1]!;
        pos += 2;
        if (length <= 0 || pos + length > avcC.length) return null;
        if ((avcC[pos]! & 0x9f) !== 8) return null;
        parameterSets.push(avcC.subarray(pos, pos + length));
        pos += length;
    }

    const maxLength = 2 ** (lengthSize * 8) - 1;
    let total = 0;
    for (const nal of parameterSets) {
        if (nal.length > maxLength) return null;
        total += lengthSize + nal.length;
    }
    const out = new Uint8Array(total);
    pos = 0;
    for (const nal of parameterSets) {
        let value = nal.length;
        for (let byte = lengthSize - 1; byte >= 0; byte--) {
            out[pos + byte] = value & 0xff;
            value = Math.floor(value / 256);
        }
        pos += lengthSize;
        out.set(nal, pos);
        pos += nal.length;
    }
    return out;
}

export function prependAvcConfigToSample(avcC: Uint8Array, sample: Uint8Array): Uint8Array | null {
    const prefix = avcConfigToSamplePrefix(avcC);
    if (!prefix) return null;
    const out = new Uint8Array(prefix.length + sample.length);
    out.set(prefix, 0);
    out.set(sample, prefix.length);
    return out;
}

/** H.264 NAL unit types that carry slices of a picture. */
const H264_SLICES = new Set([1, 2, 3, 4, 5, 19]);

/**
 * H.264 NAL unit types a decoder keeps state from, or whose references this check does not follow:
 * parameter sets, sequence and stream ends, and the scalable and multiview extensions.
 */
const H264_STATE = new Set([7, 8, 10, 11, 13, 14, 15, 20]);

/**
 * Whether an H.264 access unit (Annex B when `lengthSize` is 0) is a picture no other picture
 * refers to (H.264 7.4.1: nal_ref_idc 0 in every slice), with no parameter set or sequence end a
 * decoder would keep: decoding may skip it without changing any other picture.
 */
export function isDisposableAvcPicture(data: Uint8Array, lengthSize: 0 | 1 | 2 | 4): boolean {
    const nals =
        lengthSize === 0 ? splitAnnexBNals(data) : splitLengthPrefixedNals(data, lengthSize);
    if (!nals?.length) return false;
    let slices = 0;
    for (const nal of nals) {
        const type = nal[0]! & 0x1f;
        if (H264_STATE.has(type)) return false;
        if (!H264_SLICES.has(type)) continue;
        if (type === 5 || (nal[0]! & 0x60) !== 0) return false;
        slices++;
    }
    return slices > 0;
}
