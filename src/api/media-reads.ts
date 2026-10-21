import type { MediaDiagnostic } from '../core/errors/diagnostics';
import { DemuxError, throwIfAborted } from '../core/errors/errors';
import { awaitWithAbort, isOptionalSignal, linkAbortSignals } from '../core/io/abort';
import type { ProbeTarget } from '../core/model/track';
import type {
    MediaPacket,
    MediaSegment,
    PacketOptions,
    PacketSearchOptions,
    SegmentOptions,
} from '../pipeline/packet-types';
import type { MediaFile } from '../pipeline/read/media-file';
import type { EditProject } from '../editing/project';
import type { OptionPolicy } from '../core/errors/option-policy';
import type { MediaInput, Source } from '../core/model/types';
import type { Engine } from '../pipeline/engine';
import type { CodecPreference } from '../pipeline/api-types';
import type { MediaResult, SinkResult, TargetOptions } from './types';

/** What a Media shares with the MediaForge that opened it. */
export interface Session {
    /** The MediaForge's edit(), which replacing the audio runs through. */
    readonly edit: (
        project: EditProject,
        target: TargetOptions,
    ) => Promise<MediaResult | SinkResult>;
    readonly optionPolicy: OptionPolicy;
    readonly codecPreference?: CodecPreference;
    /** Passes a warning to the caller's listener and to the running operation's result. */
    readonly warn: (warning: MediaDiagnostic) => void;
}

/** An opened input as its operations see it. */
export interface MediaContext {
    readonly engine: Engine;
    readonly file: MediaFile;
    readonly session: Session;
    readonly input: Source | MediaInput;
}

/** How the MediaForge that opened a Media lets it read the input again. */
export interface MediaReads {
    /** The probe the opened file was read with; undefined: it is an index of the whole input. */
    readonly probe?: ProbeTarget;
    /**
     * Opens the input again: as `probe` reads it, or indexed whole without one, until `signal`
     * fires. Its warnings go to the caller's listener only, apart from those `reported` takes:
     * ones the listener had, and those it passes on itself.
     */
    reopen(
        probe: ProbeTarget | undefined,
        signal: AbortSignal,
        reported: (warning: MediaDiagnostic) => boolean,
    ): Promise<MediaFile>;
}

/**
 * What a Media reads its input with: the file open() made, how to open the input again, and the
 * index of the whole input once a part needed one, which the Media keeps until close().
 */
export interface MediaReading extends MediaReads {
    readonly context: MediaContext;
    index?: Promise<MediaFile>;
    /** The index once read, whose reads the Media drops after each operation. */
    indexed?: MediaFile;
    /**
     * Where the Media takes the warnings of reading its input from once a read went past the open:
     * the index, else the passes through the input (ProbeTarget.stream) after the open.
     */
    reports?: { readonly warnings: readonly MediaDiagnostic[] };
    /** The warnings the listener had, as keys; made with the first read after open(). */
    reported?: Set<string>;
}

/** What tells two warnings apart. */
function warningKey(warning: MediaDiagnostic): string {
    return JSON.stringify([warning.code, warning.message, warning.offset, warning.trackId]);
}

/**
 * Whether the listener had `warning` already, which it then has: each read of the input reports
 * again what the reads before it found (the open's option findings, damage they passed).
 */
function reported(reading: MediaReading, warning: MediaDiagnostic): boolean {
    const keys = (reading.reported ??= new Set(reading.context.file.warnings.map(warningKey)));
    const known = keys.has(warningKey(warning));
    keys.add(warningKey(warning));
    return known;
}

/**
 * `value` where it is an AbortSignal, else undefined: the operation that passed it reports an
 * unusable signal when it reads its options.
 */
function usable(value: AbortSignal | undefined): AbortSignal | undefined {
    return isOptionalSignal(value) ? value : undefined;
}

/**
 * Opens the input again as `probe` reads it, until the opened file closes or `signal` fires: with
 * `window`, as a window of what the open read (MediaFile.window), undefined where none holds the
 * target; without a probe, as the index the open's probe builds from what it read where it does
 * (MediaFile.probedIndex). The file closes when the opened one does, or when the returned release
 * is called. What opening it finds reaches the listener once; the warnings of the reads and writes
 * after that go to the running operation too, as the opened file's do.
 */
async function reopen(
    reading: MediaReading,
    probe: ProbeTarget | undefined,
    signal?: AbortSignal,
    window?: boolean,
): Promise<[MediaFile, () => void] | undefined> {
    const opened = reading.context.file;
    const { closing } = opened;
    const linked = linkAbortSignals(closing, usable(signal));
    let opening = true;
    let file: MediaFile | undefined;
    try {
        // A window that finds the input damaged holds nothing; what it finds reaches the listener
        // and the running operation once. Each warning of the work on it afterwards (a decoder
        // concealing one picture, then another) is the operation's, as with the opened file. An
        // index built from what the probe read finds nothing the open did not report: its probe
        // declines an input whose read warns, and its notes are the open's, which the listener
        // had. Its warnings take the window's way, as an input opened again would report none.
        const routed = (warning: MediaDiagnostic): void => {
            if (!opening || !reported(reading, warning)) reading.context.session.warn(warning);
        };
        file = window
            ? await opened.window!(probe!, linked.signal, routed).catch(error => {
                  if (error instanceof DemuxError) return undefined;
                  throw error;
              })
            : probe === undefined && opened.probedIndex
              ? await opened.probedIndex(linked.signal, routed)
              : await reading.reopen(probe, linked.signal, warning => {
                    if (opening) return reported(reading, warning);
                    reading.context.session.warn(warning);
                    return true;
                });
    } finally {
        linked.dispose();
    }
    opening = false;
    if (!file) return undefined;
    const close = (): void => file.close();
    if (closing.aborted) close();
    else closing.addEventListener('abort', close, { once: true });
    return [
        file,
        () => {
            closing.removeEventListener('abort', close);
            close();
        },
    ];
}

/** Keeps `file` as the index of the whole input, whose warnings the Media reports from then on. */
function keepIndex(reading: MediaReading, [file]: [MediaFile, unknown]): MediaFile {
    reading.indexed = reading.reports = file;
    return file;
}

/**
 * The index of the whole input: the opened file when it is one, else read once and kept until
 * close() (`signal` stops this wait only). A read of it that fails (a source that fell short) is
 * not kept: the next operation reads it again, as one of an input indexed at open reads again
 * what it needs.
 */
export async function indexed(reading: MediaReading, signal?: AbortSignal): Promise<MediaContext> {
    const { context } = reading;
    const opened = context.file;
    throwIfAborted(opened.closing);
    if (!opened.probedInput) return context;
    const index = (reading.index ??= reopen(reading, undefined).then(
        opened => keepIndex(reading, opened!),
        error => {
            if (reading.index === index) reading.index = undefined;
            throw error;
        },
    ));
    return { ...context, file: await awaitWithAbort(index, usable(signal)) };
}

/** A file an operation reads, and how to let it go when the operation ends. */
export interface ReadPlan {
    readonly context: MediaContext;
    release(): void;
}

/**
 * The file an operation reads as `probe` says (undefined: the index): the opened file when it is
 * an index or was opened so, the index when the open's probe builds it (ProbedInput.index), else,
 * but for a stream, a window of what the open read where the reader keeps it (ProbedInput.window)
 * or the index where no window holds the target, else the input opened again for the operation.
 * An index made so is kept; another file is closed on release.
 */
export async function readPlan(
    reading: MediaReading,
    probe: ProbeTarget | undefined,
    signal?: AbortSignal,
): Promise<ReadPlan> {
    const { context } = reading;
    const opened = context.file;
    throwIfAborted(opened.closing);
    const kept = { release: () => undefined };
    // The functions open the input as their operation plans to read it (read-probes). A Media
    // reads it so too, also once it holds the index: its results do not depend on what it read
    // before.
    if (!opened.probedInput || JSON.stringify(reading.probe) === JSON.stringify(probe))
        return { context, ...kept };
    // A probe that builds the index from what it read reads nothing else (ProbedInput.index).
    if (probe === undefined || opened.probedIndex)
        return { context: await indexed(reading, signal), ...kept };
    const reopened = await reopen(reading, probe, signal, !probe.stream && !!opened.window);
    if (!reopened) return { context: await indexed(reading, signal), ...kept };
    const [file, release] = reopened;
    if (!file.probedInput && !reading.index) {
        reading.index = Promise.resolve(keepIndex(reading, reopened));
        return { context: { ...context, file }, ...kept };
    }
    return { context: { ...context, file }, release };
}

/** Runs `work` on the file `probe` plans and lets that file go. */
export async function readWith<T>(
    reading: MediaReading,
    probe: ProbeTarget | undefined,
    signal: AbortSignal | undefined,
    work: (context: MediaContext) => Promise<T>,
): Promise<T> {
    const plan = await readPlan(reading, probe, signal);
    try {
        return await work(plan.context);
    } finally {
        plan.release();
    }
}

/**
 * The packets of Media.packets() on a checked request. A probed input whose index is not read yet
 * gives the packets of every selected track in one pass through it (ProbeTarget.stream), which
 * hands them as its index would, from a file let go once they are read; a range, keyframes only, or
 * an input read whole come from the index, without a generator of their own (it would add a step
 * to every packet).
 */
export async function readPackets(
    reading: MediaReading,
    request: PacketOptions,
): Promise<AsyncGenerator<MediaPacket>> {
    const { signal } = request;
    const opened = reading.context.file;
    if (opened.probedInput && !reading.index && opened.passServes(request)) {
        const plan = await readPlan(reading, { stream: true, packetsOnly: true }, signal);
        const { file } = plan.context;
        if (file.streamed) return file.packets(request, 'exclusive', () => passed(reading, plan));
        plan.release();
    }
    return (await indexed(reading, signal)).file.packets(request, 'exclusive');
}

/**
 * The end of a pass through the file `plan` reads (its packets read, a failure, or the iteration
 * stopped), which lets the file go. The damage the pass found is then reported as that of the
 * index: in media.warnings (a pass to the end finds what the index does, in its order; one
 * stopped early, what it read), and not to the listener again by a read of the index after it.
 * The pass's packets come from the file's own generator, with no step of a generator of the
 * pass's per packet.
 */
function passed(reading: MediaReading, plan: ReadPlan): void {
    const { file } = plan.context;
    const known = (reading.reports ?? reading.context.file).warnings;
    const keys = new Set(known.map(warningKey));
    const found = file.warnings.filter(warning => !keys.has(warningKey(warning)));
    for (const warning of found) reported(reading, warning);
    reading.reports = { warnings: [...known, ...found] };
    plan.release();
}

/**
 * Media.packetAt() of a probed input, the search checked first: from the window around `time`,
 * which reads the input from a few seconds before it to a few after (Matroska clusters, MPEG-TS
 * transport packets, Ogg pages, FLAC frames), where it holds the packet, else from the index. A
 * packet the window holds is the one the index finds, as the packets the search passes over lie in
 * it. A reader that keeps no reads to window from (ProbedInput.window) reads the input again for
 * the window, which reads its index where no window holds the time. An MPEG-TS window times only
 * video as the index does: an audio frame's time continues the frames since the input's start.
 */
export async function packetAt(
    reading: MediaReading,
    trackId: number,
    time: number,
    options: PacketSearchOptions | undefined,
): Promise<MediaPacket | undefined> {
    const opened = reading.context.file;
    const search = opened.packetSearch(trackId, time, options);
    const track = opened.uncountedTracks.find(item => item.id === trackId);
    if (!reading.index && (opened.format !== 'ts' || track?.type === 'video')) {
        const target = { around: Math.max(0, time - opened.timelineStart), timed: true };
        // A reader that parses the window's tracks itself (a fragmented MP4's moof boxes) gives
        // the packet without a file of the window; null: the window holds none.
        const parsed = await opened.windowPacketAt(trackId, time, target, search);
        if (parsed) return parsed;
        if (parsed === undefined) {
            const plan = await readPlan(reading, target, search.signal);
            const { file } = plan.context;
            try {
                if (!file.probedInput || file.findSample(trackId, time, search) !== undefined)
                    return await file.packetAt(trackId, time, search);
            } finally {
                plan.release();
            }
        }
    }
    const { file } = await indexed(reading, search.signal);
    return file.packetAt(trackId, time, search);
}

/** Media.segments() of a probed input, from its index. */
export async function* segments(
    reading: MediaReading,
    options: SegmentOptions | undefined,
): AsyncGenerator<MediaSegment> {
    yield* (await indexed(reading, options?.signal)).file.segments(options);
}
