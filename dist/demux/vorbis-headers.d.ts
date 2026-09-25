/** Parses setup sections to reach the packet mode table without decoding audio. */
export declare function vorbisModes(setup: Uint8Array, channels: number): readonly boolean[];
export declare function vorbisPacketBlock(prefix: Uint8Array, modes: readonly boolean[], small: number, large: number): number;
export declare function vorbisCodecConfig(headers: readonly Uint8Array[]): Uint8Array;
