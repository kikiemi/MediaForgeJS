export declare function isProResCodec(codec: string): boolean;
export declare function readProResFourCC(config: Uint8Array | undefined): string | undefined;
export declare function hasProResFrameHeader(data: Uint8Array): boolean;
export declare function proResFrameError(data: Uint8Array, track?: {
    codec?: string;
    width?: number;
    height?: number;
}, headerless?: boolean): string | undefined;
export declare function restoreProResFrame(data: Uint8Array): Uint8Array;
