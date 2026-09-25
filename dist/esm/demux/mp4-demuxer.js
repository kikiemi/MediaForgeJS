import { BlobSource } from '../io/sources.js';
import { ChunkReader } from '../io/chunk-reader.js';
import { DemuxError, MediaForgeError } from '../core/errors.js';
import { demuxAssert, DEMUX_LIMITS, DemuxIndexBudget, resolveDemuxBudget, yieldEventLoop, } from '../core/demux-guard.js';
import { DiagnosticContext } from '../core/diagnostics.js';
import { awaitWithAbort } from '../core/abort.js';
import { logger } from '../core/logger.js';
import { parseAacAudioSpecificConfig } from '../audio/adts.js';
import { bindCompactSampleIndex, enableCompactMP4Index, getCompactSampleIndex, usesCompactMP4Index, } from './sample-index.js';
import { createClassicSampleIndex } from './mp4-sample-index.js';
import { readMP4HandlerName, readMP4Title, readMP4TrackMetadata } from '../core/mp4-metadata.js';
async function createSampleArray(sampleOffsets, sizes, dtsList, durations, compositionOffsets, keyframeFlags, timescale, editShiftSeconds, hasCompositionOffsets, signal, availableSamples, decodeShift = 0) {
    const samples = [];
    for (let index = 0; index < sizes.length; index++) {
        if ((index & 4095) === 0) {
            if (signal?.aborted)
                throw new MediaForgeError('Aborted', 'ABORT');
            await yieldEventLoop();
        }
        if (availableSamples && !availableSamples[index])
            continue;
        const sample = {
            offset: sampleOffsets[index],
            size: sizes[index],
            timestamp: (dtsList[index] + compositionOffsets[index]) / timescale + editShiftSeconds,
            duration: durations[index] / timescale,
            isKeyframe: keyframeFlags === null || keyframeFlags[index] === 1,
        };
        if (hasCompositionOffsets) {
            sample.decodeTimestamp = (dtsList[index] - decodeShift) / timescale + editShiftSeconds;
            sample.compositionTimeOffset = (compositionOffsets[index] + decodeShift) / timescale;
        }
        samples.push(sample);
    }
    return samples;
}
function readU32(d, o) {
    return d.getUint32(o, false);
}
function readU16(d, o) {
    return d.getUint16(o, false);
}
function ascii(buf, o, len) {
    let s = '';
    for (let i = 0; i < len; i++)
        s += String.fromCharCode(buf[o + i]);
    return s;
}
function readFullBoxVersion(buf, box, version0Size, version1Size) {
    demuxAssert(box.size >= 12, `${box.type} box is truncated before version/flags`);
    const version = buf[box.offset + 8];
    demuxAssert(version === 0 || (version === 1 && version1Size !== undefined), `unsupported ${box.type} version ${version}`);
    demuxAssert(box.size >= (version === 1 ? version1Size : version0Size), `version-${version} ${box.type} box is truncated`);
    return version;
}
function scanBoxes(buf, start, end, visit) {
    let pos = start;
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let count = 0;
    while (pos + 8 <= end) {
        let size = dv.getUint32(pos, false);
        const type = ascii(buf, pos + 4, 4);
        let headerLen = 8;
        if (size === 0) {
            size = end - pos;
        }
        else if (size === 1) {
            if (pos + 16 > end)
                break;
            const hi = dv.getUint32(pos + 8, false);
            const lo = dv.getUint32(pos + 12, false);
            size = hi * 0x100000000 + lo;
            headerLen = 16;
        }
        if (size < headerLen || !Number.isFinite(size) || pos + size > end)
            break;
        demuxAssert(++count <= DEMUX_LIMITS.maxBoxesPerRange, `box count exceeds ${DEMUX_LIMITS.maxBoxesPerRange} in a ${end - start}-byte range (nested-box flood)`);
        if (visit?.(type, pos, size) === false)
            return count;
        pos += size;
    }
    return count;
}
function findBoxes(buf, start, end, requireComplete = false) {
    scanBoxes(buf, start, end);
    const boxes = [];
    scanBoxes(buf, start, end, (type, offset, size) => {
        boxes.push({ type, offset, size });
    });
    const last = boxes[boxes.length - 1];
    demuxAssert(!requireComplete || (last ? last.offset + last.size : start) === end, 'fragment box structure is truncated');
    return boxes;
}
function findBox(buf, start, end, type) {
    let found = null;
    scanBoxes(buf, start, end, (boxType, offset, size) => {
        if (boxType !== type)
            return;
        found = { type: boxType, offset, size };
        return false;
    });
    return found;
}
export class MP4Demuxer {
    allowEmptyTracks;
    isWorker = false;
    source;
    implicitSampleInput;
    sampleBlob;
    movieHasMvex = false;
    compactClassic = false;
    signal;
    diagnostics = new DiagnosticContext();
    externalFailure;
    samplesRecovered = false;
    mediaRanges;
    trexDefaults = new Map();
    fragmentNextDts = new Map();
    limits;
    budget;
    constructor(options = {}) {
        this.limits = resolveDemuxBudget(options);
        const { allowEmptyTracks } = options;
        if (allowEmptyTracks !== undefined && typeof allowEmptyTracks !== 'boolean') {
            throw new MediaForgeError('allowEmptyTracks must be a boolean', 'INPUT');
        }
        this.allowEmptyTracks = allowEmptyTracks ?? false;
    }
    async demux(input, signal, diagnostics) {
        if (!this.isWorker) {
            const worker = new MP4Demuxer({ ...this.limits, allowEmptyTracks: this.allowEmptyTracks });
            worker.isWorker = true;
            if (usesCompactMP4Index(this))
                enableCompactMP4Index(worker);
            const result = await worker.demux(input, signal, diagnostics);
            if (this.implicitSampleInput === undefined)
                this.implicitSampleInput = input;
            else if (this.implicitSampleInput !== input)
                this.implicitSampleInput = 'ambiguous';
            return result;
        }
        try {
            this.signal = signal;
            this.diagnostics = diagnostics ?? new DiagnosticContext();
            return await this.demuxInner(input);
        }
        catch (e) {
            if (this.externalFailure && Object.is(this.externalFailure.error, e))
                throw e;
            if (e instanceof RangeError && /call stack/i.test(e.message)) {
                throw new DemuxError('Malformed input: box nesting too deep');
            }
            if (e instanceof RangeError) {
                throw new DemuxError(`Malformed input: structure reads out of bounds (${e.message})`);
            }
            throw e;
        }
    }
    async demuxInner(input) {
        if (this.signal?.aborted)
            throw new MediaForgeError('Aborted', 'ABORT');
        const source = input instanceof Blob ? new BlobSource(input) : input;
        this.source = {
            size: source.size,
            read: async (offset, length) => {
                try {
                    return await awaitWithAbort(source.read(offset, length), this.signal);
                }
                catch (error) {
                    this.externalFailure = { error };
                    throw error;
                }
            },
        };
        this.budget = new DemuxIndexBudget(this.limits);
        const moovBuf = await this.findMoov();
        if (!moovBuf)
            throw new DemuxError('No moov box found');
        const dv = new DataView(moovBuf.buffer, moovBuf.byteOffset, moovBuf.byteLength);
        const result = { videoTracks: [], audioTracks: [] };
        result.title = readMP4Title(moovBuf, 8, moovBuf.length);
        const mvhd = findBox(moovBuf, 8, moovBuf.length, 'mvhd');
        let movieTimescale = 1000;
        if (mvhd) {
            const mvhdVer = readFullBoxVersion(moovBuf, mvhd, 108, 120);
            movieTimescale = readU32(dv, mvhd.offset + (mvhdVer === 0 ? 20 : 28));
        }
        demuxAssert(movieTimescale > 0, 'movie timescale must be greater than zero');
        const mvex = findBox(moovBuf, 8, moovBuf.length, 'mvex');
        this.movieHasMvex = !!mvex;
        this.compactClassic = usesCompactMP4Index(this) && !mvex;
        this.trexDefaults.clear();
        this.fragmentNextDts.clear();
        if (mvex) {
            for (const trex of findBoxes(moovBuf, mvex.offset + 8, mvex.offset + mvex.size).filter(b => b.type === 'trex')) {
                demuxAssert(trex.size >= 32, 'trex box is truncated');
                const tid = readU32(dv, trex.offset + 12);
                const descriptionIndex = readU32(dv, trex.offset + 16);
                demuxAssert(descriptionIndex === 1, `trex selects unsupported default_sample_description_index ${descriptionIndex}`);
                demuxAssert(!this.trexDefaults.has(tid), `duplicate trex defaults for track ${tid}`);
                this.trexDefaults.set(tid, {
                    descriptionIndex,
                    duration: readU32(dv, trex.offset + 20),
                    size: readU32(dv, trex.offset + 24),
                    flags: readU32(dv, trex.offset + 28),
                });
            }
        }
        const traks = findBoxes(moovBuf, 8, moovBuf.length).filter(b => b.type === 'trak');
        demuxAssert(traks.length <= DEMUX_LIMITS.maxTracks, `track count ${traks.length} exceeds the shared limit of ${DEMUX_LIMITS.maxTracks}`);
        this.preflightClassicSampleLedger(moovBuf, traks);
        this.mediaRanges = await this.findMediaRanges();
        const trackIdMap = new Map();
        for (const trak of traks) {
            try {
                const track = await this.parseTrak(moovBuf, dv, trak, result, movieTimescale);
                if (track && track.id && track.id > 0) {
                    demuxAssert(!trackIdMap.has(track.id), `duplicate track identifier ${track.id}`);
                    trackIdMap.set(track.id, track);
                }
            }
            catch (e) {
                if (this.externalFailure && Object.is(this.externalFailure.error, e))
                    throw e;
                if (e instanceof MediaForgeError && (e.code === 'ABORT' || e.code === 'OOM'))
                    throw e;
                if (e instanceof DemuxError)
                    throw e;
                throw new DemuxError(`Track parse failed: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
        if (this.movieHasMvex) {
            for (const [trackId, track] of trackIdMap) {
                const last = track.samples[track.samples.length - 1];
                if (!last) {
                    this.fragmentNextDts.set(trackId, 0);
                    continue;
                }
                const timescale = track.timescale || track.sampleRate || 90000;
                const rawDecode = (last.decodeTimestamp ?? last.timestamp) - (track.editTimelineShiftSeconds ?? 0);
                const nextDts = Math.round((rawDecode + last.duration) * timescale);
                demuxAssert(Number.isSafeInteger(nextDts) && nextDts >= 0, `track ${trackId} classic-to-fragment decode time is invalid`);
                this.fragmentNextDts.set(trackId, nextDts);
            }
            logger.debug('[MP4Demuxer] mvex detected, parsing moof fragments...');
            await this.parseFragments(result, trackIdMap);
        }
        const allTracks = [...result.videoTracks, ...result.audioTracks, ...(result.subtitleTracks ?? [])];
        demuxAssert(allTracks.length > 0, 'no decodable tracks');
        for (const t of allTracks) {
            const index = getCompactSampleIndex(t);
            if (!index)
                this.fillZeroDurations(t.samples);
            const length = index?.length ?? t.samples.length;
            demuxAssert(t.timescale === undefined || t.timescale > 0 || (t.sampleRate ?? 0) > 0, 'timescale is zero');
            if (length === 0 && this.allowEmptyTracks && (this.movieHasMvex || t.incomplete))
                continue;
            demuxAssert(length > 0, `track '${t.codec}' has no samples`);
            if (t.editAbsoluteMediaTimeSeconds !== undefined && t.editTimelineShiftSeconds !== undefined) {
                const first = index ? index.get(0) : t.samples[0];
                const editedFirstDecode = first.decodeTimestamp ?? first.timestamp;
                const rawFirstDecode = editedFirstDecode - t.editTimelineShiftSeconds;
                const discard = t.editAbsoluteMediaTimeSeconds - rawFirstDecode;
                demuxAssert(Number.isFinite(discard), `track '${t.codec}' edit discard is non-finite`);
                t.editMediaTimeSeconds = Math.max(0, discard);
            }
            let firstPresentation = index?.firstPresentation ?? Number.POSITIVE_INFINITY;
            let lastPresentationEnd = index?.lastPresentationEnd ?? Number.NEGATIVE_INFINITY;
            if (!index)
                for (const sample of t.samples) {
                    firstPresentation = Math.min(firstPresentation, sample.timestamp);
                    lastPresentationEnd = Math.max(lastPresentationEnd, sample.timestamp + sample.duration);
                }
            if (Number.isFinite(firstPresentation) && Number.isFinite(lastPresentationEnd)) {
                t.duration = Math.max(t.duration, lastPresentationEnd - firstPresentation);
            }
        }
        if (this.signal?.aborted)
            throw new MediaForgeError('Aborted', 'ABORT');
        return result;
    }
    recover(diagnostic) {
        try {
            this.diagnostics.recover(diagnostic);
        }
        catch (error) {
            this.externalFailure = { error };
            throw error;
        }
    }
    preflightClassicSampleLedger(buf, traks) {
        const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        let total = 0;
        for (let trackIndex = 0; trackIndex < traks.length; trackIndex++) {
            const trak = traks[trackIndex];
            const mdia = findBox(buf, trak.offset + 8, trak.offset + trak.size, 'mdia');
            if (!mdia)
                continue;
            const minf = findBox(buf, mdia.offset + 8, mdia.offset + mdia.size, 'minf');
            if (!minf)
                continue;
            const stbl = findBox(buf, minf.offset + 8, minf.offset + minf.size, 'stbl');
            if (!stbl)
                continue;
            const stsz = findBox(buf, stbl.offset + 8, stbl.offset + stbl.size, 'stsz');
            const stz2 = stsz ? null : findBox(buf, stbl.offset + 8, stbl.offset + stbl.size, 'stz2');
            const sizeBox = stsz ?? stz2;
            if (!sizeBox)
                continue;
            demuxAssert(sizeBox.size >= 20, `${sizeBox.type} box is too short`);
            const count = readU32(dv, sizeBox.offset + 16);
            this.budget.checkSamples(count, `track ${trackIndex + 1}`);
            total += count;
            demuxAssert(Number.isSafeInteger(total), 'classic sample count overflows a safe integer');
        }
        this.budget.reserveSamples(total, this.compactClassic ? 0 : 256, 'MP4 classic sample tables');
    }
    getTrackId(buf, dv, trak) {
        const trakS = trak.offset + 8;
        const trakE = trak.offset + trak.size;
        const tkhd = findBox(buf, trakS, trakE, 'tkhd');
        if (!tkhd)
            return 0;
        const ver = readFullBoxVersion(buf, tkhd, 92, 104);
        return ver === 0 ? readU32(dv, tkhd.offset + 20) : readU32(dv, tkhd.offset + 28);
    }
    fillZeroDurations(samples) {
        for (let i = 0; i < samples.length; i++) {
            const cur = samples[i];
            if (cur.duration > 0)
                continue;
            const next = samples[i + 1];
            const curDts = cur.decodeTimestamp ?? cur.timestamp;
            if (next) {
                const dt = (next.decodeTimestamp ?? next.timestamp) - curDts;
                if (dt > 0) {
                    cur.duration = dt;
                    continue;
                }
            }
            const prev = samples[i - 1];
            cur.duration = prev && prev.duration > 0 ? prev.duration : 1 / 1000;
        }
    }
    async parseFragments(result, trackIdMap) {
        const fileSize = this.source.size;
        const reader = new ChunkReader(this.source);
        let pos = 0;
        let walkedBoxes = 0;
        const maxTopBoxes = Math.min(Math.floor(fileSize / 8) + 16, 65536);
        const videoTracks = new Set(result.videoTracks);
        const unavailableByTrack = new Map();
        let retainedFragmentSamples = 0;
        const recoverTruncatedMoof = () => {
            demuxAssert(retainedFragmentSamples > 0, 'truncated moof has no preceding complete fragment samples');
            this.recover({
                code: 'MP4_TRUNCATED_MOOF',
                format: 'mp4',
                offset: pos,
                message: 'Ignored a truncated final moof; retained samples from preceding complete fragments',
            });
            for (const track of trackIdMap.values())
                track.incomplete = true;
        };
        while (pos + 8 <= fileSize) {
            if ((walkedBoxes & 0x1f) === 0)
                await yieldEventLoop();
            if (this.signal?.aborted)
                throw new MediaForgeError('Aborted', 'ABORT');
            demuxAssert(++walkedBoxes <= maxTopBoxes, `top-level box count implausible for a ${fileSize}-byte file`);
            const hdr = await reader.bytes(pos, Math.min(16, fileSize - pos));
            if (hdr.length < 8)
                break;
            const hdv = new DataView(hdr.buffer, hdr.byteOffset, hdr.byteLength);
            let boxSize = hdv.getUint32(0, false);
            const boxType = ascii(hdr, 4, 4);
            const headerSize = boxSize === 1 ? 16 : 8;
            if (boxSize === 1) {
                if (hdr.length < 16 && boxType === 'moof') {
                    recoverTruncatedMoof();
                    break;
                }
                demuxAssert(hdr.length >= 16, 'truncated MP4 extended box header');
                boxSize = hdv.getUint32(8, false) * 0x100000000 + hdv.getUint32(12, false);
            }
            else if (boxSize === 0)
                boxSize = fileSize - pos;
            demuxAssert(Number.isSafeInteger(boxSize) && boxSize >= headerSize, 'invalid MP4 box length');
            if (boxType === 'moof') {
                demuxAssert(boxSize <= 1024 * 1024, `moof box implausibly large (${boxSize} bytes); real fragment headers are tiny`);
                if (boxSize > fileSize - pos) {
                    recoverTruncatedMoof();
                    break;
                }
                const moofStart = pos;
                const moofEnd = pos + boxSize;
                const moofBuf = new Uint8Array(await reader.bytes(moofStart, boxSize));
                const mdv = new DataView(moofBuf.buffer, moofBuf.byteOffset, moofBuf.byteLength);
                const innerBoxes = findBoxes(moofBuf, headerSize, boxSize, true);
                for (const traf of innerBoxes.filter(b => b.type === 'traf')) {
                    const trafS = traf.offset + 8;
                    const trafE = traf.offset + traf.size;
                    const trafBoxes = findBoxes(moofBuf, trafS, trafE, true);
                    const tfhd = trafBoxes.find(box => box.type === 'tfhd');
                    demuxAssert(!!tfhd, 'traf has no tfhd box');
                    demuxAssert(tfhd.size >= 16, 'tfhd box is truncated before track_ID');
                    const tfhdFlags = (moofBuf[tfhd.offset + 9] << 16) |
                        (moofBuf[tfhd.offset + 10] << 8) |
                        moofBuf[tfhd.offset + 11];
                    const tfhdOptionalBytes = (tfhdFlags & 0x000001 ? 8 : 0) +
                        (tfhdFlags & 0x000002 ? 4 : 0) +
                        (tfhdFlags & 0x000008 ? 4 : 0) +
                        (tfhdFlags & 0x000010 ? 4 : 0) +
                        (tfhdFlags & 0x000020 ? 4 : 0);
                    demuxAssert(16 + tfhdOptionalBytes <= tfhd.size, 'tfhd optional fields extend past the tfhd box');
                    const trackId = readU32(mdv, tfhd.offset + 12);
                    const track = trackIdMap.get(trackId);
                    if (!track)
                        continue;
                    const editShiftSeconds = track.editTimelineShiftSeconds ?? 0;
                    let tfhdOff = tfhd.offset + 16;
                    let baseDataOffset = moofStart;
                    if (tfhdFlags & 0x000001) {
                        const hi = readU32(mdv, tfhdOff);
                        const lo = readU32(mdv, tfhdOff + 4);
                        baseDataOffset = hi * 0x100000000 + lo;
                        demuxAssert(Number.isSafeInteger(baseDataOffset), 'tfhd base_data_offset exceeds exact-integer range');
                        tfhdOff += 8;
                    }
                    if (tfhdFlags & 0x000002) {
                        const descriptionIndex = readU32(mdv, tfhdOff);
                        demuxAssert(descriptionIndex === 1, `tfhd selects unsupported sample_description_index ${descriptionIndex}`);
                        tfhdOff += 4;
                    }
                    let defaultSampleDuration = 0;
                    if (tfhdFlags & 0x000008) {
                        defaultSampleDuration = readU32(mdv, tfhdOff);
                        tfhdOff += 4;
                    }
                    let defaultSampleSize = 0;
                    if (tfhdFlags & 0x000010) {
                        defaultSampleSize = readU32(mdv, tfhdOff);
                        tfhdOff += 4;
                    }
                    let defaultSampleFlags = 0;
                    if (tfhdFlags & 0x000020) {
                        defaultSampleFlags = readU32(mdv, tfhdOff);
                    }
                    const trex = this.trexDefaults.get(trackId);
                    if (trex) {
                        if (!(tfhdFlags & 0x000008) && defaultSampleDuration === 0)
                            defaultSampleDuration = trex.duration;
                        if (!(tfhdFlags & 0x000010) && defaultSampleSize === 0)
                            defaultSampleSize = trex.size;
                        if (!(tfhdFlags & 0x000020))
                            defaultSampleFlags = trex.flags;
                    }
                    const tfdt = trafBoxes.find(box => box.type === 'tfdt');
                    const expectedDecodeTime = this.fragmentNextDts.get(trackId);
                    let baseDecodeTime = expectedDecodeTime ?? 0;
                    if (tfdt) {
                        demuxAssert(tfdt.size >= 12, 'tfdt box is truncated before version/flags');
                        const tfdtVer = moofBuf[tfdt.offset + 8];
                        if (tfdtVer === 0) {
                            demuxAssert(tfdt.size >= 16, 'version-0 tfdt box is truncated');
                            baseDecodeTime = readU32(mdv, tfdt.offset + 12);
                        }
                        else if (tfdtVer === 1) {
                            demuxAssert(tfdt.size >= 20, 'version-1 tfdt box is truncated');
                            baseDecodeTime =
                                readU32(mdv, tfdt.offset + 12) * 0x100000000 + readU32(mdv, tfdt.offset + 16);
                            demuxAssert(Number.isSafeInteger(baseDecodeTime), 'tfdt decode time exceeds exact-integer range');
                        }
                        else {
                            demuxAssert(false, `unsupported tfdt version ${tfdtVer}`);
                        }
                        demuxAssert(expectedDecodeTime === undefined || baseDecodeTime >= expectedDecodeTime, `track ${trackId} tfdt ${baseDecodeTime} precedes the previous decode end ${expectedDecodeTime}`);
                    }
                    const trunBoxes = trafBoxes.filter(b => b.type === 'trun');
                    let trafDataCursor = null;
                    let trafDts = baseDecodeTime;
                    for (const trun of trunBoxes) {
                        if (this.signal?.aborted)
                            throw new MediaForgeError('Aborted', 'ABORT');
                        demuxAssert(trun.size >= 16, 'trun box is truncated before sample_count');
                        const trunVersion = moofBuf[trun.offset + 8];
                        demuxAssert(trunVersion === 0 || trunVersion === 1, `unsupported trun version ${trunVersion}`);
                        const trunFlags = (moofBuf[trun.offset + 9] << 16) |
                            (moofBuf[trun.offset + 10] << 8) |
                            moofBuf[trun.offset + 11];
                        const sampleCount = readU32(mdv, trun.offset + 12);
                        this.budget.reserveSamples(sampleCount, 640, `MP4 trun for track ${trackId}`);
                        let trunOff = trun.offset + 16;
                        const trunOptionalBytes = (trunFlags & 0x000001 ? 4 : 0) + (trunFlags & 0x000004 ? 4 : 0);
                        demuxAssert(16 + trunOptionalBytes <= trun.size, 'trun optional fields extend past the trun box');
                        demuxAssert(!(trunFlags & 0x000004 && trunFlags & 0x000400), 'trun cannot combine first_sample_flags with per-sample flags');
                        let dataOffset = 0;
                        if (trunFlags & 0x000001) {
                            dataOffset = mdv.getInt32(trunOff, false);
                            trunOff += 4;
                        }
                        let firstSampleFlags = null;
                        if (trunFlags & 0x000004) {
                            firstSampleFlags = readU32(mdv, trunOff);
                            trunOff += 4;
                        }
                        const hasDuration = !!(trunFlags & 0x000100);
                        const hasSize = !!(trunFlags & 0x000200);
                        const hasFlags = !!(trunFlags & 0x000400);
                        const hasCTO = !!(trunFlags & 0x000800);
                        const perSample = 4 * ((hasDuration ? 1 : 0) + (hasSize ? 1 : 0) + (hasFlags ? 1 : 0) + (hasCTO ? 1 : 0));
                        demuxAssert(trunOff - trun.offset + sampleCount * perSample <= trun.size, 'trun records exceed its box');
                        if (trunFlags & 0x000001) {
                            trafDataCursor = (tfhdFlags & 0x000001 ? baseDataOffset : moofStart) + dataOffset;
                        }
                        else if (trafDataCursor === null) {
                            trafDataCursor = tfhdFlags & 0x000001 ? baseDataOffset : moofEnd + 8;
                        }
                        let curOffset = trafDataCursor;
                        let curDts = trafDts;
                        const timescale = track.timescale || track.sampleRate || 90000;
                        for (let i = 0; i < sampleCount; i++) {
                            if ((i & 0x3fff) === 0) {
                                await yieldEventLoop();
                                if (this.signal?.aborted)
                                    throw new MediaForgeError('Aborted', 'ABORT');
                            }
                            const duration = hasDuration ? readU32(mdv, trunOff) : defaultSampleDuration;
                            if (hasDuration)
                                trunOff += 4;
                            const size = hasSize ? readU32(mdv, trunOff) : defaultSampleSize;
                            if (hasSize)
                                trunOff += 4;
                            const flags = hasFlags
                                ? readU32(mdv, trunOff)
                                : i === 0 && firstSampleFlags !== null
                                    ? firstSampleFlags
                                    : defaultSampleFlags;
                            if (hasFlags)
                                trunOff += 4;
                            const cto = hasCTO
                                ? trunVersion === 0
                                    ? readU32(mdv, trunOff)
                                    : mdv.getInt32(trunOff, false)
                                : 0;
                            if (hasCTO)
                                trunOff += 4;
                            const isKeyframe = videoTracks.has(track) ? (flags & 0x10000) === 0 : true;
                            const isLeadingDiscard = ((flags >>> 26) & 3) === 1;
                            const nextOffset = curOffset + size;
                            const nextDts = curDts + duration;
                            const presentationTime = curDts + cto;
                            demuxAssert(Number.isSafeInteger(curOffset) && curOffset >= 0 && Number.isSafeInteger(nextOffset), 'fragment sample has an invalid byte range outside exact-integer bounds');
                            demuxAssert(Number.isSafeInteger(nextDts), 'fragment decode time exceeds exact-integer range');
                            demuxAssert(Number.isSafeInteger(presentationTime), 'fragment presentation time exceeds exact-integer range');
                            if (!this.sampleFitsMedia(curOffset, size)) {
                                demuxAssert(this.diagnostics.validation === 'compatible', `fragment sample spans ${curOffset}+${size} outside media data or past EOF ${fileSize}`);
                                const missing = unavailableByTrack.get(track);
                                if (missing)
                                    missing.count++;
                                else
                                    unavailableByTrack.set(track, { count: 1, offset: curOffset });
                                track.incomplete = true;
                            }
                            else {
                                track.samples.push({
                                    offset: curOffset,
                                    size,
                                    timestamp: presentationTime / timescale + editShiftSeconds,
                                    decodeTimestamp: curDts / timescale + editShiftSeconds,
                                    compositionTimeOffset: cto / timescale,
                                    duration: duration / timescale,
                                    isKeyframe,
                                    ...(isLeadingDiscard ? { leadingDiscard: true } : {}),
                                });
                                retainedFragmentSamples++;
                            }
                            curOffset = nextOffset;
                            curDts = nextDts;
                        }
                        trafDataCursor = curOffset;
                        trafDts = curDts;
                    }
                    this.fragmentNextDts.set(trackId, trafDts);
                }
            }
            if (boxSize > fileSize - pos) {
                demuxAssert(boxType === 'mdat' && this.diagnostics.validation === 'compatible', `${boxType} box extends past EOF`);
                break;
            }
            pos += boxSize;
        }
        for (const [track, missing] of unavailableByTrack) {
            this.recover({
                code: 'MP4_TRUNCATED_SAMPLES',
                format: 'mp4',
                trackId: track.id,
                offset: missing.offset,
                message: `Dropped ${missing.count} incomplete or unavailable fragment samples; retained complete samples with original timing`,
            });
        }
        logger.debug(`[MP4Demuxer] After fragments: video=${result.videoTracks[0]?.samples.length ?? 0}, audio=${result.audioTracks[0]?.samples.length ?? 0}`);
    }
    async readSample(inputOrSample, maybeSample) {
        let source;
        let sample;
        if (maybeSample) {
            sample = maybeSample;
            const inp = inputOrSample;
            if (inp instanceof Blob) {
                source = this.blobSampleSource(inp);
            }
            else if ('read' in inp) {
                source = inp;
            }
            else {
                throw new DemuxError('readSample: an MP4Sample cannot be used as the input source');
            }
        }
        else {
            if (inputOrSample instanceof Blob || 'read' in inputOrSample) {
                throw new DemuxError('readSample: sample argument is missing');
            }
            sample = inputOrSample;
            const input = this.implicitSampleInput;
            if (input === undefined)
                throw new DemuxError('readSample: demux an input successfully first, or pass the input explicitly');
            if (input === 'ambiguous')
                throw new DemuxError('readSample: this demuxer has parsed different inputs; pass the input explicitly');
            source = input instanceof Blob ? this.blobSampleSource(input) : input;
        }
        return source.read(sample.offset, sample.size);
    }
    blobSampleSource(input) {
        if (this.sampleBlob?.input !== input)
            this.sampleBlob = { input, source: new BlobSource(input) };
        return this.sampleBlob.source;
    }
    async findMediaRanges() {
        const ranges = [];
        const reader = new ChunkReader(this.source);
        let pos = 0;
        for (let count = 0; pos + 8 <= this.source.size; count++) {
            demuxAssert(count < 65536, 'MP4 media-range inspection exceeds the box budget');
            if ((count & 31) === 0)
                await yieldEventLoop();
            if (this.signal?.aborted)
                throw new MediaForgeError('Aborted', 'ABORT');
            const header = await reader.bytes(pos, Math.min(16, this.source.size - pos));
            const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
            let size = view.getUint32(0, false);
            const kind = ascii(header, 4, 4);
            const headerSize = size === 1 ? 16 : 8;
            if (size === 1) {
                if (header.length < 16 && kind === 'moof' && this.movieHasMvex)
                    break;
                demuxAssert(header.length >= 16, 'truncated MP4 extended box header');
                size = view.getUint32(8, false) * 0x100000000 + view.getUint32(12, false);
            }
            else if (size === 0)
                size = this.source.size - pos;
            demuxAssert(Number.isSafeInteger(size) && size >= headerSize, 'invalid MP4 box length');
            if (kind === 'mdat')
                ranges.push({ start: pos + headerSize, end: Math.min(pos + size, this.source.size) });
            if (size > this.source.size - pos) {
                demuxAssert(kind !== 'moof' || this.movieHasMvex, 'truncated moof requires fragmented movie metadata');
                break;
            }
            pos += size;
        }
        return ranges;
    }
    sampleFitsMedia(offset, size) {
        if (!this.mediaRanges)
            return offset + size <= this.source.size;
        let low = 0;
        let high = this.mediaRanges.length;
        while (low < high) {
            const mid = Math.floor((low + high) / 2);
            if (this.mediaRanges[mid].start <= offset)
                low = mid + 1;
            else
                high = mid;
        }
        const range = this.mediaRanges[low - 1];
        return !!range && offset + size <= range.end;
    }
    async findMoov() {
        const MOOV_CAP = 64 * 1024 * 1024;
        const fileSize = this.source.size;
        let pos = 0;
        const maxBoxes = Math.min(Math.floor(fileSize / 8) + 16, 65536);
        let boxes = 0;
        while (pos + 8 <= fileSize) {
            if ((boxes & 0x1f) === 0)
                await yieldEventLoop();
            if (this.signal?.aborted)
                throw new MediaForgeError('Aborted', 'ABORT');
            demuxAssert(++boxes <= maxBoxes, `top-level box count implausible for a ${fileSize}-byte file`);
            const header = await this.source.read(pos, 8);
            const dv = new DataView(header.buffer, header.byteOffset, header.byteLength);
            let boxSize = dv.getUint32(0, false);
            const type = ascii(header, 4, 4);
            if (boxSize === 1 && pos + 16 <= fileSize) {
                const ext = await this.source.read(pos + 8, 8);
                const edv = new DataView(ext.buffer, ext.byteOffset, ext.byteLength);
                boxSize = edv.getUint32(0, false) * 0x100000000 + edv.getUint32(4, false);
            }
            if (boxSize === 0)
                boxSize = fileSize - pos;
            if (boxSize < 8)
                break;
            if (type === 'moov') {
                demuxAssert(boxSize <= MOOV_CAP, `moov box of ${boxSize} bytes exceeds the ${MOOV_CAP} cap`);
                demuxAssert(pos + boxSize <= fileSize, 'moov box extends past EOF');
                if (usesCompactMP4Index(this))
                    this.budget.reserveBytes(boxSize, 'MP4 movie metadata');
                return this.source.read(pos, boxSize);
            }
            pos += boxSize;
        }
        return null;
    }
    async parseTrak(buf, dv, trak, result, movieTimescale) {
        if (this.signal?.aborted)
            throw new MediaForgeError('Aborted', 'ABORT');
        const trakS = trak.offset + 8;
        const trakE = trak.offset + trak.size;
        const mdia = findBox(buf, trakS, trakE, 'mdia');
        demuxAssert(!!mdia, 'trak has no mdia box (broken track structure)');
        const mdiaS = mdia.offset + 8;
        const mdiaE = mdia.offset + mdia.size;
        const hdlr = findBox(buf, mdiaS, mdiaE, 'hdlr');
        demuxAssert(!!hdlr, 'trak has no hdlr box (broken track structure)');
        readFullBoxVersion(buf, hdlr, 32);
        const handlerType = ascii(buf, hdlr.offset + 16, 4);
        const isVideo = handlerType === 'vide';
        const isAudio = handlerType === 'soun';
        const isSubtitle = ['text', 'sbtl', 'subt', 'clcp'].includes(handlerType);
        if (!isVideo && !isAudio && !isSubtitle)
            return;
        const metadata = readMP4TrackMetadata(buf, trakS, trakE, isSubtitle);
        const name = metadata.name ?? readMP4HandlerName(buf, hdlr.offset, hdlr.size);
        let forced = metadata.forced;
        const mdhd = findBox(buf, mdiaS, mdiaE, 'mdhd');
        let timescale = 90000;
        let mediaDuration = 0;
        let language;
        let colour;
        if (mdhd) {
            const ver = readFullBoxVersion(buf, mdhd, 32, 44);
            let packed = 0;
            if (ver === 0) {
                timescale = readU32(dv, mdhd.offset + 20);
                mediaDuration = readU32(dv, mdhd.offset + 24);
                if (mediaDuration === 0xffffffff)
                    mediaDuration = 0;
                packed = dv.getUint16(mdhd.offset + 28, false);
            }
            else {
                timescale = readU32(dv, mdhd.offset + 28);
                const hi = readU32(dv, mdhd.offset + 32);
                const lo = readU32(dv, mdhd.offset + 36);
                mediaDuration = hi === 0xffffffff && lo === 0xffffffff ? 0 : hi * 0x100000000 + lo;
                demuxAssert(Number.isSafeInteger(mediaDuration), 'mdhd duration exceeds JavaScript exact-integer range');
                packed = dv.getUint16(mdhd.offset + 40, false);
            }
            demuxAssert(timescale > 0, 'track timescale must be greater than zero');
            const letters = [(packed >> 10) & 0x1f, (packed >> 5) & 0x1f, packed & 0x1f];
            if (letters.every(v => v >= 1 && v <= 26)) {
                const code = letters.map(v => String.fromCharCode(v + 0x60)).join('');
                if (code !== 'und')
                    language = code;
            }
        }
        let editShiftSeconds = 0;
        let editLeadSeconds = 0;
        let editSkipSeconds = 0;
        let editPresentationDurationSeconds;
        let hasSupportedEdit = false;
        const edts = findBox(buf, trakS, trakE, 'edts');
        if (edts) {
            const elst = findBox(buf, edts.offset + 8, edts.offset + edts.size, 'elst');
            if (elst) {
                const elstVer = buf[elst.offset + 8];
                demuxAssert(elstVer === 0 || elstVer === 1, `unsupported elst version ${elstVer}`);
                const entryCount = readU32(dv, elst.offset + 12);
                demuxAssert(entryCount === 1 || entryCount === 2, `unsupported edit-list shape with ${entryCount} entries; only one media edit with an optional leading empty edit is supported`);
                let p = elst.offset + 16;
                const entrySize = elstVer === 1 ? 20 : 12;
                demuxAssert(entryCount <= Math.floor((elst.offset + elst.size - p) / entrySize), 'elst entries extend past the box');
                const entries = [];
                for (let i = 0; i < entryCount; i++) {
                    let segmentDuration;
                    let mediaTime;
                    if (elstVer === 1) {
                        segmentDuration = readU32(dv, p) * 0x100000000 + readU32(dv, p + 4);
                        const hi = dv.getInt32(p + 8, false);
                        const lo = readU32(dv, p + 12);
                        mediaTime = hi * 0x100000000 + lo;
                    }
                    else {
                        segmentDuration = readU32(dv, p);
                        mediaTime = dv.getInt32(p + 4, false);
                    }
                    demuxAssert(Number.isSafeInteger(segmentDuration) && Number.isSafeInteger(mediaTime), 'elst time exceeds JavaScript exact-integer range');
                    demuxAssert(readU32(dv, p + (elstVer === 1 ? 16 : 8)) === 0x00010000, 'edit-list media_rate other than 1.0 is unsupported');
                    entries.push({ segmentDuration, mediaTime });
                    p += entrySize;
                }
                const mediaEntry = entries[entries.length - 1];
                if (entries.length === 2) {
                    const emptyEntry = entries[0];
                    demuxAssert(emptyEntry.mediaTime === -1 && emptyEntry.segmentDuration > 0, 'unsupported edit-list shape; the first of two entries must be a non-zero leading empty edit');
                    editLeadSeconds = emptyEntry.segmentDuration / movieTimescale;
                    editShiftSeconds += editLeadSeconds;
                }
                demuxAssert(mediaEntry.mediaTime >= 0 &&
                    (mediaEntry.segmentDuration > 0 || (this.movieHasMvex && mediaEntry.segmentDuration === 0)), 'unsupported edit-list shape; the final entry must be one media edit ' +
                    '(zero duration is allowed only for a fragmented movie)');
                hasSupportedEdit = true;
                editShiftSeconds -= mediaEntry.mediaTime / timescale;
                editSkipSeconds = mediaEntry.mediaTime / timescale;
                if (mediaEntry.segmentDuration > 0) {
                    editPresentationDurationSeconds = mediaEntry.segmentDuration / movieTimescale;
                }
            }
        }
        const tkhd = findBox(buf, trakS, trakE, 'tkhd');
        let tkhdDisplayWidth = 0;
        let tkhdDisplayHeight = 0;
        let rotation = 0;
        if (tkhd) {
            const tkhdVer = readFullBoxVersion(buf, tkhd, 92, 104);
            const payloadStart = tkhd.offset + 12;
            const widthOff = payloadStart + (tkhdVer === 0 ? 72 : 84);
            const heightOff = payloadStart + (tkhdVer === 0 ? 76 : 88);
            if (widthOff + 4 <= tkhd.offset + tkhd.size && heightOff + 4 <= tkhd.offset + tkhd.size) {
                tkhdDisplayWidth = readU32(dv, widthOff) / 65536;
                tkhdDisplayHeight = readU32(dv, heightOff) / 65536;
            }
            const matrixOff = payloadStart + (tkhdVer === 0 ? 36 : 48);
            if (matrixOff + 36 <= tkhd.offset + tkhd.size) {
                const a = dv.getInt32(matrixOff, false);
                const b = dv.getInt32(matrixOff + 4, false);
                const c = dv.getInt32(matrixOff + 12, false);
                const d = dv.getInt32(matrixOff + 16, false);
                const ONE = 0x10000;
                if (a === ONE && b === 0 && c === 0 && d === ONE)
                    rotation = 0;
                else if (a === 0 && b === -ONE && c === ONE && d === 0)
                    rotation = 90;
                else if (a === -ONE && b === 0 && c === 0 && d === -ONE)
                    rotation = 180;
                else if (a === 0 && b === ONE && c === -ONE && d === 0)
                    rotation = 270;
            }
        }
        const minf = findBox(buf, mdiaS, mdiaE, 'minf');
        demuxAssert(!!minf, `'${handlerType}' track has no minf box`);
        const stbl = findBox(buf, minf.offset + 8, minf.offset + minf.size, 'stbl');
        demuxAssert(!!stbl, `'${handlerType}' track has no stbl box`);
        const stblS = stbl.offset + 8;
        const stblE = stbl.offset + stbl.size;
        const stsd = findBox(buf, stblS, stblE, 'stsd');
        demuxAssert(!!stsd, `'${handlerType}' track has no stsd box (broken sample description)`);
        demuxAssert(stsd.size >= 16, `'${handlerType}' track stsd box is truncated`);
        const entryCount = readU32(dv, stsd.offset + 12);
        demuxAssert(entryCount >= 1, `'${handlerType}' track stsd has no entries`);
        demuxAssert(entryCount === 1, `'${handlerType}' track uses ${entryCount} sample descriptions; configuration-switching standard MP4 is unsupported`);
        const entryOffset = stsd.offset + 16;
        demuxAssert(entryOffset + 8 <= stsd.offset + stsd.size, `'${handlerType}' stsd entry is truncated`);
        const entrySize = readU32(dv, entryOffset);
        demuxAssert(entrySize >= 8 && entryOffset + entrySize <= stsd.offset + stsd.size, `'${handlerType}' stsd entry exceeds its box`);
        const codecFourCC = ascii(buf, entryOffset + 4, 4);
        let codec = '';
        let width = 0, height = 0, sampleRate = 0, channelCount = 0;
        let displayWidth = 0, displayHeight = 0;
        let pixelAspectRatioNum = 1, pixelAspectRatioDen = 1;
        let codecConfig;
        if (isVideo) {
            demuxAssert(entrySize >= 86, `'${codecFourCC}' video sample entry is truncated`);
            width = readU16(dv, entryOffset + 32);
            height = readU16(dv, entryOffset + 34);
            const colr = findBox(buf, entryOffset + 86, entryOffset + entrySize, 'colr');
            if (colr && colr.size >= 8 + 11) {
                const kind = String.fromCharCode(buf[colr.offset + 8], buf[colr.offset + 9], buf[colr.offset + 10], buf[colr.offset + 11]);
                if (kind === 'nclx') {
                    colour = {
                        primaries: dv.getUint16(colr.offset + 12, false),
                        transfer: dv.getUint16(colr.offset + 14, false),
                        matrix: dv.getUint16(colr.offset + 16, false),
                        fullRange: (buf[colr.offset + 18] & 0x80) !== 0,
                    };
                }
            }
            const pasp = findBox(buf, entryOffset + 86, entryOffset + entrySize, 'pasp');
            if (pasp && pasp.offset + 16 <= entryOffset + entrySize) {
                pixelAspectRatioNum = readU32(dv, pasp.offset + 8);
                pixelAspectRatioDen = readU32(dv, pasp.offset + 12) || 1;
            }
            if (codecFourCC === 'avc1' || codecFourCC === 'avc3') {
                const avcC = findBox(buf, entryOffset + 86, entryOffset + entrySize, 'avcC');
                if (avcC) {
                    codecConfig = buf.slice(avcC.offset + 8, avcC.offset + avcC.size);
                    const profile = codecConfig[1] ?? 0x64;
                    const compat = codecConfig[2] ?? 0x00;
                    const level = codecConfig[3] ?? 0x28;
                    codec = `${codecFourCC}.${profile.toString(16).padStart(2, '0')}${compat.toString(16).padStart(2, '0')}${level.toString(16).padStart(2, '0')}`;
                }
                else {
                    codec = `${codecFourCC}.640028`;
                }
            }
            else if (codecFourCC === 'hvc1' || codecFourCC === 'hev1') {
                codec = codecFourCC;
                const hvcC = findBox(buf, entryOffset + 86, entryOffset + entrySize, 'hvcC');
                if (hvcC)
                    codecConfig = buf.slice(hvcC.offset + 8, hvcC.offset + hvcC.size);
            }
            else if (codecFourCC === 'vp08') {
                codec = 'vp8';
            }
            else if (codecFourCC === 'vp09') {
                codec = 'vp09.00.10.08';
                const vpcC = findBox(buf, entryOffset + 86, entryOffset + entrySize, 'vpcC');
                if (vpcC)
                    codecConfig = buf.slice(vpcC.offset + 8, vpcC.offset + vpcC.size);
            }
            else if (codecFourCC === 'av01') {
                codec = 'av01.0.01M.08';
                const av1C = findBox(buf, entryOffset + 86, entryOffset + entrySize, 'av1C');
                if (av1C)
                    codecConfig = buf.slice(av1C.offset + 8, av1C.offset + av1C.size);
            }
            else if (codecFourCC === 'mp4v') {
                codec = 'mp4v.20.9';
            }
            else if (codecFourCC === 's263' || codecFourCC === 'H263') {
                codec = 's263';
            }
            else {
                codec = codecFourCC;
            }
            displayWidth = tkhdDisplayWidth > 0 ? tkhdDisplayWidth : width;
            displayHeight = tkhdDisplayHeight > 0 ? tkhdDisplayHeight : height;
            if ((displayWidth <= 0 || displayHeight <= 0) && width > 0 && height > 0) {
                displayWidth = width;
                displayHeight = height;
            }
            if (displayWidth <= 0 && width > 0)
                displayWidth = width;
            if (displayHeight <= 0 && height > 0)
                displayHeight = height;
            if (pixelAspectRatioNum > 0 && pixelAspectRatioDen > 0 && width > 0 && height > 0) {
                const paspWidth = (width * pixelAspectRatioNum) / pixelAspectRatioDen;
                if (!(tkhdDisplayWidth > 0) && Number.isFinite(paspWidth) && paspWidth > 0) {
                    displayWidth = paspWidth;
                    displayHeight = height;
                }
            }
        }
        else if (isSubtitle) {
            demuxAssert(entrySize >= 16, `'${codecFourCC}' subtitle sample entry is truncated`);
            codec = codecFourCC;
            if (codecFourCC === 'wvtt') {
                const vttC = findBox(buf, entryOffset + 16, entryOffset + entrySize, 'vttC');
                demuxAssert(!!vttC, 'wvtt sample entry has no vttC configuration');
                codecConfig = buf.slice(vttC.offset + 8, vttC.offset + vttC.size);
            }
            else {
                if (codecFourCC === 'tx3g') {
                    demuxAssert(entrySize >= 38, 'tx3g sample entry is truncated');
                    forced ||= (readU32(dv, entryOffset + 16) & 0x40000000) !== 0;
                }
                if (codecFourCC === 'stpp') {
                    let strings = 0;
                    for (let offset = entryOffset + 16; offset < entryOffset + entrySize && strings < 3; offset++) {
                        if (buf[offset] === 0)
                            strings++;
                    }
                    demuxAssert(strings === 3, 'stpp sample entry has unterminated namespace/schema/MIME strings');
                }
                codecConfig = buf.slice(entryOffset + 16, entryOffset + entrySize);
            }
        }
        else {
            const audioVersion = readU16(dv, entryOffset + 16);
            const extStart = entryOffset + (audioVersion === 2 ? 72 : audioVersion === 1 ? 52 : 36);
            if (audioVersion === 2 && entryOffset + 52 <= entryOffset + entrySize) {
                sampleRate = Math.round(dv.getFloat64(entryOffset + 40, false)) || 48000;
                channelCount = readU32(dv, entryOffset + 48) || 2;
            }
            else {
                channelCount = readU16(dv, entryOffset + 24);
                sampleRate = readU16(dv, entryOffset + 32);
            }
            if (codecFourCC === 'mp4a') {
                codec = 'mp4a.40.2';
                const esds = this.findEsds(buf, extStart, entryOffset + entrySize);
                if (esds) {
                    codecConfig = esds;
                    const parsedAsc = parseAacAudioSpecificConfig(esds);
                    if (parsedAsc?.audioObjectType)
                        codec = `mp4a.40.${parsedAsc.audioObjectType}`;
                    if (parsedAsc?.sampleRate)
                        sampleRate = parsedAsc.sampleRate;
                    if (parsedAsc?.channelCount)
                        channelCount = parsedAsc.channelCount;
                }
            }
            else if (codecFourCC === 'Opus') {
                codec = 'opus';
                const dOps = findBox(buf, extStart, entryOffset + entrySize, 'dOps');
                if (dOps)
                    codecConfig = buf.slice(dOps.offset + 8, dOps.offset + dOps.size);
            }
            else if (codecFourCC === 'ac-3') {
                codec = 'ac-3';
                const dac3 = findBox(buf, extStart, entryOffset + entrySize, 'dac3');
                if (dac3)
                    codecConfig = buf.slice(dac3.offset + 8, dac3.offset + dac3.size);
            }
            else if (codecFourCC === 'ec-3') {
                codec = 'ec-3';
                const dec3 = findBox(buf, extStart, entryOffset + entrySize, 'dec3');
                if (dec3)
                    codecConfig = buf.slice(dec3.offset + 8, dec3.offset + dec3.size);
            }
            else if (codecFourCC === 'alac') {
                codec = 'alac';
                const alac = findBox(buf, extStart, entryOffset + entrySize, 'alac');
                demuxAssert(!!alac && alac.size === 36 && readU32(dv, alac.offset + 8) === 0, 'Invalid ALAC configuration box');
                codecConfig = buf.slice(alac.offset + 12, alac.offset + 36);
                sampleRate = readU32(dv, alac.offset + 32);
                channelCount = buf[alac.offset + 21];
                demuxAssert(sampleRate > 0 && channelCount >= 1 && channelCount <= 8, 'Invalid ALAC sample rate or channel count');
            }
            else if (codecFourCC === 'fLaC') {
                codec = 'flac';
                const dfLa = findBox(buf, extStart, entryOffset + entrySize, 'dfLa');
                if (dfLa) {
                    demuxAssert(dfLa.size >= 50 && buf[dfLa.offset + 8] === 0, 'Invalid FLAC configuration box');
                    const start = dfLa.offset + 12;
                    demuxAssert((buf[start] & 0x7f) === 0 &&
                        buf[start + 1] === 0 &&
                        buf[start + 2] === 0 &&
                        buf[start + 3] === 34, 'FLAC configuration omits STREAMINFO');
                    codecConfig = buf.slice(start + 4, start + 38);
                    sampleRate = codecConfig[10] * 4096 + codecConfig[11] * 16 + (codecConfig[12] >>> 4);
                    channelCount = ((codecConfig[12] >>> 1) & 7) + 1;
                    demuxAssert(sampleRate > 0, 'Invalid FLAC STREAMINFO sample rate');
                }
            }
            else {
                codec = codecFourCC;
            }
        }
        this.samplesRecovered = false;
        const samples = await this.parseSamples(buf, dv, stblS, stblE, timescale, editShiftSeconds);
        demuxAssert(samples.length > 0 || this.movieHasMvex || (this.allowEmptyTracks && this.samplesRecovered), `'${codec}' track has no samples and the file is not fragmented`);
        const trackDuration = timescale > 0 ? mediaDuration / timescale : 0;
        const track = {
            id: this.getTrackId(buf, dv, trak),
            ...(this.samplesRecovered ? { incomplete: true } : {}),
            codec,
            default: tkhd ? (readU32(dv, tkhd.offset + 8) & 1) !== 0 : undefined,
            forced,
            commentary: metadata.commentary,
            name,
            title: metadata.title,
            language,
            colour,
            width,
            height,
            displayWidth: isVideo ? displayWidth : undefined,
            displayHeight: isVideo ? displayHeight : undefined,
            rotation: isVideo && rotation !== 0 ? rotation : undefined,
            pixelAspectRatioNum: isVideo ? pixelAspectRatioNum : undefined,
            pixelAspectRatioDen: isVideo ? pixelAspectRatioDen : undefined,
            sampleRate,
            channelCount,
            duration: trackDuration,
            editLeadTimeSeconds: hasSupportedEdit ? editLeadSeconds : undefined,
            editAbsoluteMediaTimeSeconds: hasSupportedEdit ? editSkipSeconds : undefined,
            editTimelineShiftSeconds: hasSupportedEdit ? editShiftSeconds : undefined,
            editMediaTimeSeconds: editSkipSeconds,
            editPresentationDurationSeconds,
            presentationTimestampsIncludeEdits: hasSupportedEdit,
            samples: Array.isArray(samples) ? samples : [],
            codecConfig,
            timescale,
        };
        if (!Array.isArray(samples)) {
            bindCompactSampleIndex(track, samples, () => this.budget.reserveBytes(samples.length * 256, 'MP4 compatibility sample array'));
        }
        if (isVideo)
            result.videoTracks.push(track);
        else if (isAudio)
            result.audioTracks.push(track);
        else
            (result.subtitleTracks ??= []).push(track);
        return track;
    }
    findEsds(buf, start, end) {
        const esds = findBox(buf, start, end, 'esds');
        if (!esds) {
            const wave = findBox(buf, start, end, 'wave');
            if (wave)
                return this.findEsds(buf, wave.offset + 8, wave.offset + wave.size);
            return undefined;
        }
        const data = buf.slice(esds.offset + 12, esds.offset + esds.size);
        for (let i = 0; i < data.length - 2; i++) {
            if (data[i] === 0x05) {
                let j = i + 1;
                while (j < data.length && data[j] === 0x80)
                    j++;
                if (j < data.length) {
                    const len = data[j];
                    j++;
                    if (j + len <= data.length) {
                        return data.slice(j, j + len);
                    }
                }
            }
        }
        return undefined;
    }
    async parseSamples(buf, dv, stblS, stblE, timescale, editShiftSeconds = 0) {
        const breathe = async () => {
            await yieldEventLoop();
            if (this.signal?.aborted)
                throw new MediaForgeError('Aborted', 'ABORT');
        };
        const stsz = findBox(buf, stblS, stblE, 'stsz');
        const stco = findBox(buf, stblS, stblE, 'stco') ?? findBox(buf, stblS, stblE, 'co64');
        const stts = findBox(buf, stblS, stblE, 'stts');
        const stsc = findBox(buf, stblS, stblE, 'stsc');
        const stss = findBox(buf, stblS, stblE, 'stss');
        const ctts = findBox(buf, stblS, stblE, 'ctts');
        const stz2 = findBox(buf, stblS, stblE, 'stz2');
        if ((!stsz && !stz2) || !stco || !stts || !stsc)
            return [];
        for (const box of [stco, stts, stsc, stss, ctts]) {
            if (box)
                demuxAssert(box.size >= 16, `${box.type} box is truncated`);
        }
        demuxAssert(timescale > 0, 'media timescale is zero');
        const isLargeOffset = stco.type === 'co64';
        const declaredCount = stsz ? readU32(dv, stsz.offset + 16) : readU32(dv, stz2.offset + 16);
        this.budget.checkSamples(declaredCount, 'MP4 sample table');
        const sampleCount = declaredCount;
        if (sampleCount === 0)
            return [];
        if (this.compactClassic && !findBox(buf, stblS, stblE, 'cslg')) {
            return createClassicSampleIndex({
                tables: {
                    sizes: stsz ?? stz2,
                    chunks: stco,
                    layout: stsc,
                    timing: stts,
                    composition: ctts,
                    sync: stss,
                },
                bytes: buf,
                timescale,
                shift: editShiftSeconds,
                budget: this.budget,
                breathe,
                fitsMedia: (offset, size) => this.sampleFitsMedia(offset, size),
                strict: this.diagnostics.validation === 'strict',
                fileSize: this.source.size,
                missing: (count, offset) => {
                    this.samplesRecovered = true;
                    this.recover({
                        code: 'MP4_TRUNCATED_SAMPLES',
                        message: `Dropped ${count} incomplete or unavailable samples; retained ${sampleCount - count} complete samples with original timing`,
                        format: 'mp4',
                        offset,
                    });
                },
            });
        }
        if (this.compactClassic)
            this.budget.reserveBytes(sampleCount * 256, 'MP4 classic sample tables');
        const sizes = new Uint32Array(sampleCount);
        if (stsz) {
            const defaultSize = readU32(dv, stsz.offset + 12);
            if (defaultSize > 0) {
                demuxAssert(this.diagnostics.validation === 'compatible' || sampleCount * defaultSize <= this.source.size, `stsz claims ${sampleCount}x${defaultSize} bytes but the file has ${this.source.size}`);
                sizes.fill(defaultSize);
            }
            else {
                demuxAssert(20 + sampleCount * 4 <= stsz.size, 'stsz table exceeds its box');
                for (let i = 0; i < sampleCount; i++) {
                    if ((i & 0x7fff) === 0)
                        await breathe();
                    sizes[i] = readU32(dv, stsz.offset + 20 + i * 4);
                }
            }
        }
        else {
            const fieldSize = buf[stz2.offset + 15];
            demuxAssert(fieldSize === 4 || fieldSize === 8 || fieldSize === 16, `stz2 field size ${fieldSize}`);
            const tableBytes = Math.ceil((sampleCount * fieldSize) / 8);
            demuxAssert(20 + tableBytes <= stz2.size, 'stz2 table exceeds its box');
            const base = stz2.offset + 20;
            for (let i = 0; i < sampleCount; i++) {
                if ((i & 0x7fff) === 0)
                    await breathe();
                if (fieldSize === 16)
                    sizes[i] = dv.getUint16(base + i * 2, false);
                else if (fieldSize === 8)
                    sizes[i] = buf[base + i];
                else
                    sizes[i] = i & 1 ? buf[base + (i >> 1)] & 0x0f : buf[base + (i >> 1)] >> 4;
            }
        }
        const chunkCount = readU32(dv, stco.offset + 12);
        this.budget.checkSamples(chunkCount, 'MP4 table entries');
        this.budget.reserveBytes(Math.max(0, chunkCount - sampleCount) * 8, 'MP4 chunk-offset index');
        demuxAssert(16 + chunkCount * (isLargeOffset ? 8 : 4) <= stco.size, `${stco.type} table exceeds its box`);
        const chunkOffsets = new Float64Array(chunkCount);
        for (let i = 0; i < chunkCount; i++) {
            if ((i & 0x7fff) === 0)
                await breathe();
            if (isLargeOffset) {
                const hi = readU32(dv, stco.offset + 16 + i * 8);
                const lo = readU32(dv, stco.offset + 20 + i * 8);
                chunkOffsets[i] = hi * 0x100000000 + lo;
            }
            else {
                chunkOffsets[i] = readU32(dv, stco.offset + 16 + i * 4);
            }
        }
        const stscEntryCount = readU32(dv, stsc.offset + 12);
        this.budget.checkSamples(stscEntryCount, 'MP4 table entries');
        this.budget.reserveBytes(Math.max(0, stscEntryCount - sampleCount) * 8, 'MP4 chunk-layout index');
        demuxAssert(16 + stscEntryCount * 12 <= stsc.size, 'stsc table exceeds its box');
        demuxAssert(stscEntryCount > 0 || sampleCount === 0, 'stsc has no entries for a non-empty track');
        demuxAssert(readU32(dv, stsc.offset + 16) === 1, 'stsc first entry must start at chunk 1');
        const stscFirstChunk = new Uint32Array(stscEntryCount);
        const stscSamplesPerChunk = new Uint32Array(stscEntryCount);
        for (let i = 0; i < stscEntryCount; i++) {
            stscFirstChunk[i] = readU32(dv, stsc.offset + 16 + i * 12);
            stscSamplesPerChunk[i] = readU32(dv, stsc.offset + 20 + i * 12);
            const sampleDescriptionIndex = readU32(dv, stsc.offset + 24 + i * 12);
            demuxAssert(stscFirstChunk[i] > 0 && stscFirstChunk[i] <= chunkCount, 'stsc first_chunk is outside the chunk table');
            demuxAssert(stscSamplesPerChunk[i] > 0 || sampleCount === 0, 'stsc samples_per_chunk is zero');
            demuxAssert(sampleDescriptionIndex === 1, `stsc selects unsupported sample_description_index ${sampleDescriptionIndex}`);
            if (i > 0) {
                demuxAssert(stscFirstChunk[i] > stscFirstChunk[i - 1], 'stsc first_chunk not increasing');
            }
        }
        const dtsList = new Float64Array(sampleCount);
        const durations = new Uint32Array(sampleCount);
        const sttsEntryCount = readU32(dv, stts.offset + 12);
        this.budget.checkSamples(sttsEntryCount, 'MP4 table entries');
        demuxAssert(16 + sttsEntryCount * 8 <= stts.size, 'stts table exceeds its box');
        let dts = 0;
        let dtsLength = 0;
        for (let i = 0; i < sttsEntryCount; i++) {
            const count = readU32(dv, stts.offset + 16 + i * 8);
            demuxAssert(count <= sampleCount - dtsLength, 'stts covers more samples than the track');
            const delta = readU32(dv, stts.offset + 20 + i * 8);
            for (let j = 0; j < count; j++) {
                if ((dtsLength & 0x7fff) === 0)
                    await breathe();
                dtsList[dtsLength] = dts;
                durations[dtsLength] = delta;
                dts += delta;
                dtsLength++;
            }
        }
        demuxAssert(dtsLength === sampleCount, `stts covers ${dtsLength}/${sampleCount} samples`);
        const compositionVersion = ctts ? readFullBoxVersion(buf, ctts, 16, 16) : 0;
        const cslg = ctts && compositionVersion === 0 ? findBox(buf, stblS, stblE, 'cslg') : null;
        let decodeShift = 0;
        let signedComposition = compositionVersion === 1;
        let leastComposition = 0;
        let greatestComposition = 0;
        if (cslg && cslg.size >= 32 && buf[cslg.offset + 8] === 0) {
            leastComposition = dv.getInt32(cslg.offset + 16, false);
            greatestComposition = dv.getInt32(cslg.offset + 20, false);
            if (leastComposition < 0) {
                decodeShift = dv.getInt32(cslg.offset + 12, false);
                demuxAssert(decodeShift >= -leastComposition && greatestComposition >= leastComposition, 'cslg has an invalid composition range or decode shift');
                this.recover({
                    code: 'MP4_SIGNED_CTTS',
                    message: 'Interpreted legacy signed version-0 composition offsets using the cslg decode shift',
                    format: 'mp4',
                });
                signedComposition = true;
            }
        }
        const compositionOffsets = signedComposition ? new Int32Array(sampleCount) : new Uint32Array(sampleCount);
        if (ctts) {
            const entryCount = readU32(dv, ctts.offset + 12);
            this.budget.checkSamples(entryCount, 'MP4 table entries');
            demuxAssert(16 + entryCount * 8 <= ctts.size, 'ctts table exceeds its box');
            let sampleIndex = 0;
            for (let i = 0; i < entryCount; i++) {
                if ((i & 0x7fff) === 0)
                    await breathe();
                const count = readU32(dv, ctts.offset + 16 + i * 8);
                const offset = signedComposition
                    ? dv.getInt32(ctts.offset + 20 + i * 8, false)
                    : readU32(dv, ctts.offset + 20 + i * 8);
                if (decodeShift > 0)
                    demuxAssert(offset >= leastComposition && offset <= greatestComposition, 'ctts composition offset exceeds the cslg range');
                demuxAssert(count <= sampleCount - sampleIndex, 'ctts covers more samples than the track');
                for (let j = 0; j < count; j++, sampleIndex++) {
                    if ((sampleIndex & 0x7fff) === 0)
                        await breathe();
                    compositionOffsets[sampleIndex] = offset;
                }
            }
            demuxAssert(sampleIndex === sampleCount, `ctts covers ${sampleIndex}/${sampleCount} samples`);
        }
        let keyframeFlags = null;
        if (stss) {
            const ssCount = readU32(dv, stss.offset + 12);
            this.budget.checkSamples(ssCount, 'MP4 table entries');
            demuxAssert(16 + ssCount * 4 <= stss.size, 'stss table exceeds its box');
            keyframeFlags = new Uint8Array(sampleCount);
            let previousSync = 0;
            for (let i = 0; i < ssCount; i++) {
                const sampleNumber = readU32(dv, stss.offset + 16 + i * 4);
                demuxAssert(sampleNumber > previousSync && sampleNumber <= sampleCount, 'stss entries must increase within the sample count');
                keyframeFlags[sampleNumber - 1] = 1;
                previousSync = sampleNumber;
            }
        }
        const sampleOffsets = new Float64Array(sampleCount);
        let sampleIdx = 0;
        let stscIndex = 0;
        for (let ci = 0; ci < chunkCount; ci++) {
            if ((ci & 0x7fff) === 0)
                await breathe();
            const oneBasedChunk = ci + 1;
            while (stscIndex + 1 < stscEntryCount && stscFirstChunk[stscIndex + 1] <= oneBasedChunk)
                stscIndex++;
            const samplesInChunk = stscEntryCount > 0 ? stscSamplesPerChunk[stscIndex] : 1;
            demuxAssert(samplesInChunk <= sampleCount - sampleIdx, 'stsc/stco cover more samples than the track');
            let off = chunkOffsets[ci];
            for (let s = 0; s < samplesInChunk && sampleIdx < sampleCount; s++) {
                sampleOffsets[sampleIdx] = off;
                off += sizes[sampleIdx];
                sampleIdx++;
            }
        }
        demuxAssert(sampleIdx === sampleCount, `stsc/stco cover ${sampleIdx}/${sampleCount} samples`);
        if (sampleCount >= 4096) {
            let declared = 0;
            for (let i = 0; i < sampleCount; i++)
                declared += sizes[i];
            demuxAssert(declared / sampleCount >= 2, 'MP4 sample table implausibly small (ledger-flood input)');
        }
        const fileSize = this.source.size;
        const fallbackDuration = Math.max(1, Math.round(timescale / 1000));
        let availableSamples;
        let missingSamples = 0;
        let firstMissingOffset = 0;
        for (let i = 0; i < sampleCount; i++) {
            if ((i & 0x7fff) === 0)
                await breathe();
            const offset = sampleOffsets[i];
            const size = sizes[i];
            demuxAssert(Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(offset + size), `sample ${i} has an invalid byte range`);
            if (!this.sampleFitsMedia(offset, size)) {
                if (this.diagnostics.validation === 'strict') {
                    throw new DemuxError(`sample ${i} spans ${offset}+${size} past EOF ${fileSize}`);
                }
                if (!availableSamples) {
                    availableSamples = new Uint8Array(sampleCount).fill(1);
                    firstMissingOffset = offset;
                }
                availableSamples[i] = 0;
                missingSamples++;
            }
            if (durations[i] === 0) {
                const nextDelta = i + 1 < sampleCount ? dtsList[i + 1] - dtsList[i] : 0;
                durations[i] =
                    nextDelta > 0
                        ? Math.min(0xffffffff, Math.round(nextDelta))
                        : i > 0 && durations[i - 1] > 0
                            ? durations[i - 1]
                            : fallbackDuration;
            }
        }
        if (missingSamples > 0) {
            this.samplesRecovered = true;
            this.recover({
                code: 'MP4_TRUNCATED_SAMPLES',
                message: `Dropped ${missingSamples} incomplete or unavailable samples; retained ${sampleCount - missingSamples} complete samples with original timing`,
                format: 'mp4',
                offset: firstMissingOffset,
            });
        }
        return createSampleArray(sampleOffsets, sizes, dtsList, durations, compositionOffsets, keyframeFlags, timescale, editShiftSeconds, ctts !== null, this.signal, availableSamples, decodeShift);
    }
}
