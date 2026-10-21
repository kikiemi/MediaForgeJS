import type { VideoCrop, VideoRotation, VideoFlip, VideoFit } from '../../stages/geometry-settings';
import type { Source, MediaInput } from '../../core/model/types';
import type { AudioSpeedMode } from '../api-types';

export interface ResolvedFade {
    readonly in: number;
    readonly out: number;
}

export interface ResolvedClip {
    readonly input: Source | MediaInput;
    readonly start: number;
    readonly end?: number;
    readonly speed: number;
    readonly video: {
        readonly crop?: VideoCrop;
        readonly rotate?: VideoRotation;
        readonly flip?: VideoFlip;
        readonly fit?: VideoFit;
        readonly fade: ResolvedFade;
        /** True when any picture setting was requested. */
        readonly changed: boolean;
    };
    readonly audio: {
        readonly volume: number;
        readonly fade: ResolvedFade;
        readonly mute: boolean;
        /** How the sound follows a speed other than 1; default 'preserve-pitch'. */
        readonly speed?: AudioSpeedMode;
    };
}

export interface ResolvedAudioTrack {
    readonly input: Source | MediaInput;
    readonly start: number;
    readonly end?: number;
    readonly offset: number;
    readonly volume: number;
    readonly loop: boolean;
    readonly fade: ResolvedFade;
}

export type ResolvedOverlay =
    | {
          readonly kind: 'text';
          readonly text: string;
          readonly x: number;
          readonly y: number;
          readonly size: number;
          readonly color: string;
          readonly font: string;
          readonly start: number;
          readonly end?: number;
          readonly opacity: number;
      }
    | {
          readonly kind: 'image';
          readonly input: Blob | ArrayBuffer | ArrayBufferView;
          readonly x: number;
          readonly y: number;
          readonly width?: number;
          readonly height?: number;
          readonly start: number;
          readonly end?: number;
          readonly opacity: number;
      };

export interface ResolvedProject {
    readonly clips: readonly ResolvedClip[];
    readonly audio: readonly ResolvedAudioTrack[];
    readonly overlays: readonly ResolvedOverlay[];
    readonly width?: number;
    readonly height?: number;
    readonly fps?: number;
    readonly background: string;
}
