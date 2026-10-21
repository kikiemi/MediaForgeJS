import type { MediaDiagnostic } from '../../core/errors/diagnostics';
import type { ReplayablePcmSource } from '../../codecs/pcm/pcm-source';
import type { EncodedPacket } from '../../core/model/media';
import type { VideoPicture } from '../../core/contracts/stage';
import type { HostVideoEncoderOptions } from '../../codecs/webcodecs/video-options';
import type { CodecPreference } from '../api-types';
import type { MediaPacket } from '../packet-types';

// The parts of mediaforgejs/parts as their users see them: what they take and what they are. The
// code that opens them is in ./part-codecs.

/** What every part takes. */
export interface PartOptions {
    /** Stops the part: its pending and later calls fail with ABORT. */
    readonly signal?: AbortSignal;
    /** Receives the part's warnings, such as skipped damaged packets. */
    readonly onWarning?: (warning: MediaDiagnostic) => void;
}

/** The warning callback of a part. */
export function warner(options: PartOptions): (code: string, message: string) => void {
    return (code, message) =>
        options.onWarning?.(Object.freeze({ code, message, severity: 'warning' }));
}

/**
 * Sound as planar float samples: its rate, channels, a length estimate and the blocks of samples in
 * order.
 */
export interface PcmSource extends ReplayablePcmSource {
    /**
     * The frames the sound holds, when the source knows them exactly. A muxer then declares the
     * whole window (the priming and the length) before it writes, so a file written as it goes
     * trims both ends; without it the length shows only at the end, too late for that.
     */
    readonly frames?: number;
}

/** Turns encoded video packets into pictures. */
export interface VideoDecoderPart {
    /**
     * Decodes one packet of the track; packets go in in decode order, as `media.packets()` reads
     * them. Resolves the pictures that became ready, in presentation order; each picture is yours
     * to close.
     */
    decode(packet: EncodedPacket | MediaPacket): Promise<VideoPicture[]>;
    /**
     * The pictures the decoder still holds, after the last packet. Those the host decoder outputs
     * while it flushes may come as copies in memory: a GPU decoder lends few frames and outputs the
     * next only once one is closed.
     */
    flush(): Promise<VideoPicture[]>;
    /** Releases the decoder and the pictures it still holds. */
    close(): Promise<void>;
}

export interface VideoDecoderOptions extends PartOptions {
    /**
     * 'webcodecs' (default) tries the host VideoDecoder first, 'builtin' the library's decoders.
     */
    readonly codecPreference?: CodecPreference;
    /** Damaged packets fail the decode instead of being skipped with a warning. */
    readonly strict?: boolean;
}

/** Turns pictures into encoded video packets. */
export interface VideoEncoderPart {
    /**
     * The codec string the packets are in, such as 'vp8' or 'avc1.42001f', as a muxer declares it.
     */
    readonly codec: string;
    /**
     * Encodes a picture, which the encoder takes over and closes; pictures go in in presentation
     * order. Resolves the packets that became ready, in decode order; the first carries the decoder
     * configuration where the codec has one.
     */
    encode(picture: VideoPicture): Promise<EncodedPacket[]>;
    /** The packets the encoder still holds, after the last picture. */
    flush(): Promise<EncodedPacket[]>;
    close(): Promise<void>;
}

export interface VideoEncoderOptions extends PartOptions, HostVideoEncoderOptions {
    /**
     * A codec name such as 'h264', 'vp9' or 'av1', or a full codec string such as 'avc1.42001f'.
     */
    readonly codec: string;
    readonly width: number;
    readonly height: number;
    /** Pictures per second; default 30. */
    readonly framerate?: number;
    /** Bits per second; default the bitrate for the codec, size and frame rate. */
    readonly bitrate?: number;
    /** Seconds between keyframes; default 2. */
    readonly keyframeInterval?: number;
    /**
     * The container the packets go into, which decides the H.264 and HEVC bitstream format; default
     * 'mp4'.
     */
    readonly container?: string;
}

/** The video track of a muxer. */
export interface MuxerVideoTrack {
    /** The codec string of the packets, as a video encoder reports it. */
    readonly codec: string;
    readonly width: number;
    readonly height: number;
    /** Pictures per second; 0 or omitted when unknown. */
    readonly framerate?: number;
    /** The decoder configuration; omitted takes it from the first packet. */
    readonly codecConfig?: Uint8Array;
    /** Counter-clockwise display rotation in degrees. */
    readonly rotation?: number;
    readonly language?: string;
    readonly name?: string;
}

/** The audio track of a muxer. */
export interface MuxerAudioTrack {
    /** A codec name such as 'aac', 'opus' or 'mp3', or a codec string. */
    readonly codec: string;
    readonly sampleRate: number;
    readonly channels: number;
    /**
     * The decoder configuration; omitted takes it from the first packet or from the audio encoder.
     */
    readonly codecConfig?: Uint8Array;
    readonly language?: string;
    readonly name?: string;
}

export interface MuxerOptions extends PartOptions {
    readonly video?: MuxerVideoTrack;
    readonly audio?: MuxerAudioTrack;
    readonly title?: string;
}

export interface EncodeAudioOptions extends PartOptions {
    /** Bits per second of lossy codecs; default 128 000. */
    readonly bitrate?: number;
    /**
     * 'webcodecs' (default) tries the host AudioEncoder first, 'builtin' the library's encoders.
     */
    readonly codecPreference?: CodecPreference;
    /** Seconds on the output timeline of the first sample; default 0. */
    readonly start?: number;
}

/**
 * Writes packets into a container file: a video track, an audio track or both, interleaved by time
 * as they arrive. Feed the tracks side by side (encodeAudio() beside the video loop, say) so
 * neither runs far ahead.
 */
export interface Muxer {
    /** The container format, such as 'webm'. */
    readonly format: string;
    /**
     * 'standard' writes the index at the end (MP4 into a sink that can patch), 'fragmented' as it
     * goes.
     */
    readonly layout: 'standard' | 'fragmented';
    /**
     * Adds a video packet; packets go in in decode order, the first carrying the decoder
     * configuration.
     */
    addVideo(packet: EncodedPacket): Promise<void>;
    /** Adds an audio packet; packets go in in order. */
    addAudio(packet: EncodedPacket): Promise<void>;
    /**
     * Encodes the sound of `source` into the audio track, at the track's rate and channels: the
     * host AudioEncoder, else the library's AAC, FLAC, MP2 or MP3 encoder. Packets reach the muxer
     * as they are encoded; resolves when the sound ends. A source that states its `frames` has its
     * whole window declared first; one of unknown length (a live source) declares the priming
     * first and the length at the end, which a fragmented MP4 cannot take any more.
     */
    encodeAudio(source: PcmSource, options?: EncodeAudioOptions): Promise<void>;
    /** Writes what is left and the container's closing structures, and closes the sink. */
    finish(): Promise<void>;
    /** Stops writing; the sink is aborted where it can be. */
    abort(reason?: unknown): void;
}
