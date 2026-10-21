import { CodecLifetime } from '../../codecs/shared/codec-lifetime';
import type { AudioOutputMuxer } from '../../core/contracts/writer';
import { MediaForgeError } from '../../core/errors/errors';
import { mp4aAudioObjectType } from '../../core/model/codec-strings';
import { HostAudioEncoder, hostAacPriming } from '../../codecs/webcodecs/audio';
import { isCodecFailure } from '../../codecs/webcodecs/codec';
import { hostSupports } from '../../codecs/webcodecs/support';

/** An encoder's first configuration record is an OpusHead (RFC 7845 section 5.1). */
function isOpusHead(config: Uint8Array): boolean {
    return config.length >= 19 && String.fromCharCode(...config.subarray(0, 8)) === 'OpusHead';
}

export interface HostAudioStream {
    readonly config: AudioEncoderConfig;
    readonly muxer: AudioOutputMuxer;
    /** Seconds of the first encoded sample on the output timeline. */
    readonly startOffset: number;
    /**
     * Presented frames the container declares before encoding; undefined declares them at the end
     * (live sources).
     */
    readonly expectedFrames?: number;
    readonly signal?: AbortSignal;
    /** The caller's lifetime, which also receives failures that no other encoder takes over. */
    readonly parent?: CodecLifetime;
    /**
     * True when a host failure before any output returns false so another encoder can write the
     * track.
     */
    readonly fallback: boolean;
    /** Receives AUDIO_ENCODER_FALLBACK when a host that took the configuration fails so. */
    readonly warn?: (code: string, message: string) => void;
}

/**
 * Streams the PCM that `pump` hands to `consume` through a host AudioEncoder into `muxer`,
 * declaring the AAC priming or the OpusHead pre-skip. Resolves true once the host encoded the
 * sound; false when the host does not support the configuration or, with `fallback`, fails before
 * any output, which it reports as AUDIO_ENCODER_FALLBACK: the library's encoder takes over.
 */
export async function streamHostAudio(
    stream: HostAudioStream,
    pump: (
        consume: (planes: readonly Float32Array[]) => Promise<void>,
        recordFailure: (error: unknown) => Error,
    ) => Promise<number>,
): Promise<boolean> {
    const { config, muxer, startOffset, expectedFrames, parent, fallback } = stream;
    const fellBack = (): false => {
        stream.warn?.(
            'AUDIO_ENCODER_FALLBACK',
            `Host AudioEncoder failed for ${config.codec}; the built-in encoder takes over`,
        );
        return false;
    };
    const lifetime = new CodecLifetime(
        stream.signal,
        new MediaForgeError('Host audio encoder stopped', 'ENCODE'),
    );
    let encoder: HostAudioEncoder | undefined;
    let stopped = false;
    const allowsFallback = (error: Error): boolean =>
        fallback && !!encoder && encoder.packets === 0 && error === encoder.hostFailure;
    const recordFailure = (caught: unknown): Error => {
        const error = lifetime.record(caught);
        if (!stopped && !allowsFallback(error)) parent?.record(error);
        return error;
    };
    try {
        lifetime.check();
        if (config.codec === 'pcm') return false;
        if (!(await lifetime.waitFor(hostSupports('AudioEncoder', config)))) return false;
        let described = false;

        // Leading samples the decoder drops: the AAC encoder delay, or the pre-skip of an OpusHead.
        // The host's AAC delay is measured only for a muxer that declares it.
        let priming =
            mp4aAudioObjectType(config.codec) === null
                ? undefined
                : muxer.setAudioPriming
                  ? await lifetime.waitFor(hostAacPriming(config))
                  : 1024;
        // Seconds added to the packet times so that each is the time of its first decoded sample,
        // as packets read from a file are; muxers subtract the pre-skip from there (Matroska's
        // CodecDelay, the MP4 edit, Ogg's granules).
        let shift = 0;
        try {
            encoder = new HostAudioEncoder(config, lifetime, (packet, description) => {
                if (description && !described) {
                    described = true;
                    if (isOpusHead(description)) {
                        priming = description[10]! | (description[11]! << 8);
                        // Chromium stamps the first packet with the first input time, though its
                        // decoded sound starts with the pre-skip.
                        if (Math.abs(packet.timestamp - startOffset) < 1e-4)
                            shift = -priming / 48000;
                        muxer.setAudioPriming?.(priming, expectedFrames);
                    }
                }
                muxer.addAudioChunk(
                    shift ? { ...packet, timestamp: packet.timestamp + shift } : packet,
                    description,
                );
            });
        } catch (error) {
            if (fallback && isCodecFailure(error)) return fellBack();
            throw error;
        }
        // A live source's length is declared when it ends.
        if (priming !== undefined) muxer.setAudioPriming?.(priming, expectedFrames);
        if (priming !== undefined && expectedFrames !== undefined)
            muxer.setValidSamples?.(expectedFrames);
        let inputFrames = 0;
        const active = encoder;
        const consume = async (planes: readonly Float32Array[]): Promise<void> => {
            lifetime.check();
            const frames = planes[0]?.length ?? 0;
            if (frames === 0) return;
            await active.encodePlanes(planes, startOffset + inputFrames / config.sampleRate);
            inputFrames += frames;
        };
        const frames = await lifetime.waitFor(pump(consume, recordFailure));
        lifetime.check();
        await active.flush();
        if (active.packets === 0) return fallback ? fellBack() : false;
        if (expectedFrames === undefined && priming !== undefined)
            muxer.setAudioPriming?.(priming, frames);
        muxer.setValidSamples?.(frames);
        lifetime.check();
        return true;
    } catch (caught) {
        const error = recordFailure(caught);
        if (allowsFallback(error)) return fellBack();
        throw error;
    } finally {
        stopped = true;
        lifetime.stop();
        encoder?.close();
    }
}
