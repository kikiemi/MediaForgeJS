// Small MP4 files of one video track, written with the public Mp4Muxer, for the video decoders'
// tests through the public API (MP4 is a core container, so they need only the decoder's plugin).
import { Mp4Muxer } from 'mediaforgejs/formats';
import { MemorySink } from 'mediaforgejs/io';
import { avccPackets } from './h264-fixtures.mjs';

/**
 * Pictures of an MPEG-1/2 or MPEG-4 Part 2 elementary stream, one packet each with the headers
 * before it, and each picture's presentation index (MPEG-1/2 count it from the GOP's temporal
 * references; MPEG-4 Part 2 streams of these tests have no B-VOPs).
 */
export function mpegVideoPictures(bytes, kind) {
    const mpeg4 = kind === 'mpeg4';
    const isPicture = code => (mpeg4 ? code === 0xb6 : code === 0x00);
    const isHeader = code =>
        mpeg4
            ? code <= 0x2f || code === 0xb0 || code === 0xb3 || code === 0xb5
            : code === 0xb3 || code === 0xb8;
    const pictures = [];
    let start = 0;
    let holdsPicture = false;
    let gopBase = 0;
    let counted = 0;
    let current;
    const close = end => {
        if (holdsPicture) pictures.push({ ...current, data: bytes.slice(start, end) });
    };
    for (let at = 0; at + 5 < bytes.length; at++) {
        if (bytes[at] !== 0 || bytes[at + 1] !== 0 || bytes[at + 2] !== 1) continue;
        const code = bytes[at + 3];
        if (!(isPicture(code) || isHeader(code))) continue;
        if (holdsPicture) {
            close(at);
            start = at;
            holdsPicture = false;
        }
        if (!mpeg4 && code === 0xb8) gopBase = counted;
        if (!isPicture(code)) continue;
        holdsPicture = true;
        counted++;
        current = mpeg4
            ? { key: bytes[at + 4] >> 6 === 0, order: counted - 1 }
            : {
                  key: ((bytes[at + 5] >> 3) & 7) === 1,
                  order: gopBase + ((bytes[at + 4] << 2) | (bytes[at + 5] >> 6)),
              };
    }
    close(bytes.length);
    return pictures;
}

/**
 * An MP4 of `pictures` ({ data, key, order, codecConfig? } in decode order) at `frameRate`, with
 * decode times shifted so that no picture is decoded after it is presented. A picture's own
 * `codecConfig` starts a new sample description when `codecConfigChanges` is set.
 */
export async function videoMp4({
    codec,
    width,
    height,
    codecConfig,
    codecConfigChanges = false,
    pictures,
    frameRate = 25,
}) {
    const sink = new MemorySink();
    const video = { id: 1, type: 'video', codec, width, height, codecConfig, codecConfigChanges };
    const muxer = new Mp4Muxer({ format: 'mp4', mode: 'standard', autoSync: false, video }, sink);
    const lead = Math.max(0, ...pictures.map((picture, index) => index - picture.order));
    pictures.forEach((picture, index) =>
        muxer.addVideoChunk(
            {
                trackType: 'video',
                data: picture.data,
                timestamp: picture.order / frameRate,
                decodeTimestamp: (index - lead) / frameRate,
                duration: 1 / frameRate,
                isKeyframe: picture.key,
            },
            picture.codecConfig,
        ),
    );
    await muxer.finalize();
    return sink.toBlob();
}

/** An MP4 of an H.264 fixture of test/helpers/h264-fixtures.mjs, with its avcC. */
export function h264Mp4(fixture) {
    const { description, packets } = avccPackets(fixture);
    return videoMp4({
        codec: fixture.codec,
        width: fixture.width,
        height: fixture.height,
        codecConfig: description,
        pictures: packets.map((data, index) => ({
            data,
            key: index === 0,
            order: fixture.order[index],
        })),
    });
}

/** An MP4 of an MPEG-1/2 or MPEG-4 Part 2 fixture of the mpeg2 and mpeg4 fixture helpers. */
export function mpegVideoMp4(fixture, kind) {
    return videoMp4({
        codec: fixture.codec,
        width: fixture.width,
        height: fixture.height,
        pictures: mpegVideoPictures(fixture.bytes(), kind),
    });
}
