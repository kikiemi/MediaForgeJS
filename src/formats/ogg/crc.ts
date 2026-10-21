import { crc32MpegUpdate } from '../../core/bytes/crc32-mpeg';

/** The checksum field of an Ogg page as the page's CRC reads it. */
const ZEROS = new Uint8Array(4);

/** Ogg page CRC-32 (non-reflected polynomial 0x04C11DB7, from 0). */
export function oggCrc32(data: Uint8Array): number {
    return crc32MpegUpdate(0, data) >>> 0;
}

/**
 * The CRC-32 of an Ogg page with its checksum field (bytes 22 to 25) read as zero, without changing
 * the page.
 */
export function oggPageCrc32(page: Uint8Array): number {
    const head = crc32MpegUpdate(crc32MpegUpdate(0, page, 0, 22), ZEROS);
    return crc32MpegUpdate(head, page, 26, page.length) >>> 0;
}
