// Stand-ins for the host's WebCodecs classes, for the adapters' tests in Node, where WebCodecs is
// missing. Each installs itself on globalThis and returns a restore function.
import { setImmediate as yieldTask } from 'node:timers/promises';

/** Replaces the globals of `classes` (name to value) and returns a function that restores them. */
export function installGlobals(classes) {
    const saved = Object.keys(classes).map(name => [
        name,
        Object.getOwnPropertyDescriptor(globalThis, name),
    ]);
    Object.assign(globalThis, classes);
    return () => {
        for (const [name, descriptor] of saved)
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else delete globalThis[name];
    };
}

/** A chunk class that keeps its init, as EncodedAudioChunk and EncodedVideoChunk do. */
export class FakeChunk {
    constructor(init) {
        Object.assign(this, init);
        this.byteLength = init.data?.byteLength ?? 0;
    }
    copyTo(target) {
        target.set(
            new Uint8Array(
                this.data.buffer ?? this.data,
                this.data.byteOffset ?? 0,
                this.byteLength,
            ),
        );
    }
}

/**
 * AudioData of `format` ('f32-planar', 's16', 's16-planar', 'u8', 's32', ...) holding `samples`
 * (planes for planar formats, one interleaved array otherwise). Its float copy divides positive
 * integers by 2^(bits-1) - 1, as Chromium's does, so a reader that asks for float differs.
 */
export function fakeAudioData({ format = 'f32-planar', sampleRate = 48000, samples, channels }) {
    const planar = format.endsWith('-planar');
    const numberOfChannels = channels ?? (planar ? samples.length : 1);
    const numberOfFrames = planar ? samples[0].length : samples.length / numberOfChannels;
    const bits = { u8: 8, s16: 16, s32: 32 }[format.replace('-planar', '')];
    const channelOf = channel =>
        planar
            ? [...samples[channel]]
            : [...samples].filter((_, at) => at % numberOfChannels === channel);
    return {
        format,
        sampleRate,
        numberOfChannels,
        numberOfFrames,
        closed: false,
        copyTo(target, { planeIndex = 0, format: to = format } = {}) {
            if (to === format) return target.set(planar ? samples[planeIndex] : samples);
            if (to !== 'f32-planar') throw new Error(`no copy to ${to}`);
            const values = channelOf(planeIndex);
            target.set(
                bits === undefined
                    ? values
                    : values.map(value => {
                          const centred = bits === 8 ? value - 128 : value;
                          return centred / (centred < 0 ? 2 ** (bits - 1) : 2 ** (bits - 1) - 1);
                      }),
            );
        },
        close() {
            this.closed = true;
        },
    };
}

/**
 * An AudioDecoder class whose `respond(decoder, chunk, index)` makes the output of each chunk
 * (AudioData, an array of them, or an Error to fail with), after a task; `stats` counts it all.
 */
export function fakeAudioDecoder(respond, { supported = () => true } = {}) {
    const stats = { decoders: 0, chunks: [], configs: [], probes: 0 };
    class Decoder {
        static async isConfigSupported(config) {
            stats.probes++;
            return { supported: supported(config), config };
        }
        state = 'unconfigured';
        decodeQueueSize = 0;
        pending = Promise.resolve();
        constructor(init) {
            this.init = init;
            stats.decoders++;
        }
        configure(config) {
            this.config = config;
            stats.configs.push(config);
            this.state = 'configured';
        }
        decode(chunk) {
            const index = stats.chunks.length;
            stats.chunks.push(chunk);
            this.pending = this.pending.then(async () => {
                await yieldTask();
                if (this.state === 'closed') return;
                const result = respond(this, chunk, index);
                if (result instanceof Error) {
                    this.state = 'closed';
                    this.init.error(result);
                } else for (const audio of [result].flat()) if (audio) this.init.output(audio);
            });
        }
        async flush() {
            await this.pending;
        }
        close() {
            this.state = 'closed';
        }
    }
    return { Decoder, stats };
}
