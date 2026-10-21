// The movie the packaging tests cut into segments, and how they read segments back.
import { open } from 'mediaforgejs';
import { preservationFixture } from './mp4-preservation-fixture.mjs';
import { avcc, filler, idr, lengthPrefixed, predicted } from './avi-h264-fixtures.mjs';

/** 12 H.264 pictures of 40 ms, an IDR picture every fourth. */
export const MOVIE_VIDEO = Array.from({ length: 12 }, (_, index) =>
    lengthPrefixed(4, index % 4 ? predicted : idr, filler(4 + index)),
);
/** 23 AAC packets of 1024 samples at 48 kHz. */
export const MOVIE_AUDIO = Array.from({ length: 23 }, (_, index) =>
    Buffer.of(0x21, 0x10, index + 1, 0x7f, index),
);

/**
 * A 64x48 video track 'Camera' (keyframes at samples 1, 5 and 9; `edits` its edit list) beside an
 * audio track 'Main', both default, as an MP4.
 */
export function packageMovie({ edits } = {}) {
    return preservationFixture({
        tracks: [
            {
                type: 'video',
                name: 'Camera',
                default: true,
                packets: MOVIE_VIDEO,
                sync: [1, 5, 9],
                width: 64,
                height: 48,
                codecConfig: avcc(),
                ...(edits ? { edits } : {}),
            },
            { type: 'audio', name: 'Main', default: true, packets: MOVIE_AUDIO },
        ],
    }).bytes;
}

/**
 * The tracks ({ type, codec }) of `bytes` and its packets as packets() gives them: type, time in
 * 48 kHz ticks, keyframe flag and bytes.
 */
export async function readBack(bytes) {
    const media = await open(bytes);
    try {
        const result = [];
        for await (const packet of media.packets())
            result.push({
                type: packet.trackType,
                time: Math.round(packet.timestamp * 48000),
                key: packet.isKeyframe,
                data: Array.from(packet.data),
            });
        return { tracks: media.tracks.map(({ type, codec }) => ({ type, codec })), result };
    } finally {
        media.close();
    }
}

/** `parts` joined into one array. */
export const joined = parts => new Uint8Array(Buffer.concat(parts));
