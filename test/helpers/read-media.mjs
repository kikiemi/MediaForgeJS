// Reading and copying inputs through the public API, for the tests of the formats and of reading,
// copying and packaging: what open() describes and the packets it gives, and what convert() writes.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { convert, open } from 'mediaforgejs';

/**
 * Opens `input` and reads every packet of each track in decode order: the format, the title, each
 * track with its packets, and the codes of the warnings the open and the reads reported.
 */
export async function readMedia(input, options = {}) {
    const warnings = [];
    const media = await open(input, {
        ...options,
        onWarning: warning => {
            warnings.push(warning.code);
            options.onWarning?.(warning);
        },
    });
    try {
        const tracks = [];
        for (const track of media.tracks) {
            const packets = [];
            for await (const packet of media.packets({ trackIds: [track.id] }))
                packets.push(packet);
            tracks.push({ track, packets });
        }
        return { format: media.format, title: media.title, tracks, warnings };
    } finally {
        media.close();
    }
}

/**
 * Opens `input` and reads its packets as packets() interleaves them: the format, the title, the
 * tracks, the packets, a SHA-256 of each packet's bytes and the codes of the warnings reported.
 */
export async function readAll(input, options = {}) {
    const warnings = [];
    const media = await open(input, {
        ...options,
        onWarning: warning => {
            warnings.push(warning.code);
            options.onWarning?.(warning);
        },
    });
    try {
        const packets = [];
        for await (const packet of media.packets()) packets.push(packet);
        return {
            format: media.format,
            title: media.title,
            tracks: media.tracks,
            packets,
            hashes: packets.map(packet => sha256(packet.data)),
            warnings,
        };
    } finally {
        media.close();
    }
}

/**
 * Track `trackId` of `input` decoded to WAVE: its bytes, channels and frames (sample frames of
 * the data chunk).
 */
export async function decodedWave(input, trackId) {
    const { blob } = await convert(input, {
        to: 'wav',
        copy: false,
        trackIds: [trackId],
        allowPrecisionLoss: true,
    });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const view = new DataView(bytes.buffer);
    let channels = 0;
    let bits = 0;
    for (let offset = 12; offset + 8 <= bytes.length;) {
        const id = String.fromCharCode(...bytes.subarray(offset, offset + 4));
        const size = view.getUint32(offset + 4, true);
        if (id === 'fmt ') {
            channels = view.getUint16(offset + 10, true);
            bits = view.getUint16(offset + 22, true);
        }
        if (id === 'data') return { bytes, channels, frames: size / (channels * (bits / 8)) };
        offset += 8 + size + (size & 1);
    }
    throw new Error('the WAVE file has no data chunk');
}

/** The SHA-256 of `bytes` in hex. */
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/** Asserts that strict validation refuses `input` with DEMUX. */
export const rejectsStrict = (input, message) =>
    assert.rejects(open(input, { validation: 'strict' }), error => error.code === 'DEMUX', message);

/** The packets of every track of `input` in decode order, interleaved as packets() gives them. */
export async function allPackets(input, options = {}) {
    const media = await open(input, options);
    try {
        const packets = [];
        for await (const packet of media.packets()) packets.push(packet);
        return packets;
    } finally {
        media.close();
    }
}

/** The bytes convert() writes for `input` as `to`, copying every track it keeps. */
export async function copied(input, to, options = {}) {
    const result = await convert(input, { onWarning: () => {}, ...options, to, copy: true });
    return new Uint8Array(await result.blob.arrayBuffer());
}

/** The bytes of a Blob or of a MediaResult's blob. */
export async function bytesOf(blobOrResult) {
    const blob = blobOrResult instanceof Blob ? blobOrResult : blobOrResult.blob;
    return new Uint8Array(await blob.arrayBuffer());
}

/** Asserts that every number of `actual` is within 1e-6 of the same place in `expected`. */
export function assertTimes(assert, actual, expected, message) {
    assert.ok(
        actual.length === expected.length &&
            actual.every((value, index) => Math.abs(value - expected[index]) < 1e-6),
        `${message}: ${actual} vs ${expected}`,
    );
}
