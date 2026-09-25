import { type MpegAudioInputFormat } from '../core/mpeg-audio-header.js';
import type { ReplayablePcmSource } from './pcm-source.js';
/** Windowed ADTS scanner feeding the built-in replayable AAC-LC decoder. */
export declare function createAdtsPcmSource(file: File | Blob, signal?: AbortSignal): Promise<ReplayablePcmSource | null>;
/** Raw MPEG source: built-in Layer I/II decoding, native Layer III decoding. */
export declare function createRawMpegPcmSource(file: File | Blob, format: MpegAudioInputFormat, signal?: AbortSignal): Promise<ReplayablePcmSource | null>;
