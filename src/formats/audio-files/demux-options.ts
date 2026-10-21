import type { DiagnosticOptions } from '../../core/errors/diagnostics';
import type { DemuxBudgetOptions } from '../../core/contracts/reader';

// The options of the audio file readers that mediaforgejs/formats exports, apart from the readers.

/** The options of demuxStandaloneAudio(): WAV, AIFF, AU, CAF, FLAC and Ogg. */
export interface StandaloneAudioDemuxOptions extends DiagnosticOptions, DemuxBudgetOptions {
    readonly format:
        'wav' | 'aiff' | 'aif' | 'aifc' | 'au' | 'caf' | 'flac' | 'ogg' | 'ogv' | 'oga' | 'opus';
    readonly signal?: AbortSignal;
    /** One packet's byte budget; defaults to 16 MiB. */
    readonly maxPacketBytes?: number;
    /** Offsets of Ogg pages whose CRC the caller checked over the same bytes. */
    readonly checkedOggPages?: ReadonlySet<number>;
}

/** The options of demuxRawAudio(): ADTS AAC and MPEG audio streams. */
export interface RawAudioDemuxOptions extends DiagnosticOptions, DemuxBudgetOptions {
    readonly format: 'aac' | 'mp1' | 'mp2' | 'mp3';
    readonly signal?: AbortSignal;
}
