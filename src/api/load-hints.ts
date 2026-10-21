import { readBlobHead } from '../core/io/sources/blob-head';
import { MATROSKA_HINT_BYTES, prefetchOpening } from '../pipeline/read/reader-modules';

/**
 * The format of the reader an input most likely needs, from its first bytes, and the writer of a
 * target format: loading hints only, as detection proper runs when the input opens. Inputs are read
 * for it only when they are Blobs or bytes.
 */
const MP4_BOXES = ['ftyp', 'moov', 'mdat', 'free', 'skip', 'wide'];
const AUDIO_FILES = ['RIFF', 'FORM', 'caff', '.snd'];
const HEAD_BYTES = 256;
/** Bytes passed on to the reader hints, which look further into some containers. */
const HINT_BYTES = MATROSKA_HINT_BYTES;

function readerFormat(head: Uint8Array): string | undefined {
    const at = (offset: number, text: string): boolean => {
        for (let i = 0; i < text.length; i++)
            if (head[offset + i] !== text.charCodeAt(i)) return false;
        return true;
    };
    if (MP4_BOXES.some(box => at(4, box))) return 'mp4';
    if (at(0, '\x1aE\xdf\xa3')) {
        for (let i = 4; i + 4 <= head.length; i++) if (at(i, 'webm')) return 'webm';
        return 'mkv';
    }
    if (head[0] === 0x47 && (head.length <= 188 || head[188] === 0x47)) return 'ts';
    if (at(0, 'fLaC')) return 'flac';
    if (at(0, 'OggS')) return 'ogg';
    if (AUDIO_FILES.some(tag => at(0, tag))) return 'wav';
    if (head[0] === 0xff && (head[1]! & 0xf6) === 0xf0) return 'aac';
    if (at(0, 'ID3') || (head[0] === 0xff && (head[1]! & 0xe0) === 0xe0)) return 'mp3';
    return undefined;
}

/**
 * Loads what opening an input of `format` uses, given its first bytes; MPEG-TS has no signature at
 * the start: detection loads its sniffers.
 */
function loadReader(format: string | undefined, head: Uint8Array): void {
    if (format === undefined) return;
    if (format === 'ts') import('../formats/stream-format').catch(() => undefined);
    prefetchOpening(format, head);
}

/** Reader formats of the media types a Blob most often has. */
const TYPE_FORMATS: Readonly<Record<string, string>> = {
    'video/mp4': 'mp4',
    'audio/mp4': 'mp4',
    'audio/x-m4a': 'mp4',
    'video/x-m4v': 'mp4',
    'video/quicktime': 'mp4',
    'video/3gpp': 'mp4',
    'video/webm': 'webm',
    'audio/webm': 'webm',
    'video/x-matroska': 'mkv',
    'audio/x-matroska': 'mkv',
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/aac': 'aac',
    'video/mp2t': 'ts',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/wave': 'wav',
    'audio/flac': 'flac',
    'audio/ogg': 'ogg',
};

/** Reader formats of file name extensions, for files without a media type. */
const EXTENSION_FORMATS: Readonly<Record<string, string>> = {
    mp4: 'mp4',
    m4a: 'mp4',
    m4v: 'mp4',
    mov: 'mp4',
    webm: 'webm',
    mkv: 'mkv',
    mka: 'mkv',
    mp3: 'mp3',
    aac: 'aac',
    ts: 'ts',
    wav: 'wav',
    flac: 'flac',
    ogg: 'ogg',
    opus: 'ogg',
};

/** The reader format a Blob's media type, or a File's name, names. */
function namedFormat(blob: Blob): string | undefined {
    const type = TYPE_FORMATS[blob.type.split(';')[0]!.trim().toLowerCase()];
    if (type || typeof File !== 'function' || !(blob instanceof File)) return type;
    const dot = blob.name.lastIndexOf('.');
    return dot < 0 ? undefined : EXTENSION_FORMATS[blob.name.slice(dot + 1).toLowerCase()];
}

/**
 * Starts loading the reader `input` most likely needs while the engine loads; failures surface when
 * it opens. A Blob's media type or name starts it at once, its first bytes when they arrive.
 */
export function prefetchReaderFor(input: unknown): void {
    started = true;
    let head: Uint8Array | Promise<ArrayBuffer> | undefined;
    if (typeof Blob === 'function' && input instanceof Blob) {
        loadReader(namedFormat(input), new Uint8Array(0));
        head = readBlobHead(input);
    } else if (input instanceof ArrayBuffer)
        head = new Uint8Array(input, 0, Math.min(HINT_BYTES, input.byteLength));
    else if (ArrayBuffer.isView(input))
        head = new Uint8Array(
            input.buffer,
            input.byteOffset,
            Math.min(HINT_BYTES, input.byteLength),
        );
    if (head === undefined) return;
    Promise.resolve(head)
        .then(bytes => {
            const view =
                bytes instanceof Uint8Array
                    ? bytes
                    : new Uint8Array(bytes, 0, Math.min(HINT_BYTES, bytes.byteLength));
            loadReader(readerFormat(view.subarray(0, HEAD_BYTES)), view);
        })
        .catch(() => undefined);
}

/**
 * What `load` imports, loaded with the first call and kept: an import() of a module already loaded
 * still costs microseconds a call. A failed load is tried again; it fails the calls that await it,
 * and a load started ahead that nothing awaits fails silently.
 */
export function loadOnce<T>(load: () => Promise<T>): () => Promise<T> {
    let loading: Promise<T> | undefined;
    return () => {
        loading ??= load().catch(error => {
            loading = undefined;
            throw error;
        });
        loading.catch(() => undefined);
        return loading;
    };
}

/** Whether an operation has started loading its code (see api/idle-prefetch). */
let started = false;

export function operationStarted(): boolean {
    return started;
}

/** Starts loading the writer of the target format `format` while the input is read. */
export function prefetchWriterFor(format: unknown): void {
    started = true;
    let loading: Promise<unknown> | undefined;
    if (
        format === 'mp4' ||
        format === 'mov' ||
        format === 'm4a' ||
        format === 'm4v' ||
        format === '3gp'
    )
        loading = import('../formats/mp4/writer');
    else if (format === 'mkv' || format === 'webm') loading = import('../formats/matroska/writer');
    else if (format === 'ts') loading = import('../formats/mpeg-ts/writer');
    loading?.catch(() => undefined);
}
