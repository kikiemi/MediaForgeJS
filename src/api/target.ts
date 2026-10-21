import { MediaForgeError } from '../core/errors/errors';
import { OptionNormalizer, closestName } from '../core/errors/option-policy';
import { canonicalFormat, formatAliases, formatAudioCodec } from '../formats/shared/names';
import { canMuxCodec } from '../formats/shared/capabilities';
import {
    canonicalAudioCodec,
    canonicalVideoCodec,
    codecDisplayName,
    foldCodecString,
    isCodecString,
} from '../core/model/codec-names';
import type { OutputContainerFormat } from '../core/model/media';
import type { VideoCodecProvider } from '../core/contracts/encoder';
import type { StageDefinition } from '../core/contracts/stage';
import {
    ANIMATED_IMAGE_FORMATS,
    AUDIO_FILE_FORMATS,
    CONTAINER_TARGETS,
    FRAME_ENCODE_FORMATS,
    FRAME_IMAGE_FORMATS,
    IMAGE_FORMATS,
    LOSSY_IMAGE_FORMATS,
    PACKAGE_FORMATS,
    PCM_AUDIO_FORMATS,
    REMUX_FORMATS,
    audioFormatCodec,
} from '../pipeline/plan/format-policy';
import type { ConversionTarget } from '../pipeline/plan/conversion';
import type { PictureTarget } from '../pipeline/frames/pictures';
import { QUALITY_SCALE } from '../pipeline/plan/encode-settings';
import type {
    AudioFileFormat,
    AudioFileRequest,
    ConvertRequest,
    PackageRequest,
    PcmCoding,
    CopyRequest,
} from '../pipeline/types';
import type { AudioSpeedMode } from '../pipeline/api-types';
import { codecPreferenceOf, TARGET_KEYS } from './options/options';
import { snapshotEncoderSettings } from './options/encoder-settings';
import { packageSettings, snapshotRange, stageOption } from './options/requests';
import { snapshotVideoGeometry } from '../stages/geometry-options';
import type {
    AudioSettings,
    AudioSpeedSetting,
    ImageSettings,
    TargetOptions,
    VideoSettings,
} from './types';

/**
 * Target normalization: every setting of a target is read once, here, and becomes the engine's
 * typed target. Unusable settings are repaired or dropped with a finding (strict policy: rejected
 * with INPUT); an unknown format fails.
 */

/**
 * What a target asks for: a copy or re-encode into a container, an audio file, an image or a
 * package.
 */
type TargetKind = 'remux' | 'convert' | 'audio' | 'image' | 'package';

/**
 * An image target's settings after validation: the picture taken from video, or the still image
 * converted.
 */
interface ImageSettingsResolved extends Omit<
    PictureTarget,
    'format' | 'geometry' | 'start' | 'end'
> {
    readonly width?: number;
    readonly height?: number;
    readonly fit?: ImageSettings['fit'];
    readonly resize?: ImageSettings['resize'];
    /** Video pictures: crop, rotation, flip and fit of the picture taken from the input. */
    readonly geometry: PictureTarget['geometry'];
}

export interface ResolvedTarget {
    readonly kind: TargetKind;
    readonly format: string;
    /**
     * The target's settings after validation: known keys only, with checked callbacks, signal and
     * limits.
     */
    readonly settings: TargetOptions;
    /** remux, convert and audio targets: what the engine runs. */
    readonly target?: ConversionTarget;
    /** package targets: the packaging request. */
    readonly package?: PackageRequest;
    readonly image?: ImageSettingsResolved;
}

const VIDEO_KEYS = [
    'codec',
    'width',
    'height',
    'fit',
    'crop',
    'rotate',
    'flip',
    'fps',
    'speed',
    'bitrate',
    'quality',
    'keyframeInterval',
    'autoRotate',
    'hardwareAcceleration',
    'latencyMode',
    'bitrateMode',
    'stages',
];
const AUDIO_KEYS = [
    'codec',
    'sampleRate',
    'channels',
    'bitrate',
    'vbr',
    'mute',
    'replace',
    'speed',
    'stages',
];
const AUDIO_SPEEDS: readonly AudioSpeedSetting[] = ['preserve-pitch', 'shift-pitch', 'mute'];

/** Range of `video.speed`, as edit clips take it. */
const SPEED = { positive: true, min: 0.1, max: 10 } as const;
const IMAGE_KEYS = ['quality', 'fit', 'resize', 'dither'];

/** Video settings that only re-encoding uses. */
const ENCODER_KEYS = [
    'speed',
    'keyframeInterval',
    'autoRotate',
    'codec',
    'bitrate',
    'quality',
    'hardwareAcceleration',
    'latencyMode',
    'bitrateMode',
] as const;
const IMAGE_TARGETS: readonly string[] = [...IMAGE_FORMATS];
const TARGET_FORMATS: ReadonlySet<string> = new Set([
    ...REMUX_FORMATS,
    ...AUDIO_FILE_FORMATS,
    ...IMAGE_TARGETS,
    ...PACKAGE_FORMATS,
]);

/** What a target's format writes: a container, an audio file, an image or a package. */
export type TargetClass = 'container' | 'audio' | 'image' | 'package';

/**
 * The class of a target format, the one place it is decided: resolveTarget() reads a target by it
 * and each operation takes the classes OPERATION_TARGETS gives it. A format both lists name (Ogg,
 * which encodes Opus as a container does) is a container.
 */
export function targetClassOf(format: string): TargetClass {
    if ((PACKAGE_FORMATS as readonly string[]).includes(format)) return 'package';
    if (IMAGE_FORMATS.has(format as OutputContainerFormat)) return 'image';
    if (
        (AUDIO_FILE_FORMATS as readonly string[]).includes(format) &&
        !CONTAINER_TARGETS.has(format)
    )
        return 'audio';
    return 'container';
}

/** The target formats of each class. */
function classFormats(formats: Iterable<string>): Readonly<Record<TargetClass, readonly string[]>> {
    const classes: Record<TargetClass, string[]> = {
        container: [],
        audio: [],
        image: [],
        package: [],
    };
    for (const format of formats) classes[targetClassOf(format)].push(format);
    return Object.freeze({
        container: Object.freeze(classes.container),
        audio: Object.freeze(classes.audio),
        image: Object.freeze(classes.image),
        package: Object.freeze(classes.package),
    });
}

/** The formats of every class a target of convert(), check() or edit() may name. */
const CLASS_FORMATS = classFormats(TARGET_FORMATS);

/**
 * The target classes each public operation of mediaforgejs takes, with the formats it takes of
 * each; `none` for the operations without a target. The operations refuse the other classes, and
 * the support matrix runs one case per operation and class.
 */
export const OPERATION_TARGETS: Readonly<
    Record<string, Readonly<Partial<Record<TargetClass | 'none', readonly string[]>>>>
> = Object.freeze({
    capabilities: { none: [] },
    check: CLASS_FORMATS,
    convert: {
        container: CLASS_FORMATS.container,
        audio: CLASS_FORMATS.audio,
        image: CLASS_FORMATS.image,
    },
    createPlayer: { none: [] },
    edit: { container: CLASS_FORMATS.container, audio: CLASS_FORMATS.audio },
    encodeFrames: { container: FRAME_ENCODE_FORMATS },
    frames: { none: [] },
    inspect: { none: [] },
    open: { none: [] },
    packageMedia: { package: CLASS_FORMATS.package },
    play: { none: [] },
    recordStream: { container: FRAME_ENCODE_FORMATS },
    thumbnail: { image: FRAME_IMAGE_FORMATS },
});

/** Whether `operation` takes targets of `kind` (resolveTarget's kind of a target). */
export function takesTarget(operation: string, kind: TargetKind): boolean {
    const targetClass = kind === 'remux' || kind === 'convert' ? 'container' : kind;
    return OPERATION_TARGETS[operation]?.[targetClass] !== undefined;
}

/** Most pixels a re-encode writes: 8192 × 4320. */
const MAX_PIXELS = 8192 * 4320;

/** Sample-rate range of audio settings, in Hz. */
const SAMPLE_RATES = { integer: true, positive: true, min: 8000, max: 192000 } as const;
const CHANNELS = { integer: true, positive: true, max: 8 } as const;
const PCM_CODEC_ALIASES: Readonly<Record<string, PcmCoding>> = {
    mulaw: 'ulaw',
    'mu-law': 'ulaw',
    'µ-law': 'ulaw',
    pcm_mulaw: 'ulaw',
    g711u: 'ulaw',
    'a-law': 'alaw',
    pcm_alaw: 'alaw',
    g711a: 'alaw',
    pcm_s16le: 'pcm',
    'pcm-s16le': 'pcm',
    s16: 'pcm',
};

/**
 * The codec string of `video.codec` or `audio.codec`, or undefined (reported) when it names no
 * codec.
 */
function codecOption(
    normalizer: OptionNormalizer,
    kind: 'audio' | 'video',
    value: string | undefined,
    providers: readonly VideoCodecProvider[] = [],
): string | undefined {
    if (value === undefined) return undefined;
    const text = normalizer.string(`${kind}.codec`, value, 64);
    if (text === undefined) return undefined;
    const codec = foldCodecString(
        kind === 'video' ? canonicalVideoCodec(text) : canonicalAudioCodec(text),
    );
    if (codec === 'auto' || isCodecString(kind, codec)) return codec;
    // A plugin's video codec, such as ProRes 'apcn'.
    if (kind === 'video' && providers.some(provider => provider.supportsEncode(codec)))
        return codec;
    normalizer.ignore(
        `${kind}.codec`,
        value,
        kind === 'video'
            ? 'is not a video codec such as h264, vp9 or av1'
            : 'is not an audio codec such as aac, opus or mp3',
    );
    return undefined;
}

/**
 * What the plugins in use add to the names a target may use: video codecs and processing stages.
 */
export interface TargetParts {
    readonly videoCodecs: readonly VideoCodecProvider[];
    readonly stages: readonly StageDefinition[];
}

const NO_PARTS: TargetParts = { videoCodecs: [], stages: [] };

/** The requested codec of a container target; m4a holds the audio a copy into it may hold. */
function containerAudioCodec(
    normalizer: OptionNormalizer,
    format: string,
    value: string | undefined,
): string | undefined {
    const codec = codecOption(normalizer, 'audio', value);
    if (format !== 'm4a' || codec === undefined || codec === 'auto') return codec;
    if (canMuxCodec(format, 'audio', codec)) return codec;
    normalizer.ignore('audio.codec', value, 'cannot go in m4a output');
    return undefined;
}

function defined(settings: object): boolean {
    return Object.values(settings).some(value => value !== undefined);
}

/** Known keys of one settings object; misspelled keys are reported and dropped. */
function nested<T extends object>(
    normalizer: OptionNormalizer,
    value: T | undefined,
    known: readonly string[],
    scope: string,
): T {
    if (value === undefined || value === null) return {} as T;
    if (typeof value !== 'object' || Array.isArray(value)) {
        normalizer.ignore(scope, value, 'must be an object');
        return {} as T;
    }
    const nested = new OptionNormalizer(normalizer.policy, `target ${scope}`);
    const result = nested.keys(value, known) as T;
    normalizer.adopt(nested.findings);
    return result;
}

/** The format to name in an unknown-format error: a close spelling of a known format or alias. */
function suggestFormat(value: string): string | undefined {
    const name = closestName(value.replace(/^\./, ''), [
        ...TARGET_FORMATS,
        ...Object.keys(formatAliases),
    ]);
    return name === undefined ? undefined : (formatAliases[name] ?? name);
}

/**
 * Output width and height of a re-encode: positive integers up to 16384 within the pixel budget.
 */
function outputSize(
    normalizer: OptionNormalizer,
    video: VideoSettings,
): { width?: number; height?: number } {
    let width = normalizer.number('width', video.width, {
        integer: true,
        positive: true,
        max: 16384,
    });
    let height = normalizer.number('height', video.height, {
        integer: true,
        positive: true,
        max: 16384,
    });
    if (width !== undefined && height !== undefined && width * height > MAX_PIXELS) {
        normalizer.ignore('width', `${width}×${height}`, 'has more pixels than 8192×4320');
        width = height = undefined;
    }
    return { width, height };
}

/**
 * Image settings of an image target, validated for `format`, with the geometry of pictures taken
 * from video.
 */
function imageSettings(
    normalizer: OptionNormalizer,
    format: string,
    video: VideoSettings,
    image: ImageSettings,
    stages: readonly StageDefinition[],
): ImageSettingsResolved {
    const animated = ANIMATED_IMAGE_FORMATS.has(format);
    const width = normalizer.number('video.width', video.width, {
        integer: true,
        positive: true,
        max: 16384,
    });
    const height = normalizer.number('video.height', video.height, {
        integer: true,
        positive: true,
        max: 16384,
    });
    let fps = normalizer.number('video.fps', video.fps, { positive: true, max: 300 });
    if (fps !== undefined && !animated) {
        normalizer.ignore('video.fps', fps, `cannot apply to still-image '${format}' output`);
        fps = undefined;
    }

    let quality = normalizer.number('image.quality', image.quality, { min: 0, max: 1 });
    if (quality !== undefined && !LOSSY_IMAGE_FORMATS.has(format)) {
        normalizer.ignore('image.quality', quality, 'applies only to JPEG, WebP and AVIF output');
        quality = undefined;
    }

    let dither = normalizer.choice('image.dither', image.dither, ['none', 'floyd-steinberg'], {
        optional: true,
    });
    if (dither !== undefined && format !== 'gif') {
        normalizer.ignore('image.dither', dither, 'applies only to GIF output');
        dither = undefined;
    }

    const fit = normalizer.choice('image.fit', image.fit, ['fill', 'inside', 'scale-down'], {
        optional: true,
    });
    const resize = normalizer.choice(
        'image.resize',
        image.resize,
        ['nearest', 'bilinear', 'lanczos3'],
        {
            optional: true,
        },
    );
    const pictureSettings = new OptionNormalizer(normalizer.policy, 'target video');
    const geometry = snapshotVideoGeometry(
        pictureSettings,
        video,
        width !== undefined && height !== undefined,
    );
    normalizer.adopt(pictureSettings.findings);

    return {
        width,
        height,
        fps,
        quality,
        dither,
        fit,
        resize,
        geometry: {
            width,
            height,
            ...geometry,
            stages: stageOption('video', video.stages, stages),
        },
    };
}

/**
 * `video.speed` and `audio.speed` of a container target. A speed of 1 is no
 * change; the sound's setting applies only with another speed, and 'mute' leaves the sound out.
 */
function speedSettings(
    normalizer: OptionNormalizer,
    video: VideoSettings,
    audio: AudioSettings,
): { speed?: number; audio?: AudioSpeedMode; mute: boolean } {
    const value = normalizer.number('video.speed', video.speed, SPEED);
    const speed = value === undefined || value === 1 ? undefined : value;
    let sound = normalizer.choice('audio.speed', audio.speed, AUDIO_SPEEDS, { optional: true });
    if (sound !== undefined && speed === undefined) {
        normalizer.ignore('audio.speed', sound, 'applies when video.speed changes the speed');
        sound = undefined;
    }
    return {
        speed,
        audio: sound === 'mute' ? undefined : sound,
        mute: sound === 'mute',
    };
}

/** The sample coding of a PCM container target: 16-bit linear or G.711. */
function pcmCodec(
    normalizer: OptionNormalizer,
    format: string,
    codec: string | undefined,
): PcmCoding | undefined {
    if (codec === undefined) return undefined;
    let coding = normalizer.choice<PcmCoding>('audio.codec', codec, ['pcm', 'ulaw', 'alaw'], {
        optional: true,
        aliases: PCM_CODEC_ALIASES,
    });
    if (
        coding !== undefined &&
        coding !== 'pcm' &&
        !PCM_AUDIO_FORMATS.has(format as OutputContainerFormat)
    ) {
        normalizer.ignore(
            'audio.codec',
            coding,
            `applies to ${[...PCM_AUDIO_FORMATS].join(', ')} output only`,
        );
        coding = undefined;
    }
    return coding;
}

/**
 * Resolves a target without touching the input: the kind of work, the canonical format and the
 * engine target. `parts` are what the plugins in use add: video codec names for `video.codec` and
 * stages for `*.stages`.
 */
export function resolveTarget(
    input: TargetOptions,
    normalizer: OptionNormalizer,
    parts: TargetParts = NO_PARTS,
): ResolvedTarget {
    const target = normalizer.keys(input, TARGET_KEYS, {
        format: 'to',
    }) as unknown as TargetOptions;
    const format = canonicalFormat(target.to);
    if (!format)
        throw new MediaForgeError('A target needs a format in its to field', 'INPUT', {
            hint: "Name the output format, such as 'mp4', 'mp3' or 'png'.",
        });
    if (!TARGET_FORMATS.has(format)) {
        const suggestion = suggestFormat(format);
        const didYouMean = suggestion ? `; did you mean '${suggestion}'?` : '';
        const formats = [...REMUX_FORMATS, ...IMAGE_TARGETS, ...PACKAGE_FORMATS];
        throw new MediaForgeError(
            `Unknown target format ${JSON.stringify(target.to)}${didYouMean}`,
            'INPUT',
            { hint: `Use one of ${formats.join(', ')}.` },
        );
    }
    const codecPreference = codecPreferenceOf(normalizer, target.codecPreference);
    const signal = normalizer.signal('signal', target.signal);
    const onProgress = normalizer.callback<NonNullable<TargetOptions['onProgress']>>(
        'onProgress',
        target.onProgress,
    );
    const onPlan = normalizer.callback<NonNullable<TargetOptions['onPlan']>>(
        'onPlan',
        target.onPlan,
    );
    const maxBytes = normalizer.number('maxBytes', target.maxBytes, {
        integer: true,
        positive: true,
    });
    const copy = normalizer.boolean('copy', target.copy);
    const onFile = normalizer.callback<NonNullable<TargetOptions['onFile']>>(
        'onFile',
        target.onFile,
    );
    const trackIds = normalizer.ids('trackIds', target.trackIds);
    const allowPrecisionLoss = normalizer.boolean('allowPrecisionLoss', target.allowPrecisionLoss);
    const settings: TargetOptions = {
        ...target,
        to: format,
        signal,
        onProgress,
        onPlan,
        onFile,
        maxBytes,
        copy,
        codecPreference,
        trackIds,
        allowPrecisionLoss,
    };
    const shared = {
        signal,
        onProgress,
        ...(codecPreference !== undefined ? { codecPreference } : {}),
    };
    const video = nested<VideoSettings>(normalizer, target.video, VIDEO_KEYS, 'video');
    const audio = nested<AudioSettings>(normalizer, target.audio, AUDIO_KEYS, 'audio');
    const image = nested<ImageSettings>(normalizer, target.image, IMAGE_KEYS, 'image');
    const targetClass = targetClassOf(format);
    if (targetClass === 'package') {
        if (defined(video) || defined(audio))
            normalizer.ignore('video', 1, 'settings do not apply to packaging');
        if (target.start !== undefined || target.end !== undefined)
            normalizer.ignore('start', target.start ?? target.end, 'does not apply to packaging');
        if (codecPreference !== undefined)
            normalizer.ignore('codecPreference', codecPreference, 'does not apply to packaging');
        const packaged = format as PackageRequest['format'];
        const request: PackageRequest = {
            operation: 'package',
            format: packaged,
            ...packageSettings(normalizer, packaged, target),
            trackIds,
            maxTotalBytes: maxBytes,
            signal,
            onProgress,
        };
        return { kind: 'package', format, settings, package: request };
    }
    if (target.container !== undefined || target.targetDuration !== undefined)
        normalizer.ignore(
            'container',
            target.container ?? target.targetDuration,
            'applies to hls and dash targets only',
        );
    if (targetClass === 'image') {
        if (defined(audio)) normalizer.ignore('audio', 1, 'settings do not apply to image targets');

        // A picture is taken at start; an animation from start to end, which fails when that range
        // is empty.
        const range = {
            start: normalizer.number('start', target.start, { min: 0 }),
            end: normalizer.number('end', target.end, { positive: true }),
        };
        if (range.end !== undefined && !ANIMATED_IMAGE_FORMATS.has(format))
            normalizer.ignore(
                'end',
                range.end,
                'applies to gif and apng animations taken from video',
            );
        for (const key of ENCODER_KEYS)
            normalizer.ignore(`video.${key}`, video[key], 'does not apply to image targets');
        return {
            kind: 'image',
            format,
            settings: { ...settings, ...range },
            image: imageSettings(normalizer, format, video, image, parts.stages),
        };
    }
    if (defined(image)) normalizer.ignore('image', 1, 'settings apply to image targets only');
    const range = snapshotRange(normalizer, target);
    const audioBitrate = normalizer.bitrate('audio.bitrate', audio.bitrate, 'audio');
    const sampleRate = normalizer.number('audio.sampleRate', audio.sampleRate, SAMPLE_RATES);
    const channels = normalizer.number('audio.channels', audio.channels, CHANNELS);
    // 'opus' names the codec as well as the Ogg container: its audio is Opus, copied where it is
    // and encoded otherwise, never another codec in its place.
    const exactAudioCodec = formatAudioCodec(target.to);
    if (exactAudioCodec !== undefined && audio.codec !== undefined) {
        const asked = canonicalAudioCodec(audio.codec);
        if (asked !== 'auto' && asked !== exactAudioCodec)
            normalizer.ignore(
                'audio.codec',
                audio.codec,
                `does not apply to ${exactAudioCodec} output`,
            );
    }
    const exact = exactAudioCodec === undefined ? {} : { exactAudioCodec };
    if (targetClass === 'audio') {
        if (defined(video)) normalizer.ignore('video', 1, 'settings do not apply to audio targets');
        normalizer.ignore('audio.mute', audio.mute, 'does not apply to audio targets');
        normalizer.ignore(
            'audio.speed',
            audio.speed,
            'follows video.speed, which applies to container targets',
        );
        normalizer.ignore(
            'audio.replace',
            audio.replace && 1,
            'applies to container targets; convert that file itself',
        );
        if (trackIds !== undefined && trackIds.length > 1)
            normalizer.note(
                'OPTION_NORMALIZED',
                'trackIds',
                `audio output takes one track; using ${trackIds[0]}`,
            );
        let codec = audio.codec === undefined ? undefined : canonicalAudioCodec(audio.codec);
        if (codec === 'auto') codec = undefined;
        const fixed = audioFormatCodec(format);
        if (fixed === 'mp4a.40.2' && codec?.startsWith('mp4a.40.') && codec !== 'mp4a.40.2')
            throw new MediaForgeError(
                `${format} audio is encoded as AAC-LC only, not ${codec}`,
                'ENCODE',
                {
                    hint: "Ask for 'aac' (AAC-LC), which every player decodes.",
                },
            );
        const pcm = PCM_AUDIO_FORMATS.has(format as OutputContainerFormat);
        if (
            codec !== undefined &&
            !pcm &&
            fixed !== undefined &&
            codecDisplayName(codec) !== codecDisplayName(fixed)
        ) {
            normalizer.ignore(
                'audio.codec',
                audio.codec,
                `cannot apply to ${format} output (always ${codecDisplayName(fixed)})`,
            );
            codec = undefined;
        }
        const request: AudioFileRequest = {
            operation: 'audio',
            format: format as AudioFileFormat,
            trackId: trackIds?.[0],
            sampleRate,
            channels,
            bitrate: audioBitrate,
            vbr: normalizer.boolean('audio.vbr', audio.vbr),
            ...(pcm ? { codec: pcmCodec(normalizer, format, codec) } : {}),
            stages: stageOption('audio', audio.stages, parts.stages),
            allowPrecisionLoss,
            ...range,
            ...shared,
        };
        return {
            kind: 'audio',
            format,
            settings,
            target: { kind: 'audio', format, request, copy, codecPreference, allowPrecisionLoss },
        };
    }
    const playback = speedSettings(normalizer, video, audio);
    const mute =
        normalizer.boolean('audio.mute', audio.mute) === true || playback.mute
            ? { mute: true }
            : {};
    const { mute: _mute, speed: _speed, ...audioSettings } = audio;
    if (copy !== false && !defined(video) && !defined(audioSettings)) {
        const request: CopyRequest = {
            operation: 'remux',
            format: format as CopyRequest['format'],
            trackIds,
            ...range,
            signal,
            onProgress,
        };
        return {
            kind: 'remux',
            format,
            settings,
            target: {
                kind: 'remux',
                format,
                request,
                copy,
                codecPreference,
                allowPrecisionLoss,
                strict: normalizer.policy === 'strict',
                ...exact,
                ...mute,
            },
        };
    }
    if (copy === true)
        throw new MediaForgeError('copy: true cannot apply video or audio settings', 'INPUT', {
            hint: 'Drop copy: true to re-encode, or drop the settings to copy.',
        });
    if (audio.vbr !== undefined)
        normalizer.ignore('audio.vbr', audio.vbr, 'applies to audio targets only');
    const videoSettings = new OptionNormalizer(normalizer.policy, 'target video');
    const size = outputSize(videoSettings, video);
    const geometry = snapshotVideoGeometry(
        videoSettings,
        video,
        size.width !== undefined && size.height !== undefined,
    );
    const encoder = snapshotEncoderSettings(videoSettings, video);
    const keyframeInterval = videoSettings.number('keyframeInterval', video.keyframeInterval, {
        min: 0,
        max: 3600,
    });
    const autoRotate = videoSettings.boolean('autoRotate', video.autoRotate);
    const fps = videoSettings.number('fps', video.fps, { positive: true, max: 300 });
    normalizer.adopt(videoSettings.findings);
    const videoBitrate = normalizer.bitrate('video.bitrate', video.bitrate, 'video');
    const quality = normalizer.choice('video.quality', video.quality, Object.keys(QUALITY_SCALE), {
        optional: true,
    }) as ConversionTarget['quality'];
    if (videoBitrate !== undefined && quality !== undefined)
        normalizer.ignore('video.quality', quality, 'does not apply with a bitrate');
    const request: ConvertRequest = {
        operation: 'convert',
        format: format as OutputContainerFormat,
        videoCodec: codecOption(normalizer, 'video', video.codec, parts.videoCodecs),
        audioCodec: exactAudioCodec ?? containerAudioCodec(normalizer, format, audio.codec),
        ...size,
        ...geometry,
        keyframeInterval,
        autoRotate,
        fps,
        ...(playback.speed !== undefined ? { speed: playback.speed } : {}),
        ...(playback.audio !== undefined ? { audioSpeed: playback.audio } : {}),
        videoBitrate,
        ...encoder,
        audioBitrate,
        audioSampleRate: sampleRate,
        audioChannels: channels,
        videoStages: stageOption('video', video.stages, parts.stages),
        audioStages: stageOption('audio', audio.stages, parts.stages),
        allowPrecisionLoss,
        trackIds,
        ...range,
        ...shared,
    };
    return {
        kind: 'convert',
        format,
        settings,
        target: {
            kind: 'convert',
            format,
            request,
            copy,
            codecPreference,
            allowPrecisionLoss,
            strict: normalizer.policy === 'strict',
            ...exact,
            ...(videoBitrate === undefined && quality !== undefined ? { quality } : {}),
            ...mute,
        },
    };
}
