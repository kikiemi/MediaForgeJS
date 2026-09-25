export declare const ANALYSIS_WIN: Float64Array;
export declare const MPEG1_SAMPLE_RATES: readonly number[];
export declare function analysisFilterbank(pcm: Float32Array, off: number, stride: number, vbuf: Float64Array, subs: Float64Array, sbOff: number, win64: Float64Array): void;
export declare class BitReader {
    private readonly data;
    private bitPos;
    constructor(data: Uint8Array, startBit?: number);
    read(count: number): number;
    get position(): number;
}
export declare class BitWriter {
    readonly buf: Uint8Array;
    pos: number;
    constructor(buf: Uint8Array, byteStart: number);
    put(value: number, bitCount: number): void;
}
export declare class FrameSizer {
    private readonly base;
    private readonly remainder;
    private readonly sampleRate;
    private acc;
    constructor(bitrateKbps: number, sampleRate: number);
    next(): {
        size: number;
        padding: 0 | 1;
    };
    get maxFrameSize(): number;
}
