import { audioEncoderOrder, builtinAudioEncoding } from './router';
import { bitrateKbps } from './audio-settings';
import type { CodecPreference } from '../api-types';
import type { OutputMuxer } from '../../core/contracts/writer';
import { isPcmOutputMuxer } from '../../formats/audio-files/pcm-writer';
import { EncodeError } from '../../core/errors/errors';
import { encodeG711, isG711Codec } from '../../codecs/pcm/g711';
import { encodePcm } from '../../codecs/pcm/encoder';
import type { ReplayablePcmSource } from '../../codecs/pcm/pcm-source';
import { AudioStageChain, streamOf } from '../../stages/chain';
import { remixStage } from '../../stages/audio';
import { AacTrackEncoder } from './aac-track-encoder';
import type { ContainerAudioCodec, ContainerAudioEncoder } from './container-audio';
import { normalizePcmSource } from '../../codecs/pcm/pcm-source';
import { CodecLifetime } from '../../codecs/shared/codec-lifetime';
import { streamHostAudio } from './host-audio-stream';
import type { PcmSampleFormat } from '../../codecs/pcm/encoder';
import { declaredFlacHeader } from '../../core/codec-config/audio/flac-frame';

/**
 * Frames of silence handed to the encoder at a time when the sound ends before its declared length.
 */
const SILENCE_BLOCK_FRAMES = 4096;

/**
 * Whether a built-in stream declares its window before the first packet, where it cannot depend on
 * the end of the sound. Completed to `expectedFrames`, MP3 states its priming and the expected
 * length; MP2 states that length when its frames of 1152 samples cannot end there exactly
 * (otherwise only the end shows whether a window is declared at all); FLAC is fitted to a length it
 * states ahead (see streamContainer).
 */
function streamsAhead(codec: ContainerAudioCodec, expectedFrames: number): boolean {
    return expectedFrames > 0 && (codec !== 'mp2' || expectedFrames % 1152 !== 0);
}

/**
 * `source`, completed with silence to `frames` frames when it ends before them, and with `cut`,
 * ending there.
 */
function completedTo(
    source: ReplayablePcmSource,
    frames: number,
    cut: boolean,
): ReplayablePcmSource {
    return {
        ...source,
        ...(cut ? { estimatedFrames: frames } : {}),
        async *chunks(signal) {
            let done = 0;
            for await (const planes of source.chunks(signal)) {
                const count = planes[0]?.length ?? 0;
                if (cut && done + count > frames) {
                    if (done < frames) yield planes.map(plane => plane.subarray(0, frames - done));
                    done = frames;
                } else {
                    done += count;
                    yield planes;
                }
            }
            for (let missing = frames - done; missing > 0;) {
                const count = Math.min(missing, SILENCE_BLOCK_FRAMES);
                missing -= count;
                yield Array.from({ length: source.channels }, () => new Float32Array(count));
            }
        },
    };
}

/** What an audio track encode reports to and takes from its run. */
export interface AudioEncodeHost {
    readonly signal?: AbortSignal;
    /**
     * 'webcodecs' (default) runs host codecs first when they support the stream; 'builtin' prefers
     * the library's.
     */
    readonly codecPreference?: CodecPreference;
    /** Bits per second of lossy output. */
    readonly bitrate: number;
    /**
     * FLAC samples: 's24' keeps a deeper source's 24 bits, which the built-in encoder writes (the
     * host AudioEncoder chooses its own depth); default 16-bit.
     */
    readonly sampleFormat?: PcmSampleFormat;
    /**
     * The library's AAC-LC, FLAC, MP2 and MP3 track encoders that are installed; omitted leaves the
     * tracks to the host AudioEncoder.
     */
    readonly container?: ContainerAudioEncoder;
    /** Called as encoding proceeds. */
    report(): void;
    /** Waits for the output side between work units. */
    yield(): Promise<void>;
    /** Receives encoding warnings such as AUDIO_ENCODER_FALLBACK. */
    warn(code: string, message: string): void;
}

/** Encodes PCM tracks into a container with the first usable encoder of the preference order. */
export class AudioTrackEncoder {
    constructor(private readonly host: AudioEncodeHost) {}

    /**
     * Encodes PCM, mapped to `target`, into the muxer's audio track from `startOffset` seconds with
     * the first usable encoder of the preference order: a supporting host AudioEncoder, the aac
     * plugin's AAC-LC encoder, the FLAC, MP2 and MP3 encoders, G.711 or PCM. `expectedFrames`
     * declares the presented length to the container up front; undefined (a live source) declares
     * the length encoded at the end, and every encoder then streams. The caller owns `lifetime`.
     */
    async encodePcm(
        pcm: ReplayablePcmSource,
        target: { rate: number; channels: number },
        startOffset: number,
        expectedFrames: number | undefined,
        outCodec: string,
        muxer: OutputMuxer,
        lifetime: CodecLifetime,
    ): Promise<void> {
        // The sound reaches the encoder through the remix stage: channel mapping and resampling to
        // `target`.
        const pump = async (
            consume: (planes: readonly Float32Array[]) => void | Promise<void>,
        ): Promise<number> => {
            let frames = 0;
            const chain = new AudioStageChain(
                [remixStage({ sampleRate: target.rate, channels: target.channels })],
                streamOf(pcm),
                async planes => {
                    frames += planes[0]!.length;
                    await consume(planes);
                },
            );
            try {
                this.host.report();
                let units = 0;
                for await (const planes of pcm.chunks(this.host.signal)) {
                    lifetime.check();
                    await chain.push(planes);
                    lifetime.check();
                    if ((++units & 15) === 0) {
                        this.host.report();
                        await lifetime.waitFor(this.host.yield());
                    }
                }
                lifetime.check();
                await chain.finish();

                // Sound that ends before the declared length (a truncated or short last packet) is
                // completed with silence: the container states that length before the first packet.
                for (let missing = (expectedFrames ?? 0) - frames; missing > 0;) {
                    const count = Math.min(missing, SILENCE_BLOCK_FRAMES);
                    missing -= count;
                    frames += count;
                    await consume(
                        Array.from({ length: target.channels }, () => new Float32Array(count)),
                    );
                    lifetime.check();
                }
                return frames;
            } finally {
                chain.close();
            }
        };
        if (outCodec === 'pcm' || isG711Codec(outCodec)) {
            // AVI takes planar PCM; MP4 and MOV take 16-bit little-endian packets ('sowt', 'ipcm').
            let written = 0;
            const frames = await pump(planes => {
                const count = planes[0]?.length ?? 0;
                const timestamp = startOffset + written / target.rate;
                if (outCodec === 'pcm' && isPcmOutputMuxer(muxer))
                    muxer.addPcmPlanarChunk(planes, target.rate, timestamp);
                else
                    muxer.addAudioChunk({
                        data:
                            outCodec === 'pcm'
                                ? encodePcm(planes)
                                : encodeG711(planes, { codec: outCodec }),
                        timestamp,
                        duration: count / target.rate,
                        isKeyframe: true,
                        trackType: 'audio',
                    });
                written += count;
            });
            lifetime.check();
            if (frames === 0) throw new EncodeError('Audio pipeline produced no decoded frames');
            return;
        }
        const encoding = builtinAudioEncoding(
            outCodec,
            target.rate,
            target.channels,
            this.host.container?.codecs ?? [],
        );
        const builtinAac = encoding === 'aac';
        const container = encoding === 'container' ? (outCodec as ContainerAudioCodec) : undefined;
        const builtin = encoding !== undefined;
        const order = audioEncoderOrder(
            outCodec,
            builtin,
            this.host.codecPreference,
            this.host.sampleFormat,
        );
        const hostConfig: AudioEncoderConfig = {
            codec: outCodec,
            sampleRate: target.rate,
            numberOfChannels: target.channels,
            bitrate: this.host.bitrate,
        };
        const encodeWithHost = (fallback: boolean): Promise<boolean> =>
            streamHostAudio(
                {
                    config: hostConfig,
                    muxer,
                    startOffset,
                    expectedFrames,
                    signal: this.host.signal,
                    parent: lifetime,
                    fallback,
                    warn: (code, message) => this.host.warn(code, message),
                },
                (consume, recordFailure) =>
                    pump(consume).catch(error => {
                        throw recordFailure(error);
                    }),
            );
        if (order[0] === 'webcodecs' && (await lifetime.waitFor(encodeWithHost(builtin)))) return;
        if (builtinAac) {
            const Encoder = await lifetime.waitFor(this.host.container!.aacEncoder());
            const bridge = new AacTrackEncoder(
                Encoder,
                target.rate,
                target.channels,
                bitrateKbps(this.host.bitrate),
                muxer,
                startOffset,
                expectedFrames,
            );
            const frames = await pump(planes => bridge.push(planes));
            lifetime.check();
            bridge.finish(frames);
            return;
        }
        // FLAC, MP2 and MP3 stream as they are coded: a stated length is declared ahead, an
        // unknown one (a live source) at the end.
        if (container) {
            const source = normalizePcmSource(pcm, target.rate, target.channels);
            if (expectedFrames === undefined)
                await this.streamOpenContainer(source, container, startOffset, muxer, lifetime);
            else
                await this.streamContainer(
                    source,
                    container,
                    startOffset,
                    expectedFrames,
                    muxer,
                    lifetime,
                );
            return;
        }
        throw new EncodeError(`No streaming audio encoder can produce '${outCodec}'`);
    }

    /**
     * Encodes FLAC, MP2 or MP3 into the muxer frame by frame as the encoder codes them, from
     * `startOffset` seconds, with the window declared before the first packet: the priming a read
     * of the stream states and the expected length. MP2 and MP3 complete the sound with silence to
     * that length; MP2 of whole frames declares a window only once the end shows it needs one.
     * FLAC codes exactly the longer of that length and the source's own (a window cuts the rest),
     * and declares its STREAMINFO ahead with the frame sizes and MD5 unknown, then the encoder's at
     * the end, which the muxer writes over the first where the sink can patch. The packets are
     * those a read of the encoder's audio file gives, and the window the one it states.
     */
    private async streamContainer(
        source: ReplayablePcmSource,
        codec: ContainerAudioCodec,
        startOffset: number,
        expectedFrames: number,
        muxer: OutputMuxer,
        lifetime: CodecLifetime,
    ): Promise<void> {
        const { sampleFormat } = this.host;
        const flac = codec === 'flac';
        const frames = flac ? Math.max(expectedFrames, source.estimatedFrames) : expectedFrames;
        const ahead = streamsAhead(codec, expectedFrames);
        const priming = this.host.container!.streamedPriming(codec);
        const declare = (): void => {
            if (muxer.setAudioPriming) muxer.setAudioPriming(priming, expectedFrames);
            else muxer.setValidSamples?.(expectedFrames);
        };
        if (ahead && (!flac || frames > expectedFrames)) declare();
        if (flac) {
            const bits = sampleFormat === 's24' ? 24 : 16;
            const { sampleRate, channels } = source;
            muxer.setAudioCodecConfig?.(declaredFlacHeader(sampleRate, channels, bits, frames));
        }
        let chunks = 0;
        let coded = 0;
        const { codecConfig } = await lifetime.waitFor(
            this.host.container!.stream(
                completedTo(source, frames, flac),
                codec,
                {
                    bitrateKbps: bitrateKbps(this.host.bitrate),
                    sampleFormat,
                    signal: this.host.signal,
                    afterChunk: async () => {
                        if ((++chunks & 15) !== 0) return;
                        this.host.report();
                        await lifetime.waitFor(this.host.yield());
                    },
                },
                packet => {
                    coded += Math.round(packet.duration * source.sampleRate);
                    muxer.addAudioChunk({
                        data: packet.data,
                        timestamp: startOffset + packet.timestamp,
                        duration: packet.duration,
                        isKeyframe: true,
                        trackType: 'audio',
                    });
                },
            ),
        );
        lifetime.check();
        if (codecConfig) muxer.setAudioCodecConfig?.(codecConfig);
        if (!ahead && coded > expectedFrames) declare();
    }

    /**
     * Encodes FLAC, MP2 or MP3 of a sound whose length shows only at its end into the muxer frame
     * by frame as the encoder codes them, from `startOffset` seconds, as host encoders of a live
     * source do: MP2 and MP3 declare their priming before the first packet and the window once the
     * sound ends; FLAC declares its STREAMINFO ahead with the length, frame sizes and MD5 unknown,
     * then the encoder's at the end. The packets and the window are streamContainer()'s.
     */
    private async streamOpenContainer(
        source: ReplayablePcmSource,
        codec: ContainerAudioCodec,
        startOffset: number,
        muxer: OutputMuxer,
        lifetime: CodecLifetime,
    ): Promise<void> {
        const { sampleFormat } = this.host;
        const { sampleRate, channels } = source;
        const priming = this.host.container!.streamedPriming(codec);
        if (codec === 'flac') {
            const bits = sampleFormat === 's24' ? 24 : 16;
            muxer.setAudioCodecConfig?.(declaredFlacHeader(sampleRate, channels, bits, 0));
        } else muxer.setAudioPriming?.(priming, undefined);
        let chunks = 0;
        let coded = 0;
        const { inputFrames, codecConfig } = await lifetime.waitFor(
            this.host.container!.stream(
                source,
                codec,
                {
                    bitrateKbps: bitrateKbps(this.host.bitrate),
                    sampleFormat,
                    signal: this.host.signal,
                    afterChunk: async () => {
                        if ((++chunks & 15) !== 0) return;
                        this.host.report();
                        await lifetime.waitFor(this.host.yield());
                    },
                },
                packet => {
                    coded += Math.round(packet.duration * sampleRate);
                    muxer.addAudioChunk({
                        data: packet.data,
                        timestamp: startOffset + packet.timestamp,
                        duration: packet.duration,
                        isKeyframe: true,
                        trackType: 'audio',
                    });
                },
            ),
        );
        lifetime.check();
        if (inputFrames === 0 || coded === 0)
            throw new EncodeError(`The built-in ${codec} encoder produced no packets`);
        if (codecConfig) muxer.setAudioCodecConfig?.(codecConfig);
        if (priming > 0 || inputFrames < coded) {
            if (muxer.setAudioPriming) muxer.setAudioPriming(priming, inputFrames);
            else muxer.setValidSamples?.(inputFrames);
        }
    }
}
