import type { Source, MediaInput } from '../core/model/types';
import type { VideoCrop, VideoFit, VideoFlip, VideoRotation } from '../stages/geometry-settings';
import type { AudioSpeedMode } from '../pipeline/api-types';

/** Seconds of a linear fade at the beginning and the end of a clip or track. */
export interface EditFade {
    readonly in?: number;
    readonly out?: number;
}

export interface EditClipVideo {
    /** Pixels of the upright source kept before rotate, flip and resize. */
    readonly crop?: VideoCrop;
    /** Clockwise degrees. */
    readonly rotate?: VideoRotation;
    readonly flip?: VideoFlip;
    /** How the clip fills the project size; default contain, padded with the project background. */
    readonly fit?: VideoFit;
    /** Fades from and to the project background. */
    readonly fade?: EditFade;
}

export interface EditClipAudio {
    /** Linear gain, default 1. */
    readonly volume?: number;
    readonly fade?: EditFade;
    /** Leaves the clip's audio out; other clips and extra audio tracks still sound. */
    readonly mute?: boolean;
    /**
     * How the sound follows the clip's `speed`: 'preserve-pitch' (default) stretches it at the same
     * pitch, 'shift-pitch' resamples it so the pitch moves with the speed, 'mute' leaves it out.
     */
    readonly speed?: AudioSpeedMode | 'mute';
}

/** One section of the timeline; clips play one after another. */
export interface EditClip {
    readonly input: Source | MediaInput;
    /** Source seconds; default 0. */
    readonly start?: number;
    /** Exclusive source seconds; default the end of the input. */
    readonly end?: number;
    /**
     * Playback rate from 0.1 to 10; the sound keeps its pitch unless `audio.speed` says otherwise,
     * and the pictures keep the clip's frame rate (or the project's `fps`). Default 1.
     */
    readonly speed?: number;
    readonly video?: EditClipVideo;
    readonly audio?: EditClipAudio;
}

/**
 * Audio mixed under the clips, such as music: a range of the input placed at `offset` seconds of
 * the output.
 */
export interface EditAudioTrack {
    readonly input: Source | MediaInput;
    readonly start?: number;
    readonly end?: number;
    /** Output seconds where the track begins; default 0. */
    readonly offset?: number;
    readonly volume?: number;
    /** Repeats the range until the output ends. */
    readonly loop?: boolean;
    readonly fade?: EditFade;
}

export interface EditTextOverlay {
    readonly kind: 'text';
    readonly text: string;
    /** Top-left corner in output pixels. */
    readonly x: number;
    readonly y: number;
    /** Font size in pixels; default 32. */
    readonly size?: number;
    /** CSS colour; default white. */
    readonly color?: string;
    /** CSS font family; default sans-serif. */
    readonly font?: string;
    /** Output seconds the overlay is shown; default the whole output. */
    readonly start?: number;
    readonly end?: number;
    /** 0 to 1; default 1. */
    readonly opacity?: number;
}

export interface EditImageOverlay {
    readonly kind: 'image';
    /** An encoded image the host decodes (PNG, JPEG, WebP, …). */
    readonly input: Blob | ArrayBuffer | ArrayBufferView;
    readonly x: number;
    readonly y: number;
    /** Drawn size in output pixels; default the image size, or scaled by the given side. */
    readonly width?: number;
    readonly height?: number;
    readonly opacity?: number;
    readonly start?: number;
    readonly end?: number;
}

export type EditOverlay = EditTextOverlay | EditImageOverlay;

/**
 * A timeline: clips in order, extra audio under them and overlays drawn on top, at one output size
 * and rate.
 */
export interface EditProject {
    readonly clips: readonly EditClip[];
    readonly audio?: readonly EditAudioTrack[];
    readonly overlays?: readonly EditOverlay[];
    /**
     * Output pixels; default the first clip's picture size. Both sides set apply each clip's fit.
     */
    readonly width?: number;
    readonly height?: number;
    /**
     * Constant output frame rate; omitted keeps each clip's frame timing, and a project whose clips
     * change speed keeps the first clip's rate.
     */
    readonly fps?: number;
    /**
     * CSS colour behind contained clips and fades; default black. Without OffscreenCanvas only hex
     * colours (#rgb, #rrggbb) are read, and other colours are black.
     */
    readonly background?: string;
}
