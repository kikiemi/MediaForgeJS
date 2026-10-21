import type { EncodedPacket } from '../model/media';
import type { Sample, TrackInfo } from '../model/track';
import type { DecodedVideoFrame, PlanarVideoFrame } from './picture';

/**
 * The decoder contracts: the software video decoders that fill the gaps of the host VideoDecoder,
 * the application video decoders that replace it for their codecs, and the software audio
 * decoders.
 */

/** The options of the decode functions of mediaforgejs/codecs that decode a whole stream. */
export interface DecodeOptions {
    /** Stops the decode, which then rejects with ABORT. */
    readonly signal?: AbortSignal;
}

export interface BuiltinVideoDecoderConfig {
    /** Track codec string as demuxed, for example mp4v.20.9, mp4v.61 or mp4v.6a. */
    readonly codec: string;
    /** Out-of-band configuration: sequence header, VOL header or decoder-specific info. */
    readonly description?: Uint8Array;
    readonly codedWidth?: number;
    readonly codedHeight?: number;
    /** Receives the diagnostics of concealed or skipped damage; without it they are dropped. */
    readonly onWarning?: (message: string) => void;
}

/**
 * Synchronous software decoder. Packets arrive in decode order, one coded picture each; frames
 * leave in presentation order. A damaged packet is concealed or skipped with a diagnostic rather
 * than ending the stream.
 */
export interface BuiltinVideoDecoder {
    decode(chunk: EncodedPacket): readonly PlanarVideoFrame[];
    /** Returns the pictures still held for reordering. */
    flush(): readonly PlanarVideoFrame[];
    /** Drops reference pictures; decoding resumes at the next keyframe. */
    reset(): void;
    close(): void;
}

export interface BuiltinVideoCodec {
    readonly id: string;
    /** Answers from the codec string alone, without loading the decoder. */
    supports(codec: string): boolean;
    /** A decoder for one track; a plugin may load its implementation first and resolve with it. */
    create(config: BuiltinVideoDecoderConfig): BuiltinVideoDecoder | Promise<BuiltinVideoDecoder>;
}

export interface VideoDecoderConfig {
    readonly codec: string;
    readonly width: number;
    readonly height: number;
    readonly description?: Uint8Array;
    readonly signal?: AbortSignal;
    readonly maxPixels?: number;
}

export interface VideoCodecDecoder {
    /** One completed frame per packet; delayed-output codecs use the native WebCodecs bridge. */
    decode(packet: EncodedPacket): DecodedVideoFrame | Promise<DecodedVideoFrame>;
    flush?(): void | Promise<void>;
    close(): void | Promise<void>;
}

export type EncodedAudioSampleReader = (
    sample: Sample,
    index: number,
    signal?: AbortSignal,
) => Promise<Uint8Array>;

/**
 * One coded packet in, zero or more planar PCM work units out; state carries across packets until
 * reset().
 */
export interface PacketDecoder {
    decode(packet: Uint8Array): Iterable<readonly Float32Array[]>;
    /**
     * Packet-loss concealment of `frames` missing samples in place of silence, continuing the
     * decoder state.
     */
    conceal?(frames: number): Iterable<readonly Float32Array[]>;
    /** Samples the decoder still holds after the last packet (a resampler's delay line). */
    flush?(): Iterable<readonly Float32Array[]>;
    reset(): void;
}

/**
 * A decoder's report of how it adapted a stream (a code and a message), delivered at most once per
 * code and source.
 */
export type AudioDecoderWarning = (code: string, message: string) => void;

/** The library's decoder for one track configuration. */
export interface BuiltinAudioCodec {
    /** A fresh packet decoder for one decoding pass; a plugin may load its implementation first. */
    readonly create: (warn?: AudioDecoderWarning) => PacketDecoder | Promise<PacketDecoder>;
    /**
     * WAVE speaker mask of the decoded planes; omitted means the default layout for the channel
     * count.
     */
    readonly channelMask?: number;
    /**
     * Coded frames and presentation window when the codec defines them instead of the track's trim
     * metadata.
     */
    readonly window?: { readonly head: number; readonly valid: number; readonly frames: number };
    /**
     * Decoder start-up frames (Opus pre-skip) discarded when the track states no codec delay,
     * priming or edit.
     */
    readonly preRoll?: number;
    /**
     * Coded frames of the first packet that no decoder outputs (the Vorbis first block only primes
     * the overlap); the track's leading trim counts them, so it shrinks by this much on the decoded
     * samples.
     */
    readonly unoutputLead?: number;
}

/**
 * A software audio decoder a plugin contributes, used when the host AudioDecoder is missing or
 * rejects the track (or first, with codecPreference 'builtin').
 */
export interface BuiltinAudioDecoder {
    readonly id: string;
    /** Codec families decoded, as track codecs name them: 'mp3', 'flac', 'opus'. */
    readonly codecs: readonly string[];
    /**
     * The decoder of one track; may load its implementation on first use and reject a configuration
     * it cannot take.
     */
    create(track: TrackInfo): BuiltinAudioCodec | Promise<BuiltinAudioCodec>;
}
