import type { Source } from '../../model/types';
import { IOError, MediaForgeError } from '../../errors/errors';
import { BufferPool } from '../../bytes/buffer-pool';
import { releaseBytes } from '../../bytes/byte-holds';
import {
    assertSourceBytes,
    registerOwnedReads,
    registerReleaseReads,
    releaseReads,
    returnsOwnedBytes,
    sourceReadEnd,
    viewReader,
} from './source-read';
import { readerInto } from '../../bytes/read-into';

export interface CachedSourceOptions {
    /** Aligned read size in bytes; defaults to 64 KiB. */
    readonly pageBytes?: number;
    /** Maximum retained page bytes; defaults to 4 MiB. Zero disables retention. */
    readonly maxBytes?: number;
}

/** A read of pages in flight: `bytes` will cover the input from `start` to `end`. */
interface PendingRead {
    readonly start: number;
    readonly end: number;
    readonly bytes: Promise<Uint8Array>;
}

/** Bytes a borrowed read fetches at once, and reads ahead of a pass in file order. */
const SPAN_BYTES = 1024 * 1024;

/**
 * The least a pass in file order reads first: the least slice a Blob reads (blob-source), so that
 * the reads doubling from it lie in the windows the Blob reads for them, which double alike, and
 * are views of them.
 */
export const PASS_START_BYTES = 256 * 1024;

/**
 * One retained read: `bytes` covers page indices firstIndex..lastIndex starting at byte `start`.
 */
interface Page {
    readonly start: number;
    readonly firstIndex: number;
    readonly lastIndex: number;
    readonly bytes: Uint8Array;
    newer: Page | null;
    older: Page | null;
}

const cachedReads = new WeakMap<
    Source,
    {
        read: Source['read'];
        borrow: (offset: number, length: number) => Uint8Array | undefined;
        direct: Source['read'];
        pass: (end?: number) => BorrowedPass;
        /** The source the cache reads. */
        inner: Source;
    }
>();

/**
 * Internal borrowed fast path: the view aliases retained bytes that are never rewritten, so callers
 * must not modify it.
 */
function borrowCachedSource(
    source: Source,
    offset: number,
    length: number,
): Uint8Array | undefined {
    const entry = cachedReads.get(source);
    return entry && source.read === entry.read ? entry.borrow(offset, length) : undefined;
}

/** Borrows lent to sources that are views of other reads (lendBorrow). */
const lentBorrows = new WeakMap<
    Source,
    (offset: number, length: number) => Uint8Array | undefined
>();

/**
 * Makes `borrow` the borrow of `source`, a Source over other reads (a pass in file order), which
 * cachedBorrower then returns for it.
 */
export function lendBorrow(
    source: Source,
    borrow: (offset: number, length: number) => Uint8Array | undefined,
): void {
    lentBorrows.set(source, borrow);
}

/**
 * A per-source borrow function that re-checks the read override on each call without the registry
 * lookup.
 */
export function cachedBorrower(
    source: Source,
): ((offset: number, length: number) => Uint8Array | undefined) | undefined {
    const lent = lentBorrows.get(source);
    if (lent) return lent;
    const entry = cachedReads.get(source);
    if (!entry) return undefined;
    return (offset, length) =>
        source.read === entry.read ? entry.borrow(offset, length) : undefined;
}

/**
 * Reads of `source` that bypass the page cache of a CachedSource: scans that jump over media
 * payloads read only the headers they need and leave the retained pages to packet reads. Other
 * sources are read as they are.
 */
export function uncachedReads(source: Source): Source['read'] {
    const entry = cachedReads.get(source);
    if (entry && source.read === entry.read) return entry.direct;
    return (offset, length) => source.read(offset, length);
}

/**
 * The source the page cache of `source` reads when it is a CachedSource, else `source`: a read into
 * a caller's bytes (readerInto) of it bypasses the cache as uncachedReads does.
 */
export function uncachedSource(source: Source): Source {
    const entry = cachedReads.get(source);
    return entry && source.read === entry.read ? entry.inner : source;
}

/**
 * As uncachedReads, as views of bytes the input never changes, which callers must not change
 * either; undefined where the source (or the one a cache reads) reads no such views.
 */
export function uncachedViews(
    source: Source,
): ((offset: number, length: number) => Promise<Uint8Array>) | undefined {
    const entry = cachedReads.get(source);
    if (entry && source.read === entry.read) return viewReader(entry.inner, entry.inner.read);
    return viewReader(source, source.read);
}

/** Reads of a pass through an input in file order, with views of what it already read. */
export interface BorrowedReads {
    /**
     * A view of `length` bytes at `offset` when the pass or the cache holds them all, else
     * undefined.
     */
    borrow(offset: number, length: number): Uint8Array | undefined;
    read(offset: number, length: number): Promise<Uint8Array>;
}

/**
 * Borrowed reads for a pass in file order: bytes are read in spans of 1 MiB, the next span read
 * ahead while one is used, and returned as views; callers must not modify them. A view stays valid
 * until the pass has read two spans past it, unless a hold is taken on it (holdBytes). Spans stop
 * at `end` (a window's last byte read), reads past it go through the cache. Other sources are read
 * as they are.
 */
export function borrowedReads(source: Source, end?: number): BorrowedReads {
    const entry = cachedReads.get(source);
    const pass = entry && source.read === entry.read ? entry.pass(end) : undefined;
    return {
        borrow: (offset, length) =>
            source.read === entry?.read ? pass!.borrow(offset, length) : undefined,
        read: (offset, length) =>
            source.read === entry?.read ? pass!.read(offset, length) : source.read(offset, length),
    };
}

/** A span of a borrowed pass: the input from `start` to `end`, read or being read. */
interface Span {
    readonly start: number;
    readonly end: number;
    readonly bytes: Promise<Uint8Array>;
    done?: Uint8Array;
}

/** Spans a pass keeps: the one in use, the one read ahead and the one before them. */
const PASS_SPANS = 3;

/**
 * The spans of one pass in file order over a CachedSource. A pass starts with a span of the pages
 * its first request needs, at least PASS_START_BYTES; while it goes on from one span into the
 * next, each span is twice as long as the one before, up to SPAN_BYTES. From its first span of
 * SPAN_BYTES on, the span after the one in use is read ahead once the pass is halfway through it.
 * A pass that stops after a few packets (a picture from a keyframe) thus reads little more than
 * they hold, and one that stops anywhere reads at most a span and a half past where it stops.
 * Spans are read into pooled buffers where the input reads into the caller's bytes (views where it
 * reads views), and go back to the pool once the pass is PASS_SPANS spans past them and no hold is
 * left.
 */
class BorrowedPass implements BorrowedReads {
    private readonly spans: Span[] = [];
    private readonly pool = new BufferPool(SPAN_BYTES, PASS_SPANS + 1);
    /**
     * Where the latest span read, or read ahead, ends; a span that starts there is a pass in file
     * order.
     */
    private latestEnd = -1;
    private latest?: Span;

    /**
     * `pageBytes` aligns spans; 0 for a cache that retains nothing, whose pass reads each request
     * alone. No span reaches past `end`.
     */
    constructor(
        private readonly cache: CachedSource,
        private readonly span: (
            start: number,
            length: number,
            target: () => Uint8Array,
        ) => Promise<Uint8Array>,
        private readonly pageBytes: number,
        private readonly end: number,
    ) {}

    /** The cache's own borrow, for bytes outside the pass's spans. */
    private borrowCache?: (offset: number, length: number) => Uint8Array | undefined;

    borrow(offset: number, length: number): Uint8Array | undefined {
        const end = offset + length;
        for (const span of this.spans)
            if (span.done && span.start <= offset && end <= span.end) {
                // A pass that reaches the span read ahead reads the one after it, as read() does,
                // so a pass its borrows serve does not wait for a read every other span.
                if (this.leads(span, offset)) this.openAfter(span);
                return span.done.subarray(offset - span.start, end - span.start);
            }
        return (this.borrowCache ??= cachedBorrower(this.cache)!)(offset, length);
    }

    async read(offset: number, length: number): Promise<Uint8Array> {
        const count = Math.max(0, sourceReadEnd(offset, length, this.cache.size) - offset);
        const view = this.borrow(offset, count);
        if (view) return view;

        // A cache that retains nothing reads each request alone, as do requests too large for a
        // span.
        if (this.pageBytes === 0 || count >= CachedSource.DIRECT_READ_BYTES)
            return uncachedReads(this.cache)(offset, count);
        if (offset + count > this.end) return this.cache.read(offset, count);

        // A request that crosses from one span into the next is assembled as a copy, the others are
        // views.
        let span = this.spans.find(item => item.start <= offset && offset < item.end);
        if (!span) {
            const start = Math.floor(offset / this.pageBytes) * this.pageBytes;
            if (start === this.latestEnd && this.latest) {
                span = this.openAfter(this.latest);
                if (this.leads(span, offset)) this.openAfter(span);
            } else {
                const pages = Math.ceil((offset + count - start) / this.pageBytes);
                const first = Math.max(PASS_START_BYTES, pages * this.pageBytes);
                span = this.open(start, Math.min(SPAN_BYTES, first));
            }
        } else if (this.leads(span, offset)) {
            // The pass is halfway through the latest span: the one after it is read while the rest
            // of this one is used.
            this.openAfter(span);
        }
        const bytes = await span.bytes;
        const relative = offset - span.start;
        if (relative + count <= bytes.byteLength) return bytes.subarray(relative, relative + count);

        // The rest comes from the next span, which a pass in file order reads next anyway.
        const next =
            bytes.byteLength === span.end - span.start
                ? (this.spans.find(item => item.start === span.end) ?? this.openAfter(span))
                : undefined;
        if (!next || offset + count > next.end) return this.cache.read(offset, count);
        const joined = new Uint8Array(count);
        const head = bytes.byteLength - relative;
        joined.set(bytes.subarray(relative));
        const tail = await next.bytes;
        if (tail.byteLength < count - head) return this.cache.read(offset, count);
        joined.set(tail.subarray(0, count - head), head);
        return joined;
    }

    /**
     * Whether the span after `span` is read ahead of a request at `offset`: `span` is the latest,
     * ends before the pass does, is as long as spans grow, and the request is in its second half.
     */
    private leads(span: Span, offset: number): boolean {
        return (
            span.end === this.latestEnd &&
            span.end < this.end &&
            span.end - span.start >= SPAN_BYTES &&
            2 * (offset - span.start) >= span.end - span.start
        );
    }

    /** The span after `span`, twice as long, up to SPAN_BYTES. */
    private openAfter(span: Span): Span {
        return this.open(span.end, Math.min(SPAN_BYTES, 2 * (span.end - span.start)));
    }

    private open(start: number, length: number): Span {
        const end = Math.min(this.end, start + length);
        let target: Uint8Array | undefined;
        const acquire = (): Uint8Array => (target = this.pool.acquire().subarray(0, end - start));
        const span: Span = {
            start,
            end,
            bytes: this.span(start, end - start, acquire).then(bytes => (span.done = bytes)),
        };
        span.bytes.catch(() => target && releaseBytes(target));
        this.spans.push(span);
        this.latestEnd = end;
        this.latest = span;
        while (this.spans.length > PASS_SPANS) {
            const dropped = this.spans.shift()!;
            dropped.bytes.then(releaseBytes, () => undefined);
        }
        return span;
    }
}

/**
 * Internal fast path returning an independent copy; overridden reads retain their original
 * dispatch.
 */
export function readCachedSource(
    source: Source,
    offset: number,
    length: number,
): Uint8Array | undefined {
    const view = borrowCachedSource(source, offset, length);
    if (!view) return undefined;
    try {
        return view.slice();
    } catch {
        throw new MediaForgeError('CachedSource could not copy the cached output', 'OOM');
    }
}

/**
 * Bounded LRU cache over a stable Source; concurrent page reads are shared, returned bytes are
 * independent.
 */
export class CachedSource implements Source {
    readonly size: number;
    private readonly readSource: Source['read'];
    private readonly pageBytes: number;
    private readonly maxBytes: number;
    private readonly pages = new Map<number, Page>();
    /**
     * Reads in flight by page index; a read that spans several pages is listed under each, with its
     * first byte.
     */
    private readonly pending = new Map<number, PendingRead>();
    private generation = {};
    private newest: Page | null = null;
    private oldest: Page | null = null;
    private retainedBytes = 0;
    /** Reads of at least this many bytes that start outside the cache go straight to the source. */
    static readonly DIRECT_READ_BYTES = 512 * 1024;

    constructor(
        private readonly source: Source,
        options: CachedSourceOptions = {},
    ) {
        let size: number;
        let read: Source['read'];
        let pageBytes: number | undefined;
        let maxBytes: number | undefined;
        try {
            size = source.size;
            read = source.read;
            if (!options || typeof options !== 'object') throw new Error();
            pageBytes = options.pageBytes;
            maxBytes = options.maxBytes;
        } catch {
            throw new IOError('CachedSource requires a readable Source and options');
        }

        if (!Number.isSafeInteger(size) || size < 0 || typeof read !== 'function') {
            throw new IOError(
                'CachedSource requires a non-negative safe source size and read method',
            );
        }

        if (pageBytes === undefined) pageBytes = 64 * 1024;
        if (maxBytes === undefined) maxBytes = 4 * 1024 * 1024;
        if (!Number.isSafeInteger(pageBytes) || pageBytes <= 0)
            throw new MediaForgeError(
                'CachedSource pageBytes must be a positive safe integer',
                'INPUT',
            );
        if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
            throw new MediaForgeError(
                'CachedSource maxBytes must be a non-negative safe integer',
                'INPUT',
            );

        this.size = size;
        this.readSource = read;
        this.pageBytes = pageBytes;
        this.maxBytes = maxBytes;

        cachedReads.set(this, {
            read: intrinsicRead,
            borrow: (offset, length) => this.borrow(offset, length),
            direct: (offset, length) => this.readDirect(offset, length),
            pass: end =>
                new BorrowedPass(
                    this,
                    (start, length, target) => this.readSpan(start, length, target),
                    maxBytes === 0 ? 0 : pageBytes!,
                    Math.min(size, end ?? size),
                ),
            inner: source,
        });

        registerOwnedReads(this, intrinsicRead);
        registerReleaseReads(this, () => {
            this.clear();
            releaseReads(source);
        });
    }

    get cachedBytes(): number {
        return this.retainedBytes;
    }

    /**
     * Invalidates retained and pending cache entries; existing reads may finish without
     * repopulating this generation.
     */
    clear(): void {
        this.generation = {};
        this.pages.clear();
        this.pending.clear();
        this.newest = null;
        this.oldest = null;
        this.retainedBytes = 0;
    }

    async read(offset: number, length: number): Promise<Uint8Array> {
        const end = sourceReadEnd(offset, length, this.size);
        const count = Math.max(0, end - offset);
        if (count === 0) return new Uint8Array(0);
        if (this.maxBytes === 0) return this.readDirect(offset, count);
        const generation = this.generation;
        const whole = this.touch(offset, count);
        if (whole) return this.copy(whole.bytes, offset - whole.start, count);

        // Sequential scans read large spans once; retaining them would only evict the pages packet
        // reads reuse.
        if (
            count >= CachedSource.DIRECT_READ_BYTES &&
            !this.pages.has(Math.floor(offset / this.pageBytes))
        )
            return this.readDirect(offset, count);
        let output: Uint8Array;
        try {
            output = new Uint8Array(count);
        } catch {
            throw new MediaForgeError(
                'CachedSource could not allocate the requested output',
                'OOM',
            );
        }
        let written = 0;
        while (written < count) {
            const position = offset + written;
            const index = Math.floor(position / this.pageBytes);
            const cached = generation === this.generation ? this.pages.get(index) : undefined;
            let bytes: Uint8Array;
            let start: number;
            if (cached) {
                this.detach(cached);
                this.prepend(cached);
                bytes = cached.bytes;
                start = cached.start;
            } else {
                // The pages from this one to the end of the read: one read fetches them all.
                const fetched = this.getPage(
                    index,
                    offset + count - index * this.pageBytes,
                    generation,
                );
                start = fetched.start;
                bytes = await fetched.bytes;
            }
            const relative = position - start;
            const take = Math.min(count - written, bytes.byteLength - relative);
            output.set(bytes.subarray(relative, relative + take), written);
            written += take;
        }
        return output;
    }

    /**
     * One read of the underlying source for a borrowed pass: into bytes from `target` where the
     * source reads into the caller's bytes, else a view where it reads views, else bytes of its
     * own.
     */
    private async readSpan(
        start: number,
        length: number,
        target: () => Uint8Array,
    ): Promise<Uint8Array> {
        const into = readerInto(this.source, this.readSource);
        if (into) {
            const bytes = target();
            await into(start, bytes);
            return bytes;
        }
        const view = viewReader(this.source, this.readSource);
        return view ? view(start, length) : this.readDirect(start, length);
    }

    /**
     * A read that leaves the cache as it is: a copy from a retained page that holds all of it, else
     * one read of the underlying source.
     */
    private async readDirect(offset: number, length: number): Promise<Uint8Array> {
        const count = Math.max(0, sourceReadEnd(offset, length, this.size) - offset);
        if (count === 0) return new Uint8Array(0);
        const page = this.pages.get(Math.floor(offset / this.pageBytes));
        if (page && count <= page.bytes.byteLength - (offset - page.start))
            return this.copy(page.bytes, offset - page.start, count);
        const bytes = await this.readSource.call(this.source, offset, count);
        assertSourceBytes(bytes, count, 'CachedSource');
        return this.own(bytes);
    }

    private touch(offset: number, count: number): Page | undefined {
        const page = this.pages.get(Math.floor(offset / this.pageBytes));
        if (!page || count > page.bytes.byteLength - (offset - page.start)) return undefined;
        if (this.newest !== page) {
            this.detach(page);
            this.prepend(page);
        }
        return page;
    }

    private borrow(offset: number, length: number): Uint8Array | undefined {
        const end = sourceReadEnd(offset, length, this.size);
        const count = Math.max(0, end - offset);
        if (count === 0) return new Uint8Array(0);
        const page = this.touch(offset, count);
        if (!page) return undefined;
        const relative = offset - page.start;
        return page.bytes.subarray(relative, relative + count);
    }

    private copy(bytes: Uint8Array, relative: number, count: number): Uint8Array {
        try {
            return bytes.slice(relative, relative + count);
        } catch {
            throw new MediaForgeError('CachedSource could not copy the cached output', 'OOM');
        }
    }

    private own(bytes: Uint8Array): Uint8Array {
        if (returnsOwnedBytes(this.source)) return bytes;
        try {
            return new Uint8Array(bytes);
        } catch {
            throw new MediaForgeError('CachedSource could not copy the source page', 'OOM');
        }
    }

    /**
     * Reads up to 64 pages (those holding the `remaining` bytes from its start, at most SPAN_BYTES)
     * from page `index` in one source request; the whole span is retained as one entry. A read
     * already in flight for the page is shared, with its own start.
     */
    private getPage(index: number, remaining: number, generation: object): PendingRead {
        if (generation === this.generation) {
            const pending = this.pending.get(index);
            if (pending) return pending;
        }

        const start = index * this.pageBytes;
        let count = Math.min(this.pageBytes, this.size - start);
        let pages = 1;
        const limit = Math.min(
            this.maxBytes,
            Math.ceil(remaining / this.pageBytes) * this.pageBytes,
            SPAN_BYTES,
            this.size - start,
        );
        while (pages < 64 && count < limit) {
            const next = index + pages;
            const nextCount = Math.min(this.pageBytes, this.size - start - count);
            if (
                nextCount > limit - count ||
                (generation === this.generation && (this.pages.has(next) || this.pending.has(next)))
            )
                break;
            count += nextCount;
            pages++;
        }

        const lastIndex = index + pages - 1;
        const read = Promise.resolve()
            .then(() => this.readSource.call(this.source, start, count))
            .then(bytes => {
                assertSourceBytes(bytes, count, 'CachedSource');
                const owned = this.own(bytes);
                if (generation === this.generation && count <= this.maxBytes) {
                    this.retain({
                        start,
                        firstIndex: index,
                        lastIndex,
                        bytes: owned,
                        newer: null,
                        older: null,
                    });
                }
                return owned;
            })
            .finally(() => {
                for (let page = index; page <= lastIndex; page++) {
                    if (this.pending.get(page) === entry) this.pending.delete(page);
                }
            });

        void read.catch(() => undefined);
        const entry = { start, end: start + count, bytes: read };
        if (generation === this.generation) {
            for (let page = index; page <= lastIndex; page++) this.pending.set(page, entry);
        }
        return entry;
    }

    private retain(page: Page): void {
        while (page.bytes.byteLength > this.maxBytes - this.retainedBytes) this.evict(this.oldest!);
        for (let index = page.firstIndex; index <= page.lastIndex; index++) {
            const previous = this.pages.get(index);
            if (previous) this.evict(previous);
            this.pages.set(index, page);
        }
        this.prepend(page);
        this.retainedBytes += page.bytes.byteLength;
    }

    private evict(page: Page): void {
        this.detach(page);
        for (let index = page.firstIndex; index <= page.lastIndex; index++) {
            if (this.pages.get(index) === page) this.pages.delete(index);
        }
        this.retainedBytes -= page.bytes.byteLength;
    }

    private detach(page: Page): void {
        if (page.newer) page.newer.older = page.older;
        else this.newest = page.older;
        if (page.older) page.older.newer = page.newer;
        else this.oldest = page.newer;
        page.newer = null;
        page.older = null;
    }

    private prepend(page: Page): void {
        page.older = this.newest;
        if (this.newest) this.newest.newer = page;
        else this.oldest = page;
        this.newest = page;
    }
}

const intrinsicRead = CachedSource.prototype.read;
