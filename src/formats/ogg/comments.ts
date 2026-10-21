import { DemuxError } from '../../core/errors/errors';
import { dataView } from '../../core/bytes/byte-fields';
import { asciiAt } from '../detection/head-bytes';

/** The little-endian 32-bit value at `at`; out of range fails as a DataView read does. */
export function u32(bytes: Uint8Array, at: number): number {
    if (!(at >= 0 && at + 4 <= bytes.length) || !Number.isInteger(at))
        return dataView(bytes).getUint32(at, true);
    return (
        (bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16) | (bytes[at + 3]! << 24)) >>> 0
    );
}

/** Checks the bounds of a Vorbis or Opus comment header packet. */
export function validateOggComments(packet: Uint8Array, opus: boolean): void {
    const start = opus ? 8 : 7;
    if (!asciiAt(packet, 0, opus ? 'OpusTags' : '\x03vorbis') || packet.length < start + 8)
        throw new DemuxError('Invalid Ogg audio comment header');

    let offset = start + 4;
    const vendorLength = u32(packet, start);
    if (vendorLength > packet.length - offset - 4)
        throw new DemuxError('Truncated Ogg comment vendor');
    offset += vendorLength;
    const count = u32(packet, offset);
    offset += 4;
    if (count > 100_000 || count > Math.floor((packet.length - offset) / 4))
        throw new DemuxError('Ogg comment count exceeds header bounds');

    for (let index = 0; index < count; index++) {
        if (offset > packet.length - 4) throw new DemuxError('Truncated Ogg comment length');
        const length = u32(packet, offset);
        offset += 4;
        if (length > packet.length - offset) throw new DemuxError('Truncated Ogg comment');
        offset += length;
    }

    if (!opus && (offset >= packet.length || (packet[offset]! & 1) !== 1))
        throw new DemuxError('Missing Vorbis comment framing flag');
}
