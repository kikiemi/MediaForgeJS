import { isOptionalSignal, linkAbortSignals } from '../../../core/io/abort';
import { DiagnosticContext } from '../../../core/errors/diagnostics';
import type { DiagnosticOptions, MediaDiagnostic } from '../../../core/errors/diagnostics';
import { DemuxError, MediaForgeError, throwIfAborted } from '../../../core/errors/errors';
import { StreamByteReader, TruncatedByteStreamError } from './byte-reader';
import type { ByteStreamInput } from './byte-reader';
import { dataView, fourcc } from '../../../core/bytes/byte-fields';

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

interface Settings extends DiagnosticOptions {
    signal?: AbortSignal;
    maxBoxBytes: number;
    maxSegmentBytes: number;
    maxBoxes: number;
    maxInputChunkBytes: number;
    maxEmptyChunks: number;
}

interface BoxRange {
    type: string;
    start: number;
    end: number;
    headerSize: number;
}

interface ScanState {
    count: number;
    complete: number;
    truncated: boolean;
}

function requireValue(value: unknown, message: string): asserts value {
    if (!value) throw new DemuxError(`MP4 stream: ${message}`);
}

function limit(
    value: number | undefined,
    fallback: number,
    name: string,
    min = 1,
    max = 0x7fffffff,
): number {
    const result = value ?? fallback;
    if (!Number.isSafeInteger(result) || result < min || result > max) {
        throw new MediaForgeError(
            `MP4 stream ${name} must be an integer in ${min}..${max}`,
            'INPUT',
        );
    }
    return result;
}

function settings(options: Mp4StreamOptions): Settings {
    if (!options || typeof options !== 'object' || Array.isArray(options))
        throw new MediaForgeError('Invalid MP4 stream options', 'INPUT');
    const {
        signal,
        maxBoxBytes,
        maxSegmentBytes,
        maxBoxes,
        maxInputChunkBytes,
        maxEmptyChunks,
        validation,
        onWarning,
        maxWarnings,
    } = options;

    if (!isOptionalSignal(signal))
        throw new MediaForgeError('Invalid MP4 stream AbortSignal', 'INPUT');

    return {
        signal,
        validation,
        onWarning,
        maxWarnings,
        maxBoxBytes: limit(maxBoxBytes, 64 * 1024 * 1024, 'maxBoxBytes', 8),
        maxSegmentBytes: limit(maxSegmentBytes, 128 * 1024 * 1024, 'maxSegmentBytes', 16),
        maxBoxes: limit(maxBoxes, 100_000, 'maxBoxes', 1, Number.MAX_SAFE_INTEGER),
        maxInputChunkBytes: limit(maxInputChunkBytes, 16 * 1024 * 1024, 'maxInputChunkBytes'),
        maxEmptyChunks: limit(maxEmptyChunks, 1024, 'maxEmptyChunks', 0),
    };
}

function streamIterator<T>(
    input: Mp4ByteInput,
    options: Mp4StreamOptions,
    walk: (
        reader: StreamByteReader,
        config: Settings,
        context: DiagnosticContext,
    ) => AsyncGenerator<T, void>,
): Mp4StreamIterator<T> {
    const config = settings(options);
    const context = new DiagnosticContext(config, 'strict');
    const controller = new AbortController();
    const run = async function* (): AsyncGenerator<T, void> {
        const linked = linkAbortSignals(controller.signal, config.signal);
        let reader: StreamByteReader | undefined;
        let failure: unknown;
        try {
            throwIfAborted(linked.signal);
            reader = new StreamByteReader(
                input,
                linked.signal,
                config.maxInputChunkBytes,
                config.maxEmptyChunks,
            );
            yield* walk(reader, config, context);
            reader.checkAbort();
        } catch (error) {
            failure = error;
            throw error;
        } finally {
            reader?.close(failure);
            linked.dispose();
        }
    };

    const iterator = run();
    return {
        [Symbol.asyncIterator]() {
            return this;
        },
        get diagnostics() {
            return context.warnings;
        },
        get suppressedWarnings() {
            return context.suppressedWarnings;
        },
        next: () => {
            const next = iterator.next();
            void next.catch(() => undefined);
            return next;
        },
        return: async () => {
            controller.abort();
            try {
                return await iterator.return();
            } catch (error) {
                if (error instanceof MediaForgeError && error.code === 'ABORT')
                    return { done: true, value: undefined };
                throw error;
            }
        },
        throw: async (error?: unknown) => {
            controller.abort(error);
            return iterator.throw(error);
        },
    };
}

async function readBox(
    reader: StreamByteReader,
    config: Settings,
    state: ScanState,
    remaining: number,
): Promise<Mp4StreamBox | undefined> {
    const offset = reader.position;
    const first = await reader.read(8, true);
    if (!first) return undefined;
    if (++state.count > config.maxBoxes)
        throw new MediaForgeError('MP4 input exceeds maxBoxes', 'OOM');
    const view = new DataView(first.buffer);
    let size = view.getUint32(0);
    const type = fourcc(first, 4);
    let header = first;
    let headerSize = 8;
    const maximum = Math.min(config.maxBoxBytes, remaining);
    if (size === 1) {
        const extended = (await reader.read(8))!;
        const value = new DataView(extended.buffer).getBigUint64(0);
        if (value > BigInt(maximum))
            throw new MediaForgeError('MP4 extended box exceeds the configured byte limit', 'OOM');
        size = Number(value);
        headerSize = 16;
        header = new Uint8Array(16);
        header.set(first);
        header.set(extended, 8);
        requireValue(size >= headerSize, 'extended box size is smaller than its header');
    }

    const toEnd = view.getUint32(0) === 0;
    if (type === 'uuid') headerSize += 16;
    requireValue(toEnd || size >= headerSize, `${type} box size is smaller than its header`);
    if (headerSize > maximum || (!toEnd && size > maximum))
        throw new MediaForgeError('MP4 box exceeds maxBoxBytes or maxSegmentBytes', 'OOM');
    if (type === 'uuid') {
        const uuid = (await reader.read(16))!;
        const combined = new Uint8Array(headerSize);
        combined.set(header);
        combined.set(uuid, header.length);
        header = combined;
    }

    let data: Uint8Array;
    if (toEnd) {
        data = await reader.toEnd(header, maximum);
        size = data.length;
    } else {
        data = new Uint8Array(size);
        data.set(header);
        await reader.fill(data, headerSize, size - headerSize);
    }

    reader.checkAbort();
    state.complete++;
    return { type, offset, size, headerSize, data };
}

function truncated(
    error: unknown,
    reader: StreamByteReader,
    state: ScanState,
    context: DiagnosticContext,
): boolean {
    if (!(error instanceof TruncatedByteStreamError) || state.complete === 0) return false;
    context.recover({
        code: 'MP4_TRUNCATED_BOX',
        message: error.message,
        format: 'mp4',
        offset: error.offset,
    });
    reader.checkAbort();
    state.truncated = true;
    return true;
}

/**
 * Yields owned complete boxes as bytes arrive; defaults to strict validation. Returning early
 * cancels the input.
 */
export function iterateMp4Boxes(
    input: Mp4ByteInput,
    options: Mp4StreamOptions = {},
): Mp4StreamIterator<Mp4StreamBox> {
    return streamIterator(input, options, async function* (reader, config, context) {
        const state = { count: 0, complete: 0, truncated: false };
        while (true) {
            let box: Mp4StreamBox | undefined;
            try {
                box = await readBox(reader, config, state, config.maxBoxBytes);
            } catch (error) {
                if (truncated(error, reader, state, context)) return;
                throw error;
            }
            if (!box) return;
            yield box;
            reader.checkAbort();
        }
    });
}

function* children(data: Uint8Array, start: number, end: number): IterableIterator<BoxRange> {
    const view = dataView(data);
    while (start < end) {
        requireValue(end - start >= 8, 'truncated child box header');
        const type = fourcc(data, start + 4);
        let size = view.getUint32(start);
        let headerSize = 8;
        if (size === 1) {
            requireValue(end - start >= 16, 'truncated extended child header');
            const extended = view.getBigUint64(start + 8);
            requireValue(extended <= BigInt(end - start), 'child box extends outside its parent');
            size = Number(extended);
            headerSize = 16;
        } else if (size === 0) size = end - start;
        if (type === 'uuid') headerSize += 16;
        requireValue(size >= headerSize && size <= end - start, 'invalid child box boundary');
        yield { type, start, end: start + size, headerSize };
        start += size;
    }
}

function one(data: Uint8Array, parent: BoxRange, type: string): BoxRange {
    let found: BoxRange | undefined;
    for (const box of children(data, parent.start + parent.headerSize, parent.end)) {
        if (box.type !== type) continue;
        requireValue(!found, `duplicate ${type} box`);
        found = box;
    }
    requireValue(found, `missing ${type} box`);
    return found;
}

function full(
    data: Uint8Array,
    box: BoxRange,
    bytes: number,
    versions: readonly number[] = [0],
): number {
    const start = box.start + box.headerSize;
    requireValue(
        box.end - start >= bytes && versions.includes(data[start]!),
        `invalid ${box.type} version or size`,
    );
    return start;
}

function initDefaults(box: Mp4StreamBox): Map<number, number> {
    const data = box.data;
    const view = new DataView(data.buffer);
    const root: BoxRange = { type: 'moov', start: 0, end: data.length, headerSize: box.headerSize };
    const mvex = one(data, root, 'mvex');
    const tracks = new Set<number>();
    for (const trak of children(data, box.headerSize, data.length)) {
        if (trak.type !== 'trak') continue;
        const tkhd = one(data, trak, 'tkhd');
        const start = full(data, tkhd, 4, [0, 1]);
        requireValue(tkhd.end - start >= (data[start] === 1 ? 96 : 84), 'truncated track header');
        const id = view.getUint32(start + (data[start] === 1 ? 20 : 12));
        requireValue(id > 0 && !tracks.has(id), 'invalid or repeated track ID');
        tracks.add(id);
        const stbl = one(data, one(data, one(data, trak, 'mdia'), 'minf'), 'stbl');
        for (const table of children(data, stbl.start + stbl.headerSize, stbl.end)) {
            if (['stsz', 'stz2'].includes(table.type)) {
                const at = full(data, table, 12);
                requireValue(
                    view.getUint32(at + 8) === 0,
                    'progressive MP4 is not supported; pass fragmented MP4',
                );
            } else if (['stts', 'ctts', 'stsc', 'stco', 'co64'].includes(table.type)) {
                const at = full(data, table, 8, table.type === 'ctts' ? [0, 1] : [0]);
                requireValue(
                    view.getUint32(at + 4) === 0,
                    'progressive MP4 is not supported; pass fragmented MP4',
                );
            }
        }
    }

    requireValue(tracks.size > 0, 'initialization has no tracks');
    const defaults = new Map<number, number>();
    for (const trex of children(data, mvex.start + mvex.headerSize, mvex.end)) {
        if (trex.type !== 'trex') continue;
        const at = full(data, trex, 24);
        const id = view.getUint32(at + 4);
        requireValue(tracks.has(id) && !defaults.has(id), 'invalid or repeated trex track ID');
        defaults.set(id, view.getUint32(at + 16));
    }

    requireValue(
        defaults.size === tracks.size,
        'every initialization track must have trex defaults',
    );
    return defaults;
}

function validateFragment(
    moof: Mp4StreamBox,
    mdat: Mp4StreamBox,
    defaults: Map<number, number>,
): void {
    const data = moof.data;
    const view = new DataView(data.buffer);
    const root: BoxRange = {
        type: 'moof',
        start: 0,
        end: data.length,
        headerSize: moof.headerSize,
    };

    const mfhd = one(data, root, 'mfhd');
    full(data, mfhd, 8);
    const payloadStart = moof.size + mdat.headerSize;
    const payloadEnd = moof.size + mdat.size;
    let samples = 0;
    for (const traf of children(data, moof.headerSize, data.length)) {
        if (traf.type !== 'traf') continue;
        const tfhd = one(data, traf, 'tfhd');
        let at = full(data, tfhd, 8);
        const flags = view.getUint32(at) & 0xffffff;
        const id = view.getUint32(at + 4);
        requireValue(defaults.has(id), 'fragment references an undeclared track');
        requireValue(
            (flags & 0x020000) !== 0 && !(flags & 1),
            'fragment must use default-base-is-moof',
        );
        requireValue((flags & ~0x03003a) === 0, 'unsupported tfhd flags');
        at += 8;
        if (flags & 2) at += 4;
        if (flags & 8) at += 4;
        let size = defaults.get(id)!;
        if (flags & 16) {
            requireValue(at + 4 <= tfhd.end, 'truncated tfhd default sample size');
            size = view.getUint32(at);
            at += 4;
        }

        if (flags & 32) at += 4;
        requireValue(at === tfhd.end, 'invalid tfhd fields');
        const tfdt = one(data, traf, 'tfdt');
        const time = full(data, tfdt, 8, [0, 1]);
        requireValue(tfdt.end - time === (data[time] === 1 ? 12 : 8), 'invalid tfdt size');
        let end: number | undefined;
        let runs = 0;
        for (const trun of children(data, traf.start + traf.headerSize, traf.end)) {
            if (trun.type !== 'trun') continue;
            runs++;
            at = full(data, trun, 8, [0, 1]);
            const fields = view.getUint32(at) & 0xffffff;
            const count = view.getUint32(at + 4);
            requireValue((fields & ~0x000f05) === 0, 'unsupported trun flags');
            requireValue(
                !(flags & 0x010000) || count === 0,
                'duration-is-empty fragment contains samples',
            );
            at += 8;
            let start = end;
            if (fields & 1) {
                requireValue(at + 4 <= trun.end, 'truncated trun offset');
                start = view.getInt32(at);
                at += 4;
            }

            if (fields & 4) at += 4;
            const stride = [0x100, 0x200, 0x400, 0x800].reduce(
                (sum, bit) => sum + (fields & bit ? 4 : 0),
                0,
            );
            requireValue(at + count * stride === trun.end, 'invalid trun sample table length');
            requireValue(
                start !== undefined,
                'first trun must declare its moof-relative data offset',
            );
            let bytes = count * size;
            if (fields & 0x200) {
                bytes = 0;
                const sizeAt = at + (fields & 0x100 ? 4 : 0);
                for (let index = 0; index < count; index++)
                    bytes += view.getUint32(sizeAt + index * stride);
            }

            end = start + bytes;
            requireValue(
                Number.isSafeInteger(end) && start >= payloadStart && end <= payloadEnd,
                'fragment sample data lies outside its one mdat',
            );
            samples += count;
        }

        requireValue(runs > 0, 'track fragment has no trun');
    }

    requireValue(samples > 0, 'fragment has no samples');
}

function segment(
    kind: 'init' | 'media',
    boxes: readonly Mp4StreamBox[],
    length: number,
): CmafStreamSegment {
    const data = new Uint8Array(length);
    let at = 0;
    for (const box of boxes) {
        data.set(box.data, at);
        at += box.size;
    }
    return { kind, offset: boxes[0]!.offset, byteLength: length, data };
}

/**
 * Yields ftyp/moov initialization and complete moof/mdat units before EOF. Requires relative
 * fragment data offsets.
 */
export function readCmafSegments(
    input: Mp4ByteInput,
    options: Mp4StreamOptions = {},
): Mp4StreamIterator<CmafStreamSegment> {
    return streamIterator(input, options, async function* (reader, config, context) {
        const state: ScanState = { count: 0, complete: 0, truncated: false };
        let pending: Mp4StreamBox[] = [];
        let bytes = 0;
        let ftyp = false;
        let defaults: Map<number, number> | undefined;
        let moof: Mp4StreamBox | undefined;
        let trailer = false;
        while (true) {
            let box: Mp4StreamBox | undefined;
            try {
                box = await readBox(reader, config, state, config.maxSegmentBytes - bytes);
            } catch (error) {
                if (!defaults || !truncated(error, reader, state, context)) throw error;
                break;
            }

            if (!box) break;
            if (trailer)
                requireValue(
                    box.type === 'free' || box.type === 'skip',
                    'boxes follow the terminal fragment index',
                );

            if (box.type === 'mfra' || trailer) {
                requireValue(
                    defaults && pending.length === 0,
                    'fragment index interrupts an unfinished segment',
                );
                context.warn({
                    code: 'MP4_TRAILER_OMITTED',
                    message: `Terminal ${box.type} box is omitted from media segments`,
                    format: 'mp4',
                    offset: box.offset,
                });
                reader.checkAbort();
                trailer = true;
                continue;
            }

            if (moof)
                requireValue(box.type === 'mdat', 'moof must be followed immediately by one mdat');
            if (box.type === 'ftyp') {
                requireValue(!ftyp && !defaults && !moof, 'repeated or misplaced ftyp');
                requireValue(
                    box.size - box.headerSize >= 8 && (box.size - box.headerSize) % 4 === 0,
                    'invalid ftyp brands',
                );
                ftyp = true;
            } else if (box.type === 'moov') {
                requireValue(
                    ftyp && !defaults && !moof,
                    'moov requires one preceding ftyp initialization',
                );
                defaults = initDefaults(box);
            } else if (box.type === 'moof') {
                requireValue(defaults && !moof, 'media fragment precedes initialization');
                moof = box;
            } else if (box.type === 'mdat') {
                requireValue(defaults && moof, 'orphan mdat or progressive MP4 is not supported');
                validateFragment(moof, box, defaults);
            } else if (
                !['styp', 'emsg', 'prft', 'sidx', 'free', 'skip', 'wide'].includes(box.type)
            ) {
                context.recover({
                    code: 'MP4_UNKNOWN_BOX',
                    message: `Retaining unknown optional ${box.type} box`,
                    format: 'mp4',
                    offset: box.offset,
                });
                reader.checkAbort();
            } else if (['styp', 'emsg', 'prft', 'sidx'].includes(box.type)) {
                requireValue(defaults, `${box.type} precedes initialization`);
            }

            pending.push(box);
            bytes += box.size;
            if (box.type === 'moov' || box.type === 'mdat') {
                const output = segment(box.type === 'moov' ? 'init' : 'media', pending, bytes);
                pending = [];
                bytes = 0;
                moof = undefined;
                yield output;
                reader.checkAbort();
            }
        }

        requireValue(defaults, 'stream has no complete fragmented MP4 initialization');
        if (pending.length && !state.truncated) {
            const padding = pending.every(box => ['free', 'skip', 'wide'].includes(box.type));
            const diagnostic = {
                code: padding ? 'MP4_PADDING_OMITTED' : 'MP4_TRUNCATED_FRAGMENT',
                message: padding
                    ? 'Trailing padding boxes are omitted from media segments'
                    : 'Dropping an unfinished final media segment',
                format: 'mp4',
                offset: pending[0]!.offset,
            };

            if (padding) context.warn(diagnostic);
            else context.recover(diagnostic);
            reader.checkAbort();
        }
    });
}
