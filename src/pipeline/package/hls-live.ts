import type { MediaSegment } from '../packet-types';
import type { MediaDiagnostic } from '../../core/errors/diagnostics';
import { MediaForgeError, throwIfAborted } from '../../core/errors/errors';
import { parseHlsPlaylist } from '../../formats/hls/playlist';
import { segmentNamePattern } from './segments';
import type { PackagedFile } from './types';
import { HlsSegmentEncryptor, hlsKeyTag, resolveHlsEncryption } from '../../formats/hls/aes';
import type { HlsEncryptionOptions, ResolvedHlsEncryption } from '../../formats/hls/aes';

export interface HlsLiveOptions {
    /**
     * EXT-X-TARGETDURATION in seconds; raised with a warning when a segment is longer. Default 6.
     */
    readonly targetDuration?: number;
    /** Segments kept in a live playlist; 0 keeps every segment. Default 6. */
    readonly window?: number;
    /**
     * event keeps every segment and marks the playlist EVENT; live slides the window. Default live.
     */
    readonly playlistType?: 'live' | 'event';
    /** Default index.m3u8. */
    readonly playlistName?: string;
    /** Default init.mp4. */
    readonly initName?: string;
    /** One %d or %0Nd placeholder. Default segment-%05d.m4s. */
    readonly segmentNamePattern?: string;
    readonly encryption?: HlsEncryptionOptions;
    /** Wall-clock time of the first segment, written as EXT-X-PROGRAM-DATE-TIME. */
    readonly programDateTime?: Date | string | number;
    readonly onWarning?: (warning: MediaDiagnostic) => void;
    readonly signal?: AbortSignal;
}

/**
 * One playlist state after a segment was added: the files to publish and the names that left the
 * window.
 */
export interface HlsLiveUpdate {
    readonly files: readonly PackagedFile[];
    readonly playlist: string;
    readonly mediaSequence: number;
    readonly segments: number;
    readonly removed: readonly string[];
}

export interface HlsLiveSummary {
    readonly segments: number;
    readonly bytes: number;
    readonly duration: number;
    /** The final playlist text, ending with EXT-X-ENDLIST. */
    readonly playlist: string;
}

interface LiveEntry {
    readonly name: string;
    readonly duration: number;
    readonly dateTime?: number;
}

const PACKAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;

function liveError(message: string): never {
    throw new MediaForgeError(`HLS live packaging: ${message}`, 'INPUT');
}

function plainName(value: unknown, label: string, fallback: string): string {
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || !PACKAGE_NAME.test(value))
        liveError(`${label} must be a plain file name`);
    return value;
}

/**
 * Sliding-window media playlist: add() appends a segment and returns the names that fell out of the
 * window, text() renders the playlist, and end() closes it with EXT-X-ENDLIST.
 */
export class HlsLivePlaylist {
    private readonly entries: LiveEntry[] = [];
    private readonly history: LiveEntry[] = [];
    private mediaSequence = 0;
    private target: number;
    private readonly window: number;
    private readonly event: boolean;
    private ended = false;
    private elapsed = 0;
    readonly initName?: string;
    readonly encryption?: ResolvedHlsEncryption;
    private readonly startDate?: number;
    private readonly onWarning?: (warning: MediaDiagnostic) => void;
    private added = 0;

    constructor(
        options: Pick<
            HlsLiveOptions,
            | 'targetDuration'
            | 'window'
            | 'playlistType'
            | 'encryption'
            | 'programDateTime'
            | 'onWarning'
        > & { readonly initName?: string } = {},
    ) {
        const { targetDuration = 6, window = 6, playlistType = 'live' } = options;
        if (!Number.isFinite(targetDuration) || targetDuration <= 0)
            liveError('targetDuration must be positive');
        if (!Number.isInteger(window) || window < 0)
            liveError('window must be a non-negative integer');
        if (playlistType !== 'live' && playlistType !== 'event')
            liveError('playlistType must be live or event');
        this.target = Math.ceil(targetDuration);
        this.event = playlistType === 'event';
        this.window = this.event ? 0 : window;
        this.initName = options.initName;
        this.encryption = options.encryption ? resolveHlsEncryption(options.encryption) : undefined;
        if (options.programDateTime !== undefined) {
            const time = new Date(options.programDateTime).getTime();
            if (!Number.isFinite(time)) liveError('programDateTime is not a valid date');
            this.startDate = time;
        }
        this.onWarning = options.onWarning;
    }

    get targetDuration(): number {
        return this.target;
    }

    get sequence(): number {
        return this.mediaSequence;
    }

    get count(): number {
        return this.added;
    }

    /** Appends a segment of the given seconds; returns the names that left the window. */
    add(name: string, duration: number): string[] {
        if (this.ended) liveError('the playlist has ended');
        if (!PACKAGE_NAME.test(name)) liveError('segment name must be a plain file name');
        if (!Number.isFinite(duration) || duration <= 0)
            liveError('segment duration must be positive');
        if (Math.round(duration) > this.target) {
            this.onWarning?.(
                Object.freeze({
                    code: 'HLS_TARGET_DURATION_RAISED',
                    message:
                        `Segment ${name} is longer; target duration raised to ` +
                        `${Math.ceil(duration)}`,
                    severity: 'warning',
                }),
            );
            this.target = Math.ceil(duration);
        }

        const entry: LiveEntry = {
            name,
            duration,
            dateTime:
                this.startDate === undefined ? undefined : this.startDate + this.elapsed * 1000,
        };
        this.entries.push(entry);
        this.history.push(entry);
        this.elapsed += duration;
        this.added++;

        const removed: string[] = [];
        while (this.window > 0 && this.entries.length > this.window) {
            removed.push(this.entries.shift()!.name);
            this.mediaSequence++;
        }
        return removed;
    }

    /**
     * Closes the playlist: every segment ever added, from sequence 0, as a VOD recording of the
     * event.
     */
    end(): string {
        this.ended = true;
        return this.render(this.history, 0, 'VOD');
    }

    /** The live playlist: the current window and its media sequence number. */
    text(): string {
        if (this.ended) liveError('the playlist has ended');
        return this.render(this.entries, this.mediaSequence, this.event ? 'EVENT' : undefined);
    }

    private render(
        entries: readonly LiveEntry[],
        mediaSequence: number,
        type: 'VOD' | 'EVENT' | undefined,
    ): string {
        const lines = [
            '#EXTM3U',
            '#EXT-X-VERSION:6',
            `#EXT-X-TARGETDURATION:${this.target}`,
            `#EXT-X-MEDIA-SEQUENCE:${mediaSequence}`,
        ];

        if (type) lines.push(`#EXT-X-PLAYLIST-TYPE:${type}`);
        lines.push('#EXT-X-INDEPENDENT-SEGMENTS');
        if (this.initName) lines.push(`#EXT-X-MAP:URI="${this.initName}"`);
        if (this.encryption) lines.push(hlsKeyTag(this.encryption));

        entries.forEach((entry, index) => {
            if (index === 0 && entry.dateTime !== undefined)
                lines.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(entry.dateTime).toISOString()}`);
            lines.push(`#EXTINF:${entry.duration.toFixed(6)},`, entry.name);
        });

        if (this.ended) lines.push('#EXT-X-ENDLIST');
        const text = `${lines.join('\n')}\n`;
        parseHlsPlaylist(text, { validation: 'strict' });
        return text;
    }
}

function segmentSeconds(segment: Extract<MediaSegment, { kind: 'media' }>): number {
    let seconds = 0;
    for (const track of segment.tracks)
        seconds = Math.max(seconds, Number(track.duration) / track.timescale);
    if (!(seconds > 0)) liveError('media segment has no duration');
    return seconds;
}

/**
 * Packages segments from MediaFile.segments() (or any CMAF segment producer) as a live HLS
 * presentation: every media segment yields the files to publish and the current playlist; the
 * return value carries the ended playlist for recording the event as VOD.
 */
export async function* packageHlsLive(
    segments: AsyncIterable<MediaSegment> | Iterable<MediaSegment>,
    options: HlsLiveOptions = {},
): AsyncGenerator<HlsLiveUpdate, HlsLiveSummary> {
    if (!options || typeof options !== 'object') liveError('expected options');
    const playlistName = plainName(options.playlistName, 'playlistName', 'index.m3u8');
    const initName = plainName(options.initName, 'initName', 'init.mp4');
    const name = segmentNamePattern(
        options.segmentNamePattern ?? 'segment-%05d.m4s',
        'segmentNamePattern',
    );
    if (name(0) === playlistName || name(0) === initName)
        liveError('segmentNamePattern collides with a fixed name');

    const playlist = new HlsLivePlaylist({ ...options, initName });
    const encryptor = playlist.encryption
        ? new HlsSegmentEncryptor(playlist.encryption)
        : undefined;
    const signal = options.signal;

    let bytes = 0;
    let duration = 0;
    let number = 0;
    let keyEmitted = false;

    for await (const segment of segments) {
        throwIfAborted(signal);
        if (segment.kind === 'init') {
            if (number > 0)
                liveError('a new initialization segment after media segments is not representable');
            bytes += segment.data.length;
            const files: PackagedFile[] = [{ kind: 'init', name: initName, data: segment.data }];
            if (playlist.encryption?.keyFile && !keyEmitted) {
                files.push({
                    kind: 'key',
                    name: playlist.encryption.keyFile,
                    data: playlist.encryption.key,
                });
                keyEmitted = true;
            }
            yield {
                files,
                playlist: playlist.text(),
                mediaSequence: playlist.sequence,
                segments: 0,
                removed: [],
            };
            continue;
        }

        const seconds = segmentSeconds(segment);
        const data = encryptor
            ? await encryptor.encrypt(segment.data, playlist.count)
            : segment.data;
        const segmentName = name(number++);
        const removed = playlist.add(segmentName, seconds);
        bytes += data.length;
        duration += seconds;

        const files: PackagedFile[] = [];
        if (playlist.encryption?.keyFile && !keyEmitted) {
            files.push({
                kind: 'key',
                name: playlist.encryption.keyFile,
                data: playlist.encryption.key,
            });
            keyEmitted = true;
        }

        const text = playlist.text();
        files.push(
            { kind: 'segment', name: segmentName, data, number: number - 1 },
            { kind: 'playlist', name: playlistName, data: new TextEncoder().encode(text) },
        );
        yield {
            files,
            playlist: text,
            mediaSequence: playlist.sequence,
            segments: playlist.count,
            removed,
        };
    }
    if (number === 0) liveError('no media segments were produced');
    return { segments: number, bytes, duration, playlist: playlist.end() };
}
