export declare const MAX_FLAC_FRAME_HEADER_BYTES = 16;
export interface FlacFrameHeader {
    readonly headerLen: number;
    readonly blockSize: number;
    /** 0 = fixed-block frame number, 1 = variable-block sample number. */
    readonly blockingStrategy: 0 | 1;
    /** Decoded, canonically encoded frame/sample number. */
    readonly codedNumber: number;
    /** Undefined means that the frame inherits STREAMINFO's sample rate. */
    readonly sampleRate: number | undefined;
    readonly channelCount: number;
    /** Undefined means that the frame inherits STREAMINFO's bit depth. */
    readonly bitsPerSample: number | undefined;
}
/** FLAC frame CRC-16 (polynomial x^16 + x^15 + x^2 + 1). */
export declare function flacCrc16(data: Uint8Array): number;
/** Parses and CRC-checks one FLAC frame header. */
export declare function parseFlacFrameHeader(bytes: Uint8Array, offset: number): FlacFrameHeader | null;
