// The public API of 'mediaforgejs-prores', from its built declarations (npm run api:report).

export interface EncodedProResPacket extends ProResPacket {
    readonly trackType: 'video';
    readonly isKeyframe: true;
}

export type ProResCodec = 'apco' | 'apcs' | 'apcn' | 'apch' | 'ap4h' | 'ap4x';

export interface ProResDecoder {
    readonly queueSize: number;
    readonly desiredSize: number;
    readonly closed: boolean;
    decode(packet: ProResPacket): Promise<ProResFrame>;
    flush(): Promise<void>;
    close(): Promise<void>;
}

export interface ProResDecoderOptions {
    codec: ProResCodec;
    width?: number;
    height?: number;
    signal?: AbortSignal;
    concurrency?: number;
    useSharedMemory?: boolean;
    maxQueueSize?: number;
    maxPixels?: number;
    maxPacketBytes?: number;
    unspecifiedColorMatrix?: 1 | 5 | 6;
}

export interface ProResEncoder {
    readonly queueSize: number;
    readonly desiredSize: number;
    readonly closed: boolean;
    encode(frame: ProResRgbaFrame): Promise<EncodedProResPacket>;
    flush(): Promise<void>;
    close(): Promise<void>;
}

export interface ProResEncoderOptions {
    codec: ProResCodec;
    width: number;
    height: number;
    signal?: AbortSignal;
    maxQueueSize?: number;
    maxPixels?: number;
    framerate?: number;
    bitrate?: 0;
}

export interface ProResFrame {
    readonly data: Uint8Array;
    readonly format: 'I422P10' | 'I422P12' | 'I444P12' | 'I422AP12' | 'I444AP12' | 'I422P12A16' | 'I444P12A16';
    readonly bitDepth: 10 | 12;
    readonly alphaBitDepth: 0 | 12 | 16;
    readonly originalAlphaBitDepth: 0 | 8 | 16;
    readonly codedWidth: number;
    readonly codedHeight: number;
    readonly visibleWidth: number;
    readonly visibleHeight: number;
    readonly displayWidth: number;
    readonly displayHeight: number;
    readonly layout: readonly {
        readonly offset: number;
        readonly stride: number;
    }[];
    readonly pixelAspectRatio: {
        readonly num: number;
        readonly den: number;
    };
    readonly colorPrimaries: number;
    readonly colorTransfer: number;
    readonly colorMatrix: number;
    readonly colorRangeFull: false;
    readonly colorSpaceAssumed: boolean;
    readonly scanType: 'progressive' | 'interlaced-top-field-first' | 'interlaced-bottom-field-first';
    readonly timestamp: number;
    readonly duration: number;
    readonly closed: boolean;
    toRgba(options?: {
        allowPrecisionLoss?: boolean;
        signal?: AbortSignal;
    }): Promise<{
        data: Uint8Array;
        width: number;
        height: number;
    }>;
    close(): void;
}

export interface ProResPacket {
    readonly data: Uint8Array;
    readonly timestamp: number;
    readonly duration: number;
}

export interface ProResRgbaFrame extends Omit<ProResPacket, 'data'> {
    readonly data: Uint8Array | Uint8ClampedArray;
    readonly format: 'RGBA';
    readonly width: number;
    readonly height: number;
    readonly bitDepth?: 8;
    readonly scanType?: 'progressive';
    readonly colorPrimaries?: 1;
    readonly colorTransfer?: 1;
    readonly premultipliedAlpha?: false;
}

export declare function createProResDecoder(options: ProResDecoderOptions): Promise<ProResDecoder>;

export declare function createProResEncoder(options: ProResEncoderOptions): Promise<ProResEncoder>;

export declare const proResVideoCodec: VideoCodecProvider;

export declare const prores: MediaForgePlugin;
