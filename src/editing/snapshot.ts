import { isMediaInput } from '../core/io/sources/sources';
import type {
    ResolvedFade,
    ResolvedClip,
    ResolvedAudioTrack,
    ResolvedOverlay,
    ResolvedProject,
} from '../pipeline/transcode/edit-types';
import { MediaForgeError } from '../core/errors/errors';
import type { OptionNormalizer } from '../core/errors/option-policy';
import type { Source, MediaInput } from '../core/model/types';
import { snapshotVideoGeometry } from '../stages/geometry-options';
import type { EditProject } from './project';

// An edit project read once into the plain form the timeline renders (EditProject in ./project).

const CLIP_KEYS = ['input', 'start', 'end', 'speed', 'video', 'audio'];
const CLIP_VIDEO_KEYS = ['crop', 'rotate', 'flip', 'fit', 'fade'];
const CLIP_AUDIO_KEYS = ['volume', 'fade', 'mute', 'speed'];
const AUDIO_SPEEDS = ['preserve-pitch', 'shift-pitch', 'mute'] as const;
const FADE_KEYS = ['in', 'out'];
const TRACK_KEYS = ['input', 'start', 'end', 'offset', 'volume', 'loop', 'fade'];
const TEXT_KEYS = ['kind', 'text', 'x', 'y', 'size', 'color', 'font', 'start', 'end', 'opacity'];
const IMAGE_KEYS = ['kind', 'input', 'x', 'y', 'width', 'height', 'opacity', 'start', 'end'];
const PROJECT_KEYS = ['clips', 'audio', 'overlays', 'width', 'height', 'fps', 'background'];
const MAX_CLIPS = 1000;
const MAX_LAYERS = 100;

function object(
    normalizer: OptionNormalizer,
    value: unknown,
    scope: string,
): Record<string, unknown> | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'object' || Array.isArray(value)) {
        normalizer.ignore(scope, value, 'must be an object');
        return undefined;
    }
    return value as Record<string, unknown>;
}

function list(value: unknown, scope: string, max: number): readonly unknown[] {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw new MediaForgeError(`${scope} must be an array`, 'INPUT');
    if (value.length > max)
        throw new MediaForgeError(`${scope} holds more than ${max} entries`, 'INPUT');
    return value;
}

function fadeOf(normalizer: OptionNormalizer, value: unknown, scope: string): ResolvedFade {
    const raw = object(normalizer, value, scope);
    const fields = raw ? normalizer.keys(raw, FADE_KEYS) : {};
    return {
        in: normalizer.number(`${scope}.in`, fields.in, { min: 0, max: 3600, fallback: 0 })!,
        out: normalizer.number(`${scope}.out`, fields.out, { min: 0, max: 3600, fallback: 0 })!,
    };
}

function rangeOf(
    normalizer: OptionNormalizer,
    raw: Record<string, unknown>,
    scope: string,
): { start: number; end?: number } {
    const start = normalizer.number(`${scope}.start`, raw.start, { min: 0, fallback: 0 })!;
    let end = normalizer.number(`${scope}.end`, raw.end, { positive: true });
    if (end !== undefined && end <= start) {
        normalizer.note(
            'OPTION_IGNORED',
            `${scope}.end`,
            `${scope}.end ${end} is not after start ${start} and was ignored`,
        );
        end = undefined;
    }
    return { start, end };
}

function inputOf(value: unknown, scope: string): Source | MediaInput {
    if (!isMediaInput(value))
        throw new MediaForgeError(
            `${scope}.input must be a Blob, ArrayBuffer, typed array or Source`,
            'INPUT',
        );
    return value;
}

function volumeOf(normalizer: OptionNormalizer, value: unknown, scope: string): number {
    return normalizer.number(`${scope}.volume`, value, { min: 0, max: 10, fallback: 1 })!;
}

function clipOf(normalizer: OptionNormalizer, value: unknown, index: number): ResolvedClip {
    const scope = `clips[${index}]`;
    const raw = object(normalizer, value, scope);
    if (!raw) throw new MediaForgeError(`${scope} must be an object with an input`, 'INPUT');
    const fields = normalizer.keys(raw, CLIP_KEYS);

    const video = object(normalizer, fields.video, `${scope}.video`);
    const videoFields = video ? normalizer.keys(video, CLIP_VIDEO_KEYS) : {};
    const geometry = snapshotVideoGeometry(normalizer, videoFields, true);
    const audio = object(normalizer, fields.audio, `${scope}.audio`);
    const audioFields = audio ? normalizer.keys(audio, CLIP_AUDIO_KEYS) : {};
    const videoFade = fadeOf(normalizer, videoFields.fade, `${scope}.video.fade`);
    const sound = normalizer.choice(`${scope}.audio.speed`, audioFields.speed, AUDIO_SPEEDS, {
        optional: true,
    });

    return {
        input: inputOf(fields.input, scope),
        ...rangeOf(normalizer, fields, scope),
        speed: normalizer.number(`${scope}.speed`, fields.speed, {
            min: 0.1,
            max: 10,
            fallback: 1,
        })!,
        video: {
            ...geometry,
            fade: videoFade,
            changed:
                Object.values(geometry).some(setting => setting !== undefined) ||
                videoFade.in > 0 ||
                videoFade.out > 0,
        },
        audio: {
            volume: volumeOf(normalizer, audioFields.volume, `${scope}.audio`),
            fade: fadeOf(normalizer, audioFields.fade, `${scope}.audio.fade`),
            mute:
                normalizer.boolean(`${scope}.audio.mute`, audioFields.mute, false)! ||
                sound === 'mute',
            ...(sound !== undefined && sound !== 'mute' ? { speed: sound } : {}),
        },
    };
}

function trackOf(normalizer: OptionNormalizer, value: unknown, index: number): ResolvedAudioTrack {
    const scope = `audio[${index}]`;
    const raw = object(normalizer, value, scope);
    if (!raw) throw new MediaForgeError(`${scope} must be an object with an input`, 'INPUT');
    const fields = normalizer.keys(raw, TRACK_KEYS);
    return {
        input: inputOf(fields.input, scope),
        ...rangeOf(normalizer, fields, scope),
        offset: normalizer.number(`${scope}.offset`, fields.offset, { min: 0, fallback: 0 })!,
        volume: volumeOf(normalizer, fields.volume, scope),
        loop: normalizer.boolean(`${scope}.loop`, fields.loop, false)!,
        fade: fadeOf(normalizer, fields.fade, `${scope}.fade`),
    };
}

function overlayOf(normalizer: OptionNormalizer, value: unknown, index: number): ResolvedOverlay {
    const scope = `overlays[${index}]`;
    const raw = object(normalizer, value, scope);
    const kind = normalizer.choice(`${scope}.kind`, raw?.kind, ['text', 'image'], {
        aliases: { label: 'text', caption: 'text', picture: 'image', logo: 'image' },
    });
    if (!raw || !kind)
        throw new MediaForgeError(`${scope} must be a text or image overlay`, 'INPUT');
    const fields = normalizer.keys(raw, kind === 'text' ? TEXT_KEYS : IMAGE_KEYS, {
        left: 'x',
        top: 'y',
    });

    const shared = {
        x: normalizer.number(`${scope}.x`, fields.x, { fallback: 0, min: -16384, max: 16384 })!,
        y: normalizer.number(`${scope}.y`, fields.y, { fallback: 0, min: -16384, max: 16384 })!,
        ...rangeOf(normalizer, fields, scope),
        opacity: normalizer.number(`${scope}.opacity`, fields.opacity, {
            min: 0,
            max: 1,
            fallback: 1,
        })!,
    };

    if (kind === 'text') {
        const text = normalizer.string(`${scope}.text`, fields.text, 1024);
        if (text === undefined)
            throw new MediaForgeError(`${scope}.text must be a nonempty string`, 'INPUT');
        return {
            kind,
            text,
            ...shared,
            size: normalizer.number(`${scope}.size`, fields.size, {
                positive: true,
                max: 4096,
                fallback: 32,
            })!,
            color: normalizer.string(`${scope}.color`, fields.color, 64) ?? '#fff',
            font: normalizer.string(`${scope}.font`, fields.font, 256) ?? 'sans-serif',
        };
    }

    const input = fields.input;
    if (!isMediaInput(input) || typeof (input as Source).read === 'function')
        throw new MediaForgeError(
            `${scope}.input must be image bytes: a Blob, ArrayBuffer or typed array`,
            'INPUT',
        );
    return {
        kind,
        input: input as Blob | ArrayBuffer | ArrayBufferView,
        ...shared,
        width: normalizer.number(`${scope}.width`, fields.width, { positive: true, max: 16384 }),
        height: normalizer.number(`${scope}.height`, fields.height, { positive: true, max: 16384 }),
    };
}

/**
 * Resolves a project under the normalizer's policy; the shape errors that no policy repairs are
 * INPUT.
 */
export function snapshotEditProject(
    project: EditProject,
    normalizer: OptionNormalizer,
): ResolvedProject {
    if (!project || typeof project !== 'object' || Array.isArray(project))
        throw new MediaForgeError('Expected an edit project with clips', 'INPUT');
    const fields = normalizer.keys(project, PROJECT_KEYS, { music: 'audio', size: 'width' });
    const clips = list(fields.clips, 'clips', MAX_CLIPS).map((clip, index) =>
        clipOf(normalizer, clip, index),
    );
    if (!clips.length)
        throw new MediaForgeError('An edit project needs at least one clip', 'INPUT');
    const width = normalizer.number('width', fields.width, {
        integer: true,
        positive: true,
        max: 16384,
    });

    const height = normalizer.number('height', fields.height, {
        integer: true,
        positive: true,
        max: 16384,
    });

    return {
        clips,
        audio: list(fields.audio, 'audio', MAX_LAYERS).map((track, index) =>
            trackOf(normalizer, track, index),
        ),
        overlays: list(fields.overlays, 'overlays', MAX_LAYERS).map((overlay, index) =>
            overlayOf(normalizer, overlay, index),
        ),
        width,
        height,
        fps: normalizer.number('fps', fields.fps, { positive: true, max: 300 }),
        background: normalizer.string('background', fields.background, 64) ?? '#000',
    };
}
