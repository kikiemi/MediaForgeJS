export class H264BitReader {
    data;
    bitOffset = 0;
    constructor(data) {
        this.data = data;
    }
    readBit() {
        return this.readBits(1);
    }
    skipBits(count) {
        if (!Number.isSafeInteger(count) || count < 0)
            throw new RangeError('invalid bit count');
        if (count > this.data.length * 8 - this.bitOffset)
            throw new RangeError('SPS truncated');
        this.bitOffset += count;
    }
    readBits(count) {
        if (!Number.isInteger(count) || count < 0 || count > 32)
            throw new RangeError('invalid bit count');
        if (this.bitOffset + count > this.data.length * 8)
            throw new RangeError('SPS truncated');
        let value = 0;
        for (let i = 0; i < count; i++) {
            const byte = this.data[Math.floor(this.bitOffset / 8)];
            value = value * 2 + ((byte >> (7 - (this.bitOffset & 7))) & 1);
            this.bitOffset++;
        }
        return value;
    }
    readUE() {
        let leadingZeros = 0;
        while (this.readBit() === 0) {
            if (++leadingZeros > 31)
                throw new RangeError('Exp-Golomb overflow');
        }
        if (leadingZeros === 0)
            return 0;
        const suffix = this.readBits(leadingZeros);
        return 2 ** leadingZeros - 1 + suffix;
    }
    readSE() {
        const codeNum = this.readUE();
        return codeNum % 2 ? (codeNum + 1) / 2 : -codeNum / 2;
    }
    skipScalingList(size) {
        let lastScale = 8;
        let nextScale = 8;
        for (let i = 0; i < size; i++) {
            if (nextScale !== 0) {
                const deltaScale = this.readSE();
                nextScale = (lastScale + deltaScale + 256) & 0xff;
            }
            lastScale = nextScale === 0 ? lastScale : nextScale;
        }
    }
}
export function nalToRbsp(nal, headerBytes) {
    const rbsp = new Uint8Array(Math.max(0, nal.length - headerBytes));
    let rbspLength = 0;
    let zeroRun = 0;
    for (let i = headerBytes; i < nal.length; i++) {
        const byte = nal[i];
        if (zeroRun >= 2 && byte === 0x03) {
            zeroRun = 0;
            continue;
        }
        rbsp[rbspLength++] = byte;
        zeroRun = byte === 0 ? zeroRun + 1 : 0;
    }
    return rbsp.subarray(0, rbspLength);
}
export function avcCodecStringFromSps(sps) {
    if (sps.length < 4)
        return 'avc1';
    return (`avc1.${sps[1].toString(16).padStart(2, '0')}` +
        `${sps[2].toString(16).padStart(2, '0')}` +
        `${sps[3].toString(16).padStart(2, '0')}`);
}
export function parseH264Sps(sps) {
    if (sps.length < 4 || (sps[0] & 0x1f) !== 7)
        return null;
    try {
        const bits = new H264BitReader(nalToRbsp(sps, 1));
        const profileIdc = bits.readBits(8);
        bits.skipBits(8);
        bits.skipBits(8);
        bits.readUE();
        let chromaFormatIdc = 1;
        let separateColourPlaneFlag = 0;
        if (HIGH_PROFILE_IDS.has(profileIdc)) {
            chromaFormatIdc = bits.readUE();
            if (chromaFormatIdc > 3)
                return null;
            if (chromaFormatIdc === 3)
                separateColourPlaneFlag = bits.readBit();
            bits.readUE();
            bits.readUE();
            bits.readBit();
            if (bits.readBit()) {
                const scalingListCount = chromaFormatIdc !== 3 ? 8 : 12;
                for (let i = 0; i < scalingListCount; i++) {
                    if (bits.readBit())
                        bits.skipScalingList(i < 6 ? 16 : 64);
                }
            }
        }
        bits.readUE();
        const picOrderCntType = bits.readUE();
        if (picOrderCntType === 0) {
            bits.readUE();
        }
        else if (picOrderCntType === 1) {
            bits.readBit();
            bits.readSE();
            bits.readSE();
            const cycle = bits.readUE();
            if (cycle > 256)
                return null;
            for (let i = 0; i < cycle; i++)
                bits.readSE();
        }
        else if (picOrderCntType > 2) {
            return null;
        }
        bits.readUE();
        bits.readBit();
        const picWidthInMbsMinus1 = bits.readUE();
        const picHeightInMapUnitsMinus1 = bits.readUE();
        const frameMbsOnlyFlag = bits.readBit();
        if (!frameMbsOnlyFlag)
            bits.readBit();
        bits.readBit();
        let cropLeft = 0;
        let cropRight = 0;
        let cropTop = 0;
        let cropBottom = 0;
        if (bits.readBit()) {
            cropLeft = bits.readUE();
            cropRight = bits.readUE();
            cropTop = bits.readUE();
            cropBottom = bits.readUE();
        }
        const chromaArrayType = separateColourPlaneFlag ? 0 : chromaFormatIdc;
        const subWidthC = chromaArrayType === 1 || chromaArrayType === 2 ? 2 : 1;
        const subHeightC = chromaArrayType === 1 ? 2 : 1;
        const cropUnitX = chromaArrayType === 0 ? 1 : subWidthC;
        const cropUnitY = (chromaArrayType === 0 ? 1 : subHeightC) * (2 - frameMbsOnlyFlag);
        const width = (picWidthInMbsMinus1 + 1) * 16 - (cropLeft + cropRight) * cropUnitX;
        const height = (picHeightInMapUnitsMinus1 + 1) * 16 * (2 - frameMbsOnlyFlag) - (cropTop + cropBottom) * cropUnitY;
        if (!Number.isSafeInteger(width) ||
            !Number.isSafeInteger(height) ||
            width <= 0 ||
            height <= 0 ||
            width > 16384 ||
            height > 16384)
            return null;
        let pixelAspectRatioNum = 1;
        let pixelAspectRatioDen = 1;
        const vuiParametersPresent = bits.readBit();
        if (vuiParametersPresent && bits.readBit()) {
            const aspectRatioIdc = bits.readBits(8);
            if (aspectRatioIdc === 255) {
                const sarWidth = bits.readBits(16);
                const sarHeight = bits.readBits(16);
                if (sarWidth > 0 && sarHeight > 0) {
                    pixelAspectRatioNum = sarWidth;
                    pixelAspectRatioDen = sarHeight;
                }
            }
            else {
                const ratio = H264_SAR_TABLE[aspectRatioIdc];
                if (ratio)
                    [pixelAspectRatioNum, pixelAspectRatioDen] = ratio;
            }
        }
        const ratioGcd = gcd(pixelAspectRatioNum, pixelAspectRatioDen);
        pixelAspectRatioNum /= ratioGcd;
        pixelAspectRatioDen /= ratioGcd;
        const display = displayDimensions(width, height, pixelAspectRatioNum, pixelAspectRatioDen);
        return {
            width,
            height,
            pixelAspectRatioNum,
            pixelAspectRatioDen,
            displayWidth: display.num,
            displayHeight: display.den,
        };
    }
    catch {
        return null;
    }
}
export function parseHevcSps(sps) {
    if (sps.length < 6 || (sps[0] & 0x81) !== 0 || sps[1] !== 1 || ((sps[0] >> 1) & 0x3f) !== 33)
        return null;
    try {
        const bits = new H264BitReader(nalToRbsp(sps, 2));
        const videoParameterSetId = bits.readBits(4);
        const maxSubLayersMinus1 = bits.readBits(3);
        if (maxSubLayersMinus1 > 6)
            return null;
        const temporalIdNestingFlag = bits.readBit();
        const profileSpace = bits.readBits(2);
        const tierFlag = bits.readBit();
        const profileIdc = bits.readBits(5);
        let compat = 0;
        for (let i = 0; i < 32; i++)
            compat = (compat << 1) | bits.readBit();
        const constraintBytes = [];
        for (let i = 0; i < 6; i++)
            constraintBytes.push(bits.readBits(8));
        const levelIdc = bits.readBits(8);
        if (maxSubLayersMinus1 > 0) {
            const profilePresent = [];
            const levelPresent = [];
            for (let i = 0; i < maxSubLayersMinus1; i++) {
                profilePresent.push(bits.readBit());
                levelPresent.push(bits.readBit());
            }
            for (let i = maxSubLayersMinus1; i < 8; i++)
                bits.skipBits(2);
            for (let i = 0; i < maxSubLayersMinus1; i++) {
                if (profilePresent[i])
                    bits.skipBits(88);
                if (levelPresent[i])
                    bits.skipBits(8);
            }
        }
        const sequenceParameterSetId = bits.readUE();
        if (sequenceParameterSetId > 15)
            return null;
        const chromaFormatIdc = bits.readUE();
        if (chromaFormatIdc > 3)
            return null;
        if (chromaFormatIdc === 3)
            bits.readBit();
        let width = bits.readUE();
        let height = bits.readUE();
        if (bits.readBit()) {
            const left = bits.readUE();
            const right = bits.readUE();
            const top = bits.readUE();
            const bottom = bits.readUE();
            const subW = chromaFormatIdc === 1 || chromaFormatIdc === 2 ? 2 : 1;
            const subH = chromaFormatIdc === 1 ? 2 : 1;
            width -= (left + right) * subW;
            height -= (top + bottom) * subH;
        }
        if (!Number.isSafeInteger(width) ||
            !Number.isSafeInteger(height) ||
            width <= 0 ||
            height <= 0 ||
            width > 16384 ||
            height > 16384)
            return null;
        const bitDepthLumaMinus8 = bits.readUE();
        const bitDepthChromaMinus8 = bits.readUE();
        if (bitDepthLumaMinus8 > 7 || bitDepthChromaMinus8 > 7)
            return null;
        const spacePrefix = profileSpace === 0 ? '' : String.fromCharCode(64 + profileSpace);
        let reversed = 0;
        for (let i = 0; i < 32; i++)
            reversed = (reversed << 1) | ((compat >>> i) & 1);
        let constraintTail = '';
        let lastNonZero = -1;
        for (let i = 0; i < constraintBytes.length; i++) {
            if (constraintBytes[i] !== 0)
                lastNonZero = i;
        }
        for (let i = 0; i <= lastNonZero; i++) {
            constraintTail += `.${constraintBytes[i].toString(16).toUpperCase()}`;
        }
        const codec = `hev1.${spacePrefix}${profileIdc}.${(reversed >>> 0).toString(16).toUpperCase()}` +
            `.${tierFlag ? 'H' : 'L'}${levelIdc}${constraintTail}`;
        return {
            width,
            height,
            pixelAspectRatioNum: 1,
            pixelAspectRatioDen: 1,
            displayWidth: width,
            displayHeight: height,
            codec,
            videoParameterSetId,
            sequenceParameterSetId,
            profileSpace,
            tierFlag,
            profileIdc,
            profileCompatibilityFlags: compat >>> 0,
            constraintIndicatorFlags: new Uint8Array(constraintBytes),
            levelIdc,
            maxSubLayersMinus1,
            temporalIdNestingFlag,
            chromaFormatIdc,
            bitDepthLumaMinus8,
            bitDepthChromaMinus8,
        };
    }
    catch {
        return null;
    }
}
export function gcd(a, b) {
    if (!Number.isFinite(a) || !Number.isFinite(b))
        throw new RangeError('invalid ratio');
    a = Math.abs(Math.round(a));
    b = Math.abs(Math.round(b));
    while (b !== 0)
        [a, b] = [b, a % b];
    return Math.max(1, a);
}
export function displayDimensions(width, height, parNum, parDen) {
    if (parNum === parDen)
        return { num: width, den: height };
    const adjustedWidth = (width * parNum) / parDen;
    if (Number.isSafeInteger(adjustedWidth) && adjustedWidth > 0 && adjustedWidth <= 16384) {
        return { num: adjustedWidth, den: height };
    }
    const adjustedHeight = (height * parDen) / parNum;
    if (Number.isSafeInteger(adjustedHeight) && adjustedHeight > 0 && adjustedHeight <= 16384) {
        return { num: width, den: adjustedHeight };
    }
    const darGcd = gcd(width * parNum, height * parDen);
    return { num: (width * parNum) / darGcd, den: (height * parDen) / darGcd };
}
const HIGH_PROFILE_IDS = new Set([44, 83, 86, 100, 110, 118, 122, 128, 134, 135, 138, 139, 144, 244]);
const H264_SAR_TABLE = {
    1: [1, 1],
    2: [12, 11],
    3: [10, 11],
    4: [16, 11],
    5: [40, 33],
    6: [24, 11],
    7: [20, 11],
    8: [32, 11],
    9: [80, 33],
    10: [18, 11],
    11: [15, 11],
    12: [64, 33],
    13: [160, 99],
    14: [4, 3],
    15: [3, 2],
    16: [2, 1],
};
