import type { Source } from '../../core/model/types';
import type { DemuxResult, ProbedInput, ProbeTarget } from '../../core/model/track';
import type { MediaDiagnostic } from '../../core/errors/diagnostics';
import { DemuxError } from '../../core/errors/errors';
import type { SampleIndex } from '../../core/model/sample-index';
import { RangeSource } from '../../core/io/sources/sources';
import { ConcatSource } from '../../core/io/sources/concat-source';
import { DESCRIBED_AUDIO_BYTES } from './index-context';
import type { StandaloneAudioDemuxOptions } from './demux-options';

// The windows of the audio files described from their ends (FLAC and Ogg): the parts of the input
// read as one input, and the samples of a window.

/** The audio file read (demuxStandaloneAudio), which a window reads its parts with. */
export type AudioDemux = (
    source: Source,
    options: StandaloneAudioDemuxOptions,
) => Promise<DemuxResult>;

/** Seconds a window of an Ogg or FLAC stream reaches before `around` and after `through`. */
export const WINDOW_MARGIN = 1;

/** Attempts at a window, each reaching four times further back, before the index is read. */
export const WINDOW_ATTEMPTS = 3;

/**
 * The input's byte ranges `parts` read as one input of one track (by `demux`, the audio file read),
 * marked complete; undefined when the read fails, holds another number of tracks or reports what
 * `expected` does not take.
 */
export async function readParts(
    demux: AudioDemux,
    source: Source,
    options: StandaloneAudioDemuxOptions,
    parts: readonly { readonly from: number; readonly to: number }[],
    expected: (warning: MediaDiagnostic) => boolean,
): Promise<{ readonly result: DemuxResult; readonly warnings: MediaDiagnostic[] } | undefined> {
    const warnings: MediaDiagnostic[] = [];
    let result: DemuxResult;
    try {
        result = await demux(
            new ConcatSource(parts.map(({ from, to }) => new RangeSource(source, from, to - from))),
            {
                ...options,
                onWarning: warning => void warnings.push(warning),
                maxWarnings: undefined,
            },
        );
    } catch (error) {
        if (error instanceof DemuxError) return undefined;
        throw error;
    }
    const tracks = [...result.videoTracks, ...result.audioTracks];
    if (tracks.length !== 1 || !warnings.every(expected)) return undefined;
    delete tracks[0]!.incomplete;
    return { result, warnings };
}

/**
 * The probe of `target` of an Ogg or FLAC input that its ends describe: with `around`, the window
 * that `windowAt` reads there, from DESCRIBED_AUDIO_BYTES on; otherwise the description, whose
 * later windows (ProbedInput.window) start from what this open read: the ends, the pages whose CRCs
 * it checked, the frame numbering. The open reports what the input's head holds, so they do not.
 */
export async function probeWindows(
    source: Source,
    options: StandaloneAudioDemuxOptions,
    target: ProbeTarget,
    windowAt: (
        options: StandaloneAudioDemuxOptions,
        around: number,
        through: number,
    ) => Promise<ProbedInput | undefined>,
    describe: () => Promise<DemuxResult | undefined>,
): Promise<ProbedInput | undefined> {
    const window = async (
        { around, through = around, range, stream }: ProbeTarget,
        windowOptions: StandaloneAudioDemuxOptions,
    ): Promise<ProbedInput | undefined> =>
        around === undefined || range || stream || source.size < DESCRIBED_AUDIO_BYTES
            ? undefined
            : windowAt(windowOptions, around, through!);
    if (target.around !== undefined) return window(target, options);
    const result = await describe();
    return (
        result && {
            result,
            packets: false,
            window: (next, signal) => window(next, { ...options, signal, onWarning: undefined }),
        }
    );
}

/**
 * A view of the samples `from` up to `to` of `index`, their source offsets moved by `move` bytes
 * (a window read through a source that left bytes out); the summary is taken again over them.
 */
export function sampleRun(index: SampleIndex, from: number, to: number, move: number): SampleIndex {
    let firstPresentation = Number.POSITIVE_INFINITY;
    let lastPresentationEnd = Number.NEGATIVE_INFINITY;
    let maxSampleSize = 0;
    let allKeyframes = true;
    let presentationSorted = true;
    let decodeSorted = true;
    for (let position = from; position < to; position++) {
        const sample = index.get(position);
        firstPresentation = Math.min(firstPresentation, sample.timestamp);
        lastPresentationEnd = Math.max(lastPresentationEnd, sample.timestamp + sample.duration);
        maxSampleSize = Math.max(maxSampleSize, sample.size);
        if (!sample.isKeyframe) allKeyframes = false;
        if (position > from) {
            if (sample.timestamp < index.timestampAt(position - 1)) presentationSorted = false;
            if (index.decodeTimeAt(position) < index.decodeTimeAt(position - 1))
                decodeSorted = false;
        }
    }
    return {
        length: to - from,
        byteLength: index.byteLength,
        maxSampleSize,
        allKeyframes,
        presentationSorted,
        decodeSorted,
        firstPresentation,
        lastPresentationEnd,
        get: position => {
            const sample = index.get(position + from);
            return move ? { ...sample, offset: sample.offset + move } : sample;
        },
        timestampAt: position => index.timestampAt(position + from),
        decodeTimeAt: position => index.decodeTimeAt(position + from),
        isKeyframeAt: position => index.isKeyframeAt(position + from),
    };
}

/** The samples of `index` that start before input byte `offset` (they come first in it). */
export function countBefore(index: SampleIndex, offset: number): number {
    let count = 0;
    while (count < index.length && index.get(count).offset < offset) count++;
    return count;
}

/** Where sample `position` of `index` ends, in seconds. */
export function sampleEnd(index: SampleIndex, position: number): number {
    const sample = index.get(position);
    return sample.timestamp + sample.duration;
}
