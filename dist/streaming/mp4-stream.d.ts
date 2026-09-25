import type { DiagnosticOptions, MediaDiagnostic } from '../core/diagnostics.js';
import type { ByteStreamInput } from '../io/byte-reader.js';
export type Mp4ByteInput = ByteStreamInput;
export interface Mp4StreamOptions extends DiagnosticOptions {
    readonly signal?: AbortSignal;
    /** Maximum complete box, including its header. Default 64 MiB. */
    readonly maxBoxBytes?: number;
    /** Maximum initialization or media segment. Default 128 MiB. */
    readonly maxSegmentBytes?: number;
    /** Maximum top-level boxes consumed. Default 100000. */
    readonly maxBoxes?: number;
    /** Maximum single upstream chunk, checked before copying. Default 16 MiB. */
    readonly maxInputChunkBytes?: number;
    /** Maximum consecutive empty chunks. Default 1024. */
    readonly maxEmptyChunks?: number;
}
export interface Mp4StreamBox {
    readonly type: string;
    readonly offset: number;
    /** Actual byte length, including for a size-zero box extending to EOF. */
    readonly size: number;
    /** Includes the extended size and UUID user type when present. */
    readonly headerSize: number;
    readonly data: Uint8Array;
}
export interface CmafStreamSegment {
    readonly kind: 'init' | 'media';
    readonly offset: number;
    readonly byteLength: number;
    readonly data: Uint8Array;
}
export interface Mp4StreamIterator<T> extends AsyncIterableIterator<T> {
    readonly diagnostics: readonly MediaDiagnostic[];
    readonly suppressedWarnings: number;
}
/** Yields owned complete boxes as bytes arrive; defaults to strict validation. Returning early cancels the input. */
export declare function iterateMp4Boxes(input: Mp4ByteInput, options?: Mp4StreamOptions): Mp4StreamIterator<Mp4StreamBox>;
/** Yields ftyp/moov initialization and complete moof/mdat units before EOF. Requires relative fragment data offsets. */
export declare function readCmafSegments(input: Mp4ByteInput, options?: Mp4StreamOptions): Mp4StreamIterator<CmafStreamSegment>;
