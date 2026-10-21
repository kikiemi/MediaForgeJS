import { fourcc } from '../../bytes/byte-fields';

/** Bytes of the AlacSpecificConfig ('magic cookie') without any atom header. */
const ALAC_COOKIE_BYTES = 24;

/**
 * The 24-byte AlacSpecificConfig of a bare cookie, an 'alac' atom (size, type, version/flags,
 * cookie) or a CAF cookie that starts with a 'frma' atom; undefined when fewer than 24 bytes
 * remain.
 */
export function alacCookie(input: Uint8Array): Uint8Array | undefined {
    let at = 0;
    if (input.length >= at + 12 && fourcc(input, at + 4) === 'frma') at += 12;
    if (input.length >= at + 12 && fourcc(input, at + 4) === 'alac') at += 12;
    return input.length - at >= ALAC_COOKIE_BYTES
        ? input.slice(at, at + ALAC_COOKIE_BYTES)
        : undefined;
}

/**
 * Samples one ALAC packet decodes to: the cookie's frame length unless the first element header
 * marks a partial frame with its own 32-bit sample count. Undefined for a packet too short to hold
 * the header.
 */
export function alacPacketFrames(packet: Uint8Array, frameLength: number): number | undefined {
    if (packet.length < 3) return undefined;
    if (!((packet[2]! >> 4) & 1)) return frameLength;
    if (packet.length < 7) return undefined;
    return (
        (packet[2]! & 1) * 2 ** 31 +
        packet[3]! * 2 ** 23 +
        packet[4]! * 2 ** 15 +
        packet[5]! * 2 ** 7 +
        (packet[6]! >> 1)
    );
}
