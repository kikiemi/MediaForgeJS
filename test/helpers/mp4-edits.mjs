// MP4 inputs whose own edit list hides their first samples, and what their copies present.
import assert from 'node:assert/strict';
import { convert, open } from 'mediaforgejs';
import { OPUS_FIXTURES } from './opus-fixtures.mjs';

/**
 * `blob`, an MP4 of one track with a version 0 edit list, with its edit starting `seconds` later
 * and ending where it did.
 */
export async function laterEdit(blob, seconds) {
    const bytes = Buffer.from(await blob.arrayBuffer());
    const box = name => {
        const at = bytes.indexOf(name);
        assert.equal(bytes[at + 4], 0, `a version 0 ${name}`);
        return at;
    };
    const movie = bytes.readUInt32BE(box('mvhd') + 16);
    const media = bytes.readUInt32BE(box('mdhd') + 16);
    const elst = box('elst');
    bytes.writeUInt32BE(bytes.readUInt32BE(elst + 12) - Math.round(seconds * movie), elst + 12);
    bytes.writeInt32BE(bytes.readInt32BE(elst + 16) + Math.round(seconds * media), elst + 16);
    return new Blob([bytes]);
}

/** Half a second of stereo Opus (pre-skip 312) copied into MP4, its edit starting at the skip. */
export async function opusMp4() {
    const fixture = OPUS_FIXTURES.find(entry => entry.name === 'celt-fb-audio-20ms-stereo');
    return (await convert(fixture.bytes(), 'mp4')).blob;
}

/** The presentation times of the packets of `blob` in seconds, sorted, and its duration. */
export async function presented(blob) {
    const media = await open(blob);
    try {
        const times = [];
        for await (const packet of media.packets()) times.push(packet.timestamp);
        return { times: times.sort((a, b) => a - b), duration: media.duration };
    } finally {
        media.close();
    }
}

/** Asserts that `actual` presents the packets of `expected` at the same times, to 0.1 ms. */
export function assertSameTimes(actual, expected) {
    assert.equal(actual.length, expected.length, 'packet count');
    actual.forEach((time, index) =>
        assert.ok(
            Math.abs(time - expected[index]) < 1e-4,
            `packet ${index} at ${time} s, not ${expected[index]} s`,
        ),
    );
}
