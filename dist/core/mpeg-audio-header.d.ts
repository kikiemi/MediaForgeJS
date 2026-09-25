export type MpegAudioInputFormat = 'mp1' | 'mp2' | 'mp3';
export interface ParsedMpegAudioHeader {
    readonly format: MpegAudioInputFormat;
    readonly sampleRate: number;
    readonly channels: number;
    readonly frameLength: number;
    readonly samplesPerFrame: number;
}
/** Parses the four-byte MPEG audio header without reading beyond `data`. */
export declare function parseMpegAudioHeader(data: Uint8Array, offset: number): ParsedMpegAudioHeader | null;
export declare function isMpegAudioTrailerHeader(data: Uint8Array, remainingBytes: number): boolean;
