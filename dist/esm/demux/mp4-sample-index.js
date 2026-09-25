import { demuxAssert } from '../core/demux-guard.js';
const OFFSET_STRIDE = 256;
function runAt(starts, index, cursor) {
    if (starts[cursor] <= index) {
        if (cursor + 1 === starts.length || starts[cursor + 1] > index)
            return cursor;
        if (cursor + 2 === starts.length || starts[cursor + 2] > index)
            return cursor + 1;
    }
    let low = 0;
    let high = starts.length;
    while (low < high) {
        const middle = (low + high) >>> 1;
        if (starts[middle] <= index)
            low = middle + 1;
        else
            high = middle;
    }
    return low - 1;
}
class ClassicSampleIndex {
    length;
    byteLength;
    maxSampleSize;
    allKeyframes;
    presentationSorted;
    firstPresentation;
    lastPresentationEnd;
    offsets;
    offsetStarts;
    sizes;
    starts;
    decodeStarts;
    deltas;
    durations;
    compositionStarts;
    compositionOffsets;
    sync;
    retained;
    timescale;
    shift;
    decodeSorted = true;
    timingRun = 0;
    compositionRun = 0;
    offsetRun = 0;
    offsetCursor = -1;
    cursorOffset = 0;
    constructor(length, byteLength, maxSampleSize, allKeyframes, presentationSorted, firstPresentation, lastPresentationEnd, offsets, offsetStarts, sizes, starts, decodeStarts, deltas, durations, compositionStarts, compositionOffsets, sync, retained, timescale, shift) {
        this.length = length;
        this.byteLength = byteLength;
        this.maxSampleSize = maxSampleSize;
        this.allKeyframes = allKeyframes;
        this.presentationSorted = presentationSorted;
        this.firstPresentation = firstPresentation;
        this.lastPresentationEnd = lastPresentationEnd;
        this.offsets = offsets;
        this.offsetStarts = offsetStarts;
        this.sizes = sizes;
        this.starts = starts;
        this.decodeStarts = decodeStarts;
        this.deltas = deltas;
        this.durations = durations;
        this.compositionStarts = compositionStarts;
        this.compositionOffsets = compositionOffsets;
        this.sync = sync;
        this.retained = retained;
        this.timescale = timescale;
        this.shift = shift;
    }
    physical(index) {
        return this.retained ? this.retained[index] : index;
    }
    decode(index) {
        const run = (this.timingRun = runAt(this.starts, index, this.timingRun));
        return this.decodeStarts[run] + (index - this.starts[run]) * this.deltas[run];
    }
    composition(index) {
        if (!this.compositionStarts)
            return 0;
        this.compositionRun = runAt(this.compositionStarts, index, this.compositionRun);
        return this.compositionOffsets[this.compositionRun];
    }
    offset(index) {
        if (!this.offsetStarts)
            return this.offsets[index];
        const run = (this.offsetRun = runAt(this.offsetStarts, index, this.offsetRun));
        const start = this.offsetStarts[run];
        if (typeof this.sizes === 'number')
            return this.offsets[run] + (index - start) * this.sizes;
        let cursor = this.offsetCursor >= start && this.offsetCursor <= index ? this.offsetCursor : start;
        let offset = cursor === this.offsetCursor ? this.cursorOffset : this.offsets[run];
        while (cursor < index)
            offset += this.sizes[cursor++];
        this.offsetCursor = index;
        this.cursorOffset = offset;
        return offset;
    }
    timestampAt(index) {
        const physical = this.physical(index);
        return (this.decode(physical) + this.composition(physical)) / this.timescale + this.shift;
    }
    decodeTimeAt(index) {
        return this.decode(this.physical(index)) / this.timescale + this.shift;
    }
    isKeyframeAt(index) {
        const physical = this.physical(index);
        return !this.sync || (this.sync[physical >>> 3] & (1 << (physical & 7))) !== 0;
    }
    get(index) {
        const physical = this.physical(index);
        const run = (this.timingRun = runAt(this.starts, physical, this.timingRun));
        const dts = this.decodeStarts[run] + (physical - this.starts[run]) * this.deltas[run];
        const composition = this.composition(physical);
        const sample = {
            offset: this.offset(physical),
            size: typeof this.sizes === 'number' ? this.sizes : this.sizes[physical],
            timestamp: (dts + composition) / this.timescale + this.shift,
            duration: this.durations[run] / this.timescale,
            isKeyframe: !this.sync || (this.sync[physical >>> 3] & (1 << (physical & 7))) !== 0,
        };
        if (this.compositionStarts) {
            sample.decodeTimestamp = dts / this.timescale + this.shift;
            sample.compositionTimeOffset = composition / this.timescale;
        }
        return sample;
    }
}
export async function createClassicSampleIndex(options) {
    const { tables, bytes, timescale, shift, budget, breathe } = options;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const u32 = (offset) => view.getUint32(offset, false);
    const { sizes: sizeBox, chunks, layout, timing, composition, sync } = tables;
    demuxAssert(sizeBox.size >= 20, `${sizeBox.type} box is truncated`);
    for (const box of [chunks, layout, timing, composition, sync]) {
        if (box)
            demuxAssert(box.size >= 16, `${box.type} box is truncated`);
    }
    const count = u32(sizeBox.offset + 16);
    budget.checkSamples(count, 'MP4 sample table');
    demuxAssert(count > 0 && timescale > 0 && Number.isFinite(shift), 'invalid compact sample timing');
    const constantSize = sizeBox.type === 'stsz' ? u32(sizeBox.offset + 12) : 0;
    const field = sizeBox.type === 'stsz' ? 32 : bytes[sizeBox.offset + 15];
    demuxAssert(field === 4 || field === 8 || field === 16 || (field === 32 && sizeBox.type === 'stsz'), `stz2 field size ${field}`);
    demuxAssert(constantSize > 0 || 20 + Math.ceil((count * field) / 8) <= sizeBox.size, `${sizeBox.type} table exceeds its box`);
    demuxAssert(!options.strict || constantSize * count <= options.fileSize, 'stsz sample bytes exceed file size');
    const chunkCount = u32(chunks.offset + 12);
    const layoutCount = u32(layout.offset + 12);
    const timingCount = u32(timing.offset + 12);
    const compositionCount = composition ? u32(composition.offset + 12) : 0;
    const syncCount = sync ? u32(sync.offset + 12) : 0;
    for (const entries of [chunkCount, layoutCount, timingCount, compositionCount, syncCount])
        budget.checkSamples(entries, 'MP4 table entries');
    const chunkWidth = chunks.type === 'co64' ? 8 : 4;
    demuxAssert(16 + chunkCount * chunkWidth <= chunks.size, `${chunks.type} table exceeds its box`);
    demuxAssert(layoutCount > 0 && 16 + layoutCount * 12 <= layout.size, 'stsc table exceeds its box or has no entries');
    demuxAssert(u32(layout.offset + 16) === 1, 'stsc first entry must start at chunk 1');
    demuxAssert(timingCount > 0 && 16 + timingCount * 8 <= timing.size, 'stts table exceeds its box or has no entries');
    if (composition)
        demuxAssert(16 + compositionCount * 8 <= composition.size, 'ctts table exceeds its box');
    if (sync)
        demuxAssert(16 + syncCount * 4 <= sync.size, 'stss table exceeds its box');
    const compositionVersion = composition ? bytes[composition.offset + 8] : 0;
    demuxAssert(compositionVersion === 0 || compositionVersion === 1, `unsupported ctts version ${compositionVersion}`);
    let previousChunk = 0;
    for (let entry = 0; entry < layoutCount; entry++) {
        if ((entry & 0x7fff) === 0)
            await breathe();
        const at = layout.offset + 16 + entry * 12;
        const first = u32(at);
        demuxAssert(first > previousChunk && first <= chunkCount && u32(at + 4) > 0, 'invalid stsc chunk layout');
        demuxAssert(u32(at + 8) === 1, `stsc selects unsupported sample_description_index ${u32(at + 8)}`);
        previousChunk = first;
    }
    const sizeBase = sizeBox.offset + 20;
    const readSize = (index) => constantSize ||
        (field === 32
            ? u32(sizeBase + index * 4)
            : field === 16
                ? view.getUint16(sizeBase + index * 2, false)
                : field === 8
                    ? bytes[sizeBase + index]
                    : (bytes[sizeBase + (index >>> 1)] >>> (index & 1 ? 0 : 4)) & 15);
    const readOffset = (chunk) => {
        const at = chunks.offset + 16 + chunk * chunkWidth;
        return chunkWidth === 8 ? u32(at) * 0x100000000 + u32(at + 4) : u32(at);
    };
    let checkpointCount = 0;
    let maxSampleSize = constantSize;
    let sample = 0;
    let layoutRun = 0;
    let declared = 0;
    let retainedCount = 0;
    let firstMissing = 0;
    let previousEnd = -1;
    for (let chunk = 0; chunk < chunkCount; chunk++) {
        if ((chunk & 0x7fff) === 0)
            await breathe();
        while (layoutRun + 1 < layoutCount && u32(layout.offset + 28 + layoutRun * 12) <= chunk + 1)
            layoutRun++;
        const samplesInChunk = u32(layout.offset + 20 + layoutRun * 12);
        demuxAssert(samplesInChunk <= count - sample, 'stsc/stco cover more samples than the track');
        const offset = readOffset(chunk);
        const endSample = sample + samplesInChunk;
        let endOffset = offset;
        if (constantSize) {
            if (offset !== previousEnd)
                checkpointCount++;
            endOffset += samplesInChunk * constantSize;
        }
        else {
            for (let index = sample; index < endSample; index++) {
                if ((index & 0x7fff) === 0)
                    await breathe();
                if ((index & (OFFSET_STRIDE - 1)) === 0 || (index === sample && offset !== previousEnd))
                    checkpointCount++;
                const size = readSize(index);
                endOffset += size;
                maxSampleSize = Math.max(maxSampleSize, size);
            }
        }
        demuxAssert(Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(endOffset), `chunk ${chunk} has an invalid byte range`);
        declared += endOffset - offset;
        if (options.fitsMedia(offset, endOffset - offset))
            retainedCount += samplesInChunk;
        else {
            let cursor = offset;
            for (let index = sample; index < endSample; index++) {
                if ((index & 0x7fff) === 0)
                    await breathe();
                const size = readSize(index);
                if (options.fitsMedia(cursor, size))
                    retainedCount++;
                else {
                    if (options.strict)
                        demuxAssert(false, `sample ${index} spans ${cursor}+${size} past EOF ${options.fileSize}`);
                    if (retainedCount === index)
                        firstMissing = cursor;
                }
                cursor += size;
            }
        }
        sample = endSample;
        previousEnd = endOffset;
    }
    demuxAssert(sample === count, `stsc/stco cover ${sample}/${count} samples`);
    demuxAssert(count < 4096 || declared / count >= 2, 'MP4 sample table implausibly small (ledger-flood input)');
    const sizeWidth = maxSampleSize <= 0xff ? 1 : maxSampleSize <= 0xffff ? 2 : 4;
    const offsetWidth = options.fileSize <= 0xffffffff ? 4 : 8;
    const sparseOffsets = checkpointCount * (offsetWidth + 4) < count * offsetWidth;
    const offsetCount = sparseOffsets ? checkpointCount : count;
    const syncBytes = sync ? Math.ceil(count / 8) : 0;
    const byteLength = offsetCount * offsetWidth +
        (sparseOffsets ? offsetCount * 4 : 0) +
        (constantSize ? 0 : count * sizeWidth) +
        timingCount * 20 +
        compositionCount * 8 +
        syncBytes +
        (retainedCount === count ? 0 : retainedCount * 4);
    budget.reserveBytes(byteLength, 'MP4 compact sample tables');
    const offsets = offsetWidth === 4 ? new Uint32Array(offsetCount) : new Float64Array(offsetCount);
    const offsetStarts = sparseOffsets ? new Uint32Array(offsetCount) : undefined;
    const sizes = constantSize ||
        (sizeWidth === 1 ? new Uint8Array(count) : sizeWidth === 2 ? new Uint16Array(count) : new Uint32Array(count));
    const retained = retainedCount === count ? undefined : new Uint32Array(retainedCount);
    const starts = new Uint32Array(timingCount);
    const decodeStarts = new Float64Array(timingCount);
    const deltas = new Uint32Array(timingCount);
    const durations = new Uint32Array(timingCount);
    const compositionStarts = composition ? new Uint32Array(compositionCount) : undefined;
    const compositionOffsets = composition
        ? compositionVersion === 1
            ? new Int32Array(compositionCount)
            : new Uint32Array(compositionCount)
        : undefined;
    const syncFlags = sync ? new Uint8Array(syncBytes) : undefined;
    let covered = 0;
    let decode = 0;
    let previousDuration = Math.max(1, Math.round(timescale / 1000));
    for (let run = 0; run < timingCount; run++) {
        if ((run & 0x7fff) === 0)
            await breathe();
        const runCount = u32(timing.offset + 16 + run * 8);
        demuxAssert(runCount <= count - covered, 'stts covers more samples than the track');
        const delta = u32(timing.offset + 20 + run * 8);
        starts[run] = covered;
        decodeStarts[run] = decode;
        deltas[run] = delta;
        durations[run] = delta || previousDuration;
        if (runCount)
            previousDuration = durations[run];
        covered += runCount;
        decode += runCount * delta;
        demuxAssert(Number.isSafeInteger(decode), 'stts decode time exceeds exact integer range');
    }
    demuxAssert(covered === count, `stts covers ${covered}/${count} samples`);
    covered = 0;
    for (let run = 0; run < compositionCount; run++) {
        if ((run & 0x7fff) === 0)
            await breathe();
        const runCount = u32(composition.offset + 16 + run * 8);
        demuxAssert(runCount <= count - covered, 'ctts covers more samples than the track');
        compositionStarts[run] = covered;
        compositionOffsets[run] =
            compositionVersion === 1
                ? view.getInt32(composition.offset + 20 + run * 8, false)
                : u32(composition.offset + 20 + run * 8);
        covered += runCount;
    }
    demuxAssert(!composition || covered === count, `ctts covers ${covered}/${count} samples`);
    let previousSync = 0;
    for (let entry = 0; entry < syncCount; entry++) {
        if ((entry & 0x7fff) === 0)
            await breathe();
        const sample = u32(sync.offset + 16 + entry * 4);
        demuxAssert(sample > previousSync && sample <= count, 'stss entries must increase within the sample count');
        syncFlags[(sample - 1) >>> 3] |= 1 << ((sample - 1) & 7);
        previousSync = sample;
    }
    sample = 0;
    layoutRun = 0;
    previousEnd = -1;
    let checkpoint = 0;
    let retainedPosition = 0;
    for (let chunk = 0; chunk < chunkCount; chunk++) {
        if ((chunk & 0x7fff) === 0)
            await breathe();
        while (layoutRun + 1 < layoutCount && u32(layout.offset + 28 + layoutRun * 12) <= chunk + 1)
            layoutRun++;
        const endSample = sample + u32(layout.offset + 20 + layoutRun * 12);
        const offset = readOffset(chunk);
        let cursor = offset;
        if (constantSize && offsetStarts) {
            if (offset !== previousEnd) {
                offsets[checkpoint] = offset;
                offsetStarts[checkpoint++] = sample;
            }
            cursor += (endSample - sample) * constantSize;
            if (retained) {
                const fitsChunk = options.fitsMedia(offset, cursor - offset);
                for (let index = sample; index < endSample; index++) {
                    if ((index & 0x7fff) === 0)
                        await breathe();
                    if (fitsChunk || options.fitsMedia(offset + (index - sample) * constantSize, constantSize))
                        retained[retainedPosition++] = index;
                }
            }
        }
        else {
            for (let index = sample; index < endSample; index++) {
                if ((index & 0x7fff) === 0)
                    await breathe();
                const size = readSize(index);
                if (typeof sizes !== 'number')
                    sizes[index] = size;
                if (!offsetStarts)
                    offsets[index] = cursor;
                else if ((index & (OFFSET_STRIDE - 1)) === 0 || (index === sample && offset !== previousEnd)) {
                    offsets[checkpoint] = cursor;
                    offsetStarts[checkpoint++] = index;
                }
                if (retained && options.fitsMedia(cursor, size))
                    retained[retainedPosition++] = index;
                cursor += size;
            }
        }
        sample = endSample;
        previousEnd = cursor;
    }
    let timingRun = 0;
    let compositionRun = 0;
    let allKeyframes = !sync || syncCount === count;
    let presentationSorted = true;
    let previousTimestamp = -Infinity;
    let firstPresentation = Infinity;
    let lastPresentationEnd = -Infinity;
    if (retained) {
        maxSampleSize = 0;
        allKeyframes = true;
    }
    for (let position = 0, segments = 0; position < retainedCount; segments++) {
        if ((segments & 0x7fff) === 0)
            await breathe();
        const first = retained ? retained[position] : position;
        timingRun = runAt(starts, first, timingRun);
        if (compositionStarts)
            compositionRun = runAt(compositionStarts, first, compositionRun);
        const end = retained
            ? position + 1
            : Math.min(count, starts[timingRun + 1] ?? count, compositionStarts?.[compositionRun + 1] ?? count);
        const last = retained ? first : end - 1;
        const compositionOffset = compositionOffsets?.[compositionRun] ?? 0;
        const decodeStart = decodeStarts[timingRun];
        const delta = deltas[timingRun];
        const runStart = starts[timingRun];
        const firstPts = (decodeStart + (first - runStart) * delta + compositionOffset) / timescale + shift;
        const lastPts = (decodeStart + (last - runStart) * delta + compositionOffset) / timescale + shift;
        const endPts = lastPts + durations[timingRun] / timescale;
        demuxAssert(Number.isFinite(firstPts) && Number.isFinite(endPts), 'sample presentation time is non-finite');
        firstPresentation = Math.min(firstPresentation, firstPts);
        lastPresentationEnd = Math.max(lastPresentationEnd, endPts);
        if (firstPts < previousTimestamp)
            presentationSorted = false;
        previousTimestamp = lastPts;
        if (retained) {
            maxSampleSize = Math.max(maxSampleSize, typeof sizes === 'number' ? sizes : sizes[first]);
            if (syncFlags && !(syncFlags[first >>> 3] & (1 << (first & 7))))
                allKeyframes = false;
        }
        position = end;
    }
    if (retained)
        options.missing(count - retainedCount, firstMissing);
    return new ClassicSampleIndex(retainedCount, byteLength, maxSampleSize, allKeyframes, presentationSorted, firstPresentation, lastPresentationEnd, offsets, offsetStarts, sizes, starts, decodeStarts, deltas, durations, compositionStarts, compositionOffsets, syncFlags, retained, timescale, shift);
}
