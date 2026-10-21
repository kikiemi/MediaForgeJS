import type {
    PackageContainer,
    PackageLedger,
    PackageNaming,
    PackageSegmentTiming,
    PackagedFile,
    PackagedRepresentation,
    PackagedSegment,
    ResolvedPackageOptions,
} from './types';
import type { MediaFile } from '../read/media-file';
import type { FilePacket, RemuxTrack } from '../media-types';
import type { TrackInfo } from '../../core/model/track';
import type { Sink } from '../../core/model/types';
import type { CmafSample } from '../../formats/mp4/write/cmaf';
import type { CmafTrack } from '../../formats/mp4/write/cmaf-boxes';
import { mediaFileState } from '../read/file-state';
import {
    CmafTiming,
    cmafClockDiagnostic,
    cmafDecodeTimeDiagnostic,
    cmafEditTicks,
    cmafTrackConfig,
    fragmentedStart,
} from '../copy/cmaf-timing';
import { sampleCount } from '../../core/model/sample-index';
import { shiftPacket } from '../read/packet-index';
import { presentedStart } from '../copy/copy-timeline';
import { throwIfAborted } from '../../core/errors/errors';
import { linkAbortSignals } from '../../core/io/abort';
import {
    audioHasKeyframes,
    codecFamily,
    mp4aAudioObjectType,
} from '../../core/model/codec-strings';
import { parseAacAudioSpecificConfig } from '../../core/codec-config/audio/adts';
import { bigGcd, gcd } from '../../core/bytes/gcd';
import { join } from '../../formats/mp4/write/cmaf-boxes';
import { assertPackageName, packageError } from './options';

export {
    COLLECTED_PACKAGE_BYTES,
    PACKAGE_MAX_SEGMENTS,
    assertPackageName,
    collectPackage,
    collectedPackageRequest,
    packageError,
    segmentNamePattern,
    snapshotPackageOptions,
} from './options';

interface PackagePlan {
    readonly file: MediaFile;
    readonly options: ResolvedPackageOptions;
    readonly container: PackageContainer;
    readonly demuxed: boolean;
    readonly naming: PackageNaming;
    /**
     * Replaces a media segment's bytes before it is counted and emitted; sequence is its index in
     * its playlist.
     */
    readonly transformSegment?: (
        file: PackagedFile,
        sequence: number,
    ) => PackagedFile | Promise<PackagedFile>;
}

/**
 * Fixed names shared by demuxed HLS and DASH output: init-<rep>.mp4 and seg-<rep>-<number>.m4s from
 * 1.
 */
export const demuxedNaming: PackageNaming = Object.freeze({
    init: (representation: string) => `init-${representation}.mp4`,
    segment: (representation: string, number: number) => `seg-${representation}-${number}.m4s`,
    firstNumber: 1,
});

const NAL_CODECS = new Set(['avc1', 'avc3', 'hvc1', 'hev1']);

function rfc6381Codec(track: TrackInfo): string {
    const codec = track.codec;
    if (codecFamily(codec) === 'mp4a') {
        if (mp4aAudioObjectType(codec) !== null || /^mp4a\.[0-9a-f]{2}$/i.test(codec)) return codec;
        const parsed = track.codecConfig ? parseAacAudioSpecificConfig(track.codecConfig) : null;
        return `mp4a.40.${parsed?.audioObjectType ?? 2}`;
    }
    if (codec === 'mp3') return 'mp4a.40.34';
    if (codec === 'mp2' || codec === 'mp1') return 'mp4a.40.33';
    if (codec === 'Opus') return 'opus';
    if (codec === 'fLaC') return 'flac';
    return codec;
}

function trackTimescale(track: RemuxTrack): number {
    return track.info.timescale ?? (track.type === 'audio' ? track.info.sampleRate : 90000);
}

/** The frame rate of a video track of `count` packets. */
function frameRate(track: RemuxTrack, count: number): PackagedRepresentation['frameRate'] {
    const seconds = track.description.duration;
    if (track.type !== 'video' || count < 2 || !(seconds > 0)) return undefined;
    const scale = trackTimescale(track);
    const ticks = Math.round(seconds * scale);
    let num: number;
    let den: number;
    if (ticks > 0 && ticks % count === 0) {
        num = scale;
        den = ticks / count;
    } else {
        num = Math.round((count / seconds) * 1000);
        den = 1000;
    }
    if (!Number.isSafeInteger(num) || !Number.isSafeInteger(den) || num < 1 || den < 1)
        return undefined;
    const divisor = gcd(num, den);
    return { num: num / divisor, den: den / divisor };
}

/** Integer seconds not exceeded by any duration; at least 1. */
export function ceilSeconds(timings: readonly PackageSegmentTiming[]): number {
    let result = 1n;
    for (const timing of timings) {
        const scale = BigInt(timing.timescale);
        const whole = (timing.duration + scale - 1n) / scale;
        if (whole > result) result = whole;
    }
    return Number(result);
}

/**
 * Exact accumulator over mixed timescales; the shared denominator grows to their least common
 * multiple.
 */
export class TickClock {
    private numerator = 0n;
    private denominator = 1n;

    add(ticks: bigint, timescale: number): void {
        const scale = BigInt(timescale);
        if (this.denominator % scale !== 0n) {
            const factor = scale / bigGcd(this.denominator, scale);
            this.numerator *= factor;
            this.denominator *= factor;
        }
        this.numerator += ticks * (this.denominator / scale);
    }

    /** Elapsed time in whole units of 10^-digits seconds, rounded half up. */
    units(digits: number): bigint {
        return (
            (this.numerator * 10n ** BigInt(digits) * 2n + this.denominator) /
            (2n * this.denominator)
        );
    }

    /** Elapsed time in whole units of 10^-digits seconds, rounded up. */
    ceilUnits(digits: number): bigint {
        const scaled = this.numerator * 10n ** BigInt(digits);
        return (scaled + this.denominator - 1n) / this.denominator;
    }

    get seconds(): number {
        return Number(this.numerator) / Number(this.denominator);
    }
}

/** Formats whole 10^-digits units as a decimal number with exactly that many fraction digits. */
export function decimalUnits(units: bigint, digits: number): string {
    const scale = 10n ** BigInt(digits);
    return `${units / scale}.${String(units % scale).padStart(digits, '0')}`;
}

interface SegmentOutput {
    readonly init?: Uint8Array;
    readonly contiguous: boolean;
    readonly configs: readonly CmafTrack[];
    readonly bufferedBytes: number;
    readonly bufferedSamples: number;
    add(sample: CmafSample, packet: FilePacket): void;
    /**
     * Buffered fMP4 output only: replaces the last added sample's duration and returns the previous
     * one.
     */
    amend?(trackId: number, duration: number): number | undefined;
    flush(): Uint8Array;
    finish(): Promise<void>;
}

interface PendingTrack {
    readonly first: bigint;
    ticks: bigint;
    readonly timescale: number;
}

/** A packet of a segment being cut, prepared and waiting for the segment before it to end. */
interface HeldSample {
    sample: CmafSample;
    readonly packet: FilePacket;
    readonly timescale: number;
}

/**
 * A segment boundary in progress. Each track whose packets depend on earlier ones except at
 * keyframes (video, xHE-AAC) enters the next segment at its own next keyframe; the other tracks
 * enter it at once. The packets that entered wait in `held` until every such track has, then the
 * segment before them is written.
 */
interface SegmentCut {
    readonly entered: Set<number>;
    readonly held: HeldSample[];
    bytes: number;
}

interface RepresentationState {
    readonly id: string;
    readonly type: PackagedRepresentation['type'];
    readonly tracks: readonly RemuxTrack[];
    readonly reference: RemuxTrack;
    readonly hasVideo: boolean;
    /** The tracks that start a segment at a keyframe only: video and xHE-AAC. */
    readonly keyed: readonly number[];
    cut?: SegmentCut;
    readonly output: SegmentOutput;
    readonly segments: PackagedSegment[];
    readonly pending: Map<number, PendingTrack>;
    readonly clock: TickClock;
    bytes: number;
    peak: number;
}

class Ledger implements PackageLedger {
    files = 0;
    bytes = 0;
    segments = 0;
    representations: PackagedRepresentation[] = [];

    constructor(private readonly options: ResolvedPackageOptions) {}

    accept(file: PackagedFile): PackagedFile {
        assertPackageName(file.name);
        if (file.data.length > this.options.maxTotalBytes - this.bytes)
            packageError('package exceeds maxTotalBytes', 'OOM');
        this.bytes += file.data.length;
        this.files++;
        if (file.kind === 'segment') this.segments++;
        return file;
    }
}

/** The video and audio tracks of `ids`, or all; the playlists take the subtitle tracks. */
function selectTracks(file: MediaFile, ids: readonly number[] | undefined): RemuxTrack[] {
    const all = mediaFileState(file).tracks;
    const selected = (
        ids
            ? ids.map(
                  id =>
                      all.find(track => track.description.id === id) ??
                      packageError(`unknown track ${id}`),
              )
            : all
    ).filter(track => track.type !== 'subtitle');
    if (!selected.length) packageError('at least one video or audio track is required', 'FORMAT');
    for (const track of selected) {
        if (sampleCount(track.info) === 0)
            packageError('every selected track needs samples', 'FORMAT');
        const kind = track.info.codec.split('.')[0]!;
        if (
            track.type === 'video' &&
            NAL_CODECS.has(kind) &&
            (track.info.codecConfig?.length ?? 0) < (kind.startsWith('avc') ? 5 : 22)
        )
            packageError(`${track.info.codec} requires its decoder configuration record`, 'FORMAT');
    }
    return selected;
}

function cmafOutput(plan: PackagePlan, tracks: readonly RemuxTrack[]): SegmentOutput {
    const state = mediaFileState(plan.file);
    const { writer, configs } = state.planner().prepareSegments(
        tracks,
        {
            trackIds: tracks.map(track => track.description.id),
            targetDuration: plan.options.targetDuration,
            maxBufferedBytes: plan.options.maxBufferedBytes,
            maxBufferedSamples: plan.options.maxBufferedSamples,
            requireKeyframe: true,
        },
        state.diagnostics,
        undefined,
        'package',
    );

    return {
        init: writer.createInitSegment(),
        contiguous: true,
        configs,
        get bufferedBytes() {
            return writer.bufferedBytes;
        },
        get bufferedSamples() {
            return writer.bufferedSamples;
        },
        add: sample => writer.addSample(sample),
        amend: (trackId, duration) => writer.amendLastSampleDuration(trackId, duration),
        flush: () => writer.flush({ requireKeyframe: true }).data,
        finish: async () => undefined,
    };
}

function transportOutput(
    plan: PackagePlan,
    tracks: readonly RemuxTrack[],
    origin: number,
): SegmentOutput {
    const state = mediaFileState(plan.file);
    const planner = state.planner();
    planner.checkCopy(tracks);
    planner.checkTrackMetadata(tracks, 'ts', state.diagnostics);

    let chunks: Uint8Array[] = [];
    let bytes = 0;
    let samples = 0;
    let flushed = false;

    const sink: Sink = {
        write: data => {
            chunks.push(data);
            bytes += data.length;
        },
        close: async () => undefined,
    };

    const { muxer, routes } = planner.prepareContainer(
        tracks,
        sink,
        { format: 'ts', targetDuration: plan.options.targetDuration },
        state.diagnostics,
    );

    const segmented = muxer as { startSegment?: () => void };
    const startSegment = segmented.startSegment;
    if (typeof startSegment !== 'function')
        packageError('MPEG-TS packaging requires the built-in TS writer', 'FORMAT');

    return {
        contiguous: false,
        configs: tracks.map(track =>
            cmafTrackConfig({ ...track.description, timescale: trackTimescale(track) }),
        ),
        get bufferedBytes() {
            return bytes;
        },
        get bufferedSamples() {
            return samples;
        },
        add: (_sample, packet) => {
            if (flushed && samples === 0) startSegment.call(muxer);
            routes.get(packet.trackId)!(origin ? shiftPacket(packet, -origin) : packet);
            samples++;
        },
        flush: () => {
            const data = join(chunks);
            chunks = [];
            bytes = 0;
            samples = 0;
            flushed = true;
            return data;
        },
        finish: () => muxer.finalize(),
    };
}

/** A representation once its packets are written; `counts` are the packets read of each track. */
function summarize(
    rep: RepresentationState,
    naming: PackageNaming,
    counts: ReadonlyMap<number, number>,
): PackagedRepresentation {
    const info = rep.reference.info;
    const seconds = rep.clock.seconds;
    return {
        id: rep.id,
        type: rep.type,
        trackIds: rep.tracks.map(track => track.description.id),
        codecs: rep.tracks.map(track => rfc6381Codec(track.info)),
        init: rep.output.init ? naming.init(rep.id) : undefined,
        segments: rep.segments.slice(),
        bandwidth: rep.peak,
        averageBandwidth: seconds > 0 ? Math.round((rep.bytes * 8) / seconds) : 0,
        duration: seconds,
        timescale:
            rep.output.configs.find(config => config.id === rep.reference.description.id)
                ?.timescale ?? trackTimescale(rep.reference),
        width: rep.hasVideo ? info.width || undefined : undefined,
        height: rep.hasVideo ? info.height || undefined : undefined,
        displayWidth: rep.hasVideo ? info.displayWidth || info.width || undefined : undefined,
        displayHeight: rep.hasVideo ? info.displayHeight || info.height || undefined : undefined,
        frameRate: rep.hasVideo
            ? frameRate(rep.reference, counts.get(rep.reference.description.id) ?? 0)
            : undefined,
        sampleRate: rep.type === 'audio' ? info.sampleRate || undefined : undefined,
        channelCount: rep.type === 'audio' ? info.channelCount || undefined : undefined,
        language: rep.type === 'muxed' ? undefined : info.language,
        name: rep.type === 'muxed' ? undefined : info.name,
        // Only an initialization segment's sample entry keeps a spatial video.
        ...(rep.hasVideo && rep.output.init && info.spatial ? { spatial: info.spatial } : {}),
    };
}

/**
 * Yields initialization and media segments in emission order; the returned ledger accepts the
 * playlists.
 */
export async function* packageSegments(
    plan: PackagePlan,
): AsyncGenerator<PackagedFile, PackageLedger> {
    const { file, options, naming } = plan;
    const state = mediaFileState(file);
    if (plan.container === 'ts' && plan.demuxed)
        packageError('MPEG-TS output is always multiplexed');
    const tracks = selectTracks(file, options.trackIds);
    const groups = plan.demuxed ? tracks.map(track => [track]) : [tracks];
    const linked = linkAbortSignals(state.signal, options.signal);
    const reps: RepresentationState[] = [];
    const byTrack = new Map<number, RepresentationState>();
    const adapters = new Map<number, { adapter: CmafTiming; timescale: number }>();
    const ledger = new Ledger(options);
    const inits: PackagedFile[] = [];
    try {
        throwIfAborted(linked.signal);

        // The package presents its first picture or sound at zero, as file copies do: each
        // track's edit list presents it from zero past its reorder delay, priming or what the
        // input's edit list hid (fragmentedStart), as ffmpeg packages them. MPEG-TS clocks wrap
        // below zero instead.
        const fragments =
            plan.container === 'ts' ? undefined : groups.map(group => cmafOutput(plan, group));
        const start = fragments
            ? fragmentedStart(
                  groups.flat(),
                  fragments.flatMap(output => output.configs),
              )
            : presentedStart('ts', tracks);
        const origin = Number.isFinite(start) ? start : 0;
        for (const [at, group] of groups.entries()) {
            const video = group.find(track => track.type === 'video');
            const type: PackagedRepresentation['type'] = plan.demuxed
                ? video
                    ? 'video'
                    : 'audio'
                : 'muxed';
            const id = type === 'muxed' ? 'main' : `${type}${group[0]!.description.id}`;
            const output = fragments?.[at] ?? transportOutput(plan, group, origin);
            const rep: RepresentationState = {
                id,
                type,
                tracks: group,
                reference: video ?? group[0]!,
                hasVideo: video !== undefined,
                keyed: group
                    .filter(track => track.type === 'video' || audioHasKeyframes(track.info.codec))
                    .map(track => track.description.id),
                output,
                segments: [],
                pending: new Map(),
                clock: new TickClock(),
                bytes: 0,
                peak: 0,
            };
            group.forEach((track, index) => {
                const config = output.configs[index]!;
                byTrack.set(track.description.id, rep);
                adapters.set(track.description.id, {
                    timescale: config.timescale,
                    adapter: new CmafTiming(config, {
                        format: file.format,
                        timestampResolution:
                            track.info.timestampResolutionSeconds ?? 1 / trackTimescale(track),
                        origin,
                        onAligned: () =>
                            state.diagnostics.recover(
                                cmafClockDiagnostic(
                                    track.description,
                                    plan.container === 'ts' ? 'ts' : 'fmp4',
                                ),
                            ),
                        amend: rep.output.amend
                            ? (trackId, duration) => {
                                  // A sample waiting for the segment boundary is amended there.
                                  const waiting = rep.cut?.held ?? [];
                                  let index = waiting.length - 1;
                                  while (index >= 0 && waiting[index]!.packet.trackId !== trackId)
                                      index--;
                                  const held = waiting[index];
                                  if (held) {
                                      const previous = held.sample.duration;
                                      held.sample = { ...held.sample, duration };
                                      return previous;
                                  }
                                  const previous = rep.output.amend!(trackId, duration);
                                  const pending = rep.pending.get(trackId);
                                  if (previous !== undefined && pending)
                                      pending.ticks += BigInt(duration - previous);
                                  return previous;
                              }
                            : undefined,
                        onRepaired: () =>
                            state.diagnostics.recover(
                                cmafDecodeTimeDiagnostic(
                                    track.description,
                                    plan.container === 'ts' ? 'ts' : 'fmp4',
                                ),
                            ),
                        editTicks: plan.container === 'ts' ? 0 : cmafEditTicks(config),
                    }),
                });
            });
            reps.push(rep);
            if (output.init)
                inits.push(
                    ledger.accept({
                        kind: 'init',
                        name: naming.init(id),
                        data: output.init,
                        representation: id,
                    }),
                );
        }
        const referenceId = (tracks.find(track => track.type === 'video') ?? tracks[0]!).description
            .id;

        // An input read in one pass (a large one) counts its packets as it goes.
        const total = file.packetTotal(tracks.map(track => track.description.id));
        const counts = new Map<number, number>();
        const emit = async (rep: RepresentationState): Promise<PackagedFile> => {
            if (ledger.segments + 1 > options.maxSegments)
                packageError('package exceeds maxSegments', 'OUTPUT');
            const sequence = rep.segments.length;
            const number = naming.firstNumber + sequence;
            const name = naming.segment(rep.id, number);
            const timed =
                rep.pending.get(rep.reference.description.id) ?? rep.pending.values().next().value!;

            const timing: PackageSegmentTiming = {
                timescale: timed.timescale,
                time: timed.first,
                duration: timed.ticks,
            };
            rep.pending.clear();
            const raw: PackagedFile = {
                kind: 'segment',
                name,
                data: rep.output.flush(),
                representation: rep.id,
                number,
                timing,
            };

            const file = plan.transformSegment ? await plan.transformSegment(raw, sequence) : raw;
            if (file.name !== name || file.kind !== 'segment')
                packageError('segment transform must keep the name');

            const bytes = file.data.length;
            rep.peak = Math.max(
                rep.peak,
                Math.ceil((bytes * 8 * timing.timescale) / Number(timing.duration)),
            );
            rep.bytes += bytes;
            rep.clock.add(timing.duration, timing.timescale);
            rep.segments.push({ name, number, bytes, timing });
            return ledger.accept(file);
        };
        const write = (
            rep: RepresentationState,
            sample: CmafSample,
            packet: FilePacket,
            timescale: number,
        ): void => {
            rep.output.add(sample, packet);
            const duration = BigInt(sample.duration);
            const pending = rep.pending.get(packet.trackId);
            if (pending) pending.ticks += duration;
            else
                rep.pending.set(packet.trackId, {
                    first: BigInt(sample.decodeTimestamp),
                    ticks: duration,
                    timescale,
                });
        };
        const entered = (rep: RepresentationState): boolean =>
            rep.keyed.every(trackId => rep.cut!.entered.has(trackId));
        // Writes the segment before a cut, then the packets that entered the next one.
        const finishCut = async function* (rep: RepresentationState) {
            const { held } = rep.cut!;
            rep.cut = undefined;
            if (rep.output.bufferedSamples) {
                yield await emit(rep);
                throwIfAborted(linked.signal);
            }
            for (const entry of held) write(rep, entry.sample, entry.packet, entry.timescale);
        };
        for (const init of inits) {
            yield init;
            throwIfAborted(linked.signal);
        }
        let segmentStart: number | undefined;
        let packets = 0;
        let packetBytes = 0;
        /**
         * Video tracks that reached their first keyframe, and the dependent pictures left out
         * before it.
         */
        const keyed = new Set<number>();
        const leading = new Map<number, number>();
        for await (const packet of state.borrowedPackets({
            trackIds: tracks.map(track => track.description.id),
            signal: linked.signal,
        })) {
            throwIfAborted(linked.signal);
            counts.set(packet.trackId, (counts.get(packet.trackId) ?? 0) + 1);

            // Fragmented MP4 segments start at keyframes: pictures before a track's first one
            // cannot be decoded.
            if (
                plan.container !== 'ts' &&
                packet.trackType === 'video' &&
                !keyed.has(packet.trackId)
            ) {
                if (!packet.isKeyframe) {
                    leading.set(packet.trackId, (leading.get(packet.trackId) ?? 0) + 1);
                    packets++;
                    continue;
                }
                keyed.add(packet.trackId);
            }
            const rep = byTrack.get(packet.trackId)!;
            const { adapter, timescale } = adapters.get(packet.trackId)!;
            const prepared = adapter.prepare(packet);
            const size = prepared.sample.data.length;
            if (size > options.maxBufferedBytes)
                packageError('single packet exceeds maxBufferedBytes', 'OOM');
            const cutPoint = packet.trackId === referenceId && packet.isKeyframe;
            const full =
                rep.output.bufferedSamples >= options.maxBufferedSamples ||
                rep.output.bufferedBytes + size > options.maxBufferedBytes;
            const gap = rep.output.contiguous && prepared.discontinuity;
            if (
                segmentStart !== undefined &&
                cutPoint &&
                (prepared.time - segmentStart >= options.targetDuration || full || gap)
            ) {
                // Each representation's segment ends once its keyframe tracks reached a
                // keyframe: at once for the reference track's and for tracks without keyframes.
                for (const each of reps) {
                    if (!each.output.bufferedSamples || each.cut) continue;
                    const now = each === rep ? [packet.trackId] : [];
                    each.cut = { entered: new Set(now), held: [], bytes: 0 };
                    for (const trackId of each.tracks.map(track => track.description.id))
                        if (!each.keyed.includes(trackId)) each.cut.entered.add(trackId);
                    if (entered(each)) yield* finishCut(each);
                }
                segmentStart = undefined;
            } else if (full || gap) {
                if (rep.cut) yield* finishCut(rep);
                if (rep.hasVideo)
                    packageError(
                        full
                            ? 'segment reaches maxBufferedBytes or maxBufferedSamples before the ' +
                                  'next keyframe'
                            : `decode timeline gap in track ${packet.trackId} before a dependent ` +
                                  `video sample`,
                        full ? 'OOM' : 'FORMAT',
                    );
                if (rep.output.bufferedSamples) {
                    yield await emit(rep);
                    throwIfAborted(linked.signal);
                }
            }
            segmentStart ??= prepared.time;
            const cut = rep.cut;
            if (cut && (cut.entered.has(packet.trackId) || packet.isKeyframe)) {
                cut.entered.add(packet.trackId);
                cut.held.push({ sample: prepared.sample, packet, timescale });
                cut.bytes += size;
                if (
                    entered(rep) ||
                    cut.held.length >= options.maxBufferedSamples ||
                    cut.bytes >= options.maxBufferedBytes
                )
                    yield* finishCut(rep);
            } else write(rep, prepared.sample, packet, timescale);
            packets++;
            packetBytes += packet.data.length;
            options.onProgress?.({
                fraction: Math.min(1, packets / Math.max(1, total)),
                packets,
                packetBytes,
                segments: ledger.segments,
                bytes: ledger.bytes,
            });
            throwIfAborted(linked.signal);
        }
        throwIfAborted(linked.signal);
        for (const [trackId, count] of leading) {
            if (!keyed.has(trackId))
                packageError(`video track ${trackId} has no keyframe`, 'FORMAT');
            state.diagnostics.recover({
                code: 'REMUX_VIDEO_SAMPLES_DROPPED',
                message: `${count} video packet(s) before the first keyframe are left out`,
                trackId,
                format: 'fmp4',
            });
        }
        for (const rep of reps) {
            if (rep.cut) yield* finishCut(rep);
            if (!rep.output.bufferedSamples) continue;
            yield await emit(rep);
            throwIfAborted(linked.signal);
        }
        for (const rep of reps) await rep.output.finish();
        throwIfAborted(linked.signal);
        ledger.representations = reps.map(rep => summarize(rep, naming, counts));
        return ledger;
    } finally {
        linked.dispose();
    }
}
