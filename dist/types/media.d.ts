export type ImageResizeMethod = 'nearest' | 'bilinear' | 'lanczos3';
export type ImageFitMode = 'fill' | 'inside' | 'scale-down';
export type GifDitherMode = 'floyd-steinberg' | 'none';
/** Accepted input bytes for conversion and format detection. */
export type MediaInput = File | Blob | ArrayBuffer | ArrayBufferView;
/** Every container / image format the library can read or write. */
export type ContainerFormat = 'mp4' | 'mov' | 'webm' | 'mkv' | 'avi' | 'flv' | '3gp' | 'ts' | 'm4a' | 'm4v' | 'ogg' | 'mp3' | 'wav' | 'aiff' | 'au' | 'caf' | 'flac' | 'aac' | 'mp2' | 'mp1' | 'gif' | 'apng' | 'png' | 'jpeg' | 'webp' | 'bmp' | 'tiff' | 'ico';
/** Chunk kind; 'subtitle' carries mkv/webm text cues through addSubtitleChunk. */
export type TrackType = 'video' | 'audio' | 'subtitle';
export interface MatroskaPassThrough {
    chapters?: Uint8Array;
    attachments?: Uint8Array;
    title?: string;
    /** Complete EBML Tags element; scoped targets retain their original unsigned 64-bit UIDs. */
    tags?: Uint8Array;
}
export interface PcmAudioBuffer {
    /** Sample rate in Hz. */
    readonly sampleRate: number;
    /** Frame count per channel. */
    readonly length: number;
    readonly numberOfChannels: number;
    /** Duration in seconds. */
    readonly duration: number;
    /** Returns the PCM samples for one channel. */
    getChannelData(channel: number): Float32Array;
}
/** One encoded sample (video frame, audio packet, or subtitle cue). */
export interface EncodedChunk {
    readonly data: Uint8Array;
    /** VP8/VP9 alpha bitstream carried by Matroska BlockAdditional ID 1. */
    readonly alphaData?: Uint8Array;
    /** Presentation timestamp in seconds. */
    readonly timestamp: number;
    /** Duration in seconds. */
    readonly duration: number;
    /** True for sync samples. */
    readonly isKeyframe: boolean;
    readonly trackType: TrackType;
    /** Decode timestamp in seconds (B-frame streams). */
    readonly decodeTimestamp?: number;
    /** Presentation minus decode timestamp, in seconds. */
    readonly compositionTimeOffset?: number;
}
/** Minimal track description used when configuring muxers from demux results. */
export interface TrackDescriptor {
    readonly id: number;
    readonly type: TrackType;
    /** Original Matroska TrackUID, independent of the numeric track id. */
    readonly matroskaTrackUid?: bigint;
    /** Track selection dispositions; undefined when the source does not declare them. */
    readonly default?: boolean;
    readonly forced?: boolean;
    readonly name?: string;
    readonly title?: string;
    readonly commentary?: boolean;
    /** True when video carries a separate VP8/VP9 alpha bitstream. */
    readonly alphaMode?: boolean;
    /** Codec string (e.g. 'avc1.42C01E', 'mp4a.40.2'). */
    readonly codec: string;
    /** Frame width in pixels. */
    readonly width?: number;
    /** Frame height in pixels. */
    readonly height?: number;
    /** Display (aspect-corrected) width in pixels. */
    readonly displayWidth?: number;
    /** Display (aspect-corrected) height in pixels. */
    readonly displayHeight?: number;
    /** Pixel aspect ratio numerator. */
    readonly pixelAspectRatioNum?: number;
    /** Pixel aspect ratio denominator. */
    readonly pixelAspectRatioDen?: number;
    /** Frames per second (0 = unknown). */
    readonly framerate?: number;
    /** Sample rate in Hz. */
    readonly sampleRate?: number;
    /** Channel count, when known. */
    readonly channelCount?: number;
    /** Decoder configuration record (avcC / AudioSpecificConfig / ...). */
    codecConfig?: Uint8Array;
}
/** Decoded Converter/Pipeline outputs; packet-copy outputs are defined by RemuxOptions. */
export type OutputContainerFormat = Exclude<ContainerFormat, 'mp1'>;
