import type { ContainerFormat, PcmAudioBuffer } from '../types/media.js';
import type { MediaForgeJSConfig } from '../core/converter-config.js';
import { type MP4TrackInfo, type MP4DemuxResult } from '../demux/mp4-demuxer.js';
/** Bounded/native audio decoding branch used by MediaForgeConverter. */
export declare class ConverterAudioDecoder {
    private readonly config;
    private readonly mpegAudioDecoder;
    constructor(config: MediaForgeJSConfig);
    selectAudioTrack(result: MP4DemuxResult): MP4TrackInfo;
    decodeDemuxedAudioTrack(file: File | Blob, srcA: MP4TrackInfo): Promise<PcmAudioBuffer>;
    decodeAudioToBuffer(file: File | Blob, inputFmt?: ContainerFormat): Promise<PcmAudioBuffer>;
    private ensureMediaInputMime;
    private decodeAacUnitsSelfHosted;
    private placeDecodedByTimestamps;
    private sourceAudioPriming;
    private applySourceAudioWindow;
    private decodeAacTrackSelfHosted;
    private decodeAdtsSelfHosted;
    private decodeAdtsViaWebCodecs;
    private static acceleratedCaptureVerdict;
    private acceleratedCaptureSupported;
    private decodeAudioViaMediaElement;
}
