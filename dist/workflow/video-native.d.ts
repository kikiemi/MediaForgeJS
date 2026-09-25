import { CodecLifetime } from '../core/codec-lifetime.js';
import type { EncodedChunk } from '../types/media.js';
import type { RgbaVideoFrame, VideoDecoderConfig as ProviderDecoderConfig, VideoEncoderConfig as ProviderEncoderConfig } from './video-types.js';
/** Native decoder submissions and retained output frames have explicit independent bounds. */
export declare class NativeVideoDecoderBridge {
    private readonly lifetime;
    private readonly consume;
    private readonly allowPrecisionLoss;
    private readonly decoder;
    private readonly frames;
    private readonly timing;
    private closed;
    constructor(lifetime: CodecLifetime, consume: (frame: RgbaVideoFrame) => Promise<void>, allowPrecisionLoss: boolean);
    configure(config: ProviderDecoderConfig): Promise<void>;
    decode(packet: EncodedChunk): Promise<void>;
    flush(): Promise<void>;
    private drain;
    close(): void;
}
export declare class NativeVideoEncoderBridge {
    private readonly lifetime;
    private readonly encoder;
    private readonly packets;
    private readonly timing;
    private submitted;
    private closed;
    constructor(lifetime: CodecLifetime);
    configure(config: ProviderEncoderConfig): Promise<void>;
    encode(frame: RgbaVideoFrame): Promise<Array<EncodedChunk & {
        codecConfig?: Uint8Array;
    }>>;
    flush(): Promise<Array<EncodedChunk & {
        codecConfig?: Uint8Array;
    }>>;
    close(): void;
}
