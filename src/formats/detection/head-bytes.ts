/**
 * The byte tests of format signatures, small enough for the plugin manifests that carry them: every
 * entry reads the manifests.
 */

/** SMPTE 377M partition pack key up to the partition status bytes. */
export const MXF_PARTITION_KEY = [
    0x06, 0x0e, 0x2b, 0x34, 0x02, 0x05, 0x01, 0x01, 0x0d, 0x01, 0x02, 0x01, 0x01,
];

/** MXF run-in before the header partition may be at most 65535 bytes (SMPTE 377M 6.5). */
export const MXF_RUN_IN_LIMIT = 65536;

export function startsWith(h: Uint8Array, pattern: readonly number[], at = 0): boolean {
    if (h.length < at + pattern.length) return false;
    for (let index = 0; index < pattern.length; index++)
        if (h[at + index] !== pattern[index]) return false;
    return true;
}

export function indexOfPattern(h: Uint8Array, pattern: readonly number[], limit: number): number {
    const end = Math.min(h.length - pattern.length, limit);
    for (let at = 0; at <= end; at++) if (startsWith(h, pattern, at)) return at;
    return -1;
}

/** Whether `h` holds the ASCII `text` at `at`. */
export function asciiAt(h: Uint8Array, at: number, text: string): boolean {
    if (h.length < at + text.length) return false;
    for (let index = 0; index < text.length; index++)
        if (h[at + index] !== text.charCodeAt(index)) return false;
    return true;
}

/** The form of a RIFF file (bytes 8 to 11, such as 'WAVE' or 'AVI '), or null for another file. */
export function riffForm(h: Uint8Array): string | null {
    if (h.length < 12 || !asciiAt(h, 0, 'RIFF')) return null;
    return String.fromCharCode(h[8]!, h[9]!, h[10]!, h[11]!);
}
