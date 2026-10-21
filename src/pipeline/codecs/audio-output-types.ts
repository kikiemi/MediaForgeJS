import type { G711Codec } from '../../codecs/pcm/g711';
import type { PcmSampleFormat } from '../../codecs/pcm/encoder';
import type { MediaProgress, MediaTags } from '../../core/model/media';

// The output formats and options of the library's own audio encoding (mediaforgejs/codecs
// encodeReplayablePcm()), apart from the encoding (./streaming-audio-output-core).

export type StreamingSelfHostedAudioFormat =
    'aac' | 'flac' | 'mp2' | 'mp3' | 'wav' | 'aiff' | 'au' | 'caf';

/** Encoding passes and retained PCM work-unit sizes. */
export interface StreamingAudioDiagnostics {
    readonly format: StreamingSelfHostedAudioFormat;
    readonly passes: number;
    readonly inputFrames: number;
    readonly encodedFrames: number;
    /** Largest decoded PCM work unit retained by this layer, in frames. */
    readonly peakPcmFrames: number;
    /** Duration-growing analysis state. Zero for one-pass codecs. */
    readonly planningBytes: number;
}

export interface StreamingAudioEncodeOptions {
    readonly bitrateKbps?: number;
    readonly vbr?: boolean;
    /** wav, aiff, au and caf: G.711 codes instead of linear PCM. */
    readonly codec?: 'pcm' | G711Codec;
    /** wav, aiff, au and caf linear PCM: the sample coding; default s16. */
    readonly sampleFormat?: PcmSampleFormat;
    readonly signal?: AbortSignal;
    readonly onProgress?: (progress: MediaProgress) => void;
    /**
     * The input's tags, chapters and pictures: WAV writes the tags as RIFF INFO, FLAC and MP3/MP2
     * all of them.
     */
    readonly tags?: MediaTags;
}

export interface StreamingAacResult {
    readonly audioSpecificConfig: Uint8Array;
    readonly inputFrames: number;
    readonly encodedFrames: number;
    readonly peakPcmFrames: number;
}
