import { createHash } from 'node:crypto';
import { inspect, open } from '../../dist/esm/api/entries/index.js';
import { BufferSource, MemorySink } from '../../dist/esm/api/entries/io.js';
import { avcc, filler, idr, lengthPrefixed, predicted } from './avi-h264-fixtures.mjs';
import { createAacFixture } from './legacy-audio-fixture.mjs';
import { PROBE_MIB } from './probe-windows.mjs';

// What the tests of large MPEG-TS and Matroska inputs share (pipeline/read-passes, copy-passes,
// read-probes and read-lifetime). Their inputs are about 70 probe megabytes (18 MiB), large against
// the probe windows a test file scales down (scaleProbeWindows in probe-windows.mjs) and the 1 MiB
// reads of a pass, which their byte bounds measure.

export const { encoded } = await createAacFixture();

const keyPicture = lengthPrefixed(4, idr, filler((64 * PROBE_MIB) / 1024));
const predictedPicture = lengthPrefixed(4, predicted, filler((64 * PROBE_MIB) / 1024));
/**
 * Picture `index` of a large input: an IDR each 30 pictures, else a predicted picture, of 64 probe
 * kibibytes (16 KiB). The two are built once; the muxers copy what they are handed.
 */
export const largePicture = index => (index % 30 ? predictedPicture : keyPicture);

/** A source reading `input` that counts the bytes it reads and its largest read. */
export function counted(input) {
    const counter = { bytes: 0, largest: 0 };
    return {
        counter,
        source: {
            size: input.size,
            read(offset, length) {
                counter.bytes += length;
                counter.largest = Math.max(counter.largest, length);
                return input.read(offset, length);
            },
        },
    };
}

/**
 * The bytes inspect() reads to describe `input` from its ends: its probe, which reads less than
 * half of it. Bounds of a pass are its probe and the input once.
 */
export async function probeBytes(input) {
    const probe = counted(input);
    await inspect(probe.source);
    if (!(probe.counter.bytes < input.size / 2))
        throw new Error(`the probe read ${probe.counter.bytes} of ${input.size} bytes`);
    return probe.counter.bytes;
}

/**
 * Each packet of a file as [track, time, decode time, keyframe, digest of its bytes]: comparisons
 * hold digests rather than every packet's bytes of two large outputs.
 */
export async function packetsOf(blob) {
    const media = await open(new Uint8Array(await blob.arrayBuffer()));
    try {
        const packets = [];
        for await (const packet of media.packets())
            packets.push([
                packet.trackId,
                packet.timestamp,
                packet.decodeTimestamp,
                packet.isKeyframe,
                createHash('sha1').update(packet.data).digest('base64'),
            ]);
        return packets;
    } finally {
        media.close();
    }
}

const indexedCopies = new Map();
/** What an indexed Media writes for `input` and `target`, made once for each. */
export function indexedCopy(input, target) {
    if (!indexedCopies.has(input)) indexedCopies.set(input, new Map());
    const copies = indexedCopies.get(input);
    const key = JSON.stringify(target);
    if (!copies.has(key))
        copies.set(
            key,
            (async () => {
                const media = await open(input);
                try {
                    return await media.convert(target);
                } finally {
                    media.close();
                }
            })(),
        );
    return copies.get(key);
}

/**
 * `pictures` pictures (1,100: 36.7 s, about 18 MiB) with a keyframe each second, and AAC frames
 * between them (from `audioStart` to `audioEnd` seconds), muxed by `Muxer` as `format`.
 */
export async function muxedWithAudio(
    Muxer,
    format,
    { pictures = 1100, audioStart = 0, audioEnd = Infinity } = {},
) {
    const sink = new MemorySink();
    const muxer = new Muxer(
        {
            format,
            mode: 'standard',
            autoSync: true,
            video: {
                id: 1,
                type: 'video',
                codec: 'avc1.42c00a',
                codecConfig: avcc(),
                width: 64,
                height: 48,
                framerate: 30,
            },
            audio: {
                codec: 'mp4a.40.2',
                codecConfig: Uint8Array.of(0x11, 0x90),
                sampleRate: 48000,
                channelCount: 2,
            },
        },
        sink,
    );
    let frame = Math.ceil((audioStart * 48000) / 1024);
    for (let index = 0; index < pictures; index++) {
        for (; (frame * 1024) / 48000 < Math.min(index / 30, audioEnd); frame++)
            muxer.addAudioChunk({
                trackType: 'audio',
                data: encoded.frames[frame % encoded.frames.length],
                timestamp: (frame * 1024) / 48000,
                duration: 1024 / 48000,
                isKeyframe: true,
            });
        muxer.addVideoChunk({
            trackType: 'video',
            data: largePicture(index),
            timestamp: index / 30,
            duration: 1 / 30,
            isKeyframe: index % 30 === 0,
        });
    }
    await muxer.finalize();
    // The sink hands over a copy of its own: the source need not copy it again.
    return new BufferSource(sink.toUint8Array(), { copy: false });
}
