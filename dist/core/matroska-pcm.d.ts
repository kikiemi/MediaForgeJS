import { type PcmFormat } from './pcm-format.js';
export declare function describeMatroskaPcm(track: {
    codec: string;
    sampleRate: number;
    channelCount: number;
    codecConfig?: Uint8Array;
}): (PcmFormat & {
    codecId: string;
}) | undefined;
export declare function matroskaPcmCodec(codecId: string, bits: number): string | undefined;
