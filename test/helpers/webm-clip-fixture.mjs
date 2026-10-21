import { element, join, string, uint } from './multitrack-pcm-fixtures.mjs';

const float = (id, value) => {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setFloat64(0, value);
    return element(id, bytes);
};
const int16 = value => {
    const bytes = new Uint8Array(2);
    new DataView(bytes.buffer).setInt16(0, value);
    return bytes;
};
const opusHead = channels =>
    join(new TextEncoder().encode('OpusHead'), [
        1,
        channels,
        312 & 255,
        312 >> 8,
        0x80,
        0xbb,
        0,
        0,
        0,
        0,
        0,
    ]);

/** VP9 keyframe and inter-frame headers: frame marker, profile 0, sync code for keyframes. */
export const vp9Keyframe = Uint8Array.of(0x82, 0x49, 0x83, 0x42, 0x00, 0x00, 0x00);
export const vp9Interframe = Uint8Array.of(0x86, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00);
/** VP8 frame tags: bit 0 clear marks a keyframe with its start code and 16×16 size. */
export const vp8Keyframe = Uint8Array.of(0x10, 0, 0, 0x9d, 0x01, 0x2a, 16, 0, 16, 0, 0, 0, 0, 0);
export const vp8Interframe = Uint8Array.of(0x11, 0, 0, 0, 0, 0, 0, 0);
/** One 20 ms Opus packet (TOC config 15, one frame). */
export const opusPacket = Uint8Array.of(0x78, 0x00, 0x00, 0x00);

/**
 * WebM as encoders write it: 1 ms timecodes with a nominal DefaultDuration, video keyframes every
 * keyframeInterval frames, and optionally Opus with a 6.5 ms CodecDelay. No CodecPrivate unless
 * given.
 */
export function webmClip({
    codecId = 'V_VP9',
    codecPrivate,
    fps = 30,
    frames = 40,
    keyframeInterval = 15,
    opus = true,
    opusPackets = Math.round((frames * 1000) / fps / 20),
} = {}) {
    const vp8 = codecId === 'V_VP8';
    const video = element(
        0xae,
        uint(0xd7, 1),
        uint(0x73c5, 1),
        uint(0x83, 1),
        string(0x86, codecId),
        ...(codecPrivate ? [element(0x63a2, codecPrivate)] : []),
        uint(0x23e383, Math.round(1e9 / fps)),
        element(0xe0, uint(0xb0, vp8 ? 16 : 32), uint(0xba, 16)),
    );
    const audio = element(
        0xae,
        uint(0xd7, 2),
        uint(0x73c5, 2),
        uint(0x83, 2),
        string(0x86, 'A_OPUS'),
        element(0x63a2, opusHead(2)),
        uint(0x56aa, 6500000),
        uint(0x56bb, 80000000),
        element(0xe1, float(0xb5, 48000), uint(0x9f, 2)),
    );
    const blocks = [];
    for (let index = 0; index < frames; index++) {
        const key = index % keyframeInterval === 0;
        blocks.push({
            time: Math.round((index * 1000) / fps),
            data: join(
                [0x81],
                int16(0),
                [key ? 0x80 : 0x00],
                vp8 ? (key ? vp8Keyframe : vp8Interframe) : key ? vp9Keyframe : vp9Interframe,
            ),
        });
    }
    if (opus)
        for (let index = 0; index < opusPackets; index++)
            blocks.push({ time: index * 20, data: join([0x82], int16(0), [0x80], opusPacket) });
    blocks.sort((a, b) => a.time - b.time);
    const clusters = [];
    for (let start = 0; start < blocks.length; start += 32) {
        const group = blocks.slice(start, start + 32);
        const base = group[0].time;
        clusters.push(
            element(
                0x1f43b675,
                uint(0xe7, base),
                ...group.map(block => {
                    const bytes = block.data.slice();
                    bytes.set(int16(block.time - base), 1);
                    return element(0xa3, bytes);
                }),
            ),
        );
    }
    const duration = Math.max(frames * (1000 / fps), opus ? opusPackets * 20 : 0);
    return join(
        element(
            0x1a45dfa3,
            uint(0x4286, 1),
            uint(0x42f7, 1),
            uint(0x42f2, 4),
            uint(0x42f3, 8),
            string(0x4282, 'webm'),
            uint(0x4287, 4),
            uint(0x4285, 2),
        ),
        element(
            0x18538067,
            element(0x1549a966, uint(0x2ad7b1, 1000000), float(0x4489, duration)),
            element(0x1654ae6b, video, ...(opus ? [audio] : [])),
            ...clusters,
        ),
    );
}
