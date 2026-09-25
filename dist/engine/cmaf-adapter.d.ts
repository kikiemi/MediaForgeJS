import type { EncodedChunk } from '../types/media.js';
import type { CmafTrack, CmafSample } from '../streaming/cmaf.js';
export declare function cmafTrackConfig(track: CmafTrack): CmafTrack;
export declare class CmafPacketAdapter {
    private readonly track;
    private readonly timestampResolution;
    private readonly origin;
    private readonly warning;
    private end?;
    private warned;
    private readonly quantizedAudio;
    constructor(track: CmafTrack, format: string, timestampResolution: number, origin: number, warning: () => void);
    prepare(packet: EncodedChunk): {
        sample: CmafSample;
        discontinuity: boolean;
        time: number;
    };
}
