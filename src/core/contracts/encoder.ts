import type { EncodedPacket } from '../model/media';
import type { RgbaVideoFrame } from './picture';
import type { VideoCodecDecoder, VideoDecoderConfig } from './decoder';

/** The encoder contracts: application video encoders and the codecs that decode and encode. */

export interface VideoEncoderConfig extends Omit<VideoDecoderConfig, 'description'> {
    readonly bitrate?: number;
    readonly framerate?: number;
}

export interface VideoCodecEncoder {
    /** A completed encoded packet, with optional initialization bytes for the muxer. */
    encode(
        frame: RgbaVideoFrame,
    ):
        | (EncodedPacket & { readonly codecConfig?: Uint8Array })
        | Promise<EncodedPacket & { readonly codecConfig?: Uint8Array }>;
    flush?(): void | Promise<void>;
    close(): void | Promise<void>;
}

/** Application-supplied instance; factories and support checks are never registered globally. */
export interface VideoCodecProvider {
    readonly id: string;
    supportsDecode(codec: string): boolean;
    supportsEncode(codec: string): boolean;
    createDecoder(config: VideoDecoderConfig): VideoCodecDecoder | Promise<VideoCodecDecoder>;
    createEncoder(config: VideoEncoderConfig): VideoCodecEncoder | Promise<VideoCodecEncoder>;
}
