import type { MediaChapter } from '../../../core/model/media';
import type { DemuxResult, Mp4EditListEntry, Sample, TrackInfo } from '../../../core/model/track';
import {
    adtsProgramConfig,
    buildAacConfig,
    parseAdtsFrameHeader,
    type AdtsFrameHeader,
} from '../../../core/codec-config/audio/adts';
import {
    bindCompactSampleIndex,
    getCompactSampleIndex,
    sampleAt,
    sampleCount,
    type SampleIndex,
} from '../../../core/model/sample-index';
import { tx3gText } from '../../text/timed-text';
import { isSplicedEditList, spliceEditSamples } from './edit-splices';
import type { Mp4ReadContext } from './descriptions';

/**
 * An edit list of several media edits on one sample timeline: the media from the first media edit
 * after the leading empty edits, as far as the coded media (`end`, in media units) goes. A video
 * edit list that splices media ranges is kept as `splice`, laid on the samples once they are read;
 * otherwise the simplification is reported.
 */
export function simplifiedEditList(
    context: Mp4ReadContext,
    entries: Mp4EditListEntry[],
    edit: {
        readonly held: number;
        readonly end: number | undefined;
        readonly timescale: number;
        readonly movieTimescale: number;
        readonly video: boolean;
        readonly unitRate: boolean;
    },
): {
    entries: Mp4EditListEntry[];
    splice?: { readonly entries: Mp4EditListEntry[]; readonly fallback: string };
} {
    const { end, timescale, movieTimescale } = edit;
    const first = entries.findIndex(entry => entry.mediaTime >= 0);
    const lead = entries
        .slice(0, first < 0 ? entries.length : first)
        .reduce((sum, entry) => sum + entry.segmentDuration, 0);
    const start = first < 0 ? undefined : entries[first]!.mediaTime;
    const message =
        start === undefined
            ? `Edit list of ${edit.held} entries is not kept; the media plays unedited`
            : `Edit list of ${edit.held} entries is not kept; the media plays from its first edit`;

    let splice: { readonly entries: Mp4EditListEntry[]; readonly fallback: string } | undefined;
    if (
        edit.video &&
        edit.unitRate &&
        end !== undefined &&
        isSplicedEditList(entries, timescale, movieTimescale) &&
        entries.every(entry => entry.mediaTime < end)
    )
        splice = { entries, fallback: message };
    else context.recover({ code: 'MP4_EDIT_LIST_SIMPLIFIED', format: 'mp4', message });

    const simplified =
        start === undefined || end === undefined || end <= start
            ? []
            : [
                  ...(lead > 0 ? [{ segmentDuration: lead, mediaTime: -1 }] : []),
                  {
                      segmentDuration: Math.max(
                          1,
                          Math.round(((end - start) * movieTimescale) / timescale),
                      ),
                      mediaTime: start,
                  },
              ];
    return { entries: simplified, ...(splice ? { splice } : {}) };
}

/**
 * Presents each media edit of a spliced edit list at its place in the movie, keeping the samples
 * between edits that decoding needs as decode-only ones and leaving out the rest; when they do not
 * fit, the track keeps the first edit alone and says so.
 */
export function spliceEdits(
    context: Mp4ReadContext,
    track: TrackInfo,
    entries: Mp4EditListEntry[],
    fallback: string,
): void {
    const edit = track.editList!;
    const count = sampleCount(track);
    const spliced = spliceEditSamples(
        Array.from({ length: count }, (_, index) => sampleAt(track, index)!),
        entries,
        edit.mediaTimescale,
        edit.movieTimescale,
        track.editTimelineShiftSeconds ?? 0,
        track.editLeadTimeSeconds ?? 0,
    );

    if (!spliced) {
        context.recover({
            code: 'MP4_EDIT_LIST_SIMPLIFIED',
            format: 'mp4',
            trackId: track.id,
            message: fallback,
        });
        return;
    }

    context.budget.reserveBytes(count * 256, 'MP4 spliced edit samples');
    track.samples = spliced.samples;
    track.editList = { ...edit, entries };
    track.editSplices = spliced.splices;

    const presented = entries.reduce(
        (sum, entry) => sum + (entry.mediaTime >= 0 ? entry.segmentDuration : 0),
        0,
    );
    track.editPresentationDurationSeconds = presented / edit.movieTimescale;
    track.editPresentationDurationUnits = undefined;
}

/**
 * AAC sample entries without an esds whose samples are whole ADTS frames (QuickTime-era writers):
 * the ADTS header gives the AudioSpecificConfig, and every sample is read without it, as ffmpeg's
 * aac_adtstoasc copies them. Nothing changes unless each sample is exactly one single-block frame
 * with the same header length and shape.
 */
export async function unwrapAdtsSamples(context: Mp4ReadContext, track: TrackInfo): Promise<void> {
    const count = sampleCount(track);
    let first: AdtsFrameHeader | undefined;
    for (let position = 0; position < count; position++) {
        const sample = sampleAt(track, position)!;
        if (sample.size < 9) return;
        const head = sample.data ?? (await context.source.read(sample.offset, 9));
        const header = parseAdtsFrameHeader(head, 0);
        if (!header || header.frameLength !== sample.size || header.rawDataBlocks !== 0) return;
        if (
            first &&
            (header.headerLength !== first.headerLength ||
                header.sampleRate !== first.sampleRate ||
                header.channels !== first.channels ||
                header.audioObjectType !== first.audioObjectType)
        )
            return;
        first ??= header;
    }

    if (!first) return;
    let config: Uint8Array;
    let channels = first.channels;
    if (channels === 0) {
        const sample = sampleAt(track, 0)!;
        const program = adtsProgramConfig(
            sample.data ?? (await context.source.read(sample.offset, sample.size)),
            first,
        );
        if (!program) return;
        config = program.config;
        channels = program.channels;
    } else config = buildAacConfig(first.sampleRate, channels, first.audioObjectType);

    const head = first.headerLength;
    const index = getCompactSampleIndex(track);
    if (index)
        bindCompactSampleIndex(track, trimSampleHeads(index, head), () =>
            context.budget.reserveBytes(index.length * 256, 'MP4 compatibility sample array'),
        );
    else track.samples = track.samples.map(sample => trimSampleHead(sample, head));

    track.codecConfig = config;
    track.sampleRate = first.sampleRate;
    track.channelCount = channels;
}

/**
 * A view of `index` whose samples start `head` bytes later (a per-sample header the reader leaves
 * out).
 */
function trimSampleHeads(index: SampleIndex, head: number): SampleIndex {
    return {
        length: index.length,
        byteLength: Math.max(0, index.byteLength - head * index.length),
        maxSampleSize: Math.max(0, index.maxSampleSize - head),
        allKeyframes: index.allKeyframes,
        presentationSorted: index.presentationSorted,
        decodeSorted: index.decodeSorted,
        firstPresentation: index.firstPresentation,
        lastPresentationEnd: index.lastPresentationEnd,
        get: position => trimSampleHead(index.get(position), head),
        timestampAt: position => index.timestampAt(position),
        decodeTimeAt: position => index.decodeTimeAt(position),
        isKeyframeAt: position => index.isKeyframeAt(position),
    };
}

/** `sample` without its first `head` bytes. */
function trimSampleHead(sample: Sample, head: number): Sample {
    return {
        ...sample,
        offset: sample.offset + head,
        size: sample.size - head,
        ...(sample.data ? { data: sample.data.subarray(head) } : {}),
    };
}

/**
 * QuickTime chapter tracks: text tracks another track names in its tref 'chap' box. Their samples
 * are chapter titles, read as the file's chapters (unless Nero chapters gave them) rather than
 * exposed as subtitles, as ffmpeg does.
 */
export async function readChapterTracks(
    context: Mp4ReadContext,
    result: DemuxResult,
    chapterTracks: readonly TrackInfo[],
): Promise<void> {
    const chapters: MediaChapter[] = [];
    const samples = chapterTracks[0]!.samples;
    if (samples.length <= 4096 && samples.every(sample => sample.size <= 4096))
        for (const sample of samples) {
            const data = sample.data ?? (await context.source.read(sample.offset, sample.size));
            chapters.push({
                start: sample.timestamp,
                end: sample.timestamp + sample.duration,
                title: new TextDecoder().decode(tx3gText(data)),
            });
        }
    result.subtitleTracks = result.subtitleTracks!.filter(track => !chapterTracks.includes(track));
    if (chapters.length && !result.tags?.chapters?.length)
        result.tags = { entries: result.tags?.entries ?? [], ...result.tags, chapters };
}
