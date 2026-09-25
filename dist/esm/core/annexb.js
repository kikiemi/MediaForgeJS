import { MuxError } from './errors.js';
import { H264BitReader, nalToRbsp, parseHevcSps } from './video-sps.js';
export function isValidAvccWalk(data, lengthSize = 4) {
    if (!Number.isInteger(lengthSize) || lengthSize < 1 || lengthSize > 4)
        return false;
    let pos = 0;
    let count = 0;
    while (pos + lengthSize <= data.length) {
        let len = 0;
        for (let i = 0; i < lengthSize; i++)
            len = len * 256 + data[pos + i];
        if (len < 1 || pos + lengthSize + len > data.length)
            return false;
        const nalHeader = data[pos + lengthSize];
        if ((nalHeader & 0x80) !== 0)
            return false;
        if ((nalHeader & 0x1f) === 0)
            return false;
        pos += lengthSize + len;
        count++;
    }
    return pos === data.length && count >= 1;
}
export function isValidHevcWalk(data, lengthSize = 4) {
    if (!Number.isInteger(lengthSize) || lengthSize < 1 || lengthSize > 4)
        return false;
    let pos = 0;
    let count = 0;
    while (pos + lengthSize <= data.length) {
        let length = 0;
        for (let i = 0; i < lengthSize; i++)
            length = length * 256 + data[pos + i];
        pos += lengthSize;
        if (length < 2 || length > data.length - pos)
            return false;
        if ((data[pos] & 0x80) !== 0 || (data[pos + 1] & 7) === 0)
            return false;
        pos += length;
        count++;
    }
    return pos === data.length && count > 0;
}
export function isAnnexB(data) {
    if (data.length < 4)
        return false;
    if (data[0] !== 0 || data[1] !== 0)
        return false;
    let pos = 2;
    while (pos < data.length && data[pos] === 0)
        pos++;
    return pos < data.length && data[pos] === 1;
}
export function splitAnnexBNals(data) {
    const nals = [];
    let i = 0;
    let nalStart = -1;
    const flush = (end) => {
        if (nalStart < 0)
            return;
        let trimmed = end;
        while (trimmed > nalStart && data[trimmed - 1] === 0)
            trimmed--;
        if (trimmed > nalStart)
            nals.push(data.subarray(nalStart, trimmed));
        nalStart = -1;
    };
    while (i + 3 <= data.length) {
        if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
            flush(i);
            i += 3;
            nalStart = i;
        }
        else if (i + 4 <= data.length &&
            data[i] === 0 &&
            data[i + 1] === 0 &&
            data[i + 2] === 0 &&
            data[i + 3] === 1) {
            flush(i);
            i += 4;
            nalStart = i;
        }
        else {
            i++;
        }
    }
    flush(data.length);
    return nals;
}
export function annexBToAvcc(data, lengthSize = 4) {
    if (!Number.isInteger(lengthSize) || lengthSize < 1 || lengthSize > 4) {
        throw new MuxError('AVCC NAL length size must be an integer from 1 through 4');
    }
    const nals = splitAnnexBNals(data);
    const maxLength = 2 ** (lengthSize * 8) - 1;
    let total = 0;
    for (const nal of nals) {
        if (nal.length > maxLength) {
            throw new MuxError(`NAL length ${nal.length} exceeds the ${lengthSize}-byte AVCC length field`);
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
export function buildAvcCFromAnnexB(data) {
    const spsList = [];
    const ppsList = [];
    for (const nal of splitAnnexBNals(data)) {
        const type = nal[0] & 0x1f;
        if (type !== 7 && type !== 8)
            continue;
        if ((nal[0] & 0x80) !== 0 || nal.length > 0xffff)
            return null;
        if (type === 7) {
            if (spsList.length === 31)
                return null;
            spsList.push(nal);
        }
        else {
            if (ppsList.length === 255)
                return null;
            ppsList.push(nal);
        }
    }
    if (spsList.length === 0 || ppsList.length === 0)
        return null;
    const sps = spsList[0];
    if (sps.length < 4)
        return null;
    let total = 7;
    for (const s of spsList)
        total += 2 + s.length;
    for (const p of ppsList)
        total += 2 + p.length;
    const out = new Uint8Array(total);
    out[0] = 1;
    out[1] = sps[1];
    out[2] = sps[2];
    out[3] = sps[3];
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
export function avcConfigToSamplePrefix(avcC) {
    if (avcC.length < 7 || avcC[0] !== 1)
        return null;
    const lengthSize = (avcC[4] & 0x03) + 1;
    if (lengthSize < 1 || lengthSize > 4)
        return null;
    const parameterSets = [];
    let pos = 6;
    const numSps = avcC[5] & 0x1f;
    if (numSps === 0)
        return null;
    for (let i = 0; i < numSps; i++) {
        if (pos + 2 > avcC.length)
            return null;
        const length = (avcC[pos] << 8) | avcC[pos + 1];
        pos += 2;
        if (length <= 0 || pos + length > avcC.length)
            return null;
        if ((avcC[pos] & 0x9f) !== 7)
            return null;
        parameterSets.push(avcC.subarray(pos, pos + length));
        pos += length;
    }
    if (pos >= avcC.length)
        return null;
    const numPps = avcC[pos++];
    if (numPps === 0)
        return null;
    for (let i = 0; i < numPps; i++) {
        if (pos + 2 > avcC.length)
            return null;
        const length = (avcC[pos] << 8) | avcC[pos + 1];
        pos += 2;
        if (length <= 0 || pos + length > avcC.length)
            return null;
        if ((avcC[pos] & 0x9f) !== 8)
            return null;
        parameterSets.push(avcC.subarray(pos, pos + length));
        pos += length;
    }
    const maxLength = 2 ** (lengthSize * 8) - 1;
    let total = 0;
    for (const nal of parameterSets) {
        if (nal.length > maxLength)
            return null;
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
export function prependAvcConfigToSample(avcC, sample) {
    const prefix = avcConfigToSamplePrefix(avcC);
    if (!prefix)
        return null;
    const out = new Uint8Array(prefix.length + sample.length);
    out.set(prefix, 0);
    out.set(sample, prefix.length);
    return out;
}
export function buildHevcCFromAnnexB(data) {
    const arrays = [[], [], []];
    for (const nal of splitAnnexBNals(data)) {
        const type = (nal[0] >>> 1) & 0x3f;
        if (type < 32 || type > 34)
            continue;
        if (nal.length < 3 || nal.length > 0xffff || (nal[0] & 0x81) !== 0 || nal[1] !== 1)
            return null;
        const list = arrays[type - 32];
        if (list.some(existing => existing.length === nal.length && existing.every((b, i) => b === nal[i])))
            continue;
        if (list.length === 0xffff)
            return null;
        list.push(nal);
    }
    if (arrays.some(list => list.length === 0))
        return null;
    const sequenceSets = arrays[1].map(parseHevcSps);
    if (sequenceSets.some(sps => sps === null))
        return null;
    const first = sequenceSets[0];
    if (!first)
        return null;
    for (const sps of sequenceSets) {
        if (!sps ||
            sps.profileSpace !== first.profileSpace ||
            sps.tierFlag !== first.tierFlag ||
            sps.profileIdc !== first.profileIdc ||
            sps.profileCompatibilityFlags !== first.profileCompatibilityFlags ||
            sps.levelIdc !== first.levelIdc ||
            sps.chromaFormatIdc !== first.chromaFormatIdc ||
            sps.bitDepthLumaMinus8 !== first.bitDepthLumaMinus8 ||
            sps.bitDepthChromaMinus8 !== first.bitDepthChromaMinus8 ||
            sps.constraintIndicatorFlags.some((b, i) => b !== first.constraintIndicatorFlags[i]))
            return null;
    }
    try {
        const vpsIds = new Set();
        for (const vps of arrays[0]) {
            const bits = new H264BitReader(nalToRbsp(vps, 2));
            vpsIds.add(bits.readBits(4));
            bits.skipBits(2);
            if (bits.readBits(6) !== 0)
                return null;
            if (bits.readBits(3) > 6)
                return null;
            bits.readBit();
            if (bits.readBits(16) !== 0xffff)
                return null;
            bits.skipBits(96);
        }
        for (const sps of sequenceSets)
            if (!vpsIds.has(sps.videoParameterSetId))
                return null;
        const spsIds = new Set(sequenceSets.map(sps => sps.sequenceParameterSetId));
        for (const pps of arrays[2]) {
            const bits = new H264BitReader(nalToRbsp(pps, 2));
            if (bits.readUE() > 63 || !spsIds.has(bits.readUE()))
                return null;
            bits.skipBits(7);
            if (bits.readUE() > 14 || bits.readUE() > 14)
                return null;
            const initQpMinus26 = bits.readSE();
            if (initQpMinus26 < -(26 + 6 * first.bitDepthLumaMinus8) || initQpMinus26 > 25)
                return null;
        }
    }
    catch {
        return null;
    }
    let size = 23;
    for (const list of arrays) {
        size += 3;
        for (const nal of list)
            size += 2 + nal.length;
    }
    const out = new Uint8Array(size);
    const view = new DataView(out.buffer);
    out[0] = 1;
    out[1] = (first.profileSpace << 6) | (first.tierFlag << 5) | first.profileIdc;
    view.setUint32(2, first.profileCompatibilityFlags);
    out.set(first.constraintIndicatorFlags, 6);
    out[12] = first.levelIdc;
    out[13] = 0xf0;
    out[15] = 0xfc;
    out[16] = 0xfc | first.chromaFormatIdc;
    out[17] = 0xf8 | first.bitDepthLumaMinus8;
    out[18] = 0xf8 | first.bitDepthChromaMinus8;
    const temporalLayers = Math.max(...sequenceSets.map(sps => sps.maxSubLayersMinus1 + 1));
    const temporalNested = sequenceSets.every(sps => sps.temporalIdNestingFlag === 1) ? 1 : 0;
    out[21] = (temporalLayers << 3) | (temporalNested << 2) | 3;
    out[22] = arrays.length;
    let pos = 23;
    for (let i = 0; i < arrays.length; i++) {
        const list = arrays[i];
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
