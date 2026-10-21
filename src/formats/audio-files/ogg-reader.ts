import type { Source } from '../../core/model/types';
import type { DemuxResult, ProbedInput, ProbeTarget } from '../../core/model/track';
import type { MediaDiagnostic } from '../../core/errors/diagnostics';
import { bindCompactSampleIndex, getCompactSampleIndex } from '../../core/model/sample-index';
import {
    bisectOggGranule,
    firstPacketPageEnd,
    oggStreamEnds,
    type OggStreamEnds,
} from '../ogg/positions';
import { openAudioIndex } from './audio-open';
import type { StandaloneAudioDemuxOptions } from './demux-options';
import { indexOggStreams } from '../ogg/reader';
import { throwIfAborted } from '../../core/errors/errors';
import {
    WINDOW_ATTEMPTS,
    WINDOW_MARGIN,
    countBefore,
    probeWindows,
    readParts,
    sampleEnd,
    sampleRun,
} from './audio-windows';

// The part of the audio file reader that Ogg inputs run, loaded with the first of them: the index
// of every page, and the description of an input from its ends with the windows it opens later.

/**
 * Reads an Ogg file: the index of every page of its streams, after the ID3v2 tags some taggers put
 * in front.
 */
export async function demuxOgg(
    source: Source,
    options: StandaloneAudioDemuxOptions,
): Promise<DemuxResult> {
    const { context, stream, untag } = await openAudioIndex(source, options);
    const streams = await indexOggStreams(stream, options.format === 'opus');
    throwIfAborted(options.signal);
    untag([...streams.videoTracks, ...streams.audioTracks, ...(streams.subtitleTracks ?? [])]);
    const { title, tags } = context.metadata;
    return { ...(title !== undefined ? { title } : {}), ...(tags ? { tags } : {}), ...streams };
}

/**
 * Describes an Ogg audio input from its head and tail when inspecting it, as a read of every page
 * does but without counting its packets: the head gives the stream's headers and first audio pages,
 * the tail (whole pages to the end of the input, the last one closing the stream) its final
 * granule, so the duration, tags and codec configuration are those of a full read. With `around`,
 * the result also holds the packets from before `around` through after `through` that a read of
 * every page holds (see oggWindow); without, it opens such windows later (probeWindows). Inputs
 * with an ID3 tag in front, several logical streams, a chain of streams, damaged or unclosed ends,
 * and inputs whose head and tail meet, are read whole; so are a stream's read and a range's.
 */
export async function probeOgg(
    source: Source,
    options: StandaloneAudioDemuxOptions,
    target: ProbeTarget = {},
): Promise<ProbedInput | undefined> {
    if (target.stream || target.range) return undefined;
    const ends = await oggStreamEnds(source, options.signal);
    return (
        ends &&
        probeWindows(
            source,
            options,
            target,
            (windowOptions, around, through) =>
                oggWindow(source, windowOptions, ends, around, through),
            () => readOggParts(source, options, oggEnds(source, ends), ends.checked),
        )
    );
}

/**
 * A byte range of whole Ogg pages, from a page that starts a packet or continues one begun before
 * it, and where its first page that completes a packet begun in it ends (firstPacketPageEnd).
 */
interface OggPart {
    readonly from: number;
    readonly to: number;
    readonly settled: number;
}

/**
 * The input's byte ranges `parts` (in order, the first one its head) read as one Ogg input. The
 * pages left out before a part are a gap in the page sequence, which the read reports at the join,
 * and a hole in the audio, which it reports at the first page of the part that completes an audio
 * packet; parts that stop before the input's end leave the stream without its EOS page there. With
 * `kept`, what it reports in the head, as a read of every page reports it, is kept there; anything
 * else it reports is the input's and needs the full read (undefined). The pages at the offsets
 * `checked` had their CRCs checked over the same bytes.
 */
async function readOggParts(
    source: Source,
    options: StandaloneAudioDemuxOptions,
    parts: readonly OggPart[],
    checked: readonly number[],
    kept?: MediaDiagnostic[],
): Promise<DemuxResult | undefined> {
    const joins: (readonly [number, number])[] = [];
    const checkedOggPages = new Set<number>();
    let length = 0;
    for (const { from, to, settled } of parts) {
        if (length) joins.push([length, length + settled - from]);
        for (const page of checked)
            if (page >= from && page < to) checkedOggPages.add(length + page - from);
        length += to - from;
    }
    const inHead = (offset: number): boolean => offset >= 0 && offset < parts[0]!.to;
    const openEnd = parts.at(-1)!.to < source.size;
    const read = await readParts(
        demuxOgg,
        source,
        { ...options, checkedOggPages },
        parts,
        ({ code, offset = -1 }) =>
            (kept !== undefined && inHead(offset)) ||
            (openEnd && code === 'OGG_MISSING_EOS' && offset === length) ||
            joins.some(([join, settled]) =>
                code === 'OGG_PAGE_GAP'
                    ? offset === join
                    : code === 'OGG_AUDIO_HOLE' && offset >= join && offset < settled,
            ),
    );
    kept?.push(...(read?.warnings.filter(({ offset = -1 }) => inHead(offset)) ?? []));
    return read?.result;
}

/** The head and the tail of an Ogg input as parts to read. */
function oggEnds(source: Source, { headEnd, tailStart, tailSettled }: OggStreamEnds): OggPart[] {
    return [
        { from: 0, to: headEnd, settled: headEnd },
        { from: tailStart, to: source.size, settled: tailSettled },
    ];
}

/**
 * The packets of an Ogg audio input from before `around` through after `through` seconds (from its
 * start), as a read of every page holds them: the head, the pages from one that bisectOggGranule
 * finds before `around` to one after `through`, and the tail are read as one input, whose granules
 * place the packets after each gap. The packets of the first page that completes one after a gap
 * are left out: the read times them back from that page's granule, in seconds, and the first
 * one's duration may depend on the packet before it (Vorbis); the packets after them are timed as a
 * read of every page times them. A window that then does not reach `around` is moved further back.
 * Undefined when the stream is not bisected or the window is damaged.
 */
async function oggWindow(
    source: Source,
    options: StandaloneAudioDemuxOptions,
    ends: OggStreamEnds,
    around: number,
    through: number,
): Promise<ProbedInput | undefined> {
    const { size } = source;
    const { signal } = options;
    const { serial, headEnd, tailStart, headGranule, tailGranule: toPosition } = ends;
    const [head, tail] = oggEnds(source, ends);
    const kept: MediaDiagnostic[] = [];
    const checked = [...ends.checked];

    // The head alone states the timeline: its start, its rate and its codec delay.
    const headRead = await readOggParts(source, options, [head!], checked, kept);
    const track = headRead?.audioTracks[0];
    const index = track && getCompactSampleIndex(track);
    if (!headRead || !track || !index || !index.length) return undefined;
    const start = index.timestampAt(0);
    const from = Math.max(0, start) + around;
    const to = Math.max(0, start) + Math.max(around, through);
    const report = (probed: ProbedInput): ProbedInput => {
        for (const warning of kept) options.onWarning?.(warning);
        return probed;
    };
    const headPackets = countBefore(index, headEnd);
    if (headPackets && sampleEnd(index, headPackets - 1) >= to + WINDOW_MARGIN) {
        // The head holds the window: its packets are those of a read of every page.
        const described = await readOggParts(source, options, [head!, tail!], checked, []);
        const whole = described?.audioTracks[0];
        const packets = whole && getCompactSampleIndex(whole);
        if (!described || !whole || !packets) return undefined;
        bindCompactSampleIndex(whole, sampleRun(packets, 0, countBefore(packets, headEnd), 0));
        return report({ result: described, packets: true, start, fromStart: true });
    }

    // Granules count samples, from the codec delay that comes before the timeline (Opus).
    const rate = track.sampleRate;
    const delay = track.matroskaCodecDelaySeconds ?? 0;
    const granuleAt = (seconds: number): number =>
        Math.max(0, Math.round((seconds + delay) * rate));
    const span = { from: headEnd, to: tailStart, fromPosition: headGranule, toPosition };
    let margin = WINDOW_MARGIN;
    for (let attempt = 0; attempt < WINDOW_ATTEMPTS; attempt++, margin *= 4) {
        const opening = await bisectOggGranule(
            source,
            serial,
            span,
            granuleAt(from - margin),
            signal,
            checked,
        );
        const closing =
            opening &&
            (await bisectOggGranule(
                source,
                serial,
                { ...span, from: opening.before, fromPosition: opening.reached },
                granuleAt(to + margin),
                signal,
                checked,
            ));
        const settled =
            opening?.before === headEnd
                ? headEnd
                : opening && (await firstPacketPageEnd(source, serial, opening.before, signal));
        if (!opening || !closing || settled === undefined) return undefined;
        const end = closing.after ? closing.after.end : size;
        const middle = { from: opening.before, to: end >= tailStart ? size : end, settled };
        const read = await readOggParts(
            source,
            options,
            end >= tailStart ? [head!, middle] : [head!, middle, tail!],
            checked,
            [],
        );
        const window = read?.audioTracks[0];
        const packets = window && getCompactSampleIndex(window);
        if (!read || !window || !packets) return undefined;

        // The window's packets lie between the head and the tail in the joined input; those of the
        // first page that completes one after the gap are left out. Without a gap, the head's
        // packets start it.
        const fromStart = middle.from === headEnd;
        const first = fromStart ? 0 : countBefore(packets, headEnd + (settled - middle.from));
        const last = countBefore(packets, headEnd + (middle.to - middle.from));
        if (
            first < last &&
            packets.timestampAt(first) <= from &&
            (middle.to === size || sampleEnd(packets, last - 1) >= to)
        ) {
            bindCompactSampleIndex(window, sampleRun(packets, first, last, middle.from - headEnd));
            return report({ result: read, packets: true, start, fromStart });
        }
    }
    return undefined;
}
