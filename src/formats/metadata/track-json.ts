import { MediaForgeError } from '../../core/errors/errors';
import type { MediaTrack } from '../../core/model/media';
import { attachedLength } from '../../core/bytes/typed-array';

const MAX_JSON_LENGTH = 16 * 1024 * 1024;
const MAX_TRACKS = 4096;
const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_TRACK_UID = 0xffffffffffffffffn;
const trackKeys = [
    'id',
    'type',
    'codec',
    'matroskaTrackUid',
    'codecConfig',
    'default',
    'forced',
    'name',
    'commentary',
    'alphaMode',
    'width',
    'height',
    'displayWidth',
    'displayHeight',
    'pixelAspectRatioNum',
    'pixelAspectRatioDen',
    'framerate',
    'sampleRate',
    'channelCount',
    'language',
    'duration',
    'timescale',
    'sampleCount',
] as const;

function invalid(message: string): never {
    throw new MediaForgeError(message, 'FORMAT');
}

function validateTrack(track: Record<string, unknown>): void {
    if (
        !Number.isSafeInteger(track.id) ||
        (track.id as number) < 0 ||
        !['audio', 'video', 'subtitle'].includes(track.type as string) ||
        typeof track.codec !== 'string' ||
        track.codec.length === 0
    ) {
        invalid('Track JSON requires a non-negative safe integer id, track type and codec');
    }

    for (const key of ['default', 'forced', 'commentary', 'alphaMode']) {
        if (track[key] !== undefined && typeof track[key] !== 'boolean')
            invalid(`Track ${key} must be a boolean`);
    }

    for (const key of ['name', 'language']) {
        if (track[key] !== undefined && typeof track[key] !== 'string')
            invalid(`Track ${key} must be a string`);
    }

    for (const key of [
        'width',
        'height',
        'displayWidth',
        'displayHeight',
        'pixelAspectRatioNum',
        'pixelAspectRatioDen',
        'framerate',
        'sampleRate',
        'channelCount',
        'duration',
        'timescale',
        'sampleCount',
    ]) {
        const value = track[key];
        if (
            value !== undefined &&
            (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
        ) {
            invalid(`Track ${key} must be a finite non-negative number`);
        }
    }
}

function trackRecord(track: unknown): Record<string, unknown> {
    if (!track || typeof track !== 'object' || Array.isArray(track))
        invalid('Expected a track metadata object');
    const record: Record<string, unknown> = Object.create(null);
    for (const key of new Set<string>([...Object.keys(track), ...trackKeys])) {
        const value = Reflect.get(track, key);
        if (value !== undefined && !(key === 'toJSON' && typeof value === 'function'))
            record[key] = value;
    }
    validateTrack(record);
    return record;
}

function trackJson(track: unknown): Record<string, unknown> {
    const record = trackRecord(track);
    const uid = record.matroskaTrackUid;
    if (uid !== undefined) {
        if (typeof uid !== 'bigint' || uid <= 0n || uid > MAX_TRACK_UID) {
            invalid('Matroska TrackUID must be a positive unsigned 64-bit bigint');
        }
        record.matroskaTrackUid = uid.toString();
    }

    const bytes = record.codecConfig;
    if (bytes !== undefined) {
        let length: number;
        try {
            length = attachedLength(bytes as Uint8Array);
        } catch {
            invalid('Track codecConfig must be an attached Uint8Array');
        }

        if (length > MAX_CONFIG_BYTES) invalid('Track codecConfig exceeds 1 MiB');
        const values: number[] = [];
        for (let index = 0; index < length; index++) values.push((bytes as Uint8Array)[index]);
        record.codecConfig = values;
    }

    return record;
}

/** Internal hook for caller-owned public metadata copies; never modifies a prototype. */
export function withTrackJson<T extends MediaTrack>(track: T): T {
    if (!Object.hasOwn(track, 'toJSON')) {
        Object.defineProperty(track, 'toJSON', {
            value: function (this: MediaTrack): Record<string, unknown> {
                return trackJson(this);
            },
            configurable: true,
        });
    }
    return track;
}

function trackArrayLength(value: unknown): number {
    if (!Array.isArray(value)) invalid('Track JSON requires an array of at most 4096 tracks');
    const length = value.length;
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_TRACKS) {
        invalid('Track JSON requires an array of at most 4096 tracks');
    }
    return length;
}

/**
 * Serialize track metadata with decimal-string uint64 UIDs and numeric codecConfig arrays.
 * Reads known fields once on the original receiver. Other enumerable fields follow JSON rules.
 * Limits: 4096 tracks, 1 MiB codecConfig per track, 16 Mi UTF-16 code units of JSON text.
 */
export function serializeTracks(tracks: readonly MediaTrack[]): string {
    const length = trackArrayLength(tracks);
    const records: string[] = [];
    let totalLength = 2;
    for (let index = 0; index < length; index++) {
        const json = JSON.stringify(trackJson(tracks[index]));
        totalLength += json.length + (index === 0 ? 0 : 1);
        if (totalLength > MAX_JSON_LENGTH) invalid('Track JSON exceeds 16 Mi characters');
        records.push(json);
    }
    return `[${records.join(',')}]`;
}

/**
 * Restore metadata (not media packets) from serializeTracks or JSON.stringify(file.tracks). Only
 * top-level matroskaTrackUid and codecConfig fields are decoded. Returns owned bytes. Accepts
 * canonical decimal UIDs in 1..2^64-1; numeric UIDs are rejected. Same limits as serializeTracks.
 */
export function deserializeTracks(json: string): MediaTrack[] {
    if (typeof json !== 'string' || json.length > MAX_JSON_LENGTH)
        invalid('Track JSON must be at most 16 Mi characters');
    let parsed: unknown;
    try {
        parsed = JSON.parse(json);
    } catch {
        invalid('Invalid track JSON');
    }

    trackArrayLength(parsed);
    return (parsed as unknown[]).map(value => {
        const record = trackRecord(value);
        const uid = record.matroskaTrackUid;
        if (uid !== undefined) {
            if (
                typeof uid !== 'string' ||
                !/^[1-9][0-9]{0,19}$/.test(uid) ||
                BigInt(uid) > MAX_TRACK_UID
            ) {
                invalid(
                    'Track JSON Matroska TrackUID must be a canonical positive uint64 decimal ' +
                        'string',
                );
            }
            record.matroskaTrackUid = BigInt(uid);
        }

        const values = record.codecConfig;
        if (values !== undefined) {
            if (!Array.isArray(values) || values.length > MAX_CONFIG_BYTES) {
                invalid('Track JSON codecConfig must be a byte array of at most 1 MiB');
            }
            for (const byte of values) {
                if (!Number.isInteger(byte) || byte < 0 || byte > 255)
                    invalid('Track JSON codecConfig contains an invalid byte');
            }
            record.codecConfig = new Uint8Array(values);
        }

        const track = {};
        for (const key of Object.keys(record)) {
            Object.defineProperty(track, key, {
                value: record[key],
                enumerable: true,
                configurable: true,
                writable: true,
            });
        }

        return withTrackJson(track as MediaTrack);
    });
}
