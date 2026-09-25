export interface DemuxedTrackInfo {
    hasVideo: boolean;
    hasAudio: boolean;
    videoWidth: number;
    videoHeight: number;
    duration: number;
    audioSampleRate: number;
    audioChannels: number;
}
/** Browser-native decode via media elements / decodeAudioData, used as a fallback route. */
export declare class DOMDemuxer {
    private readonly fps;
    private readonly signal?;
    private readonly onProgress?;
    private readonly loadTimeoutMs;
    private readonly seekTimeoutMs;
    private video;
    private url;
    private info;
    private cachedAudio;
    constructor(cfg?: {
        fps?: number;
        signal?: AbortSignal;
        onProgress?: (p: number, m: string) => void;
        /** Mainly useful to make browser integration tests deterministic. */
        loadTimeoutMs?: number;
        /** Mainly useful to make browser integration tests deterministic. */
        seekTimeoutMs?: number;
    });
    /** Loads the input into a media element and returns its track info. */
    open(input: File | Blob): Promise<DemuxedTrackInfo>;
    /** Async-iterates decoded video frames from the media element (browser only). */
    videoFrames(): AsyncGenerator<VideoFrame>;
    /** Decodes the full audio via decodeAudioData; null where unavailable. */
    decodeAudio(_input: File | Blob): Promise<AudioBuffer | null>;
    /** Releases the media element and object URLs. */
    close(): void;
    private waitSeek;
    private waitForLoad;
    private decodeAudioBuffer;
    /** `null` means that the browser exposes no reliable track-presence API. */
    private elementAudioPresence;
    private throwIfAborted;
    private isAbort;
}
