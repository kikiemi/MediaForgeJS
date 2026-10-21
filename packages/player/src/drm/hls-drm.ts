import { MediaForgeError } from 'mediaforgejs/plugins';
import type { HlsKey } from 'mediaforgejs/streaming';
import {
    awaitWithAbort,
    copyOutputBytes,
    createDeadline,
    invalidArgument,
    linkAbortSignals,
    malformed,
    outputByteLength,
    overLimit,
    unsupported,
} from '../support.js';
import {
    EmeController,
    type EmeControllerOptions,
    type EmeLicenseCallback,
} from './eme-controller.js';
import type { HlsPartData } from '../hls-client.js';
import { type HlsDrmInitData, drmInitData, drmKeyFormats } from './hls-drm-data.js';
import type { HlsEncryptionContext, HlsEncryptionHandler } from '../encryption.js';
import {
    type HlsPlaybackOptions,
    type PlaybackHooks,
    type PlaybackStream,
    playStreams,
} from '../hls-playback.js';

export interface HlsDrmInitDataRequest {
    readonly keySystem: string;
    readonly key: Readonly<HlsKey>;
    readonly signal: AbortSignal;
}

export interface HlsDrmKeySystem {
    readonly keySystem: string;
    /** Overrides the known Widevine, PlayReady or FairPlay KEYFORMAT mapping. */
    readonly keyFormats?: readonly string[];
    /** If omitted, AVC/AAC capabilities are inferred from the playback MIME or variant. */
    readonly configurations?: readonly MediaKeySystemConfiguration[];
    readonly license: EmeLicenseCallback;
    readonly serverCertificate?: Uint8Array;
    /** Overrides playlist init-data decoding; undefined waits for the browser encrypted event. */
    readonly getInitData?: (
        request: HlsDrmInitDataRequest,
    ) => HlsDrmInitData | undefined | PromiseLike<HlsDrmInitData | undefined>;
}

export interface HlsDrmOptions {
    /** Ordered preference; capability rejection tries the next matching system. */
    readonly keySystems: readonly HlsDrmKeySystem[];
}

export type HlsDrmSessionOptions = Pick<
    EmeControllerOptions,
    | 'attachTimeoutMs'
    | 'licenseTimeoutMs'
    | 'maxSessions'
    | 'maxInitDataBytes'
    | 'maxLicenseBytes'
    | 'maxPendingMessages'
    | 'onKeyStatusesChange'
>;

export interface HlsDrmPlaybackOptions extends HlsPlaybackOptions, HlsDrmOptions {
    readonly eme?: HlsDrmSessionOptions;
    /** Maximum continuous browser waitingforkey interval; default 30000 ms. */
    readonly keyTimeoutMs?: number;
}

interface System extends HlsDrmKeySystem {
    readonly keyFormats: readonly string[];
}

/** Refuses an invalid option, argument or callback result. */
function invalid(message: string): never {
    return invalidArgument(`HLS DRM: ${message}`);
}

function timeout(value: number | undefined, name: string): number {
    const result = value === undefined ? 30000 : value;
    if (!Number.isSafeInteger(result) || result <= 0 || result > 0x7fffffff)
        invalid(`${name} must be a positive integer up to 2147483647`);
    return result;
}

function strings(values: readonly string[] | undefined, name: string): string[] | undefined {
    if (values === undefined) return undefined;
    if (!Array.isArray(values) || !values.length || values.length > 64) invalid(`invalid ${name}`);
    return Array.from(values, value => {
        if (typeof value !== 'string' || !value || value.length > 1024) invalid(`invalid ${name}`);
        return value;
    });
}

function configurations(
    values: readonly MediaKeySystemConfiguration[] | undefined,
): MediaKeySystemConfiguration[] | undefined {
    if (values === undefined) return undefined;
    if (!Array.isArray(values) || !values.length || values.length > 64)
        invalid('invalid configurations');

    const capabilities = (
        values: MediaKeySystemMediaCapability[] | undefined,
    ): MediaKeySystemMediaCapability[] | undefined => {
        if (values === undefined) return undefined;
        if (!Array.isArray(values) || values.length > 64) invalid('invalid DRM capabilities');
        return Array.from(values, value => {
            if (!value || typeof value !== 'object') invalid('invalid DRM capability');
            const { contentType, robustness, encryptionScheme } = value;
            if (
                typeof contentType !== 'string' ||
                !contentType ||
                (robustness !== undefined && typeof robustness !== 'string') ||
                (encryptionScheme !== undefined &&
                    encryptionScheme !== null &&
                    typeof encryptionScheme !== 'string')
            )
                invalid('invalid DRM capability values');
            return { contentType, robustness, encryptionScheme };
        });
    };

    return Array.from(values, value => {
        if (!value || typeof value !== 'object') invalid('invalid DRM configuration');
        const {
            label,
            initDataTypes,
            audioCapabilities,
            videoCapabilities,
            distinctiveIdentifier,
            persistentState,
            sessionTypes,
        } = value;
        if (
            (label !== undefined && typeof label !== 'string') ||
            (distinctiveIdentifier !== undefined &&
                !['required', 'optional', 'not-allowed'].includes(distinctiveIdentifier)) ||
            (persistentState !== undefined &&
                !['required', 'optional', 'not-allowed'].includes(persistentState))
        )
            invalid('invalid DRM configuration values');

        const sessions = strings(sessionTypes, 'sessionTypes');
        if (sessions?.some(type => type !== 'temporary'))
            unsupported('HLS DRM: only temporary DRM sessions are supported');
        return {
            label,
            initDataTypes: strings(initDataTypes, 'initDataTypes'),
            audioCapabilities: capabilities(audioCapabilities),
            videoCapabilities: capabilities(videoCapabilities),
            distinctiveIdentifier,
            persistentState,
            sessionTypes: ['temporary'],
        };
    });
}

function systems(options: HlsDrmOptions): System[] {
    if (!options || typeof options !== 'object' || Array.isArray(options))
        invalid('options must be an object');
    const values = options.keySystems;
    if (!Array.isArray(values) || !values.length || values.length > 16)
        invalid('keySystems must contain 1 to 16 configurations');
    return Array.from(values, value => {
        if (!value || typeof value !== 'object') invalid('invalid key system');
        const {
            keySystem,
            keyFormats,
            configurations: configs,
            license,
            serverCertificate,
            getInitData,
        } = value;

        if (typeof keySystem !== 'string' || !keySystem || keySystem.length > 256)
            invalid('invalid keySystem');
        if (
            typeof license !== 'function' ||
            (getInitData !== undefined && typeof getInitData !== 'function')
        )
            invalid('invalid DRM callback');

        if (
            serverCertificate !== undefined &&
            (!outputByteLength(serverCertificate) ||
                outputByteLength(serverCertificate) > 1024 * 1024)
        )
            invalid('serverCertificate must contain 1 to 1048576 bytes');

        return {
            keySystem,
            keyFormats: strings(keyFormats, 'keyFormats') ?? drmKeyFormats(keySystem),
            configurations: configurations(configs),
            license: license.bind(value),
            serverCertificate:
                serverCertificate === undefined ? undefined : copyOutputBytes(serverCertificate),
            getInitData: getInitData?.bind(value),
        };
    });
}

function matches(system: System, key: HlsKey): boolean {
    return (
        (key.method === 'SAMPLE-AES' || key.method === 'SAMPLE-AES-CTR') &&
        system.keyFormats.includes(key.keyFormat ?? 'identity') &&
        (!key.keyFormatVersions || key.keyFormatVersions.split('/').includes('1'))
    );
}

/** Opt-in ciphertext delivery for fMP4 CDM playback. Never fetches a DRM key URI. */
export function createHlsDrmHandler(options: HlsDrmOptions): HlsEncryptionHandler {
    const available = systems(options);
    const supports = (context: HlsEncryptionContext): boolean =>
        (context.kind === 'map' || !!context.map) &&
        available.some(system => matches(system, context.key));
    return {
        retainsEncryption: true,
        supports,
        decrypt(request) {
            if (!supports(request))
                unsupported('HLS DRM: unsupported DRM method, KEYFORMAT or media container');
            if (request.signal.aborted) throw new MediaForgeError('HLS DRM aborted', 'ABORT');
            return request.data;
        },
    };
}

function requestedConfigurations(
    system: System,
    unit: HlsPartData,
    mime: string | undefined,
    key: HlsKey,
): MediaKeySystemConfiguration[] {
    const scheme = key.method === 'SAMPLE-AES' ? 'cbcs' : 'cenc';
    let result = system.configurations;
    if (!result) {
        const codecs =
            mime?.match(/^(?:audio|video)\/mp4\s*;\s*codecs\s*=\s*"([^"\r\n]+)"\s*$/i)?.[1] ??
            unit.variant?.codecs;
        if (!codecs)
            invalid('DRM configurations or a playback MIME with AVC/AAC codecs are required');

        const video: string[] = [];
        const audio: string[] = [];
        for (const value of codecs.split(',')) {
            const codec = value.trim();
            if (/^avc[13]\.[\da-fA-F]{6}$/.test(codec)) video.push(codec);
            else if (/^mp4a\.40\.\d+$/.test(codec)) audio.push(codec);
            else invalid('provide DRM configurations for codecs other than AVC/AAC');
        }

        result = [
            {
                initDataTypes: system.keySystem === 'com.apple.fps' ? ['skd', 'cenc'] : ['cenc'],
                sessionTypes: ['temporary'],
                videoCapabilities: video.length
                    ? [{ contentType: `video/mp4; codecs="${video.join(',')}"` }]
                    : undefined,
                audioCapabilities: audio.length
                    ? [{ contentType: `audio/mp4; codecs="${audio.join(',')}"` }]
                    : undefined,
            },
        ];
    }

    const addScheme = (
        values: MediaKeySystemMediaCapability[] | undefined,
    ): MediaKeySystemMediaCapability[] | undefined =>
        values
            ?.filter(value => value.encryptionScheme == null || value.encryptionScheme === scheme)
            .map(value => ({ ...value, encryptionScheme: scheme }));

    return result.flatMap(value => {
        const audioCapabilities = addScheme(value.audioCapabilities);
        const videoCapabilities = addScheme(value.videoCapabilities);
        if (
            (value.audioCapabilities?.length && !audioCapabilities?.length) ||
            (value.videoCapabilities?.length && !videoCapabilities?.length)
        )
            return [];
        return [
            {
                ...value,
                initDataTypes: value.initDataTypes?.slice(),
                sessionTypes: ['temporary'],
                audioCapabilities,
                videoCapabilities,
            },
        ];
    });
}

/**
 * Attaches a configured CDM before protected appends; completion includes playHls's actual ended
 * event.
 */
export async function playHlsWithDrm(
    media: HTMLMediaElement,
    units: AsyncIterable<HlsPartData>,
    options: HlsDrmPlaybackOptions,
): Promise<void> {
    if (!options || typeof options !== 'object' || Array.isArray(options))
        invalid('options must be an object');
    return playStreamsWithDrm(media, [{ units, mimeType: options.mimeType }], options);
}

/** The codecs of the streams' MSE types together, for the key system's capabilities. */
function streamsMime(streams: readonly PlaybackStream[]): string | undefined {
    const codecs = streams.map(
        stream => stream.mimeType?.match(/codecs\s*=\s*"([^"\r\n]+)"/i)?.[1],
    );
    if (codecs.some(value => value === undefined)) return undefined;
    const video = streams.some(stream => /^video\//i.test(stream.mimeType!));
    return `${video ? 'video' : 'audio'}/mp4; codecs="${codecs.join(',')}"`;
}

/**
 * playHlsWithDrm for several streams in one media element (the video of an HLS variant and its
 * audio rendition): one CDM for all, chosen by the first protected unit with the capabilities of
 * every stream, and the keys of each stream followed on their own.
 */
export async function playStreamsWithDrm(
    media: HTMLMediaElement,
    streams: readonly PlaybackStream[],
    options: HlsDrmPlaybackOptions,
    hooks: PlaybackHooks = {},
): Promise<void> {
    const available = systems(options);
    const { autoplay, bufferAhead, bufferBehind, operationTimeoutMs, signal, eme, keyTimeoutMs } =
        options;
    if (eme !== undefined && (!eme || typeof eme !== 'object' || Array.isArray(eme)))
        invalid('eme must be an object');
    if (
        signal !== undefined &&
        (!signal ||
            typeof signal.addEventListener !== 'function' ||
            typeof signal.removeEventListener !== 'function' ||
            typeof signal.aborted !== 'boolean')
    )
        invalid('signal must be an AbortSignal');
    if (!Array.isArray(streams) || !streams.length) invalid('playback needs a stream');
    const mimeType = streamsMime(streams);

    const statusListener = eme?.onKeyStatusesChange;
    if (statusListener !== undefined && typeof statusListener !== 'function')
        invalid('invalid onKeyStatusesChange');
    const settings: HlsDrmSessionOptions = {
        attachTimeoutMs: eme?.attachTimeoutMs,
        licenseTimeoutMs: eme?.licenseTimeoutMs,
        maxSessions: eme?.maxSessions,
        maxInitDataBytes: eme?.maxInitDataBytes,
        maxLicenseBytes: eme?.maxLicenseBytes,
        maxPendingMessages: eme?.maxPendingMessages,
        onKeyStatusesChange: statusListener?.bind(eme),
    };

    const attachTimeout = timeout(settings.attachTimeoutMs, 'attachTimeoutMs');
    timeout(settings.licenseTimeoutMs, 'licenseTimeoutMs');
    const keyTimeout = timeout(keyTimeoutMs, 'keyTimeoutMs');

    for (const name of [
        'maxSessions',
        'maxInitDataBytes',
        'maxLicenseBytes',
        'maxPendingMessages',
    ] as const) {
        const value = settings[name];
        if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0))
            invalid(`invalid ${name}`);
    }

    const initLimit = settings.maxInitDataBytes ?? 1024 * 1024;
    const stop = new AbortController();
    const linked = linkAbortSignals(signal, stop.signal);

    let controller: EmeController | undefined;
    let selected: System | undefined;
    let failure: unknown;
    let failed = false;
    let keyTimer: ReturnType<typeof setTimeout> | undefined;
    let awaitingKey = false;
    /** The iterators of the streams, closed once with the playback. */
    const iterators: { iterator: AsyncIterator<HlsPartData>; returned: boolean }[] = [];
    /** One stream prepares its unit at a time, so the first protected unit attaches one CDM. */
    let preparing: Promise<void> = Promise.resolve();

    const pendingInit: HlsDrmInitData[] = [];

    const fail = (error: unknown): void => {
        if (!failed) {
            failed = true;
            failure = error;
            stop.abort(error);
        }
    };

    const check = (): void => {
        if (failed) throw failure;
        if (linked.signal.aborted) throw new MediaForgeError('HLS DRM aborted', 'ABORT');
    };

    const clearKeyTimer = (): void => {
        clearTimeout(keyTimer);
        keyTimer = undefined;
    };

    const startKeyTimer = (): void => {
        if (keyTimer === undefined)
            keyTimer = setTimeout(
                () => fail(new MediaForgeError('HLS DRM timed out waiting for a usable key', 'IO')),
                keyTimeout,
            );
    };

    const waitingForKey = (): void => {
        awaitingKey = true;
        if (!media.paused) startKeyTimer();
    };

    const playing = (): void => {
        awaitingKey = false;
        clearKeyTimer();
    };

    const resume = (): void => {
        if (awaitingKey) startKeyTimer();
    };

    const earlyEncrypted = (event: Event): void => {
        if (controller || failed) return;
        try {
            const { initDataType, initData } = event as MediaEncryptedEvent;
            if (
                !initData ||
                typeof initDataType !== 'string' ||
                !initDataType ||
                initDataType.length > 128
            )
                malformed('HLS DRM: invalid early encrypted event');

            const data = new Uint8Array(initData);
            const length = outputByteLength(data);
            if (!length || length > initLimit)
                overLimit('HLS DRM: early initialization data exceeds maxInitDataBytes');
            if (
                pendingInit.some(
                    value =>
                        value.type === initDataType &&
                        value.data.length === length &&
                        value.data.every((byte, i) => byte === data[i]),
                )
            )
                return;
            if (pendingInit.length >= (settings.maxSessions ?? 8))
                overLimit('HLS DRM: early initialization data exceeds maxSessions');
            pendingInit.push({ type: initDataType, data: copyOutputBytes(data) });
        } catch (error) {
            fail(error);
        }
    };

    const closeIterators = (): void => {
        for (const entry of iterators) {
            if (entry.returned) continue;
            entry.returned = true;
            try {
                void Promise.resolve(entry.iterator.return?.()).catch(() => undefined);
            } catch {}
        }
    };

    const bounded = async <T>(action: (signal: AbortSignal) => PromiseLike<T>): Promise<T> => {
        check();
        const deadline = new AbortController();
        const scope = linkAbortSignals(linked.signal, deadline.signal);
        const expired = createDeadline(attachTimeout);
        const timer = setTimeout(() => deadline.abort(), attachTimeout);

        try {
            const result = await awaitWithAbort(
                Promise.resolve().then(() => {
                    check();
                    return action(scope.signal);
                }),
                scope.signal,
            );
            check();
            if (deadline.signal.aborted || expired())
                throw new MediaForgeError('HLS DRM initialization timed out', 'IO');
            return result;
        } catch (error) {
            check();
            if (deadline.signal.aborted || expired())
                throw new MediaForgeError('HLS DRM initialization timed out', 'IO');
            throw error;
        } finally {
            clearTimeout(timer);
            scope.dispose();
        }
    };

    const prepare = async (unit: HlsPartData, stream: { previousKey?: HlsKey }): Promise<void> => {
        const protection = unit.encryption;
        if (!protection) return;
        const metadata = unit.type === 'part' ? unit.part : unit.segment;
        if (!metadata.map) unsupported('HLS DRM: DRM playback requires fMP4 initialization maps');

        const mediaKeys = metadata.keys?.length
            ? metadata.keys
            : metadata.key
              ? [metadata.key]
              : [];
        const mapKeys = metadata.map.keys?.length
            ? metadata.map.keys
            : metadata.map.key
              ? [metadata.map.key]
              : [];
        const same = (key: HlsKey): boolean =>
            key.method === protection.method &&
            key.uri === protection.uri &&
            key.iv === protection.iv &&
            key.keyFormat === protection.keyFormat &&
            key.keyFormatVersions === protection.keyFormatVersions;

        const alternatives = mediaKeys.some(same)
            ? mediaKeys
            : mapKeys.some(same)
              ? mapKeys
              : [protection];
        let key = selected ? alternatives.find(value => matches(selected!, value)) : undefined;

        if (!controller) {
            if (!EmeController.isSupported()) unsupported('HLS DRM: native EME is unavailable');
            for (const candidate of available) {
                key = alternatives.find(value => matches(candidate, value));
                if (!key) continue;
                const configs = requestedConfigurations(candidate, unit, mimeType, key);
                if (!configs.length) continue;

                let access: MediaKeySystemAccess;
                try {
                    access = await bounded(() =>
                        navigator.requestMediaKeySystemAccess(candidate.keySystem, configs),
                    );
                } catch (error) {
                    check();
                    if (error instanceof DOMException && error.name === 'NotSupportedError')
                        continue;
                    throw error;
                }

                controller = await EmeController.attach(media, {
                    ...settings,
                    keySystem: candidate.keySystem,
                    configurations: configs,
                    keySystemAccess: access,
                    license: candidate.license,
                    serverCertificate: candidate.serverCertificate,
                    signal: linked.signal,
                    onError: fail,
                });
                controller.done.catch(fail);
                selected = candidate;
                for (const init of pendingInit)
                    await bounded(() => controller!.addSession(init.type, init.data));
                pendingInit.length = 0;
                break;
            }
            if (!controller)
                unsupported('HLS DRM: no configured DRM key system supports this stream');
        }

        if (!key || !selected) unsupported('HLS DRM: DRM key system changed during playback');
        const previousKey = stream.previousKey;
        if (previousKey && previousKey.method !== key.method)
            unsupported('HLS DRM: DRM encryption scheme changed during playback');
        if (
            previousKey &&
            previousKey.method === key.method &&
            previousKey.uri === key.uri &&
            previousKey.iv === key.iv &&
            previousKey.keyFormat === key.keyFormat &&
            previousKey.keyFormatVersions === key.keyFormatVersions
        )
            return;

        const init = selected.getInitData
            ? await bounded(signal =>
                  Promise.resolve(
                      selected!.getInitData!({
                          keySystem: selected!.keySystem,
                          key: { ...key! },
                          signal,
                      }),
                  ),
              )
            : drmInitData(key, initLimit);
        if (init !== undefined) {
            if (!init || typeof init !== 'object') invalid('invalid DRM initialization data');
            const { type, data } = init;
            if (typeof type !== 'string' || !type || type.length > 128)
                invalid('invalid DRM initialization type');
            const length = outputByteLength(data);
            if (!length || length > initLimit)
                overLimit('HLS DRM: DRM initialization data exceeds maxInitDataBytes');
            await bounded(() => controller!.addSession(type, data));
        }

        check();
        stream.previousKey = { ...key };
    };

    const wrap = (units: AsyncIterable<HlsPartData>): AsyncIterable<HlsPartData> => ({
        [Symbol.asyncIterator]() {
            const getIterator = units?.[Symbol.asyncIterator];
            if (typeof getIterator !== 'function') invalid('units must be an async iterable');
            const iterator: AsyncIterator<HlsPartData> = getIterator.call(units);
            const next = iterator?.next;
            if (typeof next !== 'function') invalid('invalid media iterator');
            const entry = { iterator, returned: false };
            iterators.push(entry);
            const keys: { previousKey?: HlsKey } = {};
            return {
                async next() {
                    check();
                    const result = await awaitWithAbort(next.call(iterator), linked.signal);
                    check();
                    if (!result || typeof result !== 'object')
                        invalid('invalid media iterator result');
                    if (result.done) {
                        entry.returned = true;
                        return result;
                    }

                    const ready = preparing.then(() => prepare(result.value, keys));
                    preparing = ready.catch(() => undefined);
                    await ready;
                    check();
                    return result;
                },
                async return() {
                    if (!entry.returned) {
                        entry.returned = true;
                        try {
                            void Promise.resolve(iterator.return?.()).catch(() => undefined);
                        } catch {}
                    }
                    return { done: true, value: undefined };
                },
            };
        },
    });

    let listening = false;
    try {
        check();
        if (
            !media ||
            typeof media.addEventListener !== 'function' ||
            typeof media.removeEventListener !== 'function'
        )
            invalid('a media element is required');

        listening = true;
        media.addEventListener('encrypted', earlyEncrypted);
        media.addEventListener('waitingforkey', waitingForKey);
        media.addEventListener('playing', playing);
        media.addEventListener('pause', clearKeyTimer);
        media.addEventListener('play', resume);

        await playStreams(
            media,
            streams.map(stream => ({ ...stream, units: wrap(stream.units) })),
            { autoplay, bufferAhead, bufferBehind, operationTimeoutMs, signal: linked.signal },
            hooks,
        );
        check();
    } catch (error) {
        fail(error);
        throw failure;
    } finally {
        clearKeyTimer();
        pendingInit.length = 0;
        if (listening) {
            try {
                media.removeEventListener('encrypted', earlyEncrypted);
            } catch {}
            try {
                media.removeEventListener('waitingforkey', waitingForKey);
            } catch {}
            try {
                media.removeEventListener('playing', playing);
            } catch {}
            try {
                media.removeEventListener('pause', clearKeyTimer);
            } catch {}
            try {
                media.removeEventListener('play', resume);
            } catch {}
        }

        closeIterators();
        try {
            if (controller) {
                const closing = controller.close();
                if (failed || linked.signal.aborted) void closing.catch(() => undefined);
                else {
                    await closing;
                    check();
                }
            }
        } catch (error) {
            if (!failed) {
                fail(error);
                throw error;
            }
        } finally {
            stop.abort();
            linked.dispose();
        }
    }
}
