import { buildAacAsc } from '../../core/codec-config/audio/adts';
import { canonicalAudioCodec, canonicalVideoCodec } from '../../core/model/codec-names';
import { mp4aAudioObjectType } from '../../core/model/codec-strings';
import { MediaForgeError } from '../../core/errors/errors';
import { declaredFlacHeader } from '../../core/codec-config/audio/flac-frame';
import type { EncodedPacket, OutputContainerFormat } from '../../core/model/media';
import type { TrackInfo } from '../../core/model/track';
import { drainSink } from '../../core/io/sinks/sink-backpressure';
import type { Sink } from '../../core/model/types';
import { CodecLifetime } from '../../codecs/shared/codec-lifetime';
import { memoryFrame } from '../../codecs/webcodecs/video';
import type { BuiltinVideoCodec } from '../../core/contracts/decoder';
import type { VideoCodecProvider } from '../../core/contracts/encoder';
import { Picture, pictureOf, type PictureData } from '../../stages/picture';
import { MP4_FAMILY, containerLayout } from '../../formats/shared/capabilities';
import type { AudioTrackConfig, MuxerConfig, OutputMuxer } from '../../core/contracts/writer';
import { AudioTrackEncoder } from './track-encoder';
import type { ContainerAudioEncoder } from './container-audio';
import { DEFAULT_AUDIO_BITRATE } from './audio-settings';
import { openClipDecoder, openVideoEncoder, releaseData, type EncoderPort } from './video-codecs';
import { Interleaver } from '../copy/interleave';
import type { FormatWriters, MissingParts } from '../plugins/missing-parts';
import type { CodecPreference } from '../api-types';
import type { FilePacket } from '../media-types';
import {
    warner,
    type EncodeAudioOptions,
    type Muxer,
    type MuxerAudioTrack,
    type MuxerOptions,
    type PcmSource,
    type VideoDecoderOptions,
    type VideoDecoderPart,
    type VideoEncoderOptions,
    type VideoEncoderPart,
} from './part-options';

/**
 * The parts that decode, encode and write: a video decoder, a video encoder and a muxer, loaded
 * with the first that is opened (see parts).
 */

/** A lifetime that ends with `signal`, with its own controller for close(). */
function partLifetime(
    signal: AbortSignal | undefined,
    label: string,
): { lifetime: CodecLifetime; stop: () => void } {
    const controller = new AbortController();
    const forward = (): void => controller.abort(signal?.reason);
    if (signal?.aborted) forward();
    else signal?.addEventListener('abort', forward, { once: true });
    const lifetime = new CodecLifetime(
        controller.signal,
        new MediaForgeError(`The ${label} is closed`, 'ABORT'),
    );
    return {
        lifetime,
        stop: () => {
            signal?.removeEventListener('abort', forward);
            lifetime.stop();
            controller.abort();
        },
    };
}

/**
 * `picture` copied off its host frame, which is closed so that the decoder may output again; a
 * frame without a pixel format cannot be copied and stays.
 */
async function offDecoder(picture: Picture, lifetime: CodecLifetime): Promise<Picture> {
    const { data } = picture;
    if (data.kind !== 'frame' || !data.frame.format) return picture;
    try {
        const frame = await memoryFrame(data.frame, lifetime);
        return new Picture({ ...data, frame }, picture.timestamp, picture.duration);
    } finally {
        picture.close();
    }
}

/** The decoders a composition offers. */
export interface VideoDecoding {
    readonly decoders: readonly BuiltinVideoCodec[];
    readonly preference: CodecPreference;
    readonly missing?: MissingParts;
    readonly providers?: readonly VideoCodecProvider[];
}

/**
 * Opens the decoder of a video track: an application codec that decodes it, else the host
 * VideoDecoder or a built-in decoder in the order of the preference.
 */
export async function openVideoDecoderPart(
    track: TrackInfo,
    decoding: VideoDecoding,
    options: VideoDecoderOptions = {},
): Promise<VideoDecoderPart> {
    const { lifetime, stop } = partLifetime(options.signal, 'video decoder');
    const ready: Picture[] = [];
    /** Ends the wait of flush() for the next picture. */
    let wake: (() => void) | undefined;
    const warn = warner(options);
    const signal = new AbortController();

    let decoder: Awaited<ReturnType<typeof openClipDecoder>>;
    try {
        decoder = await openClipDecoder(
            track,
            {
                decoders: decoding.decoders,
                preference: options.codecPreference ?? decoding.preference,
                missing: decoding.missing,
                providers: decoding.providers,
                recovery: { strict: options.strict === true, warn },
                lifetime,
                signal: signal.signal,
            },
            (data: PictureData, timing) => {
                if (!lifetime.acceptingOutput) return releaseData(data);
                ready.push(new Picture(data, timing.timestamp, timing.duration));
                wake?.();
            },
        );
    } catch (error) {
        stop();
        throw error;
    }

    let closed = false;
    return {
        async decode(packet) {
            lifetime.check();
            const indexed: FilePacket = {
                trackId: 0,
                sampleIndex: 0,
                ...packet,
                trackType: 'video',
            };
            await lifetime.waitFor(decoder.decode(indexed));
            return ready.splice(0);
        },
        async flush() {
            lifetime.check();
            // A host decoder that lends few frames (a GPU decoder) outputs the next only once one
            // is closed, so while it flushes its pictures are copied off its frames, oldest first.
            const lends = decoder.kind === 'host';
            let flushed = false;
            const flushing = decoder.flush(false).then(() => {
                flushed = true;
            });
            flushing.catch(() => undefined);
            const pictures: Picture[] = [];
            let copied = 0;
            try {
                for (;;) {
                    // Every picture is out before the flush settles; those not copied by then stay.
                    const ended = flushed;
                    pictures.push(...ready.splice(0));
                    if (ended) return pictures;
                    if (lends && copied < pictures.length) {
                        pictures[copied] = await offDecoder(pictures[copied]!, lifetime);
                        copied++;
                        continue;
                    }
                    const output = new Promise<void>(resolve => (wake = resolve));
                    await lifetime.waitFor(Promise.race([flushing, output]));
                    wake = undefined;
                }
            } catch (error) {
                for (const picture of pictures) picture.close();
                throw error;
            }
        },
        async close() {
            if (closed) return;
            closed = true;
            for (const picture of ready.splice(0)) picture.close();
            stop();
            signal.abort();
            await decoder.close();
        },
    };
}

/**
 * Opens a video encoder: an application codec that encodes the codec, else the host VideoEncoder
 * with the first profile and level it accepts for the size (a full codec string is kept as given).
 */
export async function openVideoEncoderPart(
    options: VideoEncoderOptions,
    providers: readonly VideoCodecProvider[] = [],
): Promise<VideoEncoderPart> {
    if (!options || typeof options.codec !== 'string' || !options.codec.trim())
        throw new MediaForgeError('A video encoder needs a codec', 'INPUT');
    const codec = canonicalVideoCodec(options.codec);

    const { lifetime, stop } = partLifetime(options.signal, 'video encoder');
    const ready: EncodedPacket[] = [];
    let port: EncoderPort;
    try {
        port = await openVideoEncoder(
            {
                codec,
                explicit: codec.includes('.'),
                width: options.width,
                height: options.height,
                framerate: options.framerate ?? 30,
                bitrate: options.bitrate,
                keyframeInterval: options.keyframeInterval ?? 2,
                container: options.container ?? 'mp4',
                hardwareAcceleration: options.hardwareAcceleration,
                latencyMode: options.latencyMode,
                bitrateMode: options.bitrateMode,
                provider: providers.find(provider => provider.supportsEncode(codec)),
                signal: options.signal ?? new AbortController().signal,
            },
            lifetime,
            packet => ready.push(packet),
            warner(options),
        );
    } catch (error) {
        stop();
        throw error;
    }

    let closed = false;
    return {
        codec: port.codec,
        async encode(picture) {
            const owned = pictureOf(picture);
            try {
                lifetime.check();
                await port.ready();
            } catch (error) {
                owned.close();
                throw error;
            }
            await port.write(owned);
            return ready.splice(0);
        },
        async flush() {
            await port.flush();
            return ready.splice(0);
        },
        async close() {
            if (closed) return;
            closed = true;
            stop();
            await port.close();
        },
    };
}

/**
 * The audio track configuration of encoded sound, with the decoder configuration the codec declares
 * up front.
 */
export function encodedAudioTrack(
    codec: string,
    sampleRate: number,
    channels: number,
    frames?: number,
): Omit<AudioTrackConfig, 'id'> {
    return {
        type: 'audio',
        codec,
        sampleRate,
        channelCount: channels,
        ...(mp4aAudioObjectType(codec) === 2
            ? {
                  codecConfig: buildAacAsc(sampleRate, channels),
                  ...(frames !== undefined
                      ? { primingSamples: 1024, validSamples: Math.max(1, frames) }
                      : {}),
              }
            : codec === 'flac'
              ? { codecConfig: declaredFlacHeader(sampleRate, channels) }
              : {}),
    };
}

/**
 * Opens the writer of `format` into `sink`, which finish() closes; `container` encodes FLAC, MP2
 * and MP3 sound.
 */
export async function openMuxer(
    writers: FormatWriters,
    format: string,
    sink: Sink,
    options: MuxerOptions,
    container?: ContainerAudioEncoder,
): Promise<Muxer> {
    const name = format.trim().toLowerCase();
    if (!options.video && !options.audio)
        throw new MediaForgeError('A muxer needs a video or audio track', 'INPUT');
    if (!writers.container.has(name))
        throw writers.missing.format(name, `No writer for '${name}'`, true);
    await writers.load(name);

    const layout = containerLayout(name, sink);
    const video = options.video;
    const audio = options.audio && {
        ...options.audio,
        codec: canonicalAudioCodec(options.audio.codec),
    };

    const config: MuxerConfig = {
        format: name as OutputContainerFormat,
        mode: layout,
        maxFragmentDuration: 2,
        autoSync: true,
        ...(options.title !== undefined ? { title: options.title } : {}),
        ...(video
            ? {
                  video: {
                      id: 1,
                      type: 'video',
                      codec: video.codec,
                      width: video.width,
                      height: video.height,
                      framerate: video.framerate ?? 0,
                      ...(video.codecConfig ? { codecConfig: video.codecConfig } : {}),
                      ...(video.rotation ? { rotation: video.rotation } : {}),
                      ...(video.language ? { language: video.language } : {}),
                      ...(video.name ? { name: video.name } : {}),
                  },
              }
            : {}),
        ...(audio
            ? {
                  audio: {
                      ...encodedAudioTrack(audio.codec, audio.sampleRate, audio.channels),
                      id: video ? 2 : 1,
                      ...(audio.codecConfig ? { codecConfig: audio.codecConfig } : {}),
                      ...(audio.language ? { language: audio.language } : {}),
                      ...(audio.name ? { name: audio.name } : {}),
                  },
              }
            : {}),
    };

    const { lifetime, stop } = partLifetime(options.signal, 'muxer');
    try {
        const writer = writers.container.get(name)!(config, sink, { deferCodecConfig: true });
        return new ContainerMuxer(
            name,
            layout,
            writer,
            sink,
            { video: !!video, audio },
            container,
            lifetime,
            stop,
        );
    } catch (error) {
        stop();
        throw error;
    }
}

/** A muxer over a format's writer, with one interleaver lane per track. */
class ContainerMuxer implements Muxer {
    private readonly interleaver: Interleaver;
    private readonly videoLane: number | undefined;
    private readonly audioLane: number | undefined;
    private readonly started = [false, false];
    private described = false;
    private finished = false;

    constructor(
        readonly format: string,
        readonly layout: MuxerConfig['mode'],
        private readonly writer: OutputMuxer,
        private readonly sink: Sink,
        private readonly tracks: { readonly video: boolean; readonly audio?: MuxerAudioTrack },
        private readonly container: ContainerAudioEncoder | undefined,
        private readonly lifetime: CodecLifetime,
        private readonly stop: () => void,
    ) {
        this.videoLane = tracks.video ? 0 : undefined;
        this.audioLane = tracks.audio ? (tracks.video ? 1 : 0) : undefined;
        const video = this.videoLane;
        this.interleaver = new Interleaver(
            (tracks.video ? 1 : 0) + (tracks.audio ? 1 : 0),
            (lane, packet) =>
                lane === video
                    ? writer.addVideoChunk(packet, packet.codecConfig)
                    : writer.addAudioChunk(packet, packet.codecConfig),
            lifetime,
        );
    }

    /**
     * Waits while `lane` runs far ahead; a lane waits for the other only once that one runs too.
     */
    private async pace(lane: number): Promise<void> {
        if (this.started.every(Boolean)) await this.interleaver.drain(lane);
        await this.lifetime.waitFor(drainSink(this.sink));
    }

    private async add(
        lane: number | undefined,
        kind: string,
        packet: EncodedPacket,
    ): Promise<void> {
        if (lane === undefined)
            throw new MediaForgeError(`This muxer has no ${kind} track`, 'INPUT');
        if (this.finished) throw new MediaForgeError('The muxer is finished', 'INPUT');
        this.lifetime.check();
        this.started[lane] = true;
        this.interleaver.push(lane, packet);
        await this.pace(lane);
    }

    addVideo(packet: EncodedPacket): Promise<void> {
        if (!this.described && this.videoLane !== undefined) {
            this.described = true;
            if (packet.colour) this.writer.setVideoColour?.(packet.colour);
        }
        return this.add(this.videoLane, 'video', { ...packet, trackType: 'video' });
    }

    addAudio(packet: EncodedPacket): Promise<void> {
        return this.add(this.audioLane, 'audio', { ...packet, trackType: 'audio' });
    }

    async encodeAudio(source: PcmSource, options: EncodeAudioOptions = {}): Promise<void> {
        const track = this.tracks.audio;
        const lane = this.audioLane;
        if (!track || lane === undefined)
            throw new MediaForgeError('This muxer has no audio track', 'INPUT');
        if (this.finished) throw new MediaForgeError('The muxer is finished', 'INPUT');
        // The encoder declares the priming and length. A file written as it goes takes them once
        // sound started only when it is Matroska (which trims the end in its last cluster) and the
        // priming was declared before.
        const fragmented = this.layout === 'fragmented';
        const writer = this.writer;
        let declared = false;
        let described = false;
        const open = (): boolean =>
            !fragmented || !this.started[lane] || (declared && !MP4_FAMILY.has(this.format));
        const output: OutputMuxer = {
            addVideoChunk: () => {
                throw new MediaForgeError('The audio encoder writes audio', 'ENCODE');
            },
            finalize: async () => undefined,
            setAudioCodecConfig: config => writer.setAudioCodecConfig?.(config),
            setAudioPriming: (priming, valid, ...rest) => {
                if (!open()) return;
                declared ||= !this.started[lane];
                writer.setAudioPriming?.(priming, valid, ...rest);
            },
            setValidSamples: samples => {
                if (open()) writer.setValidSamples?.(samples);
            },
            addAudioChunk: (chunk, config) => {
                // The encoder's configuration replaces the one the track declared (FLAC's
                // STREAMINFO without frame sizes and MD5), before the queued chunks reach the
                // writer, as in a conversion.
                if (config && !described) {
                    described = true;
                    writer.setAudioCodecConfig?.(config);
                }
                this.started[lane] = true;
                this.interleaver.push(lane, config ? { ...chunk, codecConfig: config } : chunk);
            },
        };
        // Opus codes 48 kHz, the rate in which the container counts its priming and length.
        const rate = track.codec.startsWith('opus') ? 48000 : track.sampleRate;
        const stated = source?.frames;
        if (stated !== undefined && (!Number.isSafeInteger(stated) || stated < 1))
            throw new MediaForgeError('frames must be a positive whole number', 'INPUT');
        const expected =
            stated === undefined
                ? undefined
                : Math.max(1, Math.round((stated * rate) / source.sampleRate));
        const { lifetime, stop } = partLifetime(options.signal, 'audio encoder');
        try {
            await new AudioTrackEncoder({
                signal: options.signal,
                codecPreference: options.codecPreference,
                bitrate: options.bitrate ?? DEFAULT_AUDIO_BITRATE,
                container: this.container,
                report: () => undefined,
                yield: () => this.pace(lane),
                warn: warner(options),
            }).encodePcm(
                source,
                { rate, channels: track.channels },
                options.start ?? 0,
                expected,
                track.codec,
                output,
                lifetime,
            );
        } finally {
            this.interleaver.end(lane);
            stop();
        }
    }

    async finish(): Promise<void> {
        if (this.finished) throw new MediaForgeError('The muxer is finished', 'INPUT');
        this.finished = true;
        try {
            for (const lane of [this.videoLane, this.audioLane])
                if (lane !== undefined) this.interleaver.end(lane);
            this.lifetime.check();
            await this.lifetime.waitFor(this.writer.finalize());
        } finally {
            this.stop();
        }
    }

    abort(reason?: unknown): void {
        if (this.finished) return;
        this.finished = true;
        this.stop();
        try {
            void Promise.resolve(this.sink.abort?.(reason)).catch(() => undefined);
        } catch {
            // The sink is being given up; a failing abort changes nothing.
        }
    }
}
