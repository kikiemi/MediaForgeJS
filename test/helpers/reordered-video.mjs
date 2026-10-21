// Small H.264 inputs whose pictures are reordered as B-frames make them: decode order I0 P2 B1 P4
// B3 ..., ten pictures a second, a keyframe every second, decode times one picture ahead of the
// pictures shown. Their copies exercise every edit list a reorder delay needs.
import { Mp4Muxer } from 'mediaforgejs/formats';
import { MemorySink } from 'mediaforgejs/io';
import { avcc, idr, lengthPrefixed, predicted } from './avi-h264-fixtures.mjs';

/** The video track of the reordered inputs, as a muxer takes it. */
export const REORDERED_TRACK = {
    id: 1,
    type: 'video',
    codec: 'avc1.42c00a',
    codecConfig: avcc(),
    width: 32,
    height: 16,
};

/** Presentation numbers in decode order: 0, 2, 1, 4, 3, ... up to `count` pictures. */
export function decodeOrder(count) {
    const order = [0];
    for (let n = 2; n < count; n += 2) order.push(n, n - 1);
    return order;
}

/**
 * Adds `seconds` of reordered pictures to `muxer` (its addVideoChunk), shown from `clock` seconds,
 * and finalizes it. The last picture shown is the last even one: B9 and B19 follow the next
 * keyframe in decode order, as an open GOP's leading pictures do.
 */
export async function addReorderedPictures(muxer, { seconds = 3, clock = 0 } = {}) {
    decodeOrder(seconds * 10).forEach((n, index) =>
        muxer.addVideoChunk({
            trackType: 'video',
            data: lengthPrefixed(4, n % 10 === 0 ? idr : predicted),
            timestamp: clock + n / 10,
            decodeTimestamp: clock + (index - 1) / 10,
            duration: 0.1,
            isKeyframe: n % 10 === 0,
        }),
    );
    await muxer.finalize();
}

/** An MP4 of `seconds` of reordered pictures, its edit list presenting the first at zero. */
export async function reorderedMp4(seconds = 3) {
    const sink = new MemorySink();
    await addReorderedPictures(
        new Mp4Muxer(
            { format: 'mp4', mode: 'standard', autoSync: false, video: REORDERED_TRACK },
            sink,
        ),
        { seconds },
    );
    return sink.toBlob();
}
