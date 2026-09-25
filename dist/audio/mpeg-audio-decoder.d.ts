import type { PcmAudioBuffer } from '../types/media.js';
import { type MpegAudioInputFormat } from '../core/mpeg-audio-header.js';
export { parseMpegAudioHeader, type MpegAudioInputFormat, type ParsedMpegAudioHeader } from '../core/mpeg-audio-header.js';
export interface MpegAudioDecoderConfig {
    readonly onProgress?: (progress: number, message: string) => void;
    readonly signal?: AbortSignal;
}
export declare class MpegAudioDecoder {
    private readonly config;
    constructor(config?: MpegAudioDecoderConfig);
    decode(file: Blob, format: MpegAudioInputFormat): Promise<PcmAudioBuffer | null>;
    private decodeLayer12;
    private reportProgress;
    private tryDecodeWithCodec;
}
