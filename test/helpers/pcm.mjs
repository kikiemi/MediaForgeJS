// Small PCM inputs and readers for the codec tests: deterministic signals, conversions between
// 16-bit and float samples, a WAVE file writer and the samples of a WAVE file.

/** A linear congruential generator in [0, 1), the same sequence for the same seed. */
export function seededRandom(seed = 0x4d463430) {
    let state = seed >>> 0;
    return () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 2 ** 32;
    };
}

/**
 * Interleaved 16-bit samples that exercise a coder: tones, then noise, then silence, then
 * full-scale steps, per channel.
 */
export function testSignal(frames, channels, seed = 0x4d463430) {
    const random = seededRandom(seed);
    const samples = new Int16Array(frames * channels);
    for (let index = 0; index < frames; index++) {
        for (let channel = 0; channel < channels; channel++) {
            let value;
            if (index < frames / 4)
                value = Math.round(
                    20000 * Math.sin((2 * Math.PI * (440 + channel * 330) * index) / 48000),
                );
            else if (index < frames / 2) value = Math.round((random() - 0.5) * 65534);
            else if (index < (frames * 3) / 4) value = 0;
            else value = (index >> 6) & 1 ? 32767 : -32767;
            samples[index * channels + channel] = value;
        }
    }
    return samples;
}

/** Interleaved float samples of `channels` sine tones at `frequency` Hz (channel c at f(c + 1)). */
export function tone(rate, channels, frames, frequency = 440, level = 0.5) {
    const samples = new Float32Array(frames * channels);
    for (let index = 0; index < frames; index++)
        for (let channel = 0; channel < channels; channel++)
            samples[index * channels + channel] =
                level * Math.sin((2 * Math.PI * frequency * (channel + 1) * index) / rate);
    return samples;
}

/** 16-bit samples as floats, s / 32768. */
export const toFloat = samples => Float32Array.from(samples, value => value / 32768);

/** Float samples as 16-bit samples, rounded. */
export const toInt16 = plane => Int16Array.from(plane, value => Math.round(value * 32768));

/** The planes of interleaved samples. */
export function deinterleave(samples, channels) {
    const frames = samples.length / channels;
    return Array.from({ length: channels }, (_, channel) =>
        Float32Array.from({ length: frames }, (_, frame) => samples[frame * channels + channel]),
    );
}

/** The interleaved samples of planes. */
export function interleave(planes) {
    const frames = planes[0].length;
    const out = new Float32Array(frames * planes.length);
    planes.forEach((plane, channel) => {
        for (let frame = 0; frame < frames; frame++)
            out[frame * planes.length + channel] = plane[frame];
    });
    return out;
}

/** A 16-bit PCM WAVE file of interleaved `samples`. */
export function waveFile(samples, rate, channels) {
    const bytes = new Uint8Array(44 + samples.length * 2);
    const view = new DataView(bytes.buffer);
    const ascii = (at, text) => [...text].forEach((c, i) => (bytes[at + i] = c.charCodeAt(0)));
    ascii(0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    ascii(8, 'WAVEfmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, channels, true);
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * channels * 2, true);
    view.setUint16(32, channels * 2, true);
    view.setUint16(34, 16, true);
    ascii(36, 'data');
    view.setUint32(40, samples.length * 2, true);
    samples.forEach((value, index) => view.setInt16(44 + index * 2, value, true));
    return bytes;
}

/** The chunks of a RIFF WAVE file: id to { at, size } of the body. */
export function waveChunks(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const chunks = new Map();
    for (let at = 12; at + 8 <= bytes.length;) {
        const size = view.getUint32(at + 4, true);
        chunks.set(String.fromCharCode(...bytes.subarray(at, at + 4)), { at: at + 8, size });
        at += 8 + size + (size & 1);
    }
    return chunks;
}

/** The interleaved 16-bit samples of a WAVE file (a Blob or bytes). */
export async function waveSamples(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(await input.arrayBuffer());
    const data = waveChunks(bytes).get('data');
    if (!data) throw new Error('WAVE data chunk is missing');
    return new Int16Array(bytes.slice(data.at, data.at + data.size).buffer);
}

/** The bytes of a Blob. */
export const bytesOf = async blob => new Uint8Array(await blob.arrayBuffer());
