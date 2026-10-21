import { MediaForgeError } from '../../core/errors/errors';
import { concatBytes } from '../../core/bytes/bytes';
import { oggCrc32 } from './crc';

/** The pages of one Ogg logical stream, numbered from 0, for the Opus, FLAC and Vorbis writers. */
export class OggPager {
    private sequence = 0;

    constructor(readonly serial: number) {}

    /**
     * Pages of `packets` with at most 255 lacing values each: a page that completes a packet
     * carries `granule`, the first page the BOS flag (2) of `flags` and the last its EOS flag (4).
     */
    pages(packets: readonly Uint8Array[], granule: bigint, flags: number): Uint8Array[] {
        const lacing: number[] = [];
        for (const packet of packets) {
            for (let remaining = packet.length; remaining >= 255; remaining -= 255)
                lacing.push(255);
            lacing.push(packet.length % 255);
        }

        const data = packets.length === 1 ? packets[0]! : concatBytes(packets);
        const pages: Uint8Array[] = [];
        for (let first = 0, offset = 0; first < lacing.length; first += 255) {
            if (this.sequence > 0xffffffff)
                throw new MediaForgeError('Ogg page sequence overflow', 'MUX');
            const values = lacing.slice(first, first + 255);
            const last = first + values.length === lacing.length;
            const size = values.reduce((sum, value) => sum + value, 0);
            const page = new Uint8Array(27 + values.length + size);
            const view = new DataView(page.buffer);
            const continued = first > 0 && lacing[first - 1] === 255;
            page.set([
                79,
                103,
                103,
                83,
                0,
                (continued ? 1 : 0) | (first ? 0 : flags & 2) | (last ? flags & 4 : 0),
            ]);
            const completes = values.some(value => value < 255);
            view.setBigUint64(6, completes ? granule : 0xffffffffffffffffn, true);
            view.setUint32(14, this.serial, true);
            view.setUint32(18, this.sequence++, true);
            page[26] = values.length;
            page.set(values, 27);
            page.set(data.subarray(offset, offset + size), 27 + values.length);
            view.setUint32(22, oggCrc32(page), true);
            pages.push(page);
            offset += size;
        }

        return pages;
    }
}
