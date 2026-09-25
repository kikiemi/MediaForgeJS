import { awaitWithAbort, linkAbortSignals } from '../core/abort.js';
import { MediaForgeError } from '../core/errors.js';
import { createDeadline } from '../drm/deadline.js';
import { EmeController } from '../drm/eme-controller.js';
import { copyOutputBytes, outputByteLength } from '../io/output-data.js';
import { drmInitData, drmKeyFormats } from './hls-drm-data.js';
import { playHls } from './hls-playback.js';
function invalid(message) {
    throw new MediaForgeError(`HLS DRM: ${message}`, 'FORMAT');
}
function timeout(value, name) {
    const result = value === undefined ? 30000 : value;
    if (!Number.isSafeInteger(result) || result <= 0 || result > 0x7fffffff)
        invalid(`${name} must be a positive integer up to 2147483647`);
    return result;
}
function strings(values, name) {
    if (values === undefined)
        return undefined;
    if (!Array.isArray(values) || !values.length || values.length > 64)
        invalid(`invalid ${name}`);
    return Array.from(values, value => {
        if (typeof value !== 'string' || !value || value.length > 1024)
            invalid(`invalid ${name}`);
        return value;
    });
}
function configurations(values) {
    if (values === undefined)
        return undefined;
    if (!Array.isArray(values) || !values.length || values.length > 64)
        invalid('invalid configurations');
    const capabilities = (values) => {
        if (values === undefined)
            return undefined;
        if (!Array.isArray(values) || values.length > 64)
            invalid('invalid DRM capabilities');
        return Array.from(values, value => {
            if (!value || typeof value !== 'object')
                invalid('invalid DRM capability');
            const { contentType, robustness, encryptionScheme } = value;
            if (typeof contentType !== 'string' ||
                !contentType ||
                (robustness !== undefined && typeof robustness !== 'string') ||
                (encryptionScheme !== undefined && encryptionScheme !== null && typeof encryptionScheme !== 'string'))
                invalid('invalid DRM capability values');
            return { contentType, robustness, encryptionScheme };
        });
    };
    return Array.from(values, value => {
        if (!value || typeof value !== 'object')
            invalid('invalid DRM configuration');
        const { label, initDataTypes, audioCapabilities, videoCapabilities, distinctiveIdentifier, persistentState, sessionTypes, } = value;
        if ((label !== undefined && typeof label !== 'string') ||
            (distinctiveIdentifier !== undefined &&
                !['required', 'optional', 'not-allowed'].includes(distinctiveIdentifier)) ||
            (persistentState !== undefined && !['required', 'optional', 'not-allowed'].includes(persistentState)))
            invalid('invalid DRM configuration values');
        const sessions = strings(sessionTypes, 'sessionTypes');
        if (sessions?.some(type => type !== 'temporary'))
            invalid('only temporary DRM sessions are supported');
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
function systems(options) {
    if (!options || typeof options !== 'object' || Array.isArray(options))
        invalid('options must be an object');
    const values = options.keySystems;
    if (!Array.isArray(values) || !values.length || values.length > 16)
        invalid('keySystems must contain 1 to 16 configurations');
    return Array.from(values, value => {
        if (!value || typeof value !== 'object')
            invalid('invalid key system');
        const { keySystem, keyFormats, configurations: configs, license, serverCertificate, getInitData } = value;
        if (typeof keySystem !== 'string' || !keySystem || keySystem.length > 256)
            invalid('invalid keySystem');
        if (typeof license !== 'function' || (getInitData !== undefined && typeof getInitData !== 'function'))
            invalid('invalid DRM callback');
        if (serverCertificate !== undefined &&
            (!outputByteLength(serverCertificate) || outputByteLength(serverCertificate) > 1024 * 1024))
            invalid('serverCertificate must contain 1 to 1048576 bytes');
        return {
            keySystem,
            keyFormats: strings(keyFormats, 'keyFormats') ?? drmKeyFormats(keySystem),
            configurations: configurations(configs),
            license: license.bind(value),
            serverCertificate: serverCertificate === undefined ? undefined : copyOutputBytes(serverCertificate),
            getInitData: getInitData?.bind(value),
        };
    });
}
function matches(system, key) {
    return ((key.method === 'SAMPLE-AES' || key.method === 'SAMPLE-AES-CTR') &&
        system.keyFormats.includes(key.keyFormat ?? 'identity') &&
        (!key.keyFormatVersions || key.keyFormatVersions.split('/').includes('1')));
}
export function createHlsDrmHandler(options) {
    const available = systems(options);
    const supports = (context) => (context.kind === 'map' || !!context.map) && available.some(system => matches(system, context.key));
    return {
        retainsEncryption: true,
        supports,
        decrypt(request) {
            if (!supports(request))
                invalid('unsupported DRM method, KEYFORMAT or media container');
            if (request.signal.aborted)
                throw new MediaForgeError('HLS DRM aborted', 'ABORT');
            return request.data;
        },
    };
}
function requestedConfigurations(system, unit, mime, key) {
    const scheme = key.method === 'SAMPLE-AES' ? 'cbcs' : 'cenc';
    let result = system.configurations;
    if (!result) {
        const codecs = mime?.match(/^(?:audio|video)\/mp4\s*;\s*codecs\s*=\s*"([^"\r\n]+)"\s*$/i)?.[1] ?? unit.variant?.codecs;
        if (!codecs)
            invalid('DRM configurations or a playback MIME with AVC/AAC codecs are required');
        const video = [];
        const audio = [];
        for (const value of codecs.split(',')) {
            const codec = value.trim();
            if (/^avc[13]\.[\da-fA-F]{6}$/.test(codec))
                video.push(codec);
            else if (/^mp4a\.40\.\d+$/.test(codec))
                audio.push(codec);
            else
                invalid('provide DRM configurations for codecs other than AVC/AAC');
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
    const addScheme = (values) => values
        ?.filter(value => value.encryptionScheme == null || value.encryptionScheme === scheme)
        .map(value => ({ ...value, encryptionScheme: scheme }));
    return result.flatMap(value => {
        const audioCapabilities = addScheme(value.audioCapabilities);
        const videoCapabilities = addScheme(value.videoCapabilities);
        if ((value.audioCapabilities?.length && !audioCapabilities?.length) ||
            (value.videoCapabilities?.length && !videoCapabilities?.length))
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
export async function playHlsWithDrm(media, units, options) {
    const available = systems(options);
    const { mimeType, autoplay, bufferAhead, bufferBehind, operationTimeoutMs, signal, eme, keyTimeoutMs } = options;
    if (eme !== undefined && (!eme || typeof eme !== 'object' || Array.isArray(eme)))
        invalid('eme must be an object');
    if (signal !== undefined &&
        (!signal ||
            typeof signal.addEventListener !== 'function' ||
            typeof signal.removeEventListener !== 'function' ||
            typeof signal.aborted !== 'boolean'))
        invalid('signal must be an AbortSignal');
    const statusListener = eme?.onKeyStatusesChange;
    if (statusListener !== undefined && typeof statusListener !== 'function')
        invalid('invalid onKeyStatusesChange');
    const settings = {
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
    for (const name of ['maxSessions', 'maxInitDataBytes', 'maxLicenseBytes', 'maxPendingMessages']) {
        const value = settings[name];
        if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0))
            invalid(`invalid ${name}`);
    }
    const initLimit = settings.maxInitDataBytes ?? 1024 * 1024;
    const stop = new AbortController();
    const linked = linkAbortSignals(signal, stop.signal);
    let controller;
    let selected;
    let previousKey;
    let failure;
    let failed = false;
    let keyTimer;
    let awaitingKey = false;
    let iterator;
    let returned = false;
    const pendingInit = [];
    const fail = (error) => {
        if (!failed) {
            failed = true;
            failure = error;
            stop.abort(error);
        }
    };
    const check = () => {
        if (failed)
            throw failure;
        if (linked.signal.aborted)
            throw new MediaForgeError('HLS DRM aborted', 'ABORT');
    };
    const clearKeyTimer = () => {
        clearTimeout(keyTimer);
        keyTimer = undefined;
    };
    const startKeyTimer = () => {
        if (keyTimer === undefined)
            keyTimer = setTimeout(() => fail(new MediaForgeError('HLS DRM timed out waiting for a usable key', 'IO')), keyTimeout);
    };
    const waitingForKey = () => {
        awaitingKey = true;
        if (!media.paused)
            startKeyTimer();
    };
    const playing = () => {
        awaitingKey = false;
        clearKeyTimer();
    };
    const resume = () => {
        if (awaitingKey)
            startKeyTimer();
    };
    const earlyEncrypted = (event) => {
        if (controller || failed)
            return;
        try {
            const { initDataType, initData } = event;
            if (!initData || typeof initDataType !== 'string' || !initDataType || initDataType.length > 128)
                invalid('invalid early encrypted event');
            const data = new Uint8Array(initData);
            const length = outputByteLength(data);
            if (!length || length > initLimit)
                invalid('early initialization data exceeds maxInitDataBytes');
            if (pendingInit.some(value => value.type === initDataType &&
                value.data.length === length &&
                value.data.every((byte, i) => byte === data[i])))
                return;
            if (pendingInit.length >= (settings.maxSessions ?? 8))
                invalid('early initialization data exceeds maxSessions');
            pendingInit.push({ type: initDataType, data: copyOutputBytes(data) });
        }
        catch (error) {
            fail(error);
        }
    };
    const closeIterator = () => {
        if (returned || !iterator)
            return;
        returned = true;
        try {
            void Promise.resolve(iterator.return?.()).catch(() => undefined);
        }
        catch { }
    };
    const bounded = async (action) => {
        check();
        const deadline = new AbortController();
        const scope = linkAbortSignals(linked.signal, deadline.signal);
        const expired = createDeadline(attachTimeout);
        const timer = setTimeout(() => deadline.abort(), attachTimeout);
        try {
            const result = await awaitWithAbort(Promise.resolve().then(() => {
                check();
                return action(scope.signal);
            }), scope.signal);
            check();
            if (deadline.signal.aborted || expired())
                throw new MediaForgeError('HLS DRM initialization timed out', 'IO');
            return result;
        }
        catch (error) {
            check();
            if (deadline.signal.aborted || expired())
                throw new MediaForgeError('HLS DRM initialization timed out', 'IO');
            throw error;
        }
        finally {
            clearTimeout(timer);
            scope.dispose();
        }
    };
    const prepare = async (unit) => {
        const protection = unit.encryption;
        if (!protection)
            return;
        const metadata = unit.type === 'part' ? unit.part : unit.segment;
        if (!metadata.map)
            invalid('DRM playback requires fMP4 initialization maps');
        const mediaKeys = metadata.keys?.length ? metadata.keys : metadata.key ? [metadata.key] : [];
        const mapKeys = metadata.map.keys?.length ? metadata.map.keys : metadata.map.key ? [metadata.map.key] : [];
        const same = (key) => key.method === protection.method &&
            key.uri === protection.uri &&
            key.iv === protection.iv &&
            key.keyFormat === protection.keyFormat &&
            key.keyFormatVersions === protection.keyFormatVersions;
        const alternatives = mediaKeys.some(same) ? mediaKeys : mapKeys.some(same) ? mapKeys : [protection];
        let key = selected ? alternatives.find(value => matches(selected, value)) : undefined;
        if (!controller) {
            if (!EmeController.isSupported())
                invalid('native EME is unavailable');
            for (const candidate of available) {
                key = alternatives.find(value => matches(candidate, value));
                if (!key)
                    continue;
                const configs = requestedConfigurations(candidate, unit, mimeType, key);
                if (!configs.length)
                    continue;
                let access;
                try {
                    access = await bounded(() => navigator.requestMediaKeySystemAccess(candidate.keySystem, configs));
                }
                catch (error) {
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
                    await bounded(() => controller.addSession(init.type, init.data));
                pendingInit.length = 0;
                break;
            }
            if (!controller)
                invalid('no configured DRM key system supports this stream');
        }
        if (!key || !selected)
            invalid('DRM key system changed during playback');
        if (previousKey && previousKey.method !== key.method)
            invalid('DRM encryption scheme changed during playback');
        if (previousKey &&
            previousKey.method === key.method &&
            previousKey.uri === key.uri &&
            previousKey.iv === key.iv &&
            previousKey.keyFormat === key.keyFormat &&
            previousKey.keyFormatVersions === key.keyFormatVersions)
            return;
        const init = selected.getInitData
            ? await bounded(signal => Promise.resolve(selected.getInitData({ keySystem: selected.keySystem, key: { ...key }, signal })))
            : drmInitData(key, initLimit);
        if (init !== undefined) {
            if (!init || typeof init !== 'object')
                invalid('invalid DRM initialization data');
            const { type, data } = init;
            if (typeof type !== 'string' || !type || type.length > 128)
                invalid('invalid DRM initialization type');
            const length = outputByteLength(data);
            if (!length || length > initLimit)
                invalid('DRM initialization data exceeds maxInitDataBytes');
            await bounded(() => controller.addSession(type, data));
        }
        check();
        previousKey = { ...key };
    };
    const wrapped = {
        [Symbol.asyncIterator]() {
            const getIterator = units?.[Symbol.asyncIterator];
            if (typeof getIterator !== 'function')
                invalid('units must be an async iterable');
            iterator = getIterator.call(units);
            const next = iterator?.next;
            if (typeof next !== 'function')
                invalid('invalid media iterator');
            return {
                async next() {
                    check();
                    const result = await awaitWithAbort(next.call(iterator), linked.signal);
                    check();
                    if (!result || typeof result !== 'object')
                        invalid('invalid media iterator result');
                    if (result.done) {
                        returned = true;
                        return result;
                    }
                    await prepare(result.value);
                    check();
                    return result;
                },
                async return() {
                    closeIterator();
                    return { done: true, value: undefined };
                },
            };
        },
    };
    let listening = false;
    try {
        check();
        if (!media || typeof media.addEventListener !== 'function' || typeof media.removeEventListener !== 'function')
            invalid('a media element is required');
        listening = true;
        media.addEventListener('encrypted', earlyEncrypted);
        media.addEventListener('waitingforkey', waitingForKey);
        media.addEventListener('playing', playing);
        media.addEventListener('pause', clearKeyTimer);
        media.addEventListener('play', resume);
        await playHls(media, wrapped, {
            mimeType,
            autoplay,
            bufferAhead,
            bufferBehind,
            operationTimeoutMs,
            signal: linked.signal,
        });
        check();
    }
    catch (error) {
        fail(error);
        throw failure;
    }
    finally {
        clearKeyTimer();
        pendingInit.length = 0;
        if (listening) {
            try {
                media.removeEventListener('encrypted', earlyEncrypted);
            }
            catch { }
            try {
                media.removeEventListener('waitingforkey', waitingForKey);
            }
            catch { }
            try {
                media.removeEventListener('playing', playing);
            }
            catch { }
            try {
                media.removeEventListener('pause', clearKeyTimer);
            }
            catch { }
            try {
                media.removeEventListener('play', resume);
            }
            catch { }
        }
        closeIterator();
        try {
            if (controller) {
                const closing = controller.close();
                if (failed || linked.signal.aborted)
                    void closing.catch(() => undefined);
                else {
                    await closing;
                    check();
                }
            }
        }
        catch (error) {
            if (!failed) {
                fail(error);
                throw error;
            }
        }
        finally {
            stop.abort();
            linked.dispose();
        }
    }
}
