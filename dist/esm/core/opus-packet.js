import { DemuxError } from './errors.js';
export function opusPacketFrames(prefix, packetBytes, singleStream = false) {
    if (typeof singleStream !== 'boolean')
        throw new DemuxError('Opus single-stream validation flag must be boolean');
    if (!Number.isSafeInteger(packetBytes) ||
        packetBytes < 1 ||
        !prefix ||
        !Number.isSafeInteger(prefix.length) ||
        prefix.length < 1) {
        throw new DemuxError('Ogg Opus audio packet is truncated or has an invalid byte count');
    }
    const toc = prefix[0];
    if (!Number.isInteger(toc) || toc < 0 || toc > 255)
        throw new DemuxError('Opus packet TOC is not a byte');
    const config = toc >> 3;
    let framesPerPacket;
    if (config >= 16)
        framesPerPacket = 120 << (config & 3);
    else if (config >= 12)
        framesPerPacket = 480 << (config & 1);
    else
        framesPerPacket = [480, 960, 1920, 2880][config & 3];
    const countCode = toc & 3;
    let count = countCode === 0 ? 1 : 2;
    let control = 0;
    if (countCode === 3) {
        if (packetBytes < 2 || prefix.length < 2) {
            throw new DemuxError('Ogg Opus packet omits its frame count');
        }
        control = prefix[1];
        if (!Number.isInteger(control) || control < 0 || control > 255) {
            throw new DemuxError('Opus packet frame count is not a byte');
        }
        count = control & 0x3f;
        if (count < 1)
            throw new DemuxError('Ogg Opus packet declares zero frames');
    }
    const total = framesPerPacket * count;
    if (total > 5760)
        throw new DemuxError('Ogg Opus packet exceeds the 120 ms duration limit');
    if (singleStream) {
        if (countCode === 0) {
            if (packetBytes > 1276)
                throw new DemuxError('Opus frame exceeds 1275 bytes');
        }
        else if (countCode === 1) {
            if (packetBytes % 2 !== 1 || packetBytes > 2551) {
                throw new DemuxError('Opus CBR packet has invalid frame lengths');
            }
        }
        else if (countCode === 2) {
            let minimum = 2;
            let maximum = 2553;
            if (prefix.length >= 2) {
                const lengthByte = prefix[1];
                if (!Number.isInteger(lengthByte) || lengthByte < 0 || lengthByte > 255) {
                    throw new DemuxError('Opus VBR frame length is not a byte');
                }
                const extended = lengthByte >= 252;
                minimum = (extended ? 3 : 2) + lengthByte;
                maximum = minimum + (extended ? 1020 : 0) + 1275;
            }
            if (packetBytes < minimum || packetBytes > maximum) {
                throw new DemuxError('Opus VBR packet has invalid frame lengths');
            }
        }
        else {
            const padded = (control & 0x40) !== 0;
            const vbr = (control & 0x80) !== 0;
            const minimum = 2 + (padded ? 1 : 0) + (vbr ? count - 1 : 0);
            if (packetBytes < minimum)
                throw new DemuxError('Opus packet omits required framing bytes');
            if (!padded &&
                (packetBytes > 2 + count * 1275 + (vbr ? (count - 1) * 2 : 0) ||
                    (!vbr && (packetBytes - 2) % count !== 0))) {
                throw new DemuxError('Opus packet has invalid frame lengths');
            }
        }
    }
    return total;
}
