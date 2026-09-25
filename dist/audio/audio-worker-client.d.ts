import type { MpegAudioEncodeProgress, MpegAudioEncodeRequest } from './mpeg-audio-types.js';
export declare class AudioWorkerClient {
    private static sharedClient;
    static canUseWorker(): boolean;
    static getShared(): AudioWorkerClient | null;
    private session;
    private activeJob;
    private firstQueued;
    private lastQueued;
    private nextJobId;
    encode(request: MpegAudioEncodeRequest, onProgress?: (progress: MpegAudioEncodeProgress) => void, signal?: AbortSignal): Promise<ArrayBuffer>;
    private removeQueued;
    private dispatchNext;
    private onMessage;
    private failSession;
    private failJob;
    private ensureWorker;
    private clearReadyTimer;
    private teardownWorkerOnly;
    private disposeWorker;
}
