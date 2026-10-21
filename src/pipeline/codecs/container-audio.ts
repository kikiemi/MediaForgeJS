import { libraryAudioCodecs, type LibraryAudioCodec } from './router';
import { NO_PLUGINS, type MissingParts } from '../plugins/missing-parts';
import { encoderLoader } from '../../codecs/shared/lazy-audio-encoder';
import {
    MP3_DECODER_DELAY,
    MP3_ENCODER_DELAY,
} from '../../core/codec-config/audio/mpeg-audio-header';
import { parseFlacFrameHeader } from '../../core/codec-config/audio/flac-frame';
import type { ReplayablePcmSource } from '../../codecs/pcm/pcm-source';
import {
    createStreamingAudioOutput,
    type StreamingAudioCodecs,
} from './streaming-audio-output-core';
import type { PcmSampleFormat } from '../../codecs/pcm/encoder';

/** Codecs of container tracks the file encoders write when the host AudioEncoder cannot. */
export type ContainerAudioCodec = 'flac' | 'mp2' | 'mp3';

/** The AAC-LC encoder of the aac plugin. */
export type AacLcEncoderClass = NonNullable<StreamingAudioCodecs['aac']>;

/** A frame as the encoder codes it, timed as a read of the encoded file times it. */
export interface ContainerAudioPacket {
    readonly data: Uint8Array;
    readonly timestamp: number;
    readonly duration: number;
}

/** Samples of each MPEG-1 Layer II or III frame. */
const MPEG_FRAME_SAMPLES = 1152;

export interface ContainerAudioEncoder {
    /** The codecs of the installed library encoders: AAC-LC, FLAC, MP2 and MP3. */
    readonly codecs: readonly LibraryAudioCodec[];
    /** The AAC-LC encoder, loaded with its first use; it fails when `codecs` lacks 'aac'. */
    aacEncoder(): Promise<AacLcEncoderClass>;
    /**
     * The priming a read of a stream of these encoders states: for MP3 the LAME tag's encoder delay
     * with the decoder's own, none for MP2 (which carries no tag) and FLAC.
     */
    streamedPriming(codec: ContainerAudioCodec): number;
    /**
     * Encodes the whole source as FLAC, MP2 or MP3 (`bitrateKbps` applies to MP2 and MP3,
     * `sampleFormat`, 's24' for 24-bit samples and 16-bit by default, to FLAC), handing `onPacket`
     * each frame as it is coded, with the bytes, times and durations a read of its audio file
     * gives; resolves with the frames of the source and, for FLAC, the stream header of that file,
     * which only the end completes. `afterChunk` runs after each chunk the encoder takes.
     */
    stream(
        source: ReplayablePcmSource,
        codec: ContainerAudioCodec,
        options: {
            readonly bitrateKbps?: number;
            readonly sampleFormat?: PcmSampleFormat;
            readonly signal?: AbortSignal;
            readonly afterChunk?: () => Promise<void>;
        },
        onPacket: (packet: ContainerAudioPacket) => void,
    ): Promise<{ readonly inputFrames: number; readonly codecConfig?: Uint8Array }>;
}

/**
 * Container track encoding with the installed library encoders: AAC-LC streams into the container;
 * FLAC, MP2 and MP3 are either written as a raw audio file and indexed back into packets, or
 * streamed frame by frame as a read of that file gives them, so the container receives exactly what
 * the audio-file output would hold. `missing` names the plugin of an encoder that is not installed.
 */
export function createContainerAudioEncoder(
    codecs: StreamingAudioCodecs,
    missing: MissingParts = NO_PLUGINS,
): ContainerAudioEncoder {
    const output = createStreamingAudioOutput(codecs, missing);
    return Object.freeze({
        codecs: Object.freeze([...libraryAudioCodecs(codecs)]),
        async aacEncoder() {
            const installed = codecs.aac;
            if (!installed)
                throw missing.audioEncoder('aac', 'The AAC-LC encoder is not installed', 'ENCODE');
            const load = encoderLoader(installed) as (() => Promise<AacLcEncoderClass>) | undefined;
            return load ? load() : installed;
        },
        streamedPriming: codec => (codec === 'mp3' ? MP3_ENCODER_DELAY + MP3_DECODER_DELAY : 0),
        async stream(source, codec, options, onPacket) {
            const rate = source.sampleRate;
            let start = 0;
            const { inputFrames, header } = await output.streamReplayableFrames(
                source,
                codec,
                data => {
                    // A FLAC frame states its samples; an MPEG audio frame holds 1152.
                    const samples =
                        codec === 'flac'
                            ? parseFlacFrameHeader(data, 0)!.blockSize
                            : MPEG_FRAME_SAMPLES;
                    onPacket({ data, timestamp: start / rate, duration: samples / rate });
                    start += samples;
                },
                {
                    bitrateKbps: options.bitrateKbps,
                    sampleFormat: options.sampleFormat,
                    signal: options.signal,
                    afterPcmChunk: options.afterChunk,
                },
            );
            return header ? { inputFrames, codecConfig: header } : { inputFrames };
        },
    } satisfies ContainerAudioEncoder);
}
