import type { Source } from '../types/io.js';
import type { ContainerFormat } from '../types/media.js';
export declare function probeStructure(input: Blob | Source, fmt: ContainerFormat, signal?: AbortSignal): Promise<void>;
