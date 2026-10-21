import type { Source } from '../../model/types';
import { IOError, MediaForgeError } from '../../errors/errors';
import {
    registerOwnedReads,
    registerReleaseReads,
    registerViewReads,
    sourceReadEnd,
} from './source-read';
import { BLOB_HEAD_BYTES, blobHead } from './blob-head';

const bufferByteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!;

/** Slices start on these boundaries. */
const ALIGN = 64 * 1024;
/** The least a slice reads after a jump, as the head read while the reading code loads. */
const SEEK = BLOB_HEAD_BYTES;
/** The most a slice reads ahead; a longer read is a slice of its own. */
const WINDOW = 4 * 1024 * 1024;
/** Window bytes kept, the most recently used first. */
const RETAIN = 8 * 1024 * 1024;

/** Bytes of a Blob one slice reads: read, or still being read. */
interface Window {
    readonly start: number;
    readonly end: number;
    /** How far the slice read ahead; a read that goes on from it reads twice as far. */
    readonly ahead: number;
    readonly read: Promise<Uint8Array>;
    /** The bytes, once read. */
    bytes?: Uint8Array;
    /** The window after it is read (a pass in whole windows). */
    next?: boolean;
}

/**
 * Source over a stable Blob or File. Each slice of a Blob is a request to the browser that costs
 * more than the bytes it copies (in Chromium about a millisecond, as much as 0.7 MiB; slices read
 * at once take longer than one after another), so a BlobSource reads few slices of a useful size
 * and keeps them. One rule sizes every slice:
 * - The reads asked in one turn (the parts of a window read together) are one slice where they lie
 *   within 256 KiB of each other, up to 4 MiB.
 * - A slice starts on a 64 KiB boundary and reads at least 256 KiB, back from the end of the Blob
 *   where that cuts it, so the reads around one structure share it; it never reads bytes it holds.
 * - A read that goes on from a window, at most the window's length past it, reads twice as far as
 *   the window did, up to 4 MiB: a pass or a walk over headers soon reads whole windows, while a
 *   one-shot probe reads 256 KiB.
 * - A pass in whole windows reads the next window while it uses one.
 * - The windows used last are kept, up to 8 MiB, so a probe's head, tail and index stay read; a
 *   read longer than 4 MiB is a slice of its own that nothing keeps.
 * read() returns copies; views of the windows (registerViewReads) are never rewritten.
 */
export class BlobSource implements Source {
    private readonly blob: Blob;
    private readonly slice: Blob['slice'];
    readonly size: number;
    /** Windows read or being read, the most recently used first. */
    private windows: Window[] = [];
    /** Ranges asked for in this turn, read together when it ends. */
    private asked: [start: number, end: number][] = [];
    private planned?: Promise<void>;

    constructor(blob: Blob) {
        let size: number;
        let slice: Blob['slice'];
        try {
            size = blob.size;
            slice = blob.slice;
        } catch {
            throw new MediaForgeError('BlobSource requires a readable Blob', 'INPUT');
        }
        if (!Number.isSafeInteger(size) || size < 0 || typeof slice !== 'function') {
            throw new MediaForgeError(
                'BlobSource requires a non-negative safe size and slice method',
                'INPUT',
            );
        }
        this.blob = blob;
        this.slice = slice;
        this.size = size;
        this.takeHead();
        registerOwnedReads(this, BlobSource.prototype.read);
        registerViewReads(this, BlobSource.prototype.view);
        registerReleaseReads(this, () => (this.windows = []));
    }

    /**
     * Takes the head of the Blob read ahead while the reading code loaded (blob-head) as the first
     * window: in a method of its own, so that the closures the constructor registers, which live as
     * long as the source, do not hold that read.
     */
    private takeHead(): void {
        const head = blobHead(this.blob);
        const end = Math.min(this.size, SEEK);
        if (!head || !end) return;
        this.fetch(0, end, SEEK, async () => {
            try {
                const buffer = await head;
                if (bufferByteLength.call(buffer) === end) return new Uint8Array(buffer, 0, end);
            } catch {
                // Read as any other window.
            }
            return this.readBytes(0, end);
        });
    }

    read(offset: number, length: number): Promise<Uint8Array> {
        return this.windowed(offset, length, true);
    }

    /**
     * The bytes read() returns, as a view of the window that holds them: windows are never
     * changed, and the caller must not change them either.
     */
    private view(offset: number, length: number): Promise<Uint8Array> {
        return this.windowed(offset, length, false);
    }

    private async windowed(offset: number, length: number, copy: boolean): Promise<Uint8Array> {
        const end = sourceReadEnd(offset, length, this.size);
        if (end <= offset) return new Uint8Array(0);
        if (end - offset > WINDOW) return this.readBytes(offset, end);
        const parts: Window[] = [];
        if (this.held(offset, end, parts) < end) {
            this.asked.push([offset, end]);
            await (this.planned ??= Promise.resolve().then(() => this.plan()));
            // Windows dropped meanwhile (a release, later windows) leave a slice of its own.
            parts.length = 0;
            if (this.held(offset, end, parts) < end) return this.readBytes(offset, end);
        }
        for (const win of parts) this.used(win);
        const out = parts.length === 1 ? undefined : new Uint8Array(end - offset);
        for (const win of parts) {
            const bytes = win.bytes ?? (await win.read);
            const from = Math.max(offset, win.start) - win.start;
            const to = Math.min(end, win.end) - win.start;
            if (!out) return copy ? bytes.slice(from, to) : bytes.subarray(from, to);
            out.set(bytes.subarray(from, to), win.start + from - offset);
        }
        return out!;
    }

    /**
     * Where [start, end) stops being held (end or past it when all of it is), putting the windows
     * that hold it, each reaching farthest, into `parts`.
     */
    private held(start: number, end: number, parts: Window[] = []): number {
        for (let at = start; ;) {
            let found: Window | undefined;
            for (const win of this.windows)
                if (win.start <= at && at < win.end && (!found || win.end > found.end)) found = win;
            if (!found) return at;
            parts.push(found);
            if ((at = found.end) >= end) return at;
        }
    }

    /** Reads the ranges asked for in a turn, those near each other as one slice. */
    private plan(): void {
        const asked = this.asked.sort((a, b) => a[0] - b[0]);
        this.asked = [];
        this.planned = undefined;
        for (let index = 0; index < asked.length;) {
            let [start, end] = asked[index++]!;
            while (
                index < asked.length &&
                asked[index]![0] - end <= SEEK &&
                asked[index]![1] - start <= WINDOW
            )
                end = Math.max(end, asked[index++]![1]);
            for (let at; (at = this.held(start, end)) < end;) this.readGap(at, end);
        }
    }

    /** Reads a slice from `start`, which no window holds, to `end` or the next window. */
    private readGap(start: number, end: number): void {
        // The windows next to the gap bound the slice, which never reads their bytes again.
        let floor = 0;
        let ceiling = this.size;
        let from: Window | undefined;
        for (const win of this.windows) {
            if (win.end <= start) floor = Math.max(floor, win.end);
            else if (win.start > start) ceiling = Math.min(ceiling, win.start);
            if (!from && win.end <= start && start <= 2 * win.end - win.start) from = win;
        }
        const ahead = from ? Math.min(2 * from.ahead, WINDOW) : SEEK;
        const first = Math.max(floor, start - (start % ALIGN));
        const last = Math.min(ceiling, Math.max(end, first + ahead));
        const back = Math.max(0, last - ahead);
        this.fetch(Math.max(floor, Math.min(first, back - (back % ALIGN))), last, ahead);
    }

    /** Moves `win` to the front; a pass in whole windows reads the next one at a hit. */
    private used(win: Window): void {
        const at = this.windows.indexOf(win);
        if (at > 0) this.windows.unshift(...this.windows.splice(at, 1));
        if (!win.bytes || win.ahead !== WINDOW || win.next || win.end >= this.size) return;
        win.next = true;
        if (this.held(win.end, win.end + 1) === win.end)
            this.fetch(win.end, Math.min(this.size, win.end + WINDOW), WINDOW);
    }

    /** Reads [start, end) as the newest window, keeping the others up to RETAIN bytes. */
    private fetch(
        start: number,
        end: number,
        ahead: number,
        read = () => this.readBytes(start, end),
    ): void {
        const win: Window = {
            start,
            end,
            ahead,
            read: read().then(bytes => (win.bytes = bytes)),
        };
        // A failed read keeps no window; the reads waiting on it fail with it.
        win.read.catch(() => (this.windows = this.windows.filter(kept => kept !== win)));
        this.windows.unshift(win);
        let kept = 0;
        this.windows = this.windows.filter((other, index) => {
            kept += other.end - other.start;
            return !index || kept <= RETAIN;
        });
    }

    private async readBytes(start: number, end: number): Promise<Uint8Array> {
        const part = this.slice.call(this.blob, start, end);
        const read = part?.arrayBuffer;
        if (typeof read !== 'function')
            throw new IOError('BlobSource slice must provide an arrayBuffer method');
        const buffer = await read.call(part);
        try {
            if (bufferByteLength.call(buffer) !== end - start) {
                throw new IOError(
                    'BlobSource read must return exactly the requested ArrayBuffer bytes',
                );
            }
            return new Uint8Array(buffer, 0, end - start);
        } catch (error) {
            if (error instanceof IOError) throw error;
            throw new IOError('BlobSource received an invalid or detached ArrayBuffer');
        }
    }
}
