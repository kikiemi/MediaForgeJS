import type { DemuxResult, TrackInfo } from '../../../core/model/track';
import { throwIfAborted } from '../../../core/errors/errors';
import { demuxAssert, malformedInput } from '../../../core/errors/demux-guard';
import { DEMUX_LIMITS } from '../../shared/demux-budget';
import { yieldEventLoop } from '../../../core/io/event-loop';
import { bindCompactSampleIndex, PackedSampleIndex } from '../../../core/model/sample-index';
import { audioHasKeyframes, codecFamily } from '../../../core/model/codec-strings';
import { ascii, findBoxes, readU32 } from './boxes';
import { shiftedSeconds } from './sample-index';
import { codecConfigurations, type Mp4ReadContext } from './descriptions';
import type { FragmentState, SampleDescriptions } from './read-types';
import { decodeTime } from '../../../core/model/media-time';
import { dataView } from '../../../core/bytes/byte-fields';

/** Records of a track run read between two yields to the event loop. */
const TRUN_STEP = 0x4000;

/**
 * The samples of every movie fragment, in file order. With `compact` (the caller keeps compact
 * indexes) and no track holding samples from the movie box or switching sample descriptions, they
 * go into typed-array tables, so a long fragmented file costs tens of bytes per sample.
 */
export async function parseFragments(
    context: Mp4ReadContext,
    state: FragmentState,
    result: DemuxResult,
    trackIdMap: Map<number, TrackInfo>,
    compact: boolean,
): Promise<void> {
    const { signal, budget } = context;
    const fileSize = context.source.size;
    const reader = context.boxes;

    let pos = 0;
    let walkedBoxes = 0;
    const maxTopBoxes = Math.min(Math.floor(fileSize / 8) + 16, DEMUX_LIMITS.maxTopLevelBoxes);
    // Tracks whose sample flags tell keyframes: video, and audio with keyframes (xHE-AAC).
    const keyedTracks = new Set([
        ...result.videoTracks,
        ...result.audioTracks.filter(track => audioHasKeyframes(track.codec)),
    ]);
    const unavailableByTrack = new Map<TrackInfo, { count: number; offset: number }>();
    const packed = new Map<TrackInfo, PackedSampleIndex>();
    const pendingUse = new Map<TrackInfo, Set<number>>();
    if (
        compact &&
        [...trackIdMap.values()].every(
            track =>
                track.samples.length === 0 &&
                !track.codecConfigurations &&
                !state.fragmentDescriptions.get(track)?.pending,
        )
    )
        for (const track of trackIdMap.values())
            packed.set(
                track,
                new PackedSampleIndex(
                    track.timescale || track.sampleRate || 90000,
                    track.editTimelineShiftSeconds ?? 0,
                ),
            );
    let retainedFragmentSamples = 0;
    const recoverTruncatedMoof = (): void => {
        demuxAssert(
            retainedFragmentSamples > 0,
            'truncated moof has no preceding complete fragment samples',
        );
        context.recover({
            code: 'MP4_TRUNCATED_MOOF',
            format: 'mp4',
            offset: pos,
            message: 'Ignored a truncated final moof; earlier fragments are kept',
        });
        for (const track of trackIdMap.values()) track.incomplete = true;
    };
    const passOver = context.passOver;
    while (pos + 8 <= fileSize) {
        if (passOver && pos >= passOver.from && pos < passOver.to) pos = passOver.to;
        if (pos + 8 > fileSize) break;
        if ((walkedBoxes & 0x1f) === 0) await yieldEventLoop();
        throwIfAborted(signal);
        if (!(++walkedBoxes <= maxTopBoxes))
            malformedInput(`top-level box count implausible for a ${fileSize}-byte file`);
        const hdr = await reader.bytes(pos, Math.min(16, fileSize - pos));
        if (hdr.length < 8) break;
        const hdv = dataView(hdr);
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
        } else if (boxSize === 0) boxSize = fileSize - pos;
        demuxAssert(
            Number.isSafeInteger(boxSize) && boxSize >= headerSize,
            'invalid MP4 box length',
        );

        if (boxType === 'moof') {
            if (!(boxSize <= 1024 * 1024))
                malformedInput(
                    `moof box implausibly large (${boxSize} bytes); real fragment headers are tiny`,
                );
            if (boxSize > fileSize - pos) {
                recoverTruncatedMoof();
                break;
            }
            const moofStart = pos;
            const moofEnd = pos + boxSize;
            const moofBuf = await reader.bytes(moofStart, boxSize);
            const mdv = dataView(moofBuf);

            const innerBoxes = findBoxes(moofBuf, headerSize, boxSize, true);
            for (const traf of innerBoxes.filter(b => b.type === 'traf')) {
                const trafS = traf.offset + 8;
                const trafE = traf.offset + traf.size;
                const trafBoxes = findBoxes(moofBuf, trafS, trafE, true);

                const tfhd = trafBoxes.find(box => box.type === 'tfhd');
                demuxAssert(!!tfhd, 'traf has no tfhd box');
                demuxAssert(tfhd.size >= 16, 'tfhd box is truncated before track_ID');

                const tfhdFlags =
                    (moofBuf[tfhd.offset + 9]! << 16) |
                    (moofBuf[tfhd.offset + 10]! << 8) |
                    moofBuf[tfhd.offset + 11]!;
                const tfhdOptionalBytes =
                    (tfhdFlags & 0x000001 ? 8 : 0) +
                    (tfhdFlags & 0x000002 ? 4 : 0) +
                    (tfhdFlags & 0x000008 ? 4 : 0) +
                    (tfhdFlags & 0x000010 ? 4 : 0) +
                    (tfhdFlags & 0x000020 ? 4 : 0);
                demuxAssert(
                    16 + tfhdOptionalBytes <= tfhd.size,
                    'tfhd optional fields extend past the tfhd box',
                );
                const trackId = readU32(mdv, tfhd.offset + 12);
                const track = trackIdMap.get(trackId);
                if (!track) continue;
                const editShiftSeconds = track.editTimelineShiftSeconds ?? 0;

                let tfhdOff = tfhd.offset + 16;
                let baseDataOffset = moofStart;
                if (tfhdFlags & 0x000001) {
                    const hi = readU32(mdv, tfhdOff);
                    const lo = readU32(mdv, tfhdOff + 4);
                    baseDataOffset = hi * 0x100000000 + lo;
                    demuxAssert(
                        Number.isSafeInteger(baseDataOffset),
                        'tfhd base_data_offset exceeds exact-integer range',
                    );
                    tfhdOff += 8;
                }
                let descriptionIndex = state.trexDefaults.get(trackId)?.descriptionIndex ?? 1;
                if (tfhdFlags & 0x000002) {
                    descriptionIndex = readU32(mdv, tfhdOff);
                    tfhdOff += 4;
                }
                const descriptions = state.fragmentDescriptions.get(track);
                const configIndex =
                    descriptions?.configIndex[descriptionIndex - 1] ??
                    (descriptionIndex === 1 ? 0 : -1);
                if (!(configIndex >= 0))
                    malformedInput(
                        `track fragment selects unsupported sample_description_index ` +
                            `${descriptionIndex}`,
                    );
                const switching = !!descriptions?.configurations || !!descriptions?.pending;
                if (descriptions?.pending) {
                    let used = pendingUse.get(track);
                    if (!used) pendingUse.set(track, (used = new Set()));
                    used.add(configIndex);
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
                const trex = state.trexDefaults.get(trackId);
                if (trex) {
                    if (!(tfhdFlags & 0x000008) && defaultSampleDuration === 0)
                        defaultSampleDuration = trex.duration;
                    if (!(tfhdFlags & 0x000010) && defaultSampleSize === 0)
                        defaultSampleSize = trex.size;
                    if (!(tfhdFlags & 0x000020)) defaultSampleFlags = trex.flags;
                }

                const tfdt = trafBoxes.find(box => box.type === 'tfdt');
                // A window starts at a fragment of its own: only a decode time it states times it.
                demuxAssert(!passOver || tfdt, 'a fragment of a window states no decode time');
                const expectedDecodeTime = state.fragmentNextDts.get(trackId);
                let baseDecodeTime = expectedDecodeTime ?? 0;
                if (tfdt) {
                    demuxAssert(tfdt.size >= 12, 'tfdt box is truncated before version/flags');
                    const tfdtVer = moofBuf[tfdt.offset + 8];
                    if (tfdtVer === 0) {
                        demuxAssert(tfdt.size >= 16, 'version-0 tfdt box is truncated');
                        baseDecodeTime = readU32(mdv, tfdt.offset + 12);
                    } else if (tfdtVer === 1) {
                        demuxAssert(tfdt.size >= 20, 'version-1 tfdt box is truncated');
                        baseDecodeTime =
                            readU32(mdv, tfdt.offset + 12) * 0x100000000 +
                            readU32(mdv, tfdt.offset + 16);
                        demuxAssert(
                            Number.isSafeInteger(baseDecodeTime),
                            'tfdt decode time exceeds exact-integer range',
                        );
                    } else {
                        malformedInput(`unsupported tfdt version ${tfdtVer}`);
                    }
                    if (expectedDecodeTime !== undefined && baseDecodeTime < expectedDecodeTime)
                        supersedeFragmentSamples(context, track, packed.get(track), baseDecodeTime);
                }

                const trunBoxes = trafBoxes.filter(b => b.type === 'trun');
                let trafDataCursor: number | null = null;
                let trafDts = baseDecodeTime;
                for (const trun of trunBoxes) {
                    throwIfAborted(signal);
                    demuxAssert(trun.size >= 16, 'trun box is truncated before sample_count');
                    const trunVersion = moofBuf[trun.offset + 8];
                    if (!(trunVersion === 0 || trunVersion === 1))
                        malformedInput(`unsupported trun version ${trunVersion}`);
                    const trunFlags =
                        (moofBuf[trun.offset + 9]! << 16) |
                        (moofBuf[trun.offset + 10]! << 8) |
                        moofBuf[trun.offset + 11]!;
                    const sampleCount = readU32(mdv, trun.offset + 12);
                    const table = packed.get(track);
                    budget.reserveSamples(
                        sampleCount,
                        table ? PackedSampleIndex.BYTES_PER_SAMPLE : 640,
                        `MP4 trun for track ${trackId}`,
                    );
                    let trunOff = trun.offset + 16;
                    const trunOptionalBytes =
                        (trunFlags & 0x000001 ? 4 : 0) + (trunFlags & 0x000004 ? 4 : 0);
                    demuxAssert(
                        16 + trunOptionalBytes <= trun.size,
                        'trun optional fields extend past the trun box',
                    );
                    demuxAssert(
                        !(trunFlags & 0x000004 && trunFlags & 0x000400),
                        'trun cannot combine first_sample_flags with per-sample flags',
                    );

                    let dataOffset = 0;
                    if (trunFlags & 0x000001) {
                        dataOffset = mdv.getInt32(trunOff, false);
                        trunOff += 4;
                    }
                    let firstSampleFlags: number | null = null;
                    if (trunFlags & 0x000004) {
                        firstSampleFlags = readU32(mdv, trunOff);
                        trunOff += 4;
                    }

                    const hasDuration = !!(trunFlags & 0x000100);
                    const hasSize = !!(trunFlags & 0x000200);
                    const hasFlags = !!(trunFlags & 0x000400);
                    const hasCto = !!(trunFlags & 0x000800);
                    const perSample =
                        4 *
                        ((hasDuration ? 1 : 0) +
                            (hasSize ? 1 : 0) +
                            (hasFlags ? 1 : 0) +
                            (hasCto ? 1 : 0));
                    demuxAssert(
                        trunOff - trun.offset + sampleCount * perSample <= trun.size,
                        'trun records exceed its box',
                    );

                    if (trunFlags & 0x000001) {
                        trafDataCursor =
                            (tfhdFlags & 0x000001 ? baseDataOffset : moofStart) + dataOffset;
                    } else if (trafDataCursor === null) {
                        trafDataCursor = tfhdFlags & 0x000001 ? baseDataOffset : moofEnd + 8;
                    }
                    let curOffset: number = trafDataCursor;
                    let curDts = trafDts;
                    const timescale = track.timescale || track.sampleRate || 90000;
                    const keyed = keyedTracks.has(track);

                    // The records are read in synchronous steps with a yield between them: V8 does
                    // not optimize a loop inside an async function while it runs. A step keeps the
                    // cursors in locals and hands them back when it ends.
                    const step = (from: number, to: number): void => {
                        let at = trunOff;
                        let offset = curOffset;
                        let dts = curDts;
                        for (let i = from; i < to; i++) {
                            const duration = hasDuration ? readU32(mdv, at) : defaultSampleDuration;
                            if (hasDuration) at += 4;
                            const size = hasSize ? readU32(mdv, at) : defaultSampleSize;
                            if (hasSize) at += 4;
                            const flags = hasFlags
                                ? readU32(mdv, at)
                                : i === 0 && firstSampleFlags !== null
                                  ? firstSampleFlags
                                  : defaultSampleFlags;
                            if (hasFlags) at += 4;
                            const cto = hasCto
                                ? trunVersion === 0
                                    ? readU32(mdv, at)
                                    : mdv.getInt32(at, false)
                                : 0;
                            if (hasCto) at += 4;

                            const isKeyframe = keyed ? (flags & 0x10000) === 0 : true;
                            const isLeadingDiscard = ((flags >>> 26) & 3) === 1;
                            const nextOffset = offset + size;
                            const nextDts = dts + duration;
                            const presentationTime = dts + cto;
                            demuxAssert(
                                Number.isSafeInteger(offset) &&
                                    offset >= 0 &&
                                    Number.isSafeInteger(nextOffset),
                                'fragment sample has an invalid byte range outside exact-integer ' +
                                    'bounds',
                            );
                            demuxAssert(
                                Number.isSafeInteger(nextDts),
                                'fragment decode time exceeds exact-integer range',
                            );
                            demuxAssert(
                                Number.isSafeInteger(presentationTime),
                                'fragment presentation time exceeds exact-integer range',
                            );
                            if (!context.fitsMedia(offset, size)) {
                                if (!(context.validation === 'compatible'))
                                    malformedInput(
                                        `fragment sample spans ${offset}+${size} outside media ` +
                                            `data or past EOF ${fileSize}`,
                                    );
                                const missing = unavailableByTrack.get(track);
                                if (missing) missing.count++;
                                else unavailableByTrack.set(track, { count: 1, offset });
                                track.incomplete = true;
                            } else if (table)
                                table.push(
                                    offset,
                                    size,
                                    dts,
                                    cto,
                                    duration,
                                    isKeyframe,
                                    isLeadingDiscard,
                                );
                            else {
                                track.samples.push({
                                    offset,
                                    size,
                                    timestamp: shiftedSeconds(
                                        presentationTime,
                                        timescale,
                                        editShiftSeconds,
                                    ),
                                    decodeTimestamp: shiftedSeconds(
                                        dts,
                                        timescale,
                                        editShiftSeconds,
                                    ),
                                    compositionTimeOffset: cto / timescale,
                                    duration: duration / timescale,
                                    isKeyframe,
                                    ...(isLeadingDiscard ? { leadingDiscard: true } : {}),
                                    ...(switching ? { codecConfigIndex: configIndex } : {}),
                                });
                                retainedFragmentSamples++;
                            }

                            offset = nextOffset;
                            dts = nextDts;
                        }
                        trunOff = at;
                        curOffset = offset;
                        curDts = dts;
                    };
                    for (let from = 0; from < sampleCount; from += TRUN_STEP) {
                        if (from > 0) await yieldEventLoop();
                        throwIfAborted(signal);
                        step(from, Math.min(sampleCount, from + TRUN_STEP));
                    }
                    trafDataCursor = curOffset;
                    trafDts = curDts;
                }
                state.fragmentNextDts.set(trackId, trafDts);
            }
        }

        if (boxSize > fileSize - pos) {
            if (!(boxType === 'mdat' && context.validation === 'compatible'))
                malformedInput(`${boxType} box extends past EOF`);
            break;
        }
        pos += boxSize;
    }

    for (const [track, descriptions] of state.fragmentDescriptions)
        if (descriptions.pending)
            settleFragmentDescriptions(
                state,
                track,
                descriptions,
                pendingUse.get(track) ?? new Set(),
            );
    for (const [track, missing] of unavailableByTrack) {
        context.recover({
            code: 'MP4_TRUNCATED_SAMPLES',
            format: 'mp4',
            trackId: track.id,
            offset: missing.offset,
            message: `Dropped ${missing.count} incomplete or missing fragment samples`,
        });
    }
    for (const [track, table] of packed) {
        if (!table.length) continue;
        table.finish();
        bindCompactSampleIndex(track, table, () =>
            budget.reserveBytes(table.length * 256, 'MP4 compatibility sample array'),
        );
    }
}

/**
 * A fragment whose tfdt goes back into the decode range of earlier fragments codes that range
 * again: the earlier samples from its decode time on are dropped, so decode times keep increasing
 * and the new fragment decodes from its own first sample.
 */
function supersedeFragmentSamples(
    context: Mp4ReadContext,
    track: TrackInfo,
    table: PackedSampleIndex | undefined,
    fragmentDecode: number,
): void {
    context.recover({
        code: 'MP4_FRAGMENT_OVERLAP',
        format: 'mp4',
        trackId: track.id,
        message: `Track ${track.id} fragment overlaps earlier ones; dropped the repeated samples`,
    });

    if (table) {
        table.dropFrom(fragmentDecode);
        return;
    }

    const limit =
        fragmentDecode / (track.timescale || track.sampleRate || 90000) +
        (track.editTimelineShiftSeconds ?? 0);
    while (track.samples.length) {
        const last = track.samples[track.samples.length - 1]!;
        if (decodeTime(last) < limit - 1e-9) break;
        track.samples.pop();
    }
}

/**
 * Settles a fragmented track whose sample descriptions name different codecs by the ones its
 * fragments select: a single one describes the track; several must be configurations of one codec.
 */
function settleFragmentDescriptions(
    state: FragmentState,
    track: TrackInfo,
    descriptions: SampleDescriptions,
    used: Set<number>,
): void {
    const selected = [...used].sort((a, b) => a - b);
    const entries = selected.map(index => descriptions.entries[index]!);
    const video = track.width > 0 && !track.sampleRate;
    const family = codecFamily(entries[0]?.codec ?? track.codec);

    if (!(
        entries.length <= 1 ||
        entries.every(entry => codecFamily(entry.codec) === family && entry.codecConfig?.length)
    ))
        malformedInput(`track ${track.id} fragments switch between codecs, which is not supported`);

    const primary = entries[0];
    if (primary) {
        track.codec = primary.codec;
        track.codecConfig = primary.codecConfig;
        track.codecTag = primary.codecTag;
        track.sampleRate = primary.sampleRate;
        track.channelCount = primary.channelCount;
        track.width = primary.width;
        track.height = primary.height;
        if (primary.codec === 'mp3' && primary.codecFourCC === 'mp4a')
            state.layerPending.add(track);
    }

    if (entries.length > 1) track.codecConfigurations = codecConfigurations(entries, video);
    for (const sample of track.samples) {
        if (entries.length > 1)
            sample.codecConfigIndex = selected.indexOf(sample.codecConfigIndex!);
        else delete sample.codecConfigIndex;
    }
}
