import { readFileSync } from 'node:fs';
import { open } from 'mediaforgejs';

// The editing fixtures, written by ffmpeg 6.1.1 (libx264, libvpx-vp9, libopus, libmp3lame, native
// mpeg4 and aac):
//   clip-a.mp4:   testsrc2 64x48 25 fps 3 s, keyframes every 25 frames, 2 B-frames; 440 Hz sine,
//                 AAC 64k stereo
//     ffmpeg -f lavfi -i testsrc2=size=64x48:rate=25:duration=3
//       -f lavfi -i sine=frequency=440:sample_rate=48000:duration=3
//       -map 0:v -map 1:a -c:v libx264 -preset veryfast -profile:v main -bf 2 -g 25 -keyint_min 25
//       -sc_threshold 0 -pix_fmt yuv420p -c:a aac -b:a 64k -ac 2 -movflags +faststart clip-a.mp4
//   clip-b.mp4:   the same for 2 s with an 880 Hz sine
//   clip-m4v.mp4: testsrc2 64x48 25 fps 2 s as MPEG-4 Part 2 without B-frames
//                 (-c:v mpeg4 -q:v 4 -g 25 -bf 0), 550 Hz AAC
//   clip-c.webm:  testsrc2 64x48 30 fps 2 s, VP9 100k with keyframes every 15 frames, 660 Hz Opus
//                 48k stereo
//   music.mp3:    220 Hz sine, 4 s, 44.1 kHz mono, libmp3lame 64k

const fixtures = new URL('../fixtures/editing/', import.meta.url);
/** The bytes of an editing fixture. */
export const editingFixture = name => new Uint8Array(readFileSync(new URL(name, fixtures)));

/** Each track's type, codec, duration and packet count, and its packets' times, sorted. */
export async function tracksOf(blob) {
    const media = await open(blob);
    try {
        const times = new Map(media.tracks.map(track => [track.id, []]));
        for await (const packet of media.packets())
            times.get(packet.trackId).push(packet.timestamp);
        return media.tracks.map(track => {
            const sorted = times.get(track.id).sort((a, b) => a - b);
            return {
                type: track.type,
                codec: track.codec,
                duration: track.duration,
                sampleCount: sorted.length,
                times: sorted,
            };
        });
    } finally {
        media.close();
    }
}

/** The channel count, rate and samples (as -1..1) of a 16-bit WAV. */
export function wavSamples(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let at = 12;
    let format;
    for (;;) {
        const id = String.fromCharCode(...bytes.subarray(at, at + 4));
        const size = view.getUint32(at + 4, true);
        if (id === 'fmt ')
            format = {
                channels: view.getUint16(at + 10, true),
                sampleRate: view.getUint32(at + 12, true),
            };
        if (id === 'data') {
            const samples = new Float32Array(size / 2);
            for (let index = 0; index < samples.length; index++)
                samples[index] = view.getInt16(at + 8 + index * 2, true) / 32768;
            return { ...format, samples };
        }
        at += 8 + size + (size & 1);
    }
}

/** The length in seconds of decoded sound. */
export const seconds = audio => audio.samples.length / audio.channels / audio.sampleRate;

/**
 * The RMS of a mono mix over [from, to) seconds and the fraction of its energy at `frequency`
 * (Goertzel).
 */
export function toneLevel(audio, from, to, frequency) {
    const { channels, sampleRate, samples } = audio;
    const start = Math.round(from * sampleRate);
    const end = Math.min(Math.round(to * sampleRate), samples.length / channels);
    let energy = 0;
    let sine = 0;
    let cosine = 0;
    for (let index = start; index < end; index++) {
        let value = 0;
        for (let channel = 0; channel < channels; channel++)
            value += samples[index * channels + channel];
        value /= channels;
        energy += value * value;
        const angle = (2 * Math.PI * frequency * index) / sampleRate;
        sine += value * Math.sin(angle);
        cosine += value * Math.cos(angle);
    }
    const size = end - start;
    return {
        rms: Math.sqrt(energy / size),
        tone: energy ? (2 * (sine * sine + cosine * cosine)) / (size * energy) : 0,
    };
}
