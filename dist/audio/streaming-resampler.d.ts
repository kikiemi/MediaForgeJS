export declare class StreamingResampler {
    private readonly sourceRate;
    private readonly targetRate;
    private readonly channels;
    private readonly stages;
    private inputFrames;
    private outputFrames;
    private sealed;
    constructor(sourceRate: number, targetRate: number, channels: number);
    get ratio(): number;
    process(chunk: readonly Float32Array[]): Float32Array[];
    flush(): Float32Array[];
}
