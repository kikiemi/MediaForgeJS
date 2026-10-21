import type { OperationRequest } from '../pipeline/types';
import type { MediaInput, Source } from '../core/model/types';
import type { ContainerFormat } from '../core/model/media';
import type { ProbeTarget } from '../core/model/track';
import type { MediaDiagnostic } from '../core/errors/diagnostics';
import type { PackagedFile } from '../pipeline/package/types';
import { MediaForgeError } from '../core/errors/errors';
import { OptionNormalizer, type OptionPolicy } from '../core/errors/option-policy';
import { mimeTypeOf } from '../formats/shared/mime-types';
import { BLOB_PART_BYTES, MemorySink } from '../core/io/sinks/sinks';
import { isMediaInput } from '../core/io/sources/sources';
import { withOutputLimit } from '../core/io/sinks/output-sink';
import type { Engine } from '../pipeline/engine';
import { BLOB_MAX_BYTES } from '../pipeline/media-types';
import { prepareConversion, sameContainer } from '../pipeline/plan/conversion';
import { mediaFileState } from '../pipeline/read/file-state';
import { copyPlan, selectedTracks, settledPlan } from '../pipeline/plan/media-plan';
import { checkPicture, takePicture, type PictureTarget } from '../pipeline/frames/pictures';
import { prefetchConversion } from '../pipeline/plan/operation-loads';
// Every operation here plans or runs a copy: the packet copy loads with them, and the engine takes
// it from here (packetCopyLoaded below) instead of requesting it again.
import * as packetCopy from '../pipeline/copy/packet-copy';
import { packetCopyLoaded } from '../pipeline/read/media-file';
import type { EditProject } from '../editing/project';
import { snapshotEditProject } from '../editing/snapshot';
import { hintFor, withHint, type HintContext } from './hints';
import { convertProbe as conversionRead } from './read-probes';
import { indexed, readWith, type MediaContext, type MediaReading } from './media-reads';
import { progressReporter } from './operation';
import { mediaResult } from './results';
import { warningOf } from './options/options';
import { resolveOpenOptions } from './options/open-options';
import { resolveTarget, takesTarget, type ResolvedTarget, type TargetParts } from './target';
import type {
    ConvertSupport,
    MediaPlan,
    MediaResult,
    OpenOptions,
    PackageResult,
    PackageTargetFormat,
    SinkResult,
    TargetOptions,
} from './types';

packetCopyLoaded(packetCopy);

export { withHint };

/** convertProbe(), the copy and the target's writers loading while the input opens. */
export function convertProbe(target: TargetOptions): ProbeTarget {
    prefetchConversion(target.to);
    return conversionRead(target);
}
export type { MediaContext, Session } from './media-reads';

/**
 * What a MediaForge lends the operations it runs: its option policy, codecs, warning listener and
 * engine.
 */
export interface ForgeContext extends TargetParts {
    readonly policy: OptionPolicy;
    warn(warning: MediaDiagnostic): void;
    engine(): Promise<Engine>;
    openOptions(signal: AbortSignal | undefined): OpenOptions;
}

/** Records the context a failure's hint is chosen for. */
export type Describe = (context: HintContext) => void;

/** The resolved target of an image input, with the warnings of its options. */
function imageResolution(
    forge: ForgeContext,
    target: TargetOptions,
): { resolved: ResolvedTarget; warnings: MediaDiagnostic[] } {
    const normalizer = new OptionNormalizer(forge.policy, 'target');
    const resolved = resolveTarget(target, normalizer);
    return { resolved, warnings: normalizer.findings.map(warningOf) };
}

function assertImageTarget(resolved: ResolvedTarget): void {
    if (resolved.kind !== 'image')
        throw new MediaForgeError(
            `An image input converts to image formats, not ${resolved.format}`,
            'FORMAT',
            {
                hint: "Choose an image format such as 'png', 'jpeg' or 'webp'.",
            },
        );
}

/** Whether a still image input converts into `target`. */
export function checkImage(forge: ForgeContext, target: TargetOptions): ConvertSupport {
    const { resolved, warnings } = imageResolution(forge, target);
    assertImageTarget(resolved);
    return {
        supported: true,
        plan: { format: resolved.format, action: 'image', tracks: [] },
        warnings,
    };
}

/** A still image input drawn into an image target. */
export async function convertImage(
    forge: ForgeContext,
    input: Source | MediaInput,
    target: TargetOptions,
): Promise<MediaResult> {
    const { resolved, warnings } = imageResolution(forge, target);
    for (const warning of warnings) forge.warn(warning);
    assertImageTarget(resolved);
    if (!(input instanceof Blob) && typeof (input as Source).read === 'function')
        throw new MediaForgeError('Still image targets take a Blob, File or bytes', 'INPUT', {
            hint: 'Read the Source into a Blob first.',
        });

    const blob = input instanceof Blob ? input : new Blob([input as ArrayBuffer]);
    const video = target.video ?? {};
    for (const key of ['crop', 'rotate', 'flip', 'fit'] as const)
        if (video[key] !== undefined) {
            const warning = warningOf({
                code: 'OPTION_IGNORED',
                message: `video.${key} does not apply to still images`,
            });
            warnings.push(warning);
            forge.warn(warning);
        }

    const plan = { format: resolved.format, action: 'image' as const, tracks: [] };
    resolved.settings.onPlan?.(plan);
    try {
        const { ImageConverter } = await import('../pipeline/frames/image-converter');
        const image = resolved.image!;
        const { signal, onProgress } = resolved.settings;
        const output = await new ImageConverter({
            outputFormat: resolved.format as never,
            width: image.width,
            height: image.height,
            fps: image.fps,
            imageQuality: image.quality,
            imageFit: image.fit,
            imageResize: image.resize,
            imageDither: image.dither,
            signal,
            onProgress: onProgress
                ? progress =>
                      onProgress({ fraction: Math.min(1, progress.fraction), stage: 'encode' })
                : undefined,
            onWarning: (code, message) => {
                const warning = warningOf({ code, message, format: resolved.format });
                warnings.push(warning);
                forge.warn(warning);
            },
            strict: forge.openOptions(undefined).validation === 'strict',
        }).convertImage(blob);
        onProgress?.({ fraction: 1, stage: 'encode' });
        return mediaResult(output, resolved.format, plan, warnings, input);
    } catch (error) {
        throw withHint(error, { format: resolved.format, kind: 'image' });
    }
}

/** Runs an edit project into `target`. */
export async function edit(
    forge: ForgeContext,
    project: EditProject,
    target: TargetOptions,
): Promise<MediaResult | SinkResult> {
    const normalizer = new OptionNormalizer(forge.policy, 'target');
    const resolved = resolveTarget(target, normalizer, forge);
    const warnings = normalizer.findings.map(warningOf);
    const collect = (warning: MediaDiagnostic): void => {
        warnings.push(warning);
        forge.warn(warning);
    };
    for (const warning of warnings) forge.warn(warning);
    if (!resolved.target || !takesTarget('edit', resolved.kind))
        throw new MediaForgeError(`edit() cannot write ${resolved.kind} targets`, 'INPUT', {
            hint: 'Choose a container or an audio format.',
        });

    const {
        snapshot: open,
        policy,
        findings,
    } = resolveOpenOptions({
        ...forge.openOptions(resolved.settings.signal),
        onWarning: collect,
    });
    const projectSettings = new OptionNormalizer(policy, 'project');
    const resolvedProject = snapshotEditProject(
        resolved.target.mute && project && Array.isArray(project.clips)
            ? {
                  ...project,
                  clips: project.clips.map(clip => ({
                      ...clip,
                      audio: { ...clip?.audio, mute: true },
                  })),
              }
            : project,
        projectSettings,
    );
    for (const finding of [...findings, ...projectSettings.findings]) collect(warningOf(finding));

    const { sink: output, maxBytes } = resolved.settings;
    const memory = output
        ? undefined
        : new MemorySink({ maxBytes: maxBytes ?? BLOB_MAX_BYTES, blobPartBytes: BLOB_PART_BYTES });
    const sink = output ? withOutputLimit(output, maxBytes ?? Number.MAX_SAFE_INTEGER) : memory!;

    let plan: MediaPlan;
    try {
        const { editProject } = await import('../editing/render');
        plan = await editProject(
            await forge.engine(),
            resolvedProject,
            sink,
            resolved.target.request,
            {
                open,
                copy: resolved.target.copy,
                onPlan: resolved.settings.onPlan,
                exactAudioCodec: resolved.target.exactAudioCodec,
            },
        );
    } catch (error) {
        throw withHint(error, { format: resolved.format, kind: resolved.kind, blob: true });
    }

    const firstClip = isMediaInput(project?.clips?.[0]?.input)
        ? project.clips[0]!.input
        : undefined;
    const type = mimeTypeOf(resolved.format);
    const result = mediaResult(
        memory?.toBlob(type) ?? new Blob([], { type }),
        resolved.format,
        plan,
        warnings,
        firstClip,
    );
    if (memory) return result;
    const { blob: _blob, ...written } = result;
    return written;
}

/** The resolved `target` on the input; option findings reach the running operation's warnings. */
function resolvedFor(
    media: MediaContext,
    target: TargetOptions,
    warnings?: MediaDiagnostic[],
): ResolvedTarget {
    const normalizer = new OptionNormalizer(media.session.optionPolicy, 'target');
    const resolved = resolveTarget(
        { ...target, to: target.to ?? sameContainer(media.file.format) },
        normalizer,
        media.engine,
    );
    for (const finding of normalizer.findings) {
        if (warnings) warnings.push(warningOf(finding));
        else media.session.warn(warningOf(finding));
    }
    return resolved;
}

/** The engine's request and plan of a container or audio target on the input. */
function prepare(
    media: MediaContext,
    resolved: ResolvedTarget,
): Promise<{ request: OperationRequest; plan: MediaPlan }> {
    return prepareConversion(media.engine, media.file, resolved.target!, warning =>
        media.session.warn(warningOf(warning)),
    );
}

/** The picture or animation an image target takes from the input. */
function pictureOf(resolved: ResolvedTarget): PictureTarget {
    const image = resolved.image!;
    return {
        format: resolved.format,
        geometry: { ...image.geometry, signal: resolved.settings.signal },
        fps: image.fps,
        quality: image.quality,
        dither: image.dither,
        start: resolved.settings.start,
        end: resolved.settings.end,
    };
}

/**
 * Whether convert() copies every track of the input into a container, which a probed input does in
 * one pass through it (a whole copy) or through the window of a range. Reports nothing: the
 * conversion reports its options.
 */
async function copiesInOnePass(media: MediaContext, requested: TargetOptions): Promise<boolean> {
    try {
        const resolved = resolveTarget(
            { ...requested, to: requested.to ?? sameContainer(media.file.format) },
            new OptionNormalizer(media.session.optionPolicy, 'target'),
            media.engine,
        );
        if (
            (resolved.kind !== 'remux' && resolved.kind !== 'convert') ||
            !resolved.target ||
            resolved.settings.audio?.replace !== undefined
        )
            return false;
        const { request, plan } = await prepareConversion(
            media.engine,
            media.file,
            resolved.target,
            () => undefined,
        );
        // What runs decides: a copy of the file streams through it, while a conversion that copies
        // its tracks through the timeline reads the index.
        const copies =
            request.operation === 'remux' ||
            (request.operation === 'convert' && media.engine.runner.copies(media.file, request));
        if (plan.action !== 'copy' || !copies) return false;
        // A probe's tracks hold the samples of its head only, while an audio copy that trims (codec
        // delay, priming, padding or an edit) counts the coded samples of the whole track: such a
        // copy reads the index first. A copy of a range into Matroska keeps no count, only the
        // discard a header states.
        const { copiedAudioTrackConfig, headerAudioDiscard } =
            await import('../pipeline/copy/copied-track');
        const tracks = mediaFileState(media.file).tracks;
        const range =
            (requested.start !== undefined || requested.end !== undefined) &&
            (plan.format === 'mkv' || plan.format === 'webm');
        return !plan.tracks.some(planned => {
            const track = tracks.find(item => item.description.id === planned.trackId);
            return (
                planned.type === 'audio' &&
                track !== undefined &&
                copiedAudioTrackConfig(track.info, plan.format as ContainerFormat).validSamples !==
                    undefined &&
                !(range && headerAudioDiscard(track.info))
            );
        });
    } catch (error) {
        if (error instanceof MediaForgeError) return false;
        throw error;
    }
}

/**
 * Whether packageMedia() packages a probed input in one pass through it: each video and audio track
 * it packages (`trackIds`, or all of them) has packets in the probe's head, which times the
 * package.
 */
function packagesInOnePass(media: MediaContext, trackIds: readonly number[] | undefined): boolean {
    const file = media.file;
    return file.tracks
        .filter(
            track =>
                track.type !== 'subtitle' &&
                (trackIds === undefined || trackIds.includes(track.id)),
        )
        .every(track => file.packetTotal([track.id]) > 0);
}

/**
 * Media.convert() on a snapshot of its target. A copy of a probed input reads it as convertProbe()
 * says; a conversion of a range decodes it from the input's start and reads from there to after
 * the range; anything else reads the index.
 */
export async function convert(
    reading: MediaReading,
    requested: TargetOptions,
    warnings: MediaDiagnostic[],
    describe: Describe,
): Promise<MediaResult | SinkResult> {
    const { signal } = requested;
    const { range } = conversionRead(requested);
    const converted = await readWith(reading, convertProbe(requested), signal, async media =>
        !media.file.probedInput ||
        (await copiesInOnePass(media, requested)) ||
        (range && media.file.fromStart)
            ? convertFile(media, requested, warnings, describe)
            : undefined,
    );
    return (
        converted ??
        readWith(reading, range && { range: { ...range, fromStart: true } }, signal, media =>
            convertFile(media, requested, warnings, describe),
        )
    );
}

/** convert() on the file it reads. */
async function convertFile(
    media: MediaContext,
    requested: TargetOptions,
    warnings: MediaDiagnostic[],
    describe: Describe,
): Promise<MediaResult | SinkResult> {
    const resolved = resolvedFor(media, requested);
    const target = resolved.settings;
    describe({
        format: resolved.format,
        kind: resolved.kind,
        audioCodec: target.audio?.codec,
        blob: !target.sink,
    });

    if (!takesTarget('convert', resolved.kind))
        throw new MediaForgeError(
            `${resolved.format} targets are produced by packageMedia()`,
            'INPUT',
            {
                hint: `Call packageMedia(input, '${resolved.format}') instead.`,
            },
        );
    if (target.audio?.replace !== undefined && resolved.target && resolved.kind !== 'audio')
        return replaceAudio(media, resolved, target, warnings);
    if (resolved.kind === 'image') {
        if (target.sink) throw new MediaForgeError('Image targets are returned as a Blob', 'INPUT');
        for (const warning of await media.engine.pictureMetadataLoss(media.file, resolved.format))
            media.session.warn(warning);
        const plan: MediaPlan = { format: resolved.format, action: 'image', tracks: [] };
        target.onPlan?.(plan);
        const progress = progressReporter(target.onProgress, 'encode');
        const blob = await takePicture(media.engine, media.file, pictureOf(resolved));
        progress.finish();
        return mediaResult(blob, resolved.format, plan, warnings, media.input);
    }

    const { request, plan } = await prepare(media, resolved);
    target.onPlan?.(plan);
    const progress = progressReporter(
        target.onProgress,
        plan.action === 'copy' ? 'copy' : 'encode',
        plan.duration,
    );
    const running = { ...request, onProgress: progress.callback };

    if (target.sink) {
        await media.engine.write(media.file, target.sink, running, { maxBytes: target.maxBytes });
        progress.finish();
        const { blob: _blob, ...written } = mediaResult(
            new Blob([]),
            resolved.format,
            settledPlan(plan, warnings),
            warnings,
            media.input,
        );
        return written;
    }

    const blob = await media.engine.toBlob(media.file, running, { maxBytes: target.maxBytes });
    progress.finish();
    return mediaResult(blob, resolved.format, settledPlan(plan, warnings), warnings, media.input);
}

/**
 * The input's pictures with another file's sound: an edit of one muted clip over the replacement
 * audio. A speed plays the clip at that speed; the replacement sound plays as it is.
 */
async function replaceAudio(
    media: MediaContext,
    resolved: ResolvedTarget,
    target: TargetOptions,
    warnings: MediaDiagnostic[],
): Promise<MediaResult | SinkResult> {
    const { replace, speed: _sound, ...audio } = target.audio!;
    const { speed, ...video } = target.video ?? {};
    const result = await media.session.edit(
        {
            clips: [
                {
                    input: media.input,
                    start: target.start,
                    end: target.end,
                    speed,
                    audio: { mute: true },
                },
            ],
            audio: [{ input: replace! }],
            ...(video.fps !== undefined ? { fps: video.fps } : {}),
        },
        { ...target, to: resolved.format, video, audio, start: undefined, end: undefined },
    );
    return { ...result, warnings: Object.freeze([...warnings, ...result.warnings]) };
}

/**
 * Media.check() on a snapshot of its target, from the index; failures are thrown for the caller to
 * plan.
 */
export async function check(
    reading: MediaReading,
    requested: TargetOptions,
    warnings: MediaDiagnostic[],
    describe: Describe,
): Promise<ConvertSupport> {
    const media = await indexed(reading, requested.signal);
    const resolved = resolvedFor(media, requested, warnings);
    const target = resolved.settings;
    const context: HintContext = {
        format: resolved.format,
        kind: resolved.kind,
        audioCodec: target.audio?.codec,
    };
    describe(context);

    if (resolved.kind === 'image') {
        warnings.push(...(await media.engine.pictureMetadataLoss(media.file, resolved.format)));
        await checkPicture(media.engine, media.file, pictureOf(resolved));
        return {
            supported: true,
            plan: { format: resolved.format, action: 'image', tracks: [] },
            warnings,
        };
    }

    if (resolved.kind === 'package') {
        const request = resolved.package!;
        const trackIds =
            request.trackIds ??
            media.file.tracks.filter(track => track.type !== 'subtitle').map(track => track.id);
        const container = request.container === 'ts' ? 'ts' : 'fmp4';
        await media.engine.loadWriter(container);
        const support = media.engine.probe(media.file, {
            operation: 'remux',
            format: container,
            trackIds,
        });
        if (!support.supported)
            throw new MediaForgeError(support.reason, support.code, {
                hint: support.hint,
                plugin: support.plugin,
            });
        return { supported: true, plan: packagePlan(media, resolved.format, trackIds), warnings };
    }

    const prepared = await prepare(media, {
        ...resolved,
        target: { ...resolved.target!, request: silent(resolved) },
    });
    const support = await media.engine.check(media.file, prepared.request, {
        maxBytes: target.maxBytes,
    });
    if (!support.supported)
        return {
            ...support,
            hint: support.hint ?? hintFor(support.code, support.reason, context),
            warnings: [...warnings, ...support.warnings],
        };
    return { supported: true, plan: prepared.plan, warnings: [...warnings, ...support.warnings] };
}

/** The request of a resolved target without its progress callback, for checks that plan none. */
function silent(resolved: ResolvedTarget): OperationRequest {
    return { ...resolved.target!.request, onProgress: undefined } as OperationRequest;
}

/** The plan of packaging the selected tracks, which are copied. */
function packagePlan(
    media: MediaContext,
    format: string,
    trackIds: readonly number[] | undefined,
): MediaPlan {
    return copyPlan(format, selectedTracks(media.file.tracks, trackIds), {}, 'package');
}

/**
 * Media.packageMedia() on a snapshot of its target: a probed input in one pass through it where
 * its head times every track it packages, otherwise from the index.
 */
export async function packageMedia(
    reading: MediaReading,
    requested: TargetOptions,
    warnings: MediaDiagnostic[],
    describe: Describe,
): Promise<PackageResult> {
    const { signal, trackIds } = requested;
    const packaged = await readWith(reading, { stream: true }, signal, async media =>
        !media.file.probedInput || packagesInOnePass(media, trackIds)
            ? packageFile(media, requested, warnings, describe)
            : undefined,
    );
    return packaged ?? packageFile(await indexed(reading, signal), requested, warnings, describe);
}

/** packageMedia() on the file it reads. */
async function packageFile(
    media: MediaContext,
    requested: TargetOptions,
    warnings: MediaDiagnostic[],
    describe: Describe,
): Promise<PackageResult> {
    const resolved = resolvedFor(media, { ...requested, to: requested.to ?? 'hls' });
    const target = resolved.settings;
    describe({ format: resolved.format, kind: 'package' });
    if (!takesTarget('packageMedia', resolved.kind))
        throw new MediaForgeError('packageMedia() takes an hls, dash or hls+dash target', 'INPUT', {
            hint: `Use convert() for ${resolved.format}.`,
        });

    const request = resolved.package!;
    const plan = packagePlan(media, resolved.format, request.trackIds);
    target.onPlan?.(plan);
    const progress = progressReporter(target.onProgress, 'package');
    const running = { ...request, onProgress: progress.callback };
    let files = new Map<string, PackagedFile>();
    if (target.onFile)
        for await (const file of media.engine.package(media.file, running))
            await target.onFile(file);
    else files = await media.engine.packageToMap(media.file, running);
    progress.finish();

    const format = resolved.format as PackageTargetFormat;
    const entry =
        format === 'dash'
            ? 'manifest.mpd'
            : files.size && !files.has('master.m3u8')
              ? files.keys().next().value!
              : 'master.m3u8';
    return { files, entry, format, plan, warnings: Object.freeze([...warnings]) };
}
