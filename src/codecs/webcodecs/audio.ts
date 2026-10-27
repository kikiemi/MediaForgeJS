import { CodecLifetime } from '../shared/codec-lifetime';
import type { EncodedPacket } from '../../core/model/media';
import type { TrackInfo } from '../../core/model/track';
import { MediaForgeError } from '../../core/errors/errors';
import {
    codecFamily,
    mp4aAudioObjectType,
    webCodecsAudioCodec,
} from '../../core/model/codec-strings';
import { flacStreamHeader } from '../../core/codec-config/audio/flac-frame';
import { aacCodecString, readAacAudioObjectType } from '../../core/codec-config/audio/adts';
import { downmixChannels } from '../pcm/audio-buffer-tools';
import { opusHeadPacket } from '../../core/codec-config/audio/opus-head';
import { vorbisBlocks, vorbisPacketBlock } from '../../core/codec-config/audio/vorbis-headers';
import { QueueGate, bufferCopy, closeCodec, codecError } from './codec';
import { copyAudioPlanes } from './audio-data';

/** Chunks queued in a host audio codec before the caller waits for it to dequeue one. */
const QUEUE_LIMIT = 16;

/** Samples of an AAC-LC frame, which is also the encoder delay AAC-LC encoders have. */
const AAC_FRAME = 1024;

/** The encoder delay of Apple's AudioToolbox AAC-LC encoder. */
const TOOLBOX_AAC_DELAY = 2112;

/** Samples of silence the encoder delay probe encodes: four whole AAC frames. */
const PROBE_FRAMES = 4 * AAC_FRAME;

/** The probed encoder delay of each AudioEncoder class, by configuration. */
const aacDelays = new WeakMap<object, Map<string, Promise<number>>>();

/** WebCodecs configuration that describes a track's packets, or null when no codec string does. */
export function hostAudioDecoderConfig(track: TrackInfo): AudioDecoderConfig | null {
    const shape = { sampleRate: track.sampleRate, numberOfChannels: track.channelCount };
    const family = codecFamily(track.codec);
    if (family === 'flac') {
        const header = track.codecConfig && flacStreamHeader(track.codecConfig);
        return header ? { codec: 'flac', ...shape, description: header } : null;
    }
    if (family === 'opus') {
        try {
            return {
                codec: 'opus',
                ...shape,
                description: opusHeadPacket(track.codecConfig, track.channelCount, 0),
            };
        } catch {
            return null;
        }
    }
    if ((family === 'mp4a' || family === 'alac') && !track.codecConfig) return null;

    // MP3onMP4 (object types 32..34) packs several MPEG audio streams per access unit; hosts read
    // these codec strings as plain MPEG audio, so no host configuration describes its packets.
    const objectType = mp4aAudioObjectType(track.codec);
    if (objectType !== null && objectType >= 32 && objectType <= 34) return null;

    // HE-AAC is advertised as such, with the output rate and channels, so the host decodes SBR and
    // PS natively.
    if (family === 'mp4a' && /^mp4a\.40\./i.test(track.codec))
        return {
            codec: aacCodecString(track.codecConfig!, track.sampleRate, track.channelCount),
            ...shape,
            description: track.codecConfig!,
        };
    return {
        codec: webCodecsAudioCodec(track.codec),
        ...shape,
        ...(track.codecConfig && !['mp1', 'mp2', 'mp3', 'ulaw', 'alaw'].includes(family)
            ? { description: track.codecConfig }
            : {}),
    };
}

/** Frames the planes a host decoder gathers its output in hold before they are handed on. */
const GATHERED_FRAMES = 16384;

/**
 * One configured host AudioDecoder. Decoded audio is copied into float planes of the configured
 * shape (integer samples scaled exactly, see copyAudioPlanes) and gathered in planes of
 * GATHERED_FRAMES frames; a block is handed on as it is, without a copy, when the next output does
 * not fit and at flush(), and waits for take() in output order. A different rate, a host error or
 * a closed decoder fails the lifetime with DECODE. Audio in another channel count (a stream that
 * switches channel modes mid-way) is mixed to the configured count, with ITU-R BS.775 weights when
 * folding down, and reported once to `warn` as AUDIO_FORMAT_CHANGED.
 */
export class HostAudioDecoder {
    private readonly decoder: AudioDecoder;
    private readonly gate: QueueGate;
    private readonly decoded: Float32Array[][] = [];
    /** The planes output is gathered in (made as output arrives), and the frames they hold. */
    private gathered: Float32Array[] | null = null;
    private gatheredFrames = 0;
    private closed = false;
    private remixReported = false;
    /** Frames the host output. */
    frames = 0;

    constructor(
        private readonly config: AudioDecoderConfig,
        private readonly lifetime: CodecLifetime,
        private readonly warn?: (code: string, message: string) => void,
    ) {
        lifetime.check();
        const context = `AudioDecoder failed for '${config.codec}'`;
        try {
            this.decoder = new AudioDecoder({
                output: audio => this.onData(audio),
                error: error => {
                    if (!this.closed) lifetime.record(codecError(error, 'DECODE', context));
                },
            });
        } catch (error) {
            throw lifetime.record(codecError(error, 'DECODE', context));
        }

        this.gate = new QueueGate(this.decoder);
        try {
            this.decoder.configure(config);
        } catch (error) {
            this.close();
            throw lifetime.record(codecError(error, 'DECODE', context));
        }
    }

    private onData(audio: AudioData): void {
        try {
            if (this.closed || !this.lifetime.acceptingOutput) return;
            const { sampleRate, numberOfChannels: channels } = this.config;
            const decodedChannels = audio.numberOfChannels;
            if (
                audio.sampleRate !== sampleRate ||
                !Number.isInteger(decodedChannels) ||
                decodedChannels < 1 ||
                decodedChannels > 8
            )
                throw new MediaForgeError(
                    'AudioDecoder returned another sample rate or channel count',
                    'DECODE',
                );
            const frames = audio.numberOfFrames;
            if (!frames) return;
            this.frames += frames;
            if (frames > GATHERED_FRAMES - this.gatheredFrames) this.handOn();
            if (decodedChannels === channels && frames <= GATHERED_FRAMES) {
                this.gathered ??= Array.from(
                    { length: channels },
                    () => new Float32Array(GATHERED_FRAMES),
                );
                copyAudioPlanes(audio, this.gathered, this.gatheredFrames);
                this.gatheredFrames += frames;
                return;
            }

            const planes = Array.from({ length: decodedChannels }, () => new Float32Array(frames));
            copyAudioPlanes(audio, planes, 0);
            if (decodedChannels === channels) {
                this.decoded.push(planes);
                return;
            }
            if (!this.remixReported) {
                this.remixReported = true;
                this.warn?.(
                    'AUDIO_FORMAT_CHANGED',
                    `${this.config.codec} audio changes to ${decodedChannels} channels, mixed ` +
                        `to ${channels}`,
                );
            }

            this.handOn();
            this.decoded.push(downmixChannels(planes, decodedChannels, channels, frames));
        } catch (error) {
            this.lifetime.record(
                codecError(
                    error,
                    'DECODE',
                    `AudioDecoder output failed for '${this.config.codec}'`,
                ),
            );
        } finally {
            try {
                audio.close();
            } catch (error) {
                this.lifetime.record(codecError(error, 'DECODE', 'AudioData close failed'));
            }
        }
    }

    private check(): void {
        this.lifetime.check();
        if (this.decoder.state === 'closed')
            throw this.lifetime.record(
                new MediaForgeError(
                    `AudioDecoder for '${this.config.codec}' closed before decoding completed`,
                    'DECODE',
                ),
            );
    }

    /**
     * Submits one chunk once the decoder queue has room; times are microseconds, the caller keeps
     * `data`.
     */
    async decode(
        data: AllowSharedBufferSource,
        timestamp: number,
        duration?: number,
    ): Promise<void> {
        this.check();
        await this.gate.until(
            () => this.decoder.decodeQueueSize < QUEUE_LIMIT || this.decoder.state === 'closed',
            this.lifetime,
        );
        this.check();
        try {
            this.decoder.decode(
                new EncodedAudioChunk({
                    type: 'key',
                    timestamp,
                    ...(duration === undefined ? {} : { duration }),
                    data,
                }),
            );
        } catch (error) {
            throw this.lifetime.record(
                codecError(error, 'DECODE', `AudioDecoder failed for '${this.config.codec}'`),
            );
        }
    }

    /** Outputs every chunk submitted so far and hands on the frames gathered. */
    async flush(): Promise<void> {
        this.check();
        await this.lifetime.waitFor(
            Promise.resolve()
                .then(() => this.decoder.flush())
                .catch(error => {
                    throw codecError(
                        error,
                        'DECODE',
                        `AudioDecoder flush failed for '${this.config.codec}'`,
                    );
                }),
        );
        this.check();
        this.handOn();
    }

    /** Hands the gathered frames on as one block of planes; the next output gathers in new ones. */
    private handOn(): void {
        const frames = this.gatheredFrames;
        if (!frames) return;
        this.decoded.push(this.gathered!.map(plane => plane.subarray(0, frames)));
        this.gathered = null;
        this.gatheredFrames = 0;
    }

    /** The blocks handed on so far, in output order; ownership passes to the caller. */
    take(): Float32Array[][] {
        return this.decoded.splice(0);
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        this.decoded.length = 0;
        this.gathered = null;
        this.gatheredFrames = 0;
        this.gate?.dispose();
        closeCodec(this.decoder);
    }
}

/**
 * One configured host AudioEncoder. Each output packet is copied and passed on with the first
 * decoder configuration record the host reported; for AAC that record must name the requested
 * object type. `hostFailure` holds the host failure when it was the first to end the lifetime,
 * which lets callers fall back to a built-in encoder.
 */
export class HostAudioEncoder {
    private readonly encoder: AudioEncoder;
    private readonly gate: QueueGate;
    private readonly objectType: number | null;
    private closed = false;
    /** First decoder configuration record the encoder reported. */
    description: Uint8Array | undefined;
    /** Packets delivered to the output. */
    packets = 0;
    hostFailure: Error | undefined;
    /**
     * What times Vorbis packets, read from the reported headers, and the block of the last packet:
     * a packet lasts a quarter of its block and the previous one, which hosts misreport (Firefox
     * gives every packet 64 samples).
     */
    private vorbis?: NonNullable<ReturnType<typeof vorbisBlocks>> & { previous?: number };

    constructor(
        readonly config: AudioEncoderConfig,
        private readonly lifetime: CodecLifetime,
        private readonly output: (
            packet: EncodedPacket,
            description: Uint8Array | undefined,
        ) => void,
    ) {
        lifetime.check();
        this.objectType = mp4aAudioObjectType(config.codec);
        let encoder: AudioEncoder;
        try {
            encoder = new AudioEncoder({
                output: (chunk, metadata) => this.onChunk(chunk, metadata),
                error: error => {
                    if (!this.closed) this.fail(error);
                },
            });
        } catch (error) {
            throw this.fail(error);
        }

        this.encoder = encoder;
        this.gate = new QueueGate(encoder);
        try {
            encoder.configure(config);
        } catch (error) {
            const failure = this.fail(error);
            this.close();
            throw failure;
        }
    }

    /** Records a host failure; returns the lifetime's first failure. */
    private fail(caught: unknown): Error {
        const error = codecError(
            caught,
            'ENCODE',
            `AudioEncoder failed for '${this.config.codec}'`,
        );
        const accepting = this.lifetime.acceptingOutput;
        const first = this.lifetime.record(error);
        if (
            accepting &&
            first === error &&
            error instanceof MediaForgeError &&
            error.code === 'ENCODE'
        )
            this.hostFailure = error;
        return first;
    }

    private onChunk(
        chunk: EncodedAudioChunk,
        metadata: EncodedAudioChunkMetadata | undefined,
    ): void {
        if (this.closed || !this.lifetime.acceptingOutput) return;
        try {
            const reported = metadata?.decoderConfig?.description;
            if (reported && !this.description) {
                const description = bufferCopy(reported);
                const actual =
                    this.objectType === null ? null : readAacAudioObjectType(description);
                if (actual !== this.objectType)
                    throw this.fail(
                        new MediaForgeError(
                            `AudioEncoder returned another AAC type than ${this.config.codec}`,
                            'ENCODE',
                        ),
                    );
                this.description = description;
            }

            if (this.objectType !== null && this.objectType !== 2 && !this.description)
                throw this.fail(
                    new MediaForgeError(
                        `AudioEncoder gave no valid AudioSpecificConfig for ${this.config.codec}`,
                        'ENCODE',
                    ),
                );
            const data = new Uint8Array(chunk.byteLength);
            chunk.copyTo(data);
            this.lifetime.check();
            this.output(
                {
                    data,
                    timestamp: chunk.timestamp / 1e6,
                    duration: this.durationOf(chunk, data),
                    isKeyframe: true,
                    trackType: 'audio',
                },
                this.description,
            );
            this.packets++;
        } catch (error) {
            this.lifetime.record(error);
        }
    }

    /** Seconds of `chunk`: by its blocks for Vorbis, else as the host says. */
    private durationOf(chunk: EncodedAudioChunk, data: Uint8Array): number {
        if (this.config.codec === 'vorbis' && this.description)
            this.vorbis ??= vorbisBlocks(this.description);
        const vorbis = this.vorbis;
        if (!vorbis) return (chunk.duration ?? 0) / 1e6;
        const block = vorbisPacketBlock(data, vorbis.modes, vorbis.small, vorbis.large);
        const samples = vorbis.previous === undefined ? 0 : (vorbis.previous + block) / 4;
        vorbis.previous = block;
        return samples / this.config.sampleRate;
    }

    private check(): void {
        this.lifetime.check();
        if (this.encoder.state === 'closed')
            throw this.fail(
                new MediaForgeError(
                    `AudioEncoder for '${this.config.codec}' closed before encoding completed`,
                    'ENCODE',
                ),
            );
    }

    /**
     * Encodes `frames` frames of float PCM, planar or interleaved in the configured channel count,
     * starting at `timestamp` seconds, once the encoder queue has room. The caller keeps `samples`.
     */
    async encode(
        samples: Float32Array<ArrayBuffer>,
        frames: number,
        timestamp: number,
        planar: boolean,
    ): Promise<void> {
        this.check();
        await this.gate.until(
            () => this.encoder.encodeQueueSize < QUEUE_LIMIT || this.encoder.state === 'closed',
            this.lifetime,
        );
        this.check();
        let audio: AudioData | undefined;
        try {
            audio = new AudioData({
                format: planar ? 'f32-planar' : 'f32',
                sampleRate: this.config.sampleRate,
                numberOfFrames: frames,
                numberOfChannels: this.config.numberOfChannels,
                timestamp: Math.round(timestamp * 1e6),
                data: samples,
            });
            this.encoder.encode(audio);
        } catch (error) {
            throw this.fail(error);
        } finally {
            try {
                audio?.close();
            } catch {}
        }

        this.check();
    }

    /**
     * Encodes equally long float planes in the configured channel count starting at `timestamp`
     * seconds.
     */
    encodePlanes(planes: readonly Float32Array[], timestamp: number): Promise<void> {
        const frames = planes[0]?.length ?? 0;
        if (!frames) return Promise.resolve();
        const channels = this.config.numberOfChannels;
        const planar = new Float32Array(frames * channels);
        for (let channel = 0; channel < channels; channel++)
            planar.set(planes[channel]!, channel * frames);
        return this.encode(planar, frames, timestamp, true);
    }

    /** Outputs every packet of the input submitted so far. */
    async flush(): Promise<void> {
        this.check();
        await this.lifetime.waitFor(
            Promise.resolve()
                .then(() => this.encoder.flush())
                .catch(error => {
                    throw this.fail(error);
                }),
        );
        this.check();
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        this.gate?.dispose();
        closeCodec(this.encoder);
    }
}

/**
 * The encoder delay, in samples, of the host's AAC-LC encoder for `config`: 1024, unless the
 * encoder gives back no more frames than its input fills, so that its output starts with the first
 * input sample (Chromium on Windows), then 0, or three frames more, as Apple's AudioToolbox encoder
 * does with its 2112 samples (Chromium on macOS, which leaves them in), then 2112. Asked once per
 * AudioEncoder class and configuration by encoding four frames of silence; a probe that fails, and
 * the other AAC types, keep 1024.
 */
export function hostAacPriming(config: AudioEncoderConfig): Promise<number> {
    if (mp4aAudioObjectType(config.codec) !== 2) return Promise.resolve(AAC_FRAME);
    const host = globalThis.AudioEncoder;
    let known = aacDelays.get(host);
    if (!known) aacDelays.set(host, (known = new Map()));
    const key = `${config.codec}/${config.sampleRate}/${config.numberOfChannels}`;
    let delay = known.get(key);
    if (!delay) known.set(key, (delay = probeAacPriming(config)));
    return delay;
}

async function probeAacPriming(config: AudioEncoderConfig): Promise<number> {
    const lifetime = new CodecLifetime();
    let encoder: HostAudioEncoder | undefined;
    try {
        encoder = new HostAudioEncoder(config, lifetime, () => {});
        const silence = Array.from(
            { length: config.numberOfChannels },
            () => new Float32Array(PROBE_FRAMES),
        );
        await encoder.encodePlanes(silence, 0);
        await encoder.flush();
        const extra = encoder.packets - PROBE_FRAMES / AAC_FRAME;
        return extra <= 0 ? 0 : extra >= 3 ? TOOLBOX_AAC_DELAY : AAC_FRAME;
    } catch {
        return AAC_FRAME;
    } finally {
        encoder?.close();
        lifetime.stop();
    }
}
