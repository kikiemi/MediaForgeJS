import { demuxAssert } from './demux-guard.js';
import { DemuxError } from './errors.js';
class Bits {
    bytes;
    offset = 1;
    remaining = 0;
    byte = 0;
    zeros = 0;
    constructor(bytes) {
        this.bytes = bytes;
    }
    uint(count) {
        let value = 0;
        for (let index = 0; index < count; index++) {
            if (this.remaining === 0) {
                demuxAssert(this.offset < this.bytes.length, 'AVI H.264 timing header is truncated or exceeds its size limit');
                this.byte = this.bytes[this.offset++];
                if (this.zeros === 2 && this.byte === 3) {
                    demuxAssert(this.offset < this.bytes.length && this.bytes[this.offset] <= 3, 'AVI H.264 emulation prevention is malformed');
                    this.byte = this.bytes[this.offset++];
                    this.zeros = 0;
                }
                this.zeros = this.byte === 0 ? this.zeros + 1 : 0;
                this.remaining = 8;
            }
            value = value * 2 + ((this.byte >>> --this.remaining) & 1);
        }
        return value;
    }
    ue(max = 0x7fffffff) {
        let zeros = 0;
        while (this.uint(1) === 0)
            demuxAssert(++zeros <= 31, 'AVI H.264 Exp-Golomb value exceeds its limit');
        const value = 2 ** zeros - 1 + this.uint(zeros);
        demuxAssert(value <= max, 'AVI H.264 timing header value is out of range');
        return value;
    }
    se() {
        const value = this.ue();
        return value & 1 ? (value + 1) / 2 : -value / 2;
    }
}
function sequence(nal) {
    const bits = new Bits(nal);
    const profile = bits.uint(8);
    bits.uint(16);
    const id = bits.ue(31);
    let chroma = 1;
    let separateColourPlane = false;
    if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135, 144].includes(profile)) {
        chroma = bits.ue(3);
        if (chroma === 3)
            separateColourPlane = !!bits.uint(1);
        bits.ue(6);
        bits.ue(6);
        bits.uint(1);
        if (bits.uint(1)) {
            for (let index = 0; index < (chroma === 3 ? 12 : 8); index++) {
                if (!bits.uint(1))
                    continue;
                let last = 8;
                let next = 8;
                for (let entry = 0; entry < (index < 6 ? 16 : 64); entry++) {
                    if (next !== 0)
                        next = (((last + bits.se()) % 256) + 256) % 256;
                    if (next !== 0)
                        last = next;
                }
            }
        }
    }
    const frameBits = bits.ue(12) + 4;
    const pocType = bits.ue(2);
    let pocBits = 0;
    let deltaAlwaysZero = false;
    let nonReferenceOffset = 0;
    let bottomOffset = 0;
    const cycle = [];
    if (pocType === 0)
        pocBits = bits.ue(12) + 4;
    if (pocType === 1) {
        deltaAlwaysZero = !!bits.uint(1);
        nonReferenceOffset = bits.se();
        bottomOffset = bits.se();
        const count = bits.ue(255);
        for (let index = 0; index < count; index++)
            cycle.push(bits.se());
    }
    bits.ue(16);
    bits.uint(1);
    bits.ue(65535);
    bits.ue(65535);
    const frameOnly = !!bits.uint(1);
    if (!frameOnly)
        bits.uint(1);
    bits.uint(1);
    if (bits.uint(1))
        for (let index = 0; index < 4; index++)
            bits.ue();
    const noReordering = bits.uint(1) ? vuiNoReordering(bits) : false;
    return {
        id,
        frameBits,
        pocType,
        pocBits,
        deltaAlwaysZero,
        nonReferenceOffset,
        bottomOffset,
        cycle,
        frameOnly,
        separateColourPlane,
        chroma,
        noReordering,
    };
}
function vuiNoReordering(bits) {
    if (bits.uint(1) && bits.uint(8) === 255)
        bits.uint(32);
    if (bits.uint(1))
        bits.uint(1);
    if (bits.uint(1)) {
        bits.uint(4);
        if (bits.uint(1))
            bits.uint(24);
    }
    if (bits.uint(1)) {
        bits.ue();
        bits.ue();
    }
    if (bits.uint(1)) {
        bits.uint(32);
        bits.uint(32);
        bits.uint(1);
    }
    const hrd = () => {
        if (!bits.uint(1))
            return false;
        const count = bits.ue(31) + 1;
        bits.uint(8);
        for (let index = 0; index < count; index++) {
            bits.ue();
            bits.ue();
            bits.uint(1);
        }
        bits.uint(20);
        return true;
    };
    const nalHrd = hrd();
    const vclHrd = hrd();
    if (nalHrd || vclHrd)
        bits.uint(1);
    bits.uint(1);
    if (!bits.uint(1))
        return false;
    bits.uint(1);
    for (let index = 0; index < 4; index++)
        bits.ue();
    const reordered = bits.ue(16);
    const buffered = bits.ue(16);
    demuxAssert(reordered <= buffered, 'AVI H.264 reorder limit exceeds its decoded picture buffer');
    return reordered === 0;
}
function parameters(nal) {
    const bits = new Bits(nal);
    const id = bits.ue(255);
    const sequenceId = bits.ue(31);
    bits.uint(1);
    const bottomPresent = !!bits.uint(1);
    const groups = bits.ue(7) + 1;
    if (groups > 1) {
        const map = bits.ue(6);
        if (map === 0)
            for (let index = 0; index < groups; index++)
                bits.ue();
        else if (map === 2)
            for (let index = 1; index < groups; index++) {
                bits.ue();
                bits.ue();
            }
        else if (map >= 3 && map <= 5) {
            bits.uint(1);
            bits.ue();
        }
        else if (map === 6) {
            const count = bits.ue(1048575) + 1;
            const width = Math.ceil(Math.log2(groups));
            for (let index = 0; index < count; index++)
                demuxAssert(bits.uint(width) < groups, 'AVI H.264 slice group is out of range');
        }
    }
    const references = [bits.ue(31) + 1, bits.ue(31) + 1];
    const weightedPrediction = !!bits.uint(1);
    const weightedBiprediction = bits.uint(2);
    demuxAssert(weightedBiprediction <= 2, 'AVI H.264 weighted prediction is invalid');
    bits.se();
    bits.se();
    bits.se();
    bits.uint(2);
    const redundant = !!bits.uint(1);
    return { id, sequenceId, bottomPresent, redundant, references, weightedPrediction, weightedBiprediction };
}
export class AVCPictureOrderReader {
    sequences = new Map();
    parameters = new Map();
    pendingSequences = new Map();
    pendingParameters = new Map();
    picture;
    epoch = 0;
    previousFrame = 0;
    frameOffset = 0;
    previousLsb = 0;
    previousMsb = 0;
    beginPacket() {
        this.picture = undefined;
        this.pendingSequences.clear();
        this.pendingParameters.clear();
    }
    parameter(nal, configuration = false) {
        if ((nal[0] & 31) === 7) {
            const value = sequence(nal);
            (configuration ? this.sequences : this.pendingSequences).set(value.id, value);
        }
        else {
            const value = parameters(nal);
            (configuration ? this.parameters : this.pendingParameters).set(value.id, value);
        }
    }
    slice(nal) {
        const type = nal[0] & 31;
        demuxAssert(type === 1 || type === 5, 'AVI H.264 partitioned or extended pictures are not supported for timing restoration');
        const bits = new Bits(nal);
        bits.ue();
        const sliceType = bits.ue(9) % 5;
        const ppsId = bits.ue(255);
        const pps = this.pendingParameters.get(ppsId) ?? this.parameters.get(ppsId);
        demuxAssert(pps, 'AVI H.264 slice references a missing PPS parameter set');
        const sps = this.pendingSequences.get(pps.sequenceId) ?? this.sequences.get(pps.sequenceId);
        demuxAssert(sps, 'AVI H.264 slice references a missing SPS parameter set');
        const colourPlane = sps.separateColourPlane ? bits.uint(2) : 0;
        const frame = bits.uint(sps.frameBits);
        if (!sps.frameOnly && bits.uint(1))
            throw new DemuxError('AVI H.264 separate field pictures need explicit presentation timing');
        const idr = type === 5;
        const idrId = idr ? bits.ue(65535) : 0;
        const lsb = sps.pocType === 0 ? bits.uint(sps.pocBits) : 0;
        const deltaBottom = sps.pocType === 0 && pps.bottomPresent ? bits.se() : 0;
        const delta0 = sps.pocType === 1 && !sps.deltaAlwaysZero ? bits.se() : 0;
        const delta1 = sps.pocType === 1 && !sps.deltaAlwaysZero && pps.bottomPresent ? bits.se() : 0;
        if (pps.redundant)
            bits.ue(127);
        const intra = sliceType === 2 || sliceType === 4;
        const b = sliceType === 1;
        if (b)
            bits.uint(1);
        const references = pps.references.slice();
        if (!intra && bits.uint(1)) {
            references[0] = bits.ue(31) + 1;
            if (b)
                references[1] = bits.ue(31) + 1;
        }
        if (!intra) {
            for (let list = 0; list < (b ? 2 : 1); list++) {
                if (!bits.uint(1))
                    continue;
                let count = 0;
                while (true) {
                    demuxAssert(++count <= 64, 'AVI H.264 reference-list modification exceeds its limit');
                    const operation = bits.ue(3);
                    if (operation === 3)
                        break;
                    bits.ue();
                }
            }
        }
        if ((pps.weightedPrediction && (sliceType === 0 || sliceType === 3)) || (pps.weightedBiprediction === 1 && b)) {
            bits.ue(7);
            const chroma = !sps.separateColourPlane && sps.chroma !== 0;
            if (chroma)
                bits.ue(7);
            for (let list = 0; list < (b ? 2 : 1); list++) {
                for (let index = 0; index < references[list]; index++) {
                    if (bits.uint(1)) {
                        bits.se();
                        bits.se();
                    }
                    if (chroma && bits.uint(1))
                        for (let plane = 0; plane < 2; plane++) {
                            bits.se();
                            bits.se();
                        }
                }
            }
        }
        const reference = (nal[0] & 0x60) !== 0;
        let reset = false;
        if (reference) {
            if (idr)
                bits.uint(2);
            else if (bits.uint(1)) {
                let count = 0;
                while (true) {
                    demuxAssert(++count <= 64, 'AVI H.264 reference marking exceeds its limit');
                    const operation = bits.ue(6);
                    if (operation === 0)
                        break;
                    if (operation === 1 || operation === 3)
                        bits.ue();
                    if (operation === 2)
                        bits.ue();
                    if (operation === 3 || operation === 6)
                        bits.ue();
                    if (operation === 4)
                        bits.ue();
                    if (operation === 5)
                        reset = true;
                }
            }
        }
        demuxAssert(!idr || (reference && frame === 0), 'AVI H.264 IDR picture has invalid reference/frame numbering');
        const value = {
            sequence: sps,
            parameters: pps,
            frame,
            reference,
            idr,
            idrId,
            colourPlane,
            lsb,
            deltaBottom,
            delta0,
            delta1,
            reset,
        };
        if (this.picture) {
            const previous = this.picture;
            demuxAssert(previous.parameters.id === ppsId &&
                previous.sequence === sps &&
                previous.frame === frame &&
                previous.reference === reference &&
                previous.idr === idr &&
                previous.idrId === idrId &&
                previous.lsb === lsb &&
                previous.deltaBottom === deltaBottom &&
                previous.delta0 === delta0 &&
                previous.delta1 === delta1 &&
                previous.reset === reset, 'AVI H.264 packet contains multiple pictures with one container timestamp');
        }
        else
            this.picture = value;
    }
    finishPacket() {
        for (const [id, value] of this.pendingSequences)
            this.sequences.set(id, value);
        for (const [id, value] of this.pendingParameters)
            this.parameters.set(id, value);
        const picture = this.picture;
        if (!picture)
            return undefined;
        const sps = picture.sequence;
        if (picture.idr) {
            this.previousFrame = this.frameOffset = this.previousMsb = this.previousLsb = 0;
            this.epoch++;
        }
        if (picture.frame < this.previousFrame)
            this.frameOffset += 2 ** sps.frameBits;
        let msb = this.previousMsb;
        let top;
        let bottom;
        if (sps.pocType === 0) {
            const maximum = 2 ** sps.pocBits;
            if (picture.lsb < this.previousLsb && this.previousLsb - picture.lsb >= maximum / 2)
                msb += maximum;
            else if (picture.lsb > this.previousLsb && picture.lsb - this.previousLsb > maximum / 2)
                msb -= maximum;
            top = msb + picture.lsb;
            bottom = top + picture.deltaBottom;
        }
        else if (sps.pocType === 1) {
            let absoluteFrame = sps.cycle.length ? this.frameOffset + picture.frame : 0;
            if (!picture.reference && absoluteFrame > 0)
                absoluteFrame--;
            let expected = 0;
            if (absoluteFrame > 0) {
                expected =
                    Math.floor((absoluteFrame - 1) / sps.cycle.length) *
                        sps.cycle.reduce((sum, value) => sum + value, 0);
                for (let index = 0; index <= (absoluteFrame - 1) % sps.cycle.length; index++)
                    expected += sps.cycle[index];
            }
            if (!picture.reference)
                expected += sps.nonReferenceOffset;
            top = expected + picture.delta0;
            bottom = top + sps.bottomOffset + picture.delta1;
        }
        else {
            top = picture.idr ? 0 : 2 * (this.frameOffset + picture.frame) - (picture.reference ? 0 : 1);
            bottom = top;
        }
        let poc = Math.min(top, bottom);
        demuxAssert(Number.isSafeInteger(top) && Number.isSafeInteger(bottom), 'AVI H.264 picture order exceeds its numeric limit');
        if (picture.reset) {
            this.epoch++;
            top -= poc;
            poc = 0;
        }
        this.previousFrame = picture.reset ? 0 : picture.frame;
        if (picture.reset)
            this.frameOffset = 0;
        if (picture.reference) {
            this.previousMsb = picture.reset ? 0 : msb;
            this.previousLsb = picture.reset ? top : picture.lsb;
        }
        return { epoch: this.epoch, poc, noReordering: sps.noReordering };
    }
}
