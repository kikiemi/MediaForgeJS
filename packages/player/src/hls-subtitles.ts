import { parseWebVtt } from 'mediaforgejs/formats';
import type { RenditionChoice } from 'mediaforgejs/plugins';
import {
    type HlsMasterPlaylist,
    type HlsRendition,
    type HlsVariant,
    getHlsRenditions,
} from 'mediaforgejs/streaming';
import { HlsClient, type HlsClientOptions } from './hls-client.js';
import { chosenRendition } from './hls-renditions.js';
import { linkAbortSignals } from './support.js';

/** The 90 kHz clock of an X-TIMESTAMP-MAP. */
const MPEG_CLOCK = 90000;

/** The times of the element's timeline a rendition gives a track the cues of, from `from`. */
interface CueRange {
    readonly from: number;
    until: number;
}

/** A text track of the element and the subtitles rendition its cues come from. */
interface SubtitleTrack {
    rendition: HlsRendition;
    readonly track: TextTrack;
    /** The cues on the track by time and text, so a cue that two segments repeat is added once. */
    readonly cues: Map<string, TextTrackCue>;
    /** The range of the rendition playing. */
    range: CueRange;
}

/** The SUBTITLES renditions of `variant` that have a playlist. */
function subtitlesOf(master: HlsMasterPlaylist, variant: HlsVariant): HlsRendition[] {
    return getHlsRenditions(master, variant, 'SUBTITLES').filter(
        rendition => rendition.uri !== undefined,
    );
}

/**
 * The SUBTITLES renditions of an HLS variant as text tracks of the media element: each WebVTT
 * segment's cues, read with the library's parser, go onto the element's timeline as the segments
 * load (following a live playlist), moved by the X-TIMESTAMP-MAP of the segment and by the offset
 * the playback gives the media of its discontinuity. The rendition chosen, else the DEFAULT=YES
 * one, shows; the others are hidden and can be shown through `media.textTracks`. When the video
 * moves to a variant of another SUBTITLES group, each track keeps its place and its mode and takes
 * that group's rendition of its name, else of its language, else the group's default, whose cues
 * replace its own from the switch on. A rendition that fails stops with a warning; the playback
 * goes on.
 */
export class SubtitleTracks {
    readonly #tracks: SubtitleTrack[] = [];
    readonly #offsets = new Map<number, number>();
    #latest?: number;
    #waiting: (() => void)[] = [];
    readonly #stop = new AbortController();
    readonly #linked: { signal: AbortSignal; dispose(): void };
    #variant: HlsVariant;

    constructor(
        media: HTMLMediaElement,
        private readonly master: HlsMasterPlaylist,
        variant: HlsVariant,
        choice: RenditionChoice | undefined,
        private readonly clientOptions: HlsClientOptions,
        private readonly options: {
            readonly live?: boolean;
            readonly signal: AbortSignal;
            readonly warn?: (code: string, message: string) => void;
        },
    ) {
        this.#variant = variant;
        const renditions = subtitlesOf(master, variant);
        const shown = choice
            ? chosenRendition(master, variant, 'SUBTITLES', choice)
            : renditions.find(rendition => rendition.default);
        this.#linked = linkAbortSignals(options.signal, this.#stop.signal);
        for (const rendition of renditions) {
            const track = media.addTextTrack('subtitles', rendition.name, rendition.language ?? '');
            track.mode = shown?.name === rendition.name ? 'showing' : 'hidden';
            const entry: SubtitleTrack = {
                rendition,
                track,
                cues: new Map(),
                range: { from: -Infinity, until: Infinity },
            };
            this.#tracks.push(entry);
            this.#read(entry);
        }
    }

    /** The offset of the media of `discontinuity` on the element's timeline, as the playback set. */
    offset(discontinuity: number, seconds: number): void {
        this.#offsets.set(discontinuity, seconds);
        this.#latest = seconds;
        for (const wake of this.#waiting.splice(0)) wake();
    }

    /**
     * Follows the variant the video plays from `from` seconds of the element's timeline: in another
     * SUBTITLES group, each track takes the group's rendition of its name, else of its language,
     * else the default, and its cues from `from` on are that rendition's; the rendition before
     * still gives the cues before. A variant without subtitles keeps the renditions playing.
     */
    follow(variant: HlsVariant, from: number): void {
        const same = variant.subtitles === this.#variant.subtitles;
        this.#variant = variant;
        const group = same ? [] : subtitlesOf(this.master, variant);
        if (!group.length) return;
        for (const entry of this.#tracks) {
            const { name, language } = entry.rendition;
            const next =
                group.find(rendition => rendition.name === name) ??
                group.find(
                    rendition =>
                        language !== undefined &&
                        rendition.language?.toLowerCase() === language.toLowerCase(),
                ) ??
                group.find(rendition => rendition.default) ??
                group.find(rendition => rendition.autoselect) ??
                group[0]!;
            if (next.uri === entry.rendition.uri) continue;
            entry.range.until = Math.max(entry.range.from, from);
            entry.rendition = next;
            entry.range = { from: entry.range.until, until: Infinity };
            for (const [key, cue] of entry.cues)
                if (cue.startTime >= entry.range.from) {
                    entry.cues.delete(key);
                    entry.track.removeCue(cue);
                }
            this.#read(entry);
        }
    }

    /** Reads the cues of the track's rendition in its range, until stopped or past the range. */
    #read(entry: SubtitleTrack): void {
        const { rendition, range } = entry;
        const signal = this.#linked.signal;
        this.#load(entry, rendition, range, signal).catch(error => {
            if (signal.aborted) return;
            const reason = error instanceof Error ? error.message : String(error);
            this.options.warn?.(
                'HLS_SUBTITLES_FAILED',
                `Subtitles ${rendition.name} stopped: ${reason}`,
            );
        });
    }

    /** The offset of a discontinuity's cues: the playback's for it, else its latest. */
    async #offsetOf(discontinuity: number, signal: AbortSignal): Promise<number> {
        while (this.#latest === undefined) {
            if (signal.aborted) throw new Error('stopped');
            await new Promise<void>(resolve => {
                this.#waiting.push(resolve);
                signal.addEventListener('abort', () => resolve(), { once: true });
            });
        }
        return this.#offsets.get(discontinuity) ?? this.#latest;
    }

    async #load(
        entry: SubtitleTrack,
        rendition: HlsRendition,
        range: CueRange,
        signal: AbortSignal,
    ): Promise<void> {
        const client = new HlsClient({ ...this.clientOptions, adaptive: false, signal });
        const live = this.options.live;
        try {
            await client.load(rendition.uri!, { signal });
            const segments = client.segments({ signal, ...(live !== undefined ? { live } : {}) });
            for await (const { segment, data } of segments) {
                const document = parseWebVtt(data);
                const map = document.timestampMap;
                const shift =
                    (map ? map.mpegTimestamp / MPEG_CLOCK - map.localTime : 0) +
                    (await this.#offsetOf(segment.discontinuitySequence, signal));
                if (signal.aborted) return;
                let past = false;
                for (const cue of document.cues) {
                    const start = cue.startTime + shift;
                    const end = cue.endTime + shift;
                    const key = `${start}\n${end}\n${cue.text}`;
                    past ||= start >= range.until;
                    if (end <= start || start < range.from || start >= range.until) continue;
                    if (entry.cues.has(key)) continue;
                    const added = new VTTCue(start, end, cue.text);
                    entry.cues.set(key, added);
                    entry.track.addCue(added);
                }
                // A rendition replaced at a switch stops at its first cue after it.
                if (past) return;
            }
        } finally {
            client.close();
        }
    }

    /** Stops loading and takes the cues off the element: the tracks stay, disabled. */
    stop(): void {
        this.#stop.abort();
        this.#linked.dispose();
        for (const { track, cues } of this.#tracks) {
            try {
                for (const cue of Array.from(track.cues ?? [])) track.removeCue(cue);
                cues.clear();
                track.mode = 'disabled';
            } catch {}
        }
    }
}
