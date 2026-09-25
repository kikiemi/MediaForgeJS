import type { Source } from '../types/io.js';
import type { MatroskaPassThrough } from '../types/media.js';
import { type DemuxBudgetOptions } from '../core/demux-guard.js';
import { DiagnosticContext } from '../core/diagnostics.js';
export interface MP4TrackInfo {
    id?: number;
    /** Original Matroska TrackUID; full unsigned 64-bit identity independent of TrackNumber. */
    matroskaTrackUid?: bigint;
    language?: string;
    default?: boolean;
    name?: string;
    title?: string;
    commentary?: boolean;
    forced?: boolean;
    alphaMode?: boolean;
    colour?: {
        primaries: number;
        transfer: number;
        matrix: number;
        fullRange: boolean;
    };
    opusTrailingPaddingSamples?: number;
    audioTrailingPaddingSamples?: number;
    /** Explicit coded audio prefix discard, independent of presentation timestamp origin. */
    audioPrimingSamples?: number;
    /** Some declared samples were unavailable and omitted during recovery. */
    incomplete?: boolean;
    matroskaCodecDelaySeconds?: number;
    /** Duration of the optional leading empty MP4 edit. */
    editLeadTimeSeconds?: number;
    editAbsoluteMediaTimeSeconds?: number;
    /** Signed shift from the media timeline to the movie timeline. */
    editTimelineShiftSeconds?: number;
    editMediaTimeSeconds?: number;
    editPresentationDurationSeconds?: number;
    presentationTimestampsIncludeEdits?: boolean;
    codec: string;
    width: number;
    height: number;
    displayWidth?: number;
    displayHeight?: number;
    pixelAspectRatioNum?: number;
    pixelAspectRatioDen?: number;
    rotation?: number;
    sampleRate: number;
    channelCount: number;
    duration: number;
    samples: MP4Sample[];
    codecConfig?: Uint8Array;
    codecConfigurations?: MP4CodecConfiguration[];
    timescale?: number;
    timestampResolutionSeconds?: number;
}
export interface MP4CodecConfiguration {
    codec: string;
    codecConfig: Uint8Array;
    width?: number;
    height?: number;
    displayWidth?: number;
    displayHeight?: number;
    pixelAspectRatioNum?: number;
    pixelAspectRatioDen?: number;
    rotation?: number;
    sampleRate?: number;
    channelCount?: number;
    samplesPerAccessUnit?: number;
}
export interface MP4Sample {
    proResHeaderless?: boolean;
    leadingDiscard?: boolean;
    /** Explicit source framing; avoids guessing when Annex B bytes also resemble NAL lengths. */
    nalUnitFormat?: 'annexb' | 'avcc';
    /** Source range of the Matroska VP8/VP9 alpha bitstream. */
    alphaOffset?: number;
    alphaSize?: number;
    offset: number;
    size: number;
    timestamp: number;
    duration: number;
    isKeyframe: boolean;
    decodeTimestamp?: number;
    compositionTimeOffset?: number;
    codecConfigIndex?: number;
    data?: Uint8Array;
}
export interface MP4DemuxResult {
    title?: string;
    videoTracks: MP4TrackInfo[];
    audioTracks: MP4TrackInfo[];
    subtitleTracks?: MP4TrackInfo[];
    matroskaPassThrough?: MatroskaPassThrough;
    matroskaUnsupportedTags?: boolean;
}
export interface MP4DemuxerOptions extends DemuxBudgetOptions {
    allowEmptyTracks?: boolean;
}
/** MP4/MOV/M4A demuxer (windowed reads, fragmented input, sample-budget hardening). */
export declare class MP4Demuxer {
    private readonly allowEmptyTracks;
    private isWorker;
    private source;
    private implicitSampleInput;
    private sampleBlob;
    private movieHasMvex;
    private compactClassic;
    private signal;
    private diagnostics;
    private externalFailure;
    private samplesRecovered;
    private mediaRanges;
    private trexDefaults;
    private fragmentNextDts;
    private readonly limits;
    private budget;
    constructor(options?: MP4DemuxerOptions);
    /** Parses the container with windowed reads and returns tracks plus encoded samples; honors `signal`. */
    demux(input: File | Blob | Source, signal?: AbortSignal, diagnostics?: DiagnosticContext): Promise<MP4DemuxResult>;
    private demuxInner;
    private recover;
    private preflightClassicSampleLedger;
    private getTrackId;
    private fillZeroDurations;
    private parseFragments;
    /** Reads from the sole successfully demuxed input; pass an explicit input after reusing this instance for different inputs. */
    readSample(sample: MP4Sample): Promise<Uint8Array>;
    readSample(input: File | Blob | Source, sample: MP4Sample): Promise<Uint8Array>;
    private blobSampleSource;
    /** A bounded top-level walk prevents recovery from treating metadata as media. */
    private findMediaRanges;
    private sampleFitsMedia;
    private findMoov;
    private parseTrak;
    private findEsds;
    private parseSamples;
}
