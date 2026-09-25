export interface StreamingAudioWindow {
    /** Output-rate PCM frames to discard before encoding. */
    readonly head: number;
    /** Maximum number of output-rate PCM frames to encode. */
    readonly valid: number;
    /** Presentation timestamp assigned to the first retained frame. */
    readonly startOffset: number;
}
export declare class WebCodecsAudioTranscoder {
    private readonly encoder;
    private readonly targetSampleRate;
    private readonly targetChannels;
    private readonly window;
    private transformer;
    private sourceRate;
    private encodedFrames;
    private sawInput;
    private sealed;
    constructor(encoder: AudioEncoder, targetSampleRate: number, targetChannels: number, window: StreamingAudioWindow);
    /** Number of target-rate frames emitted to AudioEncoder. */
    get framesEncoded(): number;
    get peakWorkFrames(): number;
    push(audioData: AudioData): void;
    flush(): void;
    private encode;
}
