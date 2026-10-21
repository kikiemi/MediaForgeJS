import { oggCrc32 } from './crc';
import { u32 } from './comments';
import { findOggPage } from './audio-index';
import type { AudioIndexContext } from '../audio-files/index-context';
import { checkPacketBytes } from '../shared/demux-budget';
import { asciiAt } from '../detection/head-bytes';

/** Ogg pages and the packets of one logical stream (RFC 3533). */
interface PageHeader {
    readonly offset: number;
    readonly flags: number;
    readonly serial: number;
    readonly granule: number | null;
    readonly laces: Uint8Array;
    readonly size: number;
}

/**
 * Reads one page header at `offset`; null when the bytes are not an Ogg page or the page is cut
 * short.
 */
export async function readPageHeader(
    context: Pick<AudioIndexContext, 'size' | 'read'>,
    offset: number,
): Promise<PageHeader | null> {
    if (context.size - offset < 27) return null;
    const header = await context.read(offset, 27);
    if (!asciiAt(header, 0, 'OggS') || header[4] !== 0) return null;
    const laces = await context.read(
        offset + 27,
        Math.min(header[26]!, context.size - offset - 27),
    );
    if (laces.length < header[26]!) return null;

    let payload = 0;
    for (const lace of laces) payload += lace;
    const size = 27 + laces.length + payload;
    if (size > context.size - offset) return null;

    const lo = u32(header, 6);
    const hi = u32(header, 10);
    return {
        offset,
        flags: header[5]!,
        serial: u32(header, 14),
        granule: lo === 0xffffffff && hi === 0xffffffff ? null : hi * 2 ** 32 + lo,
        laces,
        size,
    };
}

/**
 * A packet of one logical stream: `offset` is -1 for a packet whose bytes span pages, and `data` is
 * then a copy.
 */
export interface OggPacket {
    readonly offset: number;
    readonly data: Uint8Array;
}

/**
 * One page of a logical stream with the packets it completes; empty packets are left out unless
 * kept.
 */
interface OggStreamPage {
    readonly offset: number;
    readonly granule: number | null;
    readonly eos: boolean;
    readonly packets: readonly OggPacket[];
}

/**
 * The pages of logical stream `serial` up to its EOS page. A page whose CRC does not match is
 * dropped with the packet it continues, and bytes that do not hold a complete page end the walk;
 * `state.recovered` reports either. `keepEmpty` yields zero-length packets too (Theora codes a
 * repeated frame as one).
 */
export async function* oggStreamPages(
    context: AudioIndexContext,
    serial: number,
    state: { recovered: boolean },
    keepEmpty = false,
): AsyncGenerator<OggStreamPage> {
    let parts: Uint8Array[] = [];
    let partOffset = -1;
    let packetSize = 0;
    let continued = false;
    let offset = 0;
    let pages = 0;

    while (offset < context.size) {
        if ((pages++ & 127) === 0) await context.checkpoint();
        const page = await readPageHeader(context, offset);
        const resumed = page ? -1 : await findOggPage(context, offset + 1);
        if (resumed > 0) {
            context.diagnostics.recover(
                {
                    code: 'OGG_RESYNCHRONIZED',
                    format: 'ogg',
                    offset,
                    message: `Skipped ${resumed - offset} damaged bytes at byte ${offset}`,
                },
                `Invalid Ogg page at ${offset}`,
            );
            state.recovered = true;
            parts = [];
            packetSize = 0;
            continued = false;
            offset = resumed;
            continue;
        }

        if (!page) {
            context.diagnostics.recover(
                {
                    code: 'OGG_TRUNCATED',
                    format: 'ogg',
                    offset,
                    message:
                        `Ignored ${context.size - offset} bytes that do not hold a complete ` +
                        `Ogg page`,
                },
                `Invalid Ogg page at ${offset}`,
            );
            state.recovered = true;
            return;
        }

        offset += page.size;
        if (page.serial !== serial) continue;

        const bytes = (await context.read(page.offset, page.size)).slice();
        const crc = u32(bytes, 22);
        bytes.fill(0, 22, 26);
        if (oggCrc32(bytes) !== crc) {
            context.diagnostics.recover(
                {
                    code: 'OGG_PAGE_CRC',
                    format: 'ogg',
                    offset: page.offset,
                    message: `Ogg page CRC mismatch at byte ${page.offset}; the page is dropped`,
                },
                `Ogg page CRC mismatch at ${page.offset}`,
            );
            state.recovered = true;
            parts = [];
            packetSize = 0;
            continued = false;
            continue;
        }

        if (((page.flags & 1) !== 0) !== continued) {
            parts = [];
            packetSize = 0;
        }

        let body = 27 + page.laces.length;
        const packets: OggPacket[] = [];
        for (let segment = 0; segment < page.laces.length; segment++) {
            const lace = page.laces[segment]!;
            if (lace) {
                if (parts.length === 0) partOffset = page.offset + body;
                parts.push(bytes.subarray(body, body + lace));
                packetSize += lace;
                checkPacketBytes(packetSize, context.maxPacketBytes, 'Ogg packet');
            }

            body += lace;
            continued = lace === 255;
            if (continued) continue;
            if (packetSize === 0) {
                parts = [];
                if (keepEmpty)
                    packets.push({ offset: page.offset + body, data: new Uint8Array(0) });
                continue;
            }

            let data: Uint8Array;
            if (parts.length === 1) data = parts[0]!;
            else {
                data = new Uint8Array(packetSize);
                let at = 0;
                for (const part of parts) {
                    data.set(part, at);
                    at += part.length;
                }
            }

            const spansPages = parts.length > 1 || partOffset < page.offset;
            packets.push(
                spansPages
                    ? { offset: -1, data: parts.length === 1 ? data.slice() : data }
                    : { offset: partOffset, data },
            );
            parts = [];
            packetSize = 0;
        }

        const eos = (page.flags & 4) !== 0;
        yield { offset: page.offset, granule: page.granule, eos, packets };
        if (eos) return;
    }
}

/**
 * Indexes the Theora stream `serial`: three header packets, then one frame per packet. A
 * zero-length packet repeats the previous frame (Theora spec 7.1): it counts for the timeline and
 * lengthens the frame before it.
 */
