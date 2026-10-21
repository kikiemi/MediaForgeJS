import { malformedInput } from '../../core/errors/demux-guard';

/** Bytes of Matroska Tags, Chapters, Attachments and text a reader or writer accepts. */
export const MATROSKA_METADATA_LIMIT = 16 * 1024 * 1024;

/** A Matroska UID or other unsigned integer of at most eight bytes. */
export function matroskaUid(bytes: Uint8Array, start = 0, end = bytes.length): bigint {
    if (end - start < 0 || end - start > 8)
        malformedInput('Matroska metadata unsigned integer exceeds eight bytes');
    let value = 0n;
    for (let pos = start; pos < end; pos++) value = value * 256n + BigInt(bytes[pos]!);
    return value;
}
