import { awaitWithAbort, isOptionalSignal, linkAbortSignals } from '../../core/io/abort';
import { throwIfAborted } from '../../core/errors/errors';
import { assertSourceBytes } from '../../core/io/sources/source-read';
import {
    DASH_U64,
    dashInvalidArgument,
    dashLimit,
    dashMalformed,
    dashOverLimit,
    dashUnsupported,
    registerDashRepresentation,
    type DashFraction,
} from './common';
import { parseSidx } from '../mp4/write/sidx';
import type { SidxIndex } from '../mp4/write/sidx';
import type {
    DashIndexRequest,
    DashManifest,
    DashRepresentation,
    DashResolveOptions,
    DashResource,
    DashSegmentInfo,
    DashTimelineEntry,
} from './types';
import {
    typedArrayBuffer as buffer,
    typedArrayByteLength as byteLength,
    typedArrayOffset as byteOffset,
} from '../../core/bytes/typed-array';

export interface DashPendingIndex {
    readonly kind: 'pending-index';
    readonly description: Omit<DashRepresentation, 'segmentInfo' | 'segmentCount'>;
    readonly index: DashIndexRequest;
    readonly exact: boolean;
    readonly timescale: number;
    readonly presentationTimeOffset: bigint;
    readonly start: DashFraction;
    readonly duration?: DashFraction;
    readonly maxSegments: number;
}

interface PreparedIndexes {
    readonly pending: readonly DashPendingIndex[];
    reserveEntries(count: number): void;
    reserveCharacters(count: number): void;
    finish(resolved: ReadonlyMap<DashPendingIndex, DashRepresentation>): DashManifest;
}

function readIndexRange(
    input: Uint8Array,
    request: DashPendingIndex,
    maximumReferences: number,
): SidxIndex {
    assertSourceBytes(input, request.index.byteRange.length, 'DASH index');
    const length: number = byteLength.call(input);
    const inputBuffer: ArrayBuffer = buffer.call(input),
        inputOffset: number = byteOffset.call(input);
    const parseAt = (start: number, size: number): SidxIndex =>
        parseSidx(new Uint8Array(inputBuffer, inputOffset + start, size), {
            offset: BigInt(request.index.byteRange.offset) + BigInt(start),
            maxReferences: maximumReferences,
        });

    if (request.exact) return parseAt(0, length);
    const view = new DataView(inputBuffer, inputOffset, length);
    let cursor = 0,
        count = 0;
    let result: SidxIndex | undefined;
    while (cursor < length) {
        if (++count > 4096) dashOverLimit('index range exceeds the 4096-box scan limit');
        if (length - cursor < 8) dashMalformed('truncated index-range box header');
        let size = view.getUint32(cursor),
            header = 8;
        const type = view.getUint32(cursor + 4);
        if (size === 1) {
            if (length - cursor < 16) dashMalformed('truncated extended index-range header');
            const extended = view.getBigUint64(cursor + 8);
            if (extended > BigInt(length - cursor))
                dashMalformed('index-range box exceeds the supplied bytes');
            size = Number(extended);
            header = 16;
        } else if (size === 0) size = length - cursor;

        if (type === 0x75756964) header += 16;
        if (size < header || size > length - cursor)
            dashMalformed('invalid index-range box boundary');
        if (type === 0x73696478) {
            if (result)
                dashUnsupported('multiple sidx boxes in one SegmentBase index are unsupported');
            result = parseAt(cursor, size);
        }

        cursor += size;
    }

    if (!result) dashMalformed('index range contains no complete sidx');
    return result;
}

function resolvedRepresentation(
    request: DashPendingIndex,
    sidx: SidxIndex,
    prepared: PreparedIndexes,
): DashRepresentation {
    const count = sidx.references.length;
    if (!count) dashMalformed('SegmentBase index contains no media references');
    if (count > request.maxSegments) dashOverLimit('SegmentBase index exceeds maxSegments');
    const scaledOffset = request.presentationTimeOffset * BigInt(sidx.timescale);
    if (scaledOffset % BigInt(request.timescale))
        dashUnsupported('SegmentBase PTO cannot be represented as integral sidx ticks');
    const presentationTimeOffset = scaledOffset / BigInt(request.timescale);
    if (presentationTimeOffset > DASH_U64)
        dashUnsupported('normalized SegmentBase PTO exceeds uint64');
    for (const reference of sidx.references) {
        if (reference.referenceType !== 0)
            dashUnsupported('hierarchical sidx references are unsupported for media planning');
        if (!reference.size || reference.duration <= 0n)
            dashMalformed('sidx media references require positive size and duration');
        if (reference.offset + BigInt(reference.size) > BigInt(Number.MAX_SAFE_INTEGER))
            dashUnsupported('sidx byte range exceeds safe integer precision');
    }

    prepared.reserveEntries(count);
    prepared.reserveCharacters(request.index.url.length * count);
    const resources: DashResource[] = [];
    const entries: Array<{ time: bigint; duration: bigint; repeat: bigint }> = [];
    for (const reference of sidx.references) {
        const previous = entries.at(-1);
        if (previous?.duration === reference.duration) previous.repeat++;
        else {
            prepared.reserveEntries(1);
            entries.push({ time: reference.time, duration: reference.duration, repeat: 0n });
        }
        resources.push(
            Object.freeze({
                url: request.index.url,
                byteRange: Object.freeze({
                    offset: Number(reference.offset),
                    length: reference.size,
                }),
            }),
        );
    }

    const timeline: readonly DashTimelineEntry[] = Object.freeze(
        entries.map(entry => Object.freeze(entry)),
    );
    const segmentInfo: DashSegmentInfo = Object.freeze({
        type: 'list',
        sourceType: 'segment-base',
        index: request.index,
        sidx,
        timescale: sidx.timescale,
        presentationTimeOffset,
        startNumber: 1n,
        timeline,
        resources: Object.freeze(resources),
    });

    return registerDashRepresentation(
        { ...request.description, segmentInfo, segmentCount: BigInt(count) },
        { start: request.start, duration: request.duration, maxSegments: request.maxSegments },
    );
}

export async function resolveDashIndexes(
    options: DashResolveOptions,
    prepare: () => PreparedIndexes,
): Promise<DashManifest> {
    if (!options || typeof options !== 'object' || Array.isArray(options))
        dashInvalidArgument('invalid resolve options');
    const { readIndex, signal, maxIndexBytes, maxIndexReferences, maxIndexRequests } = options;
    if (typeof readIndex !== 'function') dashInvalidArgument('readIndex callback is required');
    if (!isOptionalSignal(signal)) dashInvalidArgument('invalid AbortSignal');

    const bytesLimit = dashLimit(maxIndexBytes, 8 * 1024 * 1024, 'maxIndexBytes', 64 * 1024 * 1024);
    const referencesLimit = dashLimit(maxIndexReferences, 200000, 'maxIndexReferences', 1000000);
    const requestsLimit = dashLimit(maxIndexRequests, 256, 'maxIndexRequests', 4096);
    const linked = linkAbortSignals(signal);
    try {
        throwIfAborted(linked.signal);
        const prepared = prepare();
        throwIfAborted(linked.signal);
        if (prepared.pending.length > requestsLimit)
            dashOverLimit('manifest exceeds maxIndexRequests');
        let declaredBytes = 0;
        for (const request of prepared.pending) {
            const length = request.index.byteRange.length;
            if (length < 32) dashMalformed('index range is shorter than a sidx');
            if (length > 1048576) dashOverLimit('index range exceeds 1048576 bytes');
            declaredBytes += length;
            if (declaredBytes > bytesLimit) dashOverLimit('manifest exceeds maxIndexBytes');
        }

        const resolved = new Map<DashPendingIndex, DashRepresentation>();
        let references = 0;
        for (const request of prepared.pending) {
            throwIfAborted(linked.signal);
            if (references >= referencesLimit) dashOverLimit('manifest exceeds maxIndexReferences');
            const pending = readIndex(request.index, linked.signal);
            const data = await awaitWithAbort(Promise.resolve(pending), linked.signal);
            throwIfAborted(linked.signal);
            const sidx = readIndexRange(
                data,
                request,
                Math.min(65535, referencesLimit - references),
            );

            references += sidx.references.length;
            resolved.set(request, resolvedRepresentation(request, sidx, prepared));
            throwIfAborted(linked.signal);
        }

        return prepared.finish(resolved);
    } finally {
        linked.dispose();
    }
}
