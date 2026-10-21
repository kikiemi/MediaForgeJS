import type { ReplayablePcmSource } from '../../codecs/pcm/pcm-source';
import { normalizePcmSource } from '../../codecs/pcm/pcm-source';
import { MediaForgeError } from '../../core/errors/errors';
import type { MediaFile } from '../read/media-file';
import type { RemuxTrack } from '../media-types';
import { leadingTime } from '../read/track-start';
import { mixAudioLayers, type AudioLayer } from './edit-audio';
import type { ResolvedFade } from './edit-types';

/**
 * One sounding range on the output timeline: source seconds of `track`, placed at `offset` output
 * seconds.
 */
export interface SoundSpan {
    readonly file: MediaFile;
    readonly track: RemuxTrack;
    /** Packet-layer seconds of the source; `end` is exclusive. */
    readonly start: number;
    readonly end?: number;
    readonly speed: number;
    /** A speed other than 1 keeps the pitch by time stretching instead of resampling. */
    readonly stretch: boolean;
    /** Output seconds where `start` plays, and the seconds the span covers there. */
    readonly offset: number;
    readonly length: number;
    readonly volume: number;
    readonly fade: ResolvedFade;
    readonly loop: boolean;
}

/** A span whose samples pass through unchanged: unit speed and volume, no fades or loops. */
function untouched(span: SoundSpan): boolean {
    return span.speed === 1 && span.volume === 1 && !span.fade.in && !span.fade.out && !span.loop;
}

/**
 * The sound of the spans on the output timeline at `sampleRate` and `channels`, `total` seconds
 * long. A source that starts after its span's start begins with silence; one span that changes
 * nothing is resampled and windowed without mixing, so its samples are not clamped.
 */
export function timelineSound(
    spans: readonly { readonly span: SoundSpan; readonly source: ReplayablePcmSource }[],
    sampleRate: number,
    channels: number,
    total: number,
): ReplayablePcmSource {
    const frames = Math.round(total * sampleRate);
    const layers: AudioLayer[] = [];
    for (const { span, source } of spans) {
        // Decoded sound begins at the track's first presented sample, which packet times place at
        // its own start.
        const head = Math.max(0, leadingTime([span.track], false));
        let start = span.start - head;
        let offset = span.offset;
        let length = span.length;
        if (start < 0) {
            const lead = -start / span.speed;
            offset += lead;
            length -= lead;
            start = 0;
        }

        if (length <= 0) continue;
        layers.push({
            source,
            start,
            end: span.end === undefined ? undefined : span.end - head,
            speed: span.speed,
            stretch: span.stretch,
            offset: Math.round(offset * sampleRate),
            length: Math.max(0, Math.round(length * sampleRate)),
            volume: span.volume,
            fade: span.fade,
            loop: span.loop,
        });
    }

    if (!frames || !layers.length)
        throw new MediaForgeError('The timeline has no audio to write', 'FORMAT');
    const only = layers.length === 1 ? layers[0]! : undefined;
    if (only && only.offset === 0 && untouched(spans[0]!.span) && only.length >= frames) {
        const head = Math.round(only.start * sampleRate);
        return normalizePcmSource(only.source, sampleRate, channels, { head, valid: frames });
    }
    return mixAudioLayers(layers, sampleRate, channels, frames);
}
