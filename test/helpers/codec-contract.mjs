// The contract every packet decoder of the library keeps, checked by each codec's tests:
// - an audio decoder turns packets into chunks of equal-length Float32Array planes of finite
//   samples, flushes, decodes the same packets to the same samples after reset(), and ends damage
//   in a DECODE error or concealment, never another error;
// - a video decoder flushes nothing before input, decodes garbage to pictures or a DECODE error,
//   survives reset() and repeated close().
import assert from 'node:assert/strict';
import { isMediaForgeError, open } from 'mediaforgejs';

/** True for a library error with one of `codes` (any code when none is given). */
export function isLibraryError(error, ...codes) {
    return isMediaForgeError(error) && (codes.length === 0 || codes.includes(error.code));
}

/**
 * The public track of the first track of `type`, the data of its packets and their timing as
 * `samples` ({ timestamp, duration } in seconds).
 */
export async function trackPackets(input, type = 'audio') {
    const media = await open(input instanceof Blob ? input : new Blob([input]));
    try {
        const track = media.tracks.find(candidate => candidate.type === type);
        const packets = [];
        const samples = [];
        for await (const packet of media.packets({ trackIds: [track.id] })) {
            packets.push(packet.data);
            samples.push({ timestamp: packet.timestamp, duration: packet.duration });
        }
        return { track, packets, samples };
    } finally {
        media.close();
    }
}

/** Every chunk `decoder` yields for `packets` and its flush, each checked for shape. */
export function decodeChunks(decoder, packets, channels) {
    const chunks = [];
    const take = output => {
        for (const chunk of output ?? []) {
            assert(chunk.length >= 1, 'a chunk has channels');
            if (channels) assert.equal(chunk.length, channels, 'channel count');
            for (const plane of chunk) {
                assert(plane instanceof Float32Array, 'planes are Float32Array');
                assert.equal(plane.length, chunk[0].length, 'planes of one chunk have one length');
                assert(plane.every(Number.isFinite), 'samples are finite');
            }
            chunks.push(chunk.map(plane => plane.slice()));
        }
    };
    for (const packet of packets) take(decoder.decode(packet));
    take(decoder.flush?.());
    return chunks;
}

/**
 * Asserts that two lists of chunks hold the same samples, naming the first difference (a deep
 * comparison of long typed arrays that differ takes minutes to describe).
 */
export function assertSameChunks(actual, expected, message) {
    assert.equal(actual.length, expected.length, `${message}: chunk count`);
    actual.forEach((chunk, index) => {
        assert.equal(chunk.length, expected[index].length, `${message}: chunk ${index} channels`);
        chunk.forEach((plane, channel) => {
            const other = expected[index][channel];
            assert.equal(plane.length, other.length, `${message}: chunk ${index} length`);
            const at = plane.findIndex((value, sample) => !Object.is(value, other[sample]));
            assert.equal(at, -1, `${message}: chunk ${index}, channel ${channel}, sample ${at}`);
        });
    });
}

/** Asserts the audio decoder contract for a created packet decoder and a track's packets. */
export function assertAudioDecoderContract(decoder, packets, channels) {
    for (const method of ['decode', 'reset']) assert.equal(typeof decoder[method], 'function');
    const first = decodeChunks(decoder, packets, channels);
    assert(first.length > 0, 'decoded nothing');
    decoder.reset();
    assertSameChunks(decodeChunks(decoder, packets, channels), first, 'reset() repeats');
    decoder.reset();
    try {
        decodeChunks(decoder, [new Uint8Array(37).fill(0xa5), new Uint8Array(0)]);
    } catch (error) {
        assert(isLibraryError(error, 'DECODE'), error);
    }
}

/** Asserts the video decoder contract for a created picture decoder. */
export function assertVideoDecoderContract(decoder) {
    for (const method of ['decode', 'flush', 'reset', 'close'])
        assert.equal(typeof decoder[method], 'function');
    assert.deepEqual([...decoder.flush()], [], 'nothing to flush before input');
    for (const data of [
        new Uint8Array(64).fill(0xff),
        Uint8Array.of(0, 0, 1, 0xb3, 1, 2),
        new Uint8Array(0),
    ]) {
        try {
            const pictures = decoder.decode({ type: 'key', timestamp: 0, duration: 0.04, data });
            assert(Array.isArray(pictures), 'decode() returns the finished pictures');
        } catch (error) {
            assert(isLibraryError(error, 'DECODE'), error);
        }
    }
    decoder.reset();
    assert.deepEqual([...decoder.flush()], [], 'reset() drops held pictures');
    decoder.close();
    decoder.close();
}

/**
 * The presented sound of the first audio track of an input through mediaforgejs/parts
 * decodeAudio(), joined per channel, with its rate and channel count.
 */
export async function presentedAudio(input, options = { codecPreference: 'builtin' }) {
    const parts = await import('mediaforgejs/parts');
    const media = await parts.open(input instanceof Blob ? input : new Blob([input]));
    try {
        const track = media.tracks.find(candidate => candidate.type === 'audio');
        const source = await parts.decodeAudio(media, track.id, options);
        const chunks = [];
        for await (const planes of source.chunks()) chunks.push(planes.map(plane => plane.slice()));
        const frames = chunks.reduce((sum, chunk) => sum + chunk[0].length, 0);
        const planes = Array.from({ length: source.channels }, () => new Float32Array(frames));
        let at = 0;
        for (const chunk of chunks) {
            chunk.forEach((plane, channel) => planes[channel].set(plane, at));
            at += chunk[0].length;
        }
        return { planes, sampleRate: source.sampleRate, channels: source.channels, track };
    } finally {
        media.close();
    }
}

/**
 * Signal-to-noise ratio in dB and the largest difference of `planes` against interleaved
 * `reference` samples that start at presented frame `start`.
 */
export function compareWithReference(planes, reference, start) {
    const channels = planes.length;
    const frames = reference.length / channels;
    let signal = 0;
    let noise = 0;
    let maxDifference = 0;
    for (let index = 0; index < frames; index++)
        for (let channel = 0; channel < channels; channel++) {
            const expected = reference[index * channels + channel];
            const difference = planes[channel][start + index] - expected;
            signal += expected * expected;
            noise += difference * difference;
            maxDifference = Math.max(maxDifference, Math.abs(difference));
        }
    return { snrDb: 10 * Math.log10(signal / Math.max(noise, 1e-30)), maxDifference };
}

/**
 * The audio codec a plugin's audio decoder part makes for a track. The part reads the demuxer's
 * track model, which also holds the sample table the public track leaves out; pass
 * `{ ...track, samples }` when the codec reads packet timing from it.
 */
export async function pluginAudioCodec(plugin, track) {
    const part = plugin.decoders.find(candidate => candidate.kind === 'audio');
    const factory = await part.load();
    return factory({ samples: [], ...track });
}

/** The packet decoder a plugin's audio decoder part makes for a track. */
export async function pluginAudioDecoder(plugin, track, warn = () => undefined) {
    return (await pluginAudioCodec(plugin, track)).create(warn);
}
