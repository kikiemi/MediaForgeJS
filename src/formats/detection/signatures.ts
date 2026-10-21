import type { ContainerFormat } from '../../core/model/media';
import type { Source } from '../../core/model/types';
import { DemuxError, throwIfAborted } from '../../core/errors/errors';
import { awaitWithAbort } from '../../core/io/abort';
import { fourcc, u32be } from '../../core/bytes/byte-fields';
import { assertSourceBytes } from '../../core/io/sources/source-read';

/** ISOBMFF family of an ftyp box from its major and compatible brands. */
export function ftypFormat(h: Uint8Array, boxStart: number): ContainerFormat {
    const size = u32be(h, boxStart);
    const brand = fourcc(h, boxStart + 8);
    const brands = [brand];
    const end = Math.min(h.length - 3, size >= 16 && size < 4096 ? boxStart + size : boxStart + 16);
    for (let at = boxStart + 16; at + 4 <= end; at += 4) brands.push(fourcc(h, at));
    if (brand === 'avif' || brand === 'avis' || brands.includes('avif') || brands.includes('avis'))
        return 'avif';
    if (
        ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1'].includes(
            brand,
        ) ||
        brands.includes('heic') ||
        brands.includes('heix')
    )
        return 'heif';
    if (brand === 'jxl ') return 'jxl';
    if (brand.startsWith('qt')) return 'mov';
    if (brand.startsWith('3gp') || brand.startsWith('3g2')) return '3gp';
    if (brand === 'M4A ' || brand === 'M4B ') return 'm4a';
    // Apple's video brands: M4V, and M4VH and M4VP of its players.
    if (brand.startsWith('M4V')) return 'm4v';
    return 'mp4';
}

/** QuickTime 'pnot' preview headers name a 'PICT' thumbnail atom that precedes the movie. */
export const MP4_TOP_BOXES = new Set([
    'free',
    'skip',
    'wide',
    'pdin',
    'uuid',
    'prft',
    'emsg',
    'sidx',
    'ssix',
    'pnot',
    'PICT',
]);

export const MP4_DECISIVE = new Set(['moov', 'moof', 'mdat', 'styp']);

export const SNIFF_PREFIX_BYTES = 8192;

export const SNIFF_WINDOW_BYTES = 1 << 20;

export class SniffWindowReader {
    private start = -1;
    private bytes: Uint8Array = new Uint8Array(0);
    private windowBytes = SNIFF_PREFIX_BYTES;
    readonly size: number;

    constructor(
        private readonly source: Source,
        private readonly signal?: AbortSignal,
    ) {
        this.size = source.size;
    }

    useDeepWindow(): void {
        this.windowBytes = SNIFF_WINDOW_BYTES;
    }

    checkAbort(): void {
        throwIfAborted(this.signal);
    }

    async read(offset: number, length: number): Promise<Uint8Array> {
        this.checkAbort();
        const want = Math.min(length, this.size - offset);
        if (want <= 0) return new Uint8Array(0);
        if (offset >= this.start && offset + want <= this.start + this.bytes.length) {
            const relative = offset - this.start;
            return this.bytes.subarray(relative, relative + want);
        }
        const readLength = Math.min(this.size - offset, Math.max(want, this.windowBytes));
        const bytes = await awaitWithAbort(this.source.read(offset, readLength), this.signal);
        this.checkAbort();
        assertSourceBytes(bytes, readLength, 'Format detection');
        this.bytes = bytes;
        this.start = offset;
        return this.bytes.subarray(0, want);
    }
}

export function isId3v2Header(h: Uint8Array): boolean {
    return h.length >= 10 && h[0] === 0x49 && h[1] === 0x44 && h[2] === 0x33;
}

/**
 * Bytes of the ID3v2 tag starting `h` (header, payload and, for ID3v2.4, the footer its flag
 * states); 0 when `h` starts no tag. A header of a version other than 2.2 to 2.4, or whose size is
 * not syncsafe, fails.
 */
export function id3v2Span(h: Uint8Array): number {
    if (!isId3v2Header(h)) return 0;
    if (h[3]! < 2 || h[3]! > 4) throw new DemuxError(`ID3v2.${h[3]} is not supported`);
    if (h.subarray(6, 10).some(byte => byte > 127))
        throw new DemuxError('Invalid ID3v2 syncsafe size');
    const payload = (h[6]! << 21) | (h[7]! << 14) | (h[8]! << 7) | h[9]!;
    return 10 + payload + (h[3] === 4 && h[5]! & 0x10 ? 10 : 0);
}
