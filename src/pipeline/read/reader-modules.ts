/** Containers whose audio is usually AAC, which its syntax describes when the input opens. */
const AAC_CONTAINERS: readonly string[] = ['mp4', 'mov', 'm4a', 'm4v', '3gp', 'mkv', 'ts', 'aac'];

/** The reader formats/core-formats opens a container of the detected `format` with. */
function loadReader(format: string): Promise<unknown> | undefined {
    if (['mp4', 'mov', 'm4a', 'm4v', '3gp'].includes(format))
        return import('../../formats/mp4/reader');
    if (format === 'mkv' || format === 'webm') return import('../../formats/matroska/reader');
    if (format === 'ts') return import('../../formats/mpeg-ts/reader');
    if (['aac', 'mp1', 'mp2', 'mp3'].includes(format))
        return import('../../formats/audio-files/mpeg-audio-reader');
    if (['ac3', 'eac3', 'dts', 'truehd'].includes(format))
        return import('../../formats/audio-files/sync-reader');
    // FLAC and Ogg inputs run a part of the audio file reader instead of its WAV, AIFF and AU code.
    if (['flac', 'ogg', 'ogv', 'oga', 'opus'].includes(format))
        return import('../../formats/audio-files/described-files');
    if (['wav', 'aiff', 'au', 'caf'].includes(format))
        return import('../../formats/audio-files/reader');
    return undefined;
}

/**
 * Leading bytes of a Matroska input searched for the IDs of its metadata elements, which its
 * SeekHead names.
 */
export const MATROSKA_HINT_BYTES = 4096;

/**
 * Whether `head` holds the ID of a Tags, Chapters or Attachments element, which a part of the
 * reader reads.
 */
function namesMatroskaMetadata(head: Uint8Array): boolean {
    for (let i = 0, end = Math.min(head.length, MATROSKA_HINT_BYTES) - 3; i < end; i++) {
        const first = head[i];
        if (first !== 0x12 && first !== 0x10 && first !== 0x19) continue;
        const id =
            ((first << 24) | (head[i + 1]! << 16) | (head[i + 2]! << 8) | head[i + 3]!) >>> 0;
        if (id === 0x1254c367 || id === 0x1043a770 || id === 0x1941a469) return true;
    }
    return false;
}

/**
 * Starts loading what opening an input of `format` uses, its container reader and for containers
 * whose audio is usually AAC the AAC syntax, while other code loads; opening the input waits for
 * the same modules. The input's first bytes, when known, add the metadata part of the Matroska
 * reader for inputs that name their metadata there.
 */
export function prefetchOpening(format: string, head?: Uint8Array): void {
    loadReader(format)?.catch(() => undefined);
    if (AAC_CONTAINERS.includes(format))
        import('../../core/codec-config/audio/aac-syntax').catch(() => undefined);
    if ((format === 'mkv' || format === 'webm') && head && namesMatroskaMetadata(head))
        import('../../formats/matroska/read/metadata').catch(() => undefined);
}
