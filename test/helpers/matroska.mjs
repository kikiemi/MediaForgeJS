// Hand-built Matroska files for the tests of the Matroska reader and writer: the EBML header, a
// segment of tracks and clusters, and the blocks in them.
import { element, join, string, uint } from './multitrack-pcm-fixtures.mjs';

export { element, join, string, uint };

/** A float element of `value` (eight bytes). */
export function float(id, value) {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setFloat64(0, value);
    return element(id, bytes);
}

/** The EBML header of a Matroska (or `docType`) file of version 4. */
export const ebmlHeader = (docType = 'matroska') =>
    element(
        0x1a45dfa3,
        uint(0x4286, 1),
        uint(0x42f7, 1),
        uint(0x42f2, 4),
        uint(0x42f3, 8),
        string(0x4282, docType),
        uint(0x4287, 4),
        uint(0x4285, 2),
    );

/** The Info of a segment: millisecond timestamps, and `children`. */
export const info = (...children) => element(0x1549a966, uint(0x2ad7b1, 1000000), ...children);

/** A file of one segment of `children` (an Info first unless they hold one). */
export function matroskaFile(children, { docType } = {}) {
    const hasInfo = children.some(child => child[0] === 0x15 && child[1] === 0x49);
    return join(
        ebmlHeader(docType),
        element(0x18538067, ...(hasInfo ? [] : [info()]), ...children),
    );
}

/** The Tracks element of `entries`. */
export const tracks = (...entries) => element(0x1654ae6b, ...entries);

/** A TrackEntry of number `number`, type `type` (1 video, 2 audio, 17 subtitle) and `codecId`. */
export const trackEntry = (number, type, codecId, ...children) =>
    element(0xae, uint(0xd7, number), uint(0x83, type), string(0x86, codecId), ...children);

/** The Video element of a `width` × `height` track. */
export const videoShape = (width, height, ...children) =>
    element(0xe0, uint(0xb0, width), uint(0xba, height), ...children);

/** The Audio element of `channels` channels at `rate` Hz. */
export const audioShape = (channels, rate, ...children) =>
    element(0xe1, uint(0x9f, channels), float(0xb5, rate), ...children);

/** A Cluster at `time` (ms) of `blocks`. */
export const cluster = (time, ...blocks) => element(0x1f43b675, uint(0xe7, time), ...blocks);

/** The block header of track `track` at `time` (ms, relative to the cluster) with `flags`. */
export const blockHeader = (track, time, flags) =>
    Uint8Array.of(0x80 | track, (time >> 8) & 255, time & 255, flags);

/** A SimpleBlock of track `track` at `time` holding `data`, a keyframe unless `flags` say else. */
export const simpleBlock = (track, time, data, flags = 0x80) =>
    element(0xa3, blockHeader(track, time, flags), data);

/** A BlockGroup of a Block of track `track` at `time` holding `data`, and `children`. */
export const blockGroup = (track, time, data, ...children) =>
    element(0xa0, element(0xa1, blockHeader(track, time, 0), data), ...children);

/** An OpusHead of `channels` channels at 48 kHz with `preSkip`. */
export const opusHead = (channels = 2, preSkip = 0) =>
    Uint8Array.of(
        ...new TextEncoder().encode('OpusHead'),
        1,
        channels,
        preSkip & 255,
        preSkip >> 8,
        0x80,
        0xbb,
        0,
        0,
        0,
        0,
        0,
    );

/** The SimpleTag `name` = `value`. */
export const simpleTag = (name, value) =>
    element(0x67c8, string(0x45a3, name), string(0x4487, value));
