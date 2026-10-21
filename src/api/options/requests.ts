import { MediaForgeError } from '../../core/errors/errors';
import { checkSignal } from '../../core/io/abort';
import type { OptionNormalizer } from '../../core/errors/option-policy';
import { snapshotVideoGeometry } from '../../stages/geometry-options';
import type { FrameExtraction, ThumbnailExtraction } from '../../pipeline/frames/frame-extract';
import type { PackageRequest } from '../../pipeline/types';
import { checkStageDefinition } from '../../pipeline/plugins/plugin-check';
import type { StageFactory } from '../../stages/chain';
import type {
    AudioStage,
    StageDefinition,
    StageRequest,
    VideoStage,
} from '../../core/contracts/stage';
import { FRAME_KEYS, THUMBNAIL_KEYS } from './request-keys';
import type { FrameOptions, ThumbnailOptions } from '../types';

/**
 * Readers of the settings a target, a frame extraction and a thumbnail share. Each reads one value
 * once, repairs or drops what it cannot use (strict policy: rejects with INPUT) and reports through
 * the normalizer.
 */

/**
 * Presentation seconds to keep: a nonnegative start and an end after it, which is dropped
 * otherwise.
 */
export function snapshotRange(
    normalizer: OptionNormalizer,
    raw: { readonly start?: unknown; readonly end?: unknown },
): { start?: number; end?: number } {
    const start = normalizer.number('start', raw.start, { min: 0 });
    let end = normalizer.number('end', raw.end, { positive: true });
    if (end !== undefined && end <= (start ?? 0)) {
        normalizer.note(
            'OPTION_IGNORED',
            'end',
            `end ${end} is not after start ${start ?? 0} and was ignored`,
        );
        end = undefined;
    }
    return { start, end };
}

function requestObject(request: unknown, label: string): Record<string, unknown> {
    if (!request || typeof request !== 'object' || Array.isArray(request))
        throw new MediaForgeError(`Expected a ${label}`, 'INPUT');
    return request as Record<string, unknown>;
}

/**
 * Output size, fit and geometry shared by frame extraction and thumbnails; fit needs both sides.
 */
function frameGeometry(
    normalizer: OptionNormalizer,
    raw: Record<string, unknown>,
): FrameExtraction {
    const width = normalizer.number('width', raw.width, {
        integer: true,
        positive: true,
        max: 16384,
    });
    const height = normalizer.number('height', raw.height, {
        integer: true,
        positive: true,
        max: 16384,
    });
    const geometry = snapshotVideoGeometry(
        normalizer,
        raw,
        width !== undefined && height !== undefined,
    );
    return {
        trackId: normalizer.number('trackId', raw.trackId, { integer: true, positive: true }),
        width,
        height,
        ...geometry,
        signal: normalizer.signal('signal', raw.signal),
    };
}

/**
 * `video.stages` or `audio.stages` as factories of fresh stages. Each entry is a stage definition,
 * or the name of a plugin's stage with optional options; an unknown name fails, since output
 * without the asked processing is wrong.
 */
export function stageOption<Stage extends VideoStage | AudioStage>(
    type: Stage['type'],
    value: readonly StageRequest<Stage>[] | undefined,
    offered: readonly StageDefinition[],
): readonly StageFactory<Stage>[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value))
        throw new MediaForgeError(`${type}.stages must be an array of stages`, 'INPUT', {
            hint: `Pass stages or stage names, such as ${type}: { stages: ['name'] }.`,
        });
    if (!value.length) return undefined;
    return value.map((request: StageRequest<Stage>): StageFactory<Stage> => {
        if (
            request &&
            typeof request === 'object' &&
            typeof (request as StageDefinition).create === 'function'
        ) {
            const definition = checkStageDefinition(request as StageDefinition);
            if (definition.type !== type)
                throw new MediaForgeError(
                    `Stage '${definition.name}' processes ${definition.type}, not ${type}`,
                    'INPUT',
                );
            return { name: definition.name, create: () => definition.create() as Stage };
        }

        const name = typeof request === 'string' ? request : (request as { name?: unknown })?.name;
        const options =
            typeof request === 'object' ? (request as { options?: unknown }).options : undefined;
        const definition = offered.find(stage => stage.name === name);
        if (!definition) {
            const known = offered
                .filter(stage => stage.type === type)
                .map(stage => `'${stage.name}'`);
            throw new MediaForgeError(
                `No ${type} stage is named ${JSON.stringify(name)}`,
                'INPUT',
                {
                    hint: known.length
                        ? `The plugins in use offer ${known.join(', ')}.`
                        : 'Add its plugin with plugins: { add: [plugin] }.',
                },
            );
        }
        if (definition.type !== type)
            throw new MediaForgeError(
                `Stage '${definition.name}' processes ${definition.type}, not ${type}`,
                'INPUT',
            );
        return { name: definition.name, create: () => definition.create(options) as Stage };
    });
}

/** The pictures frames() decodes: times, a period or every picture, and their geometry. */
export function snapshotFrameOptions(
    options: Omit<FrameOptions, 'onProgress'>,
    normalizer: OptionNormalizer,
    stages: readonly StageDefinition[] = [],
): FrameExtraction {
    const raw = normalizer.keys(requestObject(options, 'frame options object'), FRAME_KEYS, {
        time: 'times',
    });
    let times: number[] | undefined;
    if (raw.times !== undefined && raw.times !== null) {
        const list = Array.isArray(raw.times) ? raw.times : [raw.times];
        times = [];
        for (const entry of list) {
            const time = normalizer.number('times entry', entry, { min: 0 });
            if (time !== undefined) times.push(time);
        }
    }

    let every = normalizer.number('every', raw.every, { positive: true });
    if (times !== undefined && every !== undefined) {
        normalizer.ignore('every', every, 'does not apply when times are given');
        every = undefined;
    }
    const output = normalizer.choice('format', raw.format, ['rgba', 'videoframe'], {
        fallback: 'rgba',
        aliases: { 'video-frame': 'videoframe', video_frame: 'videoframe' },
    });

    const result = {
        ...frameGeometry(normalizer, raw),
        times,
        every,
        maxFrames: normalizer.number('maxFrames', raw.maxFrames, { integer: true, positive: true }),
        ...(output === 'videoframe' ? { videoFrame: true } : {}),
        stages: stageOption('video', raw.stages as FrameOptions['stages'], stages),
    };
    checkSignal(result.signal);
    return result;
}

/** The picture thumbnail() takes: its time, geometry, image format and quality. */
export function snapshotThumbnailOptions(
    options: ThumbnailOptions,
    normalizer: OptionNormalizer,
    stages: readonly StageDefinition[] = [],
): ThumbnailExtraction {
    const raw = normalizer.keys(
        requestObject(options, 'thumbnail options object'),
        THUMBNAIL_KEYS,
        { format: 'to' },
    );
    const to = normalizer.choice('to', raw.to, ['png', 'jpeg', 'webp'], {
        fallback: 'png',
        aliases: { jpg: 'jpeg', jpe: 'jpeg' },
    })!;

    let quality = normalizer.number('quality', raw.quality, { min: 0, max: 1 });
    if (quality !== undefined && to === 'png') {
        normalizer.ignore('quality', quality, 'applies to jpeg and webp thumbnails');
        quality = undefined;
    }

    const result = {
        ...frameGeometry(normalizer, raw),
        time: normalizer.number('time', raw.time, { min: 0, fallback: 0 })!,
        to,
        quality,
        stages: stageOption('video', raw.stages as ThumbnailOptions['stages'], stages),
    };
    checkSignal(result.signal);
    return result;
}

/**
 * The packaging settings of an hls, dash or hls+dash target; HLS-only settings are dropped for
 * DASH.
 */
export function packageSettings(
    normalizer: OptionNormalizer,
    format: PackageRequest['format'],
    raw: {
        readonly container?: unknown;
        readonly targetDuration?: unknown;
        readonly encryption?: unknown;
        readonly programDateTime?: unknown;
    },
): Pick<PackageRequest, 'container' | 'targetDuration' | 'encryption' | 'programDateTime'> {
    let container = normalizer.choice('container', raw.container, ['fmp4', 'ts'], {
        optional: true,
        aliases: { mp4: 'fmp4', cmaf: 'fmp4', mpegts: 'ts', m2ts: 'ts' },
    });
    if (container === 'ts' && format !== 'hls') {
        normalizer.ignore('container', container, 'is available for HLS output only');
        container = undefined;
    }

    let encryption = raw.encryption;
    if (encryption !== undefined && encryption !== null && format !== 'hls') {
        normalizer.ignore('encryption', encryption, 'is available for HLS output only');
        encryption = undefined;
    }

    let dateTime = raw.programDateTime;
    if (dateTime !== undefined && dateTime !== null) {
        if (format !== 'hls') {
            normalizer.ignore('programDateTime', dateTime, 'is available for HLS output only');
            dateTime = undefined;
        } else if (!Number.isFinite(new Date(dateTime as string).getTime())) {
            normalizer.ignore('programDateTime', dateTime, 'is not a valid date');
            dateTime = undefined;
        }
    }

    return {
        container,
        targetDuration: normalizer.number('targetDuration', raw.targetDuration, {
            min: 0.1,
            max: 3600,
        }),
        encryption: (encryption ?? undefined) as PackageRequest['encryption'],
        programDateTime: (dateTime ?? undefined) as PackageRequest['programDateTime'],
    };
}
