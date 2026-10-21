/** An integer AudioData sample format: bytes per sample, the stored value of zero, its array. */
interface IntegerSamples {
    readonly bytes: number;
    readonly zero: number;
    readonly view: (buffer: ArrayBuffer, length: number) => Uint8Array | Int16Array | Int32Array;
}

/** The integer AudioData sample formats, interleaved or planar. */
const INTEGER_SAMPLES: Readonly<Record<string, IntegerSamples>> = {
    u8: { bytes: 1, zero: 128, view: (buffer, length) => new Uint8Array(buffer, 0, length) },
    s16: { bytes: 2, zero: 0, view: (buffer, length) => new Int16Array(buffer, 0, length) },
    s32: { bytes: 4, zero: 0, view: (buffer, length) => new Int32Array(buffer, 0, length) },
};

/** Integer samples copied out of an AudioData before they are scaled; it grows as needed. */
let scratch = new ArrayBuffer(0);

/**
 * Copies the frames of `audio` into `planes` from frame `at`: channel c into planes[c], for the
 * first planes.length channels. Integer samples are copied in their own format and scaled by a
 * power of two, v / 2^(bits - 1), which is exact and how the library reads linear PCM: a host's
 * own conversion to float may scale positive samples by 1 / (2^(bits - 1) - 1) instead (Chromium
 * does), and they would then differ from the library's. Float samples are copied as f32-planar.
 * Interleaved samples are copied out once.
 */
export function copyAudioPlanes(
    audio: AudioData,
    planes: readonly Float32Array[],
    at: number,
): void {
    const frames = audio.numberOfFrames;
    const format = audio.format ?? 'f32-planar';
    const planar = format.endsWith('-planar');
    const integer = INTEGER_SAMPLES[planar ? format.slice(0, -'-planar'.length) : format];
    if (!integer) {
        for (let channel = 0; channel < planes.length; channel++)
            audio.copyTo(planes[channel]!.subarray(at, at + frames), {
                planeIndex: channel,
                format: 'f32-planar',
            });
        return;
    }
    const stride = planar ? 1 : audio.numberOfChannels;
    const count = frames * stride;
    if (scratch.byteLength < count * integer.bytes)
        scratch = new ArrayBuffer(count * integer.bytes);
    const samples = integer.view(scratch, count);
    const { zero } = integer;
    const scale = 2 ** (1 - 8 * integer.bytes);
    if (!planar) audio.copyTo(samples, { planeIndex: 0, format });
    for (let channel = 0; channel < planes.length; channel++) {
        if (planar) audio.copyTo(samples, { planeIndex: channel, format });
        const target = planes[channel]!;
        for (let frame = 0, from = planar ? 0 : channel; frame < frames; frame++, from += stride)
            target[at + frame] = (samples[from]! - zero) * scale;
    }
}
