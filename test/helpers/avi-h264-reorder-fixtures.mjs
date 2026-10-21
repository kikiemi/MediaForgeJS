import { Bits, nal, join, annexB, lengthPrefixed, aviH264 } from './avi-h264-fixtures.mjs';

export function reorderFixture(options = {}) {
    const {
        pocType = 0,
        log2Poc = 4,
        log2FrameNum = 4,
        offsets = [2],
        nonRefOffset = -1,
        bottomOffset = 0,
        deltaAlwaysZero = false,
        bottomPresent = false,
        frameOnly = true,
        weightedPred = false,
        ppsId = 0,
        spsId = 0,
        framing = 'annexb',
        width = 4,
        inBand = false,
    } = options;
    const seq = new Bits()
        .ue(spsId)
        .ue(log2FrameNum - 4)
        .ue(pocType);
    if (pocType === 0) seq.ue(log2Poc - 4);
    if (pocType === 1) {
        seq.uint(+deltaAlwaysZero, 1).se(nonRefOffset).se(bottomOffset).ue(offsets.length);
        for (const value of offsets) seq.se(value);
    }
    seq.ue(4).uint(0, 1).ue(1).ue(0).uint(+frameOnly, 1);
    if (!frameOnly) seq.uint(1, 1);
    seq.uint(1, 1).uint(0, 2);
    const sps = nal(0x67, join([77, 0, 10], seq.bytes()));
    const pps = nal(
        0x68,
        new Bits()
            .ue(ppsId)
            .ue(spsId)
            .uint(0, 1)
            .uint(+bottomPresent, 1)
            .ue(0)
            .ue(0)
            .ue(0)
            .uint(+weightedPred, 1)
            .uint(0, 2)
            .se(0)
            .se(0)
            .se(0)
            .uint(0, 3)
            .bytes(),
    );
    const config = join(
        [1, 77, 0, 10, 0xfc | (width - 1), 0xe1, 0, sps.length],
        sps,
        [1, 0, pps.length],
        pps,
    );
    const slice = ({
        type = 'P',
        frameNum = 0,
        poc = 0,
        delta0 = 0,
        delta1 = 0,
        firstMb = 0,
        reference = type !== 'B',
        reset = false,
        field = false,
        bottom = false,
        idrId = 0,
    } = {}) => {
        const idr = type === 'IDR';
        const b = type === 'B';
        const intra = idr || type === 'I';
        const bits = new Bits()
            .ue(firstMb)
            .ue(intra ? 2 : b ? 1 : 0)
            .ue(ppsId)
            .uint(frameNum, log2FrameNum);
        if (!frameOnly) {
            bits.uint(+field, 1);
            if (field) bits.uint(+bottom, 1);
        }
        if (idr) bits.ue(idrId);
        if (pocType === 0) {
            bits.uint(poc, log2Poc);
            if (bottomPresent && !field) bits.se(delta1);
        } else if (pocType === 1 && !deltaAlwaysZero) {
            bits.se(delta0);
            if (bottomPresent && !field) bits.se(delta1);
        }
        if (b) bits.uint(1, 1);
        if (!intra) {
            bits.uint(0, 1).uint(0, 1);
            if (b) bits.uint(0, 1);
        }
        if (weightedPred && !intra && !b) bits.ue(0).ue(0).uint(0, 2);
        if (reference) {
            if (idr) bits.uint(0, 2);
            else {
                bits.uint(+reset, 1);
                if (reset) bits.ue(5).ue(0);
            }
        }
        bits.se(0);
        return nal((reference ? 0x40 : 0) | (idr ? 5 : 1), bits.bytes());
    };
    const packet = (...nals) =>
        framing === 'annexb' ? annexB(...nals) : lengthPrefixed(width, ...nals);
    const avi = (pictures, extraPackets = []) => {
        const packets = pictures.map(picture =>
            packet(...(Array.isArray(picture) ? picture : [slice(picture)])),
        );
        if (inBand) packets[0] = packet(sps, pps, slice(pictures[0]));
        return aviH264({
            extra: inBand ? new Uint8Array(0) : config,
            packets: [...packets, ...extraPackets],
        });
    };
    return { avi, slice, packet, sps, pps, config };
}
