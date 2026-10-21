import type { Source } from '../../model/types';
import { demuxAssert, malformedInput } from '../../errors/demux-guard';
import { DemuxError, MediaForgeError } from '../../errors/errors';
import { assertSourceBytes, returnsOwnedBytes } from './source-read';
import { cachedBorrower, uncachedViews } from './cached-source';

export const MAX_ELEMENT_BYTES = 64 * 1024 * 1024;
export const CHUNK_BYTES = 1 << 20;
/**
 * One CachedSource page: the first read of a reader that may stop after the headers at the start of
 * its input (an audio file's description).
 */
export const FIRST_CHUNK_BYTES = 64 * 1024;

export interface ByteReader {
    readonly size: number;
    /** Returned views are borrowed: read only, and never transfer their backing buffers. */
    bytes(pos: number, len: number): Promise<Uint8Array>;
}

/** Bytes read from `start`, kept while the reader may still need them. */
interface Chunk {
    readonly start: number;
    readonly bytes: Uint8Array;
}

/**
 * Reads an input in chunks for parsers that walk it. A miss reads `firstBytes` from the position
 * before it that is a multiple of them; a scan that continues where the last read ended reads
 * twice as much each time, up to `chunkBytes`. With the default `firstBytes`, every read is a whole
 * chunk: a reader that reads a known span, such as a window, reads it at once. A reader that may
 * stop after the headers at the start of its input starts at FIRST_CHUNK_BYTES, so a description
 * reads one page; one that reads its whole input starts at PASS_START_BYTES, so its reads lie in
 * the windows a Blob reads for them (cached-source). Either reaches whole chunks after a few
 * reads. The three chunks used last are kept.
 */
export class ChunkReader implements ByteReader {
    readonly size: number;
    private readonly readSource: Source['read'];
    /** Views of the input where it reads them: chunks are borrowed, as they are handed out. */
    private readonly view?: (offset: number, length: number) => Promise<Uint8Array>;
    /** The bytes a CachedSource input already holds, borrowed rather than copied. */
    private readonly borrow?: (offset: number, length: number) => Uint8Array | undefined;
    /** The chunks kept, least recently used first. */
    private readonly chunks: Chunk[] = [];
    private readonly pending = new Map<number, Promise<Chunk>>();
    /** Where the chunk read last ends, and its length: a read from there continues the scan. */
    private lastEnd = -1;
    private lastLength = 0;
    /** The chunk the scan used last, which read-ahead follows. */
    private entered?: Chunk;

    /**
     * `chunkBytes` is the largest read; walkers that jump between small headers use a smaller one.
     * With `readAhead`, a scan moving into the chunk after the one it used also starts reading the
     * next, so it parses one chunk while the source reads the following one.
     */
    constructor(
        private readonly source: Source,
        private readonly chunkBytes = CHUNK_BYTES,
        private readonly readAhead = false,
        private readonly firstBytes = chunkBytes,
    ) {
        let size: number;
        let read: Source['read'];
        try {
            size = source.size;
            read = source.read;
        } catch {
            throw new DemuxError('ChunkReader requires a readable Source');
        }
        demuxAssert(
            Number.isSafeInteger(size) && size >= 0 && typeof read === 'function',
            'ChunkReader requires a non-negative safe source size and read method',
        );
        this.size = size;
        this.readSource = read;
        this.view = uncachedViews(source);
        this.borrow = cachedBorrower(source);
    }

    async bytes(pos: number, len: number): Promise<Uint8Array> {
        demuxAssert(
            Number.isSafeInteger(pos) &&
                Number.isSafeInteger(len) &&
                pos >= 0 &&
                len >= 0 &&
                Number.isSafeInteger(pos + len),
            'read range must use non-negative safe integers',
        );

        const end = Math.min(pos + len, this.size);
        if (end <= pos) return new Uint8Array(0);
        if (!(end - pos <= MAX_ELEMENT_BYTES))
            malformedInput(
                `element of ${end - pos} bytes exceeds the ${MAX_ELEMENT_BYTES}-byte cap`,
            );

        let chunk = this.kept(pos) ?? (await this.chunk(pos));
        this.enter(chunk);
        if (end <= chunk.start + chunk.bytes.length)
            return chunk.bytes.subarray(pos - chunk.start, end - chunk.start);

        // A range that runs past its chunk is assembled from the chunks that follow it.
        const out = new Uint8Array(end - pos);
        let cursor = pos;
        for (;;) {
            const to = Math.min(end, chunk.start + chunk.bytes.length);
            out.set(chunk.bytes.subarray(cursor - chunk.start, to - chunk.start), cursor - pos);
            cursor = to;
            if (cursor >= end) return out;
            chunk = this.kept(cursor) ?? (await this.chunk(cursor));
            this.enter(chunk);
        }
    }

    /** A kept chunk that holds byte `pos`, made the most recently used. */
    private kept(pos: number): Chunk | undefined {
        for (let at = this.chunks.length - 1; at >= 0; at--) {
            const chunk = this.chunks[at]!;
            if (pos >= chunk.start && pos < chunk.start + chunk.bytes.length) {
                if (at !== this.chunks.length - 1) {
                    this.chunks.splice(at, 1);
                    this.chunks.push(chunk);
                }
                return chunk;
            }
        }
        return undefined;
    }

    /** With read-ahead, a scan moving into the chunk after the one it used reads the next one. */
    private enter(chunk: Chunk): void {
        const previous = this.entered;
        this.entered = chunk;
        if (!this.readAhead || !previous || previous.start + previous.bytes.length !== chunk.start)
            return;
        const next = chunk.start + chunk.bytes.length;
        if (next < this.size && !this.kept(next)) this.chunk(next).catch(() => undefined);
    }

    /** The chunk read for byte `pos`: from where the last read ended, else a first read. */
    private chunk(pos: number): Promise<Chunk> {
        const continues = pos === this.lastEnd;
        const page = Math.min(this.firstBytes, this.chunkBytes);
        const start = continues ? pos : pos - (pos % page);
        const pending = this.pending.get(start);
        if (pending) return pending;
        const length = Math.min(
            this.size - start,
            continues ? Math.min(this.chunkBytes, this.lastLength * 2) : page,
        );
        this.lastEnd = start + length;
        this.lastLength = length;
        const read = Promise.resolve().then(() => this.read(start, length));
        this.pending.set(start, read);
        const settle = (): void => void this.pending.delete(start);
        read.then(settle, settle);
        return read;
    }

    private async read(start: number, length: number): Promise<Chunk> {
        const held = this.borrow?.(start, length);
        if (held) return this.keep({ start, bytes: held });
        const sourceBytes = await (this.view?.(start, length) ??
            this.readSource.call(this.source, start, length));
        try {
            assertSourceBytes(sourceBytes, length, 'ChunkReader');
        } catch {
            throw new DemuxError(`Malformed input: the read at ${start} returned no valid bytes`);
        }

        let data = sourceBytes;
        if (!this.view && !returnsOwnedBytes(this.source)) {
            try {
                data = new Uint8Array(sourceBytes);
            } catch {
                throw new MediaForgeError('ChunkReader could not copy the source page', 'OOM');
            }
        }

        return this.keep({ start, bytes: data });
    }

    private keep(chunk: Chunk): Chunk {
        this.chunks.push(chunk);
        if (this.chunks.length > 3) this.chunks.shift();
        return chunk;
    }
}

/**
 * Reads small structures spread over a large input, such as box or element headers between media
 * payloads: a miss reads one window that starts at the requested position, so the payloads between
 * the structures are never read. Returned views are borrowed and stay valid; a later miss reads a
 * new window instead of reusing the old one.
 */
export class WindowReader implements ByteReader {
    private start = 0;
    private window: Uint8Array = new Uint8Array(0);

    /** `read` returns bytes nobody rewrites, such as a source read or an uncached read of one. */
    constructor(
        readonly size: number,
        private readonly read: Source['read'],
        private readonly windowBytes = 4096,
    ) {
        demuxAssert(
            Number.isSafeInteger(size) && size >= 0,
            'WindowReader requires a non-negative safe size',
        );
    }

    async bytes(pos: number, len: number): Promise<Uint8Array> {
        demuxAssert(
            Number.isSafeInteger(pos) &&
                Number.isSafeInteger(len) &&
                pos >= 0 &&
                len >= 0 &&
                Number.isSafeInteger(pos + len),
            'read range must use non-negative safe integers',
        );

        const end = Math.min(pos + len, this.size);
        if (end <= pos) return new Uint8Array(0);
        if (!(end - pos <= MAX_ELEMENT_BYTES))
            malformedInput(
                `element of ${end - pos} bytes exceeds the ${MAX_ELEMENT_BYTES}-byte cap`,
            );

        if (pos < this.start || end > this.start + this.window.length) {
            const count = Math.min(Math.max(end - pos, this.windowBytes), this.size - pos);
            const bytes = await this.read(pos, count);
            try {
                assertSourceBytes(bytes, count, 'WindowReader');
            } catch {
                throw new DemuxError(`Malformed input: the read at ${pos} returned no valid bytes`);
            }
            this.start = pos;
            this.window = bytes;
        }
        return this.window.subarray(pos - this.start, end - this.start);
    }

    /** The bytes at `pos` when the current window holds all `len` of them, without reading. */
    retained(pos: number, len: number): Uint8Array | undefined {
        return pos >= this.start && pos + len <= this.start + this.window.length
            ? this.window.subarray(pos - this.start, pos - this.start + len)
            : undefined;
    }
}
