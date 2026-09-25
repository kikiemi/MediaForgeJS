import type { ContainerFormat } from '../types/media.js';
import type { Source } from '../types/io.js';
/** Format sniffing and demuxer/MIME lookup shared by Converter and Pipeline. */
export declare class DemuxerRegistry {
    /** Sniffs a byte prefix and returns the container/image format. */
    static detect(h: Uint8Array): ContainerFormat;
    /** Sniffs a file (reading only a small head) and returns its format. */
    static detectFromFile(file: File | Blob, signal?: AbortSignal): Promise<ContainerFormat>;
    /** Sniffs stable random-access bytes; this does not validate the entire media stream. */
    static detectFromSource(source: Source, signal?: AbortSignal): Promise<ContainerFormat>;
    /** MIME type string for a container format. */
    static getMimeType(fmt: ContainerFormat): string;
}
