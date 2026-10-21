import type { Sample } from '../../../core/model/track';
import { DemuxError, throwIfAborted } from '../../../core/errors/errors';
import { demuxAssert, malformedInput } from '../../../core/errors/demux-guard';
import { yieldEventLoop } from '../../../core/io/event-loop';
import { leastCompositionShift, shiftedSeconds } from './sample-index';
import {
    findBox,
    forEachGroupedSample,
    preRollGroups,
    readFullBoxVersion,
    readU32,
    type Box,
} from './boxes';
import { sampleTableNotes, type Mp4ReadContext } from './descriptions';
import type { SampleDescriptions } from './read-types';

/**
 * The sample table boxes of a track: sizes (stsz or stz2), chunk offsets, layout and timing, the
 * rest optional.
 */
export interface SampleTableBoxes {
    readonly stsz: Box | null;
    readonly stz2: Box | null;
    readonly stco: Box;
    readonly stts: Box;
    readonly stsc: Box;
    readonly stss: Box | null;
    readonly ctts: Box | null;
}

/**
 * Every sample of a track's tables as an object: the reading of tracks that switch sample
 * descriptions, of legacy signed composition offsets (cslg), and of callers that keep no compact
 * index. `recovered` is true when samples past the media were dropped.
 */
export async function readSampleArray(
    context: Mp4ReadContext,
    buf: Uint8Array,
    dv: DataView,
    stbl: { readonly start: number; readonly end: number },
    tables: SampleTableBoxes,
    sampleCount: number,
    timescale: number,
    editShiftSeconds: number,
    pcmFrameBytes: number,
    descriptions: SampleDescriptions | undefined,
    /** A text track, whose zero stts deltas are instants (see the compact index's `instants`). */
    instants = false,
): Promise<{ samples: Sample[]; recovered: boolean }> {
    const { stsz, stz2, stco, stts, stsc, stss, ctts } = tables;
    const { budget, validation, signal } = context;
    const notes = sampleTableNotes(context);
    const switching = !!descriptions?.configurations;
    const isLargeOffset = stco.type === 'co64';
    const breathe = async (): Promise<void> => {
        await yieldEventLoop();
        throwIfAborted(signal);
    };
    if (context.compactClassic) budget.reserveBytes(sampleCount * 256, 'MP4 classic sample tables');
    const sizes = new Uint32Array(sampleCount);
    if (stsz) {
        const defaultSize = readU32(dv, stsz.offset + 12);
        if (defaultSize > 0) {
            if (!(validation === 'compatible' || sampleCount * defaultSize <= context.source.size))
                malformedInput(
                    `stsz claims ${sampleCount}x${defaultSize} bytes but the file has ` +
                        `${context.source.size}`,
                );
            sizes.fill(defaultSize);
        } else {
            demuxAssert(20 + sampleCount * 4 <= stsz.size, 'stsz table exceeds its box');
            for (let i = 0; i < sampleCount; i++) {
                if ((i & 0x7fff) === 0) await breathe();
                sizes[i] = readU32(dv, stsz.offset + 20 + i * 4);
            }
        }
    } else {
        const fieldSize = buf[stz2!.offset + 15];
        if (!(fieldSize === 4 || fieldSize === 8 || fieldSize === 16))
            malformedInput(`stz2 field size ${fieldSize}`);
        const tableBytes = Math.ceil((sampleCount * fieldSize) / 8);
        demuxAssert(20 + tableBytes <= stz2!.size, 'stz2 table exceeds its box');
        const base = stz2!.offset + 20;
        for (let i = 0; i < sampleCount; i++) {
            if ((i & 0x7fff) === 0) await breathe();
            if (fieldSize === 16) sizes[i] = dv.getUint16(base + i * 2, false);
            else if (fieldSize === 8) sizes[i] = buf[base + i]!;
            else sizes[i] = i & 1 ? buf[base + (i >> 1)]! & 0x0f : buf[base + (i >> 1)]! >> 4;
        }
    }

    const chunkCount = readU32(dv, stco.offset + 12);
    budget.checkSamples(chunkCount, 'MP4 table entries');
    budget.reserveBytes(Math.max(0, chunkCount - sampleCount) * 8, 'MP4 chunk-offset index');
    if (!(16 + chunkCount * (isLargeOffset ? 8 : 4) <= stco.size))
        malformedInput(`${stco.type} table exceeds its box`);
    const chunkOffsets = new Float64Array(chunkCount);
    for (let i = 0; i < chunkCount; i++) {
        if ((i & 0x7fff) === 0) await breathe();
        if (isLargeOffset) {
            const hi = readU32(dv, stco.offset + 16 + i * 8);
            const lo = readU32(dv, stco.offset + 20 + i * 8);
            chunkOffsets[i] = hi * 0x100000000 + lo;
        } else {
            chunkOffsets[i] = readU32(dv, stco.offset + 16 + i * 4);
        }
    }

    const stscEntryCount = readU32(dv, stsc.offset + 12);
    budget.checkSamples(stscEntryCount, 'MP4 table entries');
    budget.reserveBytes(Math.max(0, stscEntryCount - sampleCount) * 8, 'MP4 chunk-layout index');
    demuxAssert(16 + stscEntryCount * 12 <= stsc.size, 'stsc table exceeds its box');
    demuxAssert(
        stscEntryCount > 0 || sampleCount === 0,
        'stsc has no entries for a non-empty track',
    );
    demuxAssert(readU32(dv, stsc.offset + 16) === 1, 'stsc first entry must start at chunk 1');
    const stscFirstChunk = new Uint32Array(stscEntryCount);
    const stscSamplesPerChunk = new Uint32Array(stscEntryCount);
    const stscConfig = new Int32Array(stscEntryCount);
    const configIndex = descriptions?.configIndex ?? Int32Array.of(0);
    for (let i = 0; i < stscEntryCount; i++) {
        stscFirstChunk[i] = readU32(dv, stsc.offset + 16 + i * 12);
        stscSamplesPerChunk[i] = readU32(dv, stsc.offset + 20 + i * 12);
        const sampleDescriptionIndex = readU32(dv, stsc.offset + 24 + i * 12);
        demuxAssert(
            stscFirstChunk[i]! > 0 && stscFirstChunk[i]! <= chunkCount,
            'stsc first_chunk is outside the chunk table',
        );
        demuxAssert(
            stscSamplesPerChunk[i]! > 0 || sampleCount === 0 || validation !== 'strict',
            'stsc samples_per_chunk is zero',
        );
        stscConfig[i] = configIndex[sampleDescriptionIndex - 1] ?? -1;
        if (!(stscConfig[i]! >= 0))
            malformedInput(
                `stsc selects unsupported sample_description_index ${sampleDescriptionIndex}`,
            );
        if (i > 0) {
            demuxAssert(
                stscFirstChunk[i]! > stscFirstChunk[i - 1]!,
                'stsc first_chunk not increasing',
            );
        }
    }

    const dtsList = new Float64Array(sampleCount);
    const durations = new Uint32Array(sampleCount);
    const sttsEntryCount = readU32(dv, stts.offset + 12);
    budget.checkSamples(sttsEntryCount, 'MP4 table entries');
    demuxAssert(16 + sttsEntryCount * 8 <= stts.size, 'stts table exceeds its box');
    let dts = 0;
    let dtsLength = 0;
    for (let i = 0; i < sttsEntryCount; i++) {
        let count = readU32(dv, stts.offset + 16 + i * 8);
        if (count > sampleCount - dtsLength) {
            demuxAssert(
                validation !== 'strict' && i === sttsEntryCount - 1,
                'stts covers more samples than the track',
            );
            notes.timingExcess(count - (sampleCount - dtsLength));
            count = sampleCount - dtsLength;
        }
        const delta = readU32(dv, stts.offset + 20 + i * 8);
        for (let j = 0; j < count; j++) {
            if ((dtsLength & 0x7fff) === 0) await breathe();
            dtsList[dtsLength] = dts;
            durations[dtsLength] = delta;
            dts += delta;
            dtsLength++;
        }
    }
    if (dtsLength < sampleCount && dtsLength > 0 && validation !== 'strict') {
        notes.timingShort(sampleCount - dtsLength);
        const delta = durations[dtsLength - 1]!;
        for (; dtsLength < sampleCount; dtsLength++) {
            if ((dtsLength & 0x7fff) === 0) await breathe();
            dtsList[dtsLength] = dts;
            durations[dtsLength] = delta;
            dts += delta;
        }
    }
    if (!(dtsLength === sampleCount))
        malformedInput(`stts covers ${dtsLength}/${sampleCount} samples`);

    const compositionVersion = ctts ? readFullBoxVersion(buf, ctts, 16, 16) : 0;

    // Legacy QuickTime can store signed offsets in version-0 ctts. Only accept
    // this interpretation when an intact cslg explicitly describes that range.
    const cslg =
        ctts && compositionVersion === 0 ? findBox(buf, stbl.start, stbl.end, 'cslg') : null;
    let decodeShift = 0;
    let signedComposition = compositionVersion === 1;
    let leastComposition = 0;
    let greatestComposition = 0;
    if (cslg && cslg.size >= 32 && buf[cslg.offset + 8] === 0) {
        leastComposition = dv.getInt32(cslg.offset + 16, false);
        greatestComposition = dv.getInt32(cslg.offset + 20, false);
        if (leastComposition < 0) {
            decodeShift = dv.getInt32(cslg.offset + 12, false);
            demuxAssert(
                decodeShift >= -leastComposition && greatestComposition >= leastComposition,
                'cslg has an invalid composition range or decode shift',
            );
            context.recover({
                code: 'MP4_SIGNED_CTTS',
                message: 'Read legacy signed composition offsets with the cslg shift',
                format: 'mp4',
            });
            signedComposition = true;
        }
    }
    const compositionOffsets = signedComposition
        ? new Int32Array(sampleCount)
        : new Uint32Array(sampleCount);
    if (ctts) {
        const entryCount = readU32(dv, ctts.offset + 12);
        budget.checkSamples(entryCount, 'MP4 table entries');
        demuxAssert(16 + entryCount * 8 <= ctts.size, 'ctts table exceeds its box');
        let sampleIndex = 0;
        for (let i = 0; i < entryCount; i++) {
            if ((i & 0x7fff) === 0) await breathe();
            const count = readU32(dv, ctts.offset + 16 + i * 8);
            const offset = signedComposition
                ? dv.getInt32(ctts.offset + 20 + i * 8, false)
                : readU32(dv, ctts.offset + 20 + i * 8);
            if (decodeShift > 0)
                demuxAssert(
                    offset >= leastComposition && offset <= greatestComposition,
                    'ctts composition offset exceeds the cslg range',
                );
            if (count > sampleCount - sampleIndex) {
                demuxAssert(validation !== 'strict', 'ctts covers more samples than the track');
                notes.compositionExcess(count - (sampleCount - sampleIndex));
            }
            for (let j = 0; j < count && sampleIndex < sampleCount; j++, sampleIndex++) {
                if ((sampleIndex & 0x7fff) === 0) await breathe();
                compositionOffsets[sampleIndex] = offset;
            }
        }
        if (!(sampleIndex === sampleCount))
            malformedInput(`ctts covers ${sampleIndex}/${sampleCount} samples`);
        if (decodeShift === 0) decodeShift = leastCompositionShift(compositionOffsets);
    }

    let keyframeFlags: Uint8Array | null = null;
    const stps = stss && findBox(buf, stbl.start, stbl.end, 'stps');
    for (const table of stps ? [stss!, stps] : stss ? [stss] : []) {
        const ssCount = readU32(dv, table.offset + 12);
        budget.checkSamples(ssCount, 'MP4 table entries');
        if (!(table.size >= 16 && 16 + ssCount * 4 <= table.size))
            malformedInput(`${table.type} table exceeds its box`);
        keyframeFlags ??= new Uint8Array(sampleCount);
        let previousSync = 0;
        let ignored = 0;
        for (let i = 0; i < ssCount; i++) {
            const sampleNumber = readU32(dv, table.offset + 16 + i * 4);
            if (!(sampleNumber > previousSync && sampleNumber <= sampleCount)) {
                if (!(validation !== 'strict'))
                    malformedInput(`${table.type} entries must increase within the sample count`);
                ignored++;
                continue;
            }
            keyframeFlags[sampleNumber - 1] = 1;
            previousSync = sampleNumber;
        }
        if (ignored) notes.syncIgnored(table.type, ignored);
    }
    const preRoll = keyframeFlags && preRollGroups(buf, stbl.start, stbl.end);
    if (preRoll)
        forEachGroupedSample(dv, preRoll, sampleCount, member => {
            keyframeFlags![member - 1] = 1;
        });

    const sampleOffsets = new Float64Array(sampleCount);
    const sampleConfigs = switching ? new Uint8Array(sampleCount) : null;
    let sampleIdx = 0;
    let stscIndex = 0;
    for (let ci = 0; ci < chunkCount; ci++) {
        if ((ci & 0x7fff) === 0) await breathe();
        const oneBasedChunk = ci + 1;
        while (stscIndex + 1 < stscEntryCount && stscFirstChunk[stscIndex + 1]! <= oneBasedChunk)
            stscIndex++;
        const samplesInChunk = stscEntryCount > 0 ? stscSamplesPerChunk[stscIndex]! : 1;
        demuxAssert(
            samplesInChunk <= sampleCount - sampleIdx,
            'stsc/stco cover more samples than the track',
        );
        let off = chunkOffsets[ci]!;
        for (let s = 0; s < samplesInChunk && sampleIdx < sampleCount; s++) {
            if (sampleConfigs) sampleConfigs[sampleIdx] = stscConfig[stscIndex]!;
            sampleOffsets[sampleIdx] = off;
            off += sizes[sampleIdx]!;
            sampleIdx++;
        }
    }

    if (!(sampleIdx === sampleCount))
        malformedInput(`stsc/stco cover ${sampleIdx}/${sampleCount} samples`);
    if (sampleCount >= 4096) {
        let declared = 0;
        for (let i = 0; i < sampleCount; i++) declared += sizes[i]!;

        demuxAssert(
            declared / sampleCount >= 2 || declared === sampleCount * pcmFrameBytes,
            'MP4 sample table implausibly small (ledger-flood input)',
        );
    }

    const fileSize = context.source.size;
    const fallbackDuration = Math.max(1, Math.round(timescale / 1000));
    let availableSamples: Uint8Array | undefined;
    let missingSamples = 0;
    let firstMissingOffset = 0;
    for (let i = 0; i < sampleCount; i++) {
        if ((i & 0x7fff) === 0) await breathe();
        const offset = sampleOffsets[i]!;
        const size = sizes[i]!;
        if (!(Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(offset + size)))
            malformedInput(`sample ${i} has an invalid byte range`);
        if (!context.fitsMedia(offset, size)) {
            if (validation === 'strict') {
                throw new DemuxError(`sample ${i} spans ${offset}+${size} past EOF ${fileSize}`);
            }
            if (!availableSamples) {
                availableSamples = new Uint8Array(sampleCount).fill(1);
                firstMissingOffset = offset;
            }
            availableSamples[i] = 0;
            missingSamples++;
        }
        if (durations[i] === 0 && !instants) {
            const nextDelta = i + 1 < sampleCount ? dtsList[i + 1]! - dtsList[i]! : 0;
            durations[i] =
                nextDelta > 0
                    ? Math.min(0xffffffff, Math.round(nextDelta))
                    : i > 0 && durations[i - 1]! > 0
                      ? durations[i - 1]!
                      : fallbackDuration;
        }
    }

    if (missingSamples > 0)
        context.recover({
            code: 'MP4_TRUNCATED_SAMPLES',
            message: `Dropped ${missingSamples} incomplete or missing samples`,
            format: 'mp4',
            offset: firstMissingOffset,
        });
    const samples = await createSampleArray(
        sampleOffsets,
        sizes,
        dtsList,
        durations,
        compositionOffsets,
        keyframeFlags,
        timescale,
        editShiftSeconds,
        ctts !== null,
        signal,
        availableSamples,
        decodeShift,
        sampleConfigs,
    );
    return { samples, recovered: missingSamples > 0 };
}

async function createSampleArray(
    sampleOffsets: Float64Array,
    sizes: Uint32Array,
    dtsList: Float64Array,
    durations: Uint32Array,
    compositionOffsets: Int32Array | Uint32Array,
    keyframeFlags: Uint8Array | null,
    timescale: number,
    editShiftSeconds: number,
    hasCompositionOffsets: boolean,
    signal?: AbortSignal,
    availableSamples?: Uint8Array,
    decodeShift = 0,
    sampleConfigs: Uint8Array | null = null,
): Promise<Sample[]> {
    const samples: Sample[] = [];
    for (let index = 0; index < sizes.length; index++) {
        if ((index & 4095) === 0) {
            throwIfAborted(signal);
            await yieldEventLoop();
        }
        if (availableSamples && !availableSamples[index]) continue;
        const sample: Sample = {
            offset: sampleOffsets[index]!,
            size: sizes[index]!,
            timestamp: shiftedSeconds(
                dtsList[index]! + compositionOffsets[index]!,
                timescale,
                editShiftSeconds,
            ),
            duration: durations[index]! / timescale,
            isKeyframe: keyframeFlags === null || keyframeFlags[index] === 1,
        };

        if (hasCompositionOffsets) {
            sample.decodeTimestamp = shiftedSeconds(
                dtsList[index]! - decodeShift,
                timescale,
                editShiftSeconds,
            );
            sample.compositionTimeOffset = (compositionOffsets[index]! + decodeShift) / timescale;
        }

        if (sampleConfigs) sample.codecConfigIndex = sampleConfigs[index]!;
        samples.push(sample);
    }
    return samples;
}
