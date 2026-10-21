import type { ContainerFormat } from '../core/model/media';
import { DemuxError } from '../core/errors/errors';
import { signatureFormat } from './source-format';
import { streamFormat } from './stream-format';

/**
 * The container or image format of a file from its first bytes; unrecognised bytes fail with DEMUX.
 */
export function detectFormat(h: Uint8Array): ContainerFormat {
    const format = signatureFormat(h) ?? streamFormat(h);
    if (!format) throw new DemuxError('Unable to detect file format');
    return format;
}
