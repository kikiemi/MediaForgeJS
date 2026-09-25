/** Returns declared 48 kHz samples; optional single-stream checks use at most two prefix bytes. */
export declare function opusPacketFrames(prefix: ArrayLike<number>, packetBytes: number, singleStream?: boolean): number;
