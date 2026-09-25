import { MediaForgeError } from '../core/errors.js';
import { copyOutputBytes, outputByteLength, outputError } from '../io/output-data.js';
import { createDeadline } from './deadline.js';
const owners = new WeakMap();
const aborted = () => new MediaForgeError('EME controller was aborted or closed', 'ABORT');
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer').get;
const typedArrayOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset').get;
const typedArrayLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength').get;
const dataViewBuffer = Object.getOwnPropertyDescriptor(DataView.prototype, 'buffer').get;
const dataViewOffset = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteOffset').get;
const dataViewLength = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteLength').get;
function keyIdSnapshot(input) {
    let bytes;
    if (!ArrayBuffer.isView(input))
        bytes = new Uint8Array(input);
    else {
        try {
            bytes = new Uint8Array(dataViewBuffer.call(input), dataViewOffset.call(input), dataViewLength.call(input));
        }
        catch {
            bytes = new Uint8Array(typedArrayBuffer.call(input), typedArrayOffset.call(input), typedArrayLength.call(input));
        }
    }
    return copyOutputBytes(bytes);
}
function positive(value, fallback, name) {
    const result = value ?? fallback;
    if (!Number.isSafeInteger(result) || result <= 0)
        throw new MediaForgeError(`${name} must be a positive safe integer`, 'FORMAT');
    return result;
}
function timeout(value, name) {
    const result = positive(value, 30000, name);
    if (result > 0x7fffffff)
        throw new MediaForgeError(`${name} exceeds the timer range`, 'FORMAT');
    return result;
}
function accessSnapshot(access, expected) {
    if (!access || typeof access !== 'object')
        throw new MediaForgeError('Invalid EME keySystemAccess', 'FORMAT');
    const { keySystem, getConfiguration, createMediaKeys } = access;
    if (keySystem !== expected || typeof getConfiguration !== 'function' || typeof createMediaKeys !== 'function') {
        throw new MediaForgeError('EME keySystemAccess must match the configured key system', 'FORMAT');
    }
    return { getConfiguration: getConfiguration.bind(access), createMediaKeys: createMediaKeys.bind(access) };
}
function stringList(value, name) {
    if (value === undefined)
        return undefined;
    if (!Array.isArray(value))
        throw new MediaForgeError(`${name} must be an array of strings`, 'FORMAT');
    const items = [...value];
    if (items.some(item => typeof item !== 'string')) {
        throw new MediaForgeError(`${name} must be an array of strings`, 'FORMAT');
    }
    return items;
}
function capabilities(value) {
    if (value === undefined)
        return undefined;
    if (!Array.isArray(value))
        throw new MediaForgeError('EME capabilities must be an array', 'FORMAT');
    return value.map(capability => {
        if (!capability || typeof capability !== 'object')
            throw new MediaForgeError('Invalid EME capability', 'FORMAT');
        const { contentType, robustness, encryptionScheme } = capability;
        if ((contentType !== undefined && typeof contentType !== 'string') ||
            (robustness !== undefined && typeof robustness !== 'string') ||
            (encryptionScheme !== undefined && encryptionScheme !== null && typeof encryptionScheme !== 'string')) {
            throw new MediaForgeError('Invalid EME capability values', 'FORMAT');
        }
        return { contentType, robustness, encryptionScheme };
    });
}
function configurationSnapshot(configuration) {
    if (!configuration || typeof configuration !== 'object')
        throw new MediaForgeError('Invalid EME configuration', 'FORMAT');
    const { label, initDataTypes, audioCapabilities, videoCapabilities, distinctiveIdentifier, persistentState, sessionTypes, } = configuration;
    const sessions = stringList(sessionTypes, 'sessionTypes');
    if (sessions !== undefined && (sessions.length === 0 || sessions.some(type => type !== 'temporary'))) {
        throw new MediaForgeError('EME supports temporary session configurations only', 'FORMAT');
    }
    if ((label !== undefined && typeof label !== 'string') ||
        (distinctiveIdentifier !== undefined &&
            !['required', 'optional', 'not-allowed'].includes(distinctiveIdentifier)) ||
        (persistentState !== undefined && !['required', 'optional', 'not-allowed'].includes(persistentState))) {
        throw new MediaForgeError('Invalid EME configuration values', 'FORMAT');
    }
    return {
        label,
        initDataTypes: stringList(initDataTypes, 'initDataTypes'),
        audioCapabilities: capabilities(audioCapabilities),
        videoCapabilities: capabilities(videoCapabilities),
        distinctiveIdentifier,
        persistentState,
        sessionTypes: ['temporary'],
    };
}
function resolveOptions(options) {
    if (!options || typeof options !== 'object')
        throw new MediaForgeError('EME requires options', 'FORMAT');
    const { keySystem, configurations, license, signal, maxSessions, maxInitDataBytes, maxLicenseBytes, maxPendingMessages, licenseTimeoutMs, onError, serverCertificate, attachTimeoutMs, onKeyStatusesChange, keySystemAccess, } = options;
    if (typeof keySystem !== 'string' ||
        !keySystem ||
        typeof license !== 'function' ||
        (onError !== undefined && typeof onError !== 'function') ||
        (onKeyStatusesChange !== undefined && typeof onKeyStatusesChange !== 'function')) {
        throw new MediaForgeError('EME requires a keySystem and license callback', 'FORMAT');
    }
    if (signal !== undefined &&
        (!signal ||
            typeof signal.aborted !== 'boolean' ||
            typeof signal.addEventListener !== 'function' ||
            typeof signal.removeEventListener !== 'function')) {
        throw new MediaForgeError('EME requires a valid AbortSignal', 'FORMAT');
    }
    if (signal?.aborted)
        throw aborted();
    if (!Array.isArray(configurations) || configurations.length === 0) {
        throw new MediaForgeError('EME requires at least one MediaKeySystemConfiguration', 'FORMAT');
    }
    let certificate;
    if (serverCertificate !== undefined) {
        let length;
        try {
            length = outputByteLength(serverCertificate);
        }
        catch {
            throw new MediaForgeError('serverCertificate must be an attached Uint8Array', 'FORMAT');
        }
        if (!length)
            throw new MediaForgeError('serverCertificate must not be empty', 'FORMAT');
        certificate = copyOutputBytes(serverCertificate);
    }
    return {
        keySystem,
        configurations: configurations.map(configurationSnapshot),
        license: license.bind(options),
        signal,
        onError: onError?.bind(options),
        onKeyStatusesChange: onKeyStatusesChange?.bind(options),
        serverCertificate: certificate,
        access: keySystemAccess === undefined ? undefined : accessSnapshot(keySystemAccess, keySystem),
        maxSessions: positive(maxSessions, 8, 'maxSessions'),
        maxInitDataBytes: positive(maxInitDataBytes, 1024 * 1024, 'maxInitDataBytes'),
        maxLicenseBytes: positive(maxLicenseBytes, 1024 * 1024, 'maxLicenseBytes'),
        maxPendingMessages: positive(maxPendingMessages, 16, 'maxPendingMessages'),
        licenseTimeoutMs: timeout(licenseTimeoutMs, 'licenseTimeoutMs'),
        attachTimeoutMs: timeout(attachTimeoutMs, 'attachTimeoutMs'),
    };
}
function snapshot(bytes, limit, label) {
    const length = outputByteLength(bytes);
    if (length === 0)
        throw new MediaForgeError(`${label} must not be empty`, 'IO');
    if (length > limit)
        throw new MediaForgeError(`${label} exceeds its byte limit`, 'OOM');
    return copyOutputBytes(bytes);
}
async function waitFor(pending, signal) {
    let rejectAbort = () => undefined;
    const interruption = new Promise((_resolve, reject) => {
        rejectAbort = reject;
    });
    const onAbort = () => rejectAbort(signal.reason ?? aborted());
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted)
        onAbort();
    try {
        const result = await Promise.race([pending, interruption]);
        if (signal.aborted)
            throw signal.reason ?? aborted();
        return result;
    }
    finally {
        signal.removeEventListener('abort', onAbort);
    }
}
export class EmeController {
    element;
    keySystem;
    done;
    lifetime = new AbortController();
    entries = new Set();
    license;
    maxSessions;
    maxInitDataBytes;
    maxLicenseBytes;
    maxPendingMessages;
    licenseTimeoutMs;
    attachTimeoutMs;
    onError;
    onKeyStatusesChange;
    detachSignal;
    encrypted;
    keys = null;
    selected = null;
    attachment = null;
    closePromise = null;
    pendingMessages = 0;
    stopped = false;
    error = null;
    resolveDone = () => undefined;
    rejectDone = () => undefined;
    constructor(element, options) {
        this.element = element;
        this.keySystem = options.keySystem;
        this.license = options.license;
        this.onError = options.onError;
        this.onKeyStatusesChange = options.onKeyStatusesChange;
        this.maxSessions = options.maxSessions;
        this.maxInitDataBytes = options.maxInitDataBytes;
        this.maxLicenseBytes = options.maxLicenseBytes;
        this.maxPendingMessages = options.maxPendingMessages;
        this.licenseTimeoutMs = options.licenseTimeoutMs;
        this.attachTimeoutMs = options.attachTimeoutMs;
        this.done = new Promise((resolve, reject) => {
            this.resolveDone = resolve;
            this.rejectDone = reject;
        });
        this.done.catch(() => undefined);
        this.encrypted = event => {
            if (this.stopped)
                return;
            try {
                const { initData, initDataType } = event;
                if (!initData)
                    throw new MediaForgeError('Encrypted event has no init data', 'IO');
                this.addSession(initDataType, new Uint8Array(initData)).catch(error => this.fail(error));
            }
            catch (error) {
                this.fail(error);
            }
        };
        const signal = options.signal;
        const onAbort = () => this.fail(aborted());
        this.detachSignal = () => signal?.removeEventListener('abort', onAbort);
        owners.set(element, this);
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted)
            onAbort();
    }
    static isSupported() {
        return typeof navigator !== 'undefined' && typeof navigator.requestMediaKeySystemAccess === 'function';
    }
    static async attach(element, options) {
        const resolved = resolveOptions(options);
        if ((!resolved.access && !EmeController.isSupported()) ||
            !element ||
            typeof element.setMediaKeys !== 'function' ||
            typeof element.addEventListener !== 'function' ||
            typeof element.removeEventListener !== 'function') {
            throw new MediaForgeError('Native EME is unavailable in this environment', 'FORMAT');
        }
        if (element.mediaKeys || owners.has(element))
            throw new MediaForgeError('Media element already has a MediaKeys owner', 'IO');
        const controller = new EmeController(element, resolved);
        const expired = createDeadline(resolved.attachTimeoutMs);
        const onTimeout = () => controller.fail(new MediaForgeError('EME attachment timed out', 'IO'));
        const timer = setTimeout(onTimeout, resolved.attachTimeoutMs);
        const check = () => {
            if (expired())
                onTimeout();
            controller.assertOpen();
        };
        const initialize = Promise.resolve().then(async () => {
            check();
            const access = resolved.access ??
                accessSnapshot(await navigator.requestMediaKeySystemAccess(controller.keySystem, resolved.configurations), controller.keySystem);
            check();
            controller.selected = configurationSnapshot(access.getConfiguration());
            check();
            const keys = await access.createMediaKeys();
            check();
            controller.keys = keys;
            if (resolved.serverCertificate) {
                const accepted = await keys.setServerCertificate(resolved.serverCertificate);
                check();
                if (!accepted)
                    throw new MediaForgeError('EME server certificate is unsupported', 'IO');
            }
            controller.attachment = Promise.resolve().then(() => {
                check();
                if (element.mediaKeys || owners.get(element) !== controller) {
                    throw new MediaForgeError('MediaKeys ownership changed during EME initialization', 'IO');
                }
                return element.setMediaKeys(keys);
            });
            await controller.attachment;
            check();
            element.addEventListener('encrypted', controller.encrypted);
        });
        try {
            await waitFor(initialize, controller.lifetime.signal);
            check();
            return controller;
        }
        catch (error) {
            controller.fail(error);
            throw controller.failure ?? error;
        }
        finally {
            clearTimeout(timer);
        }
    }
    get failure() {
        return this.error;
    }
    get sessionCount() {
        return this.entries.size;
    }
    get configuration() {
        if (!this.selected)
            throw new MediaForgeError('EME configuration has not been selected', 'IO');
        return configurationSnapshot(this.selected);
    }
    async addSession(initDataType, initData) {
        this.assertOpen();
        if (!this.keys)
            throw new MediaForgeError('MediaKeys are not attached', 'IO');
        if (typeof initDataType !== 'string' || !initDataType || initDataType.length > 128) {
            throw new MediaForgeError('Invalid EME initDataType', 'IO');
        }
        const bytes = snapshot(initData, this.maxInitDataBytes, 'EME init data');
        for (const entry of this.entries) {
            if (entry.initDataType === initDataType &&
                entry.initData.length === bytes.length &&
                entry.initData.every((byte, index) => byte === bytes[index]))
                return entry.ready;
        }
        if (this.entries.size >= this.maxSessions)
            throw new MediaForgeError('EME session limit exceeded', 'OOM');
        let session;
        try {
            session = this.keys.createSession('temporary');
        }
        catch (error) {
            this.fail(error);
            throw this.error;
        }
        const entry = {
            session,
            lifetime: new AbortController(),
            initDataType,
            initData: bytes,
            ready: Promise.resolve(session),
            pending: Promise.resolve(),
            message: event => this.enqueueMessage(entry, event),
            statuses: () => this.notifyStatuses(entry),
            released: false,
            generating: true,
            closeRequested: false,
            closeStarted: false,
        };
        this.entries.add(entry);
        session.addEventListener('message', entry.message);
        session.addEventListener('keystatuseschange', entry.statuses);
        session.closed.then(() => this.releaseEntry(entry, false), error => this.fail(error));
        const generation = Promise.resolve()
            .then(() => {
            this.assertOpen();
            return session.generateRequest(initDataType, bytes);
        })
            .then(() => {
            entry.generating = false;
            if (entry.closeRequested)
                this.closeSession(entry);
            return session;
        }, error => {
            entry.generating = false;
            if (entry.closeRequested)
                this.closeSession(entry);
            throw error;
        });
        entry.ready = waitFor(generation, entry.lifetime.signal).catch(error => {
            if (!entry.released)
                this.fail(error);
            throw this.error ?? error;
        });
        return entry.ready;
    }
    close() {
        if (!this.closePromise)
            this.stop();
        return this.closePromise;
    }
    assertOpen() {
        if (this.error)
            throw this.error;
        if (this.stopped)
            throw aborted();
    }
    fail(reason) {
        if (this.stopped)
            return;
        this.error = outputError(reason, 'EME failed');
        this.stop(this.error);
        try {
            this.onError?.(this.error);
        }
        catch { }
    }
    stop(error) {
        this.stopped = true;
        const detach = async () => {
            try {
                if (this.keys && this.element.mediaKeys === this.keys)
                    await this.element.setMediaKeys(null);
            }
            finally {
                if (owners.get(this.element) === this)
                    owners.delete(this.element);
            }
        };
        const cleanup = (this.attachment ?? Promise.resolve()).then(detach, detach);
        const deadline = new AbortController();
        const expired = createDeadline(this.attachTimeoutMs);
        const timeoutError = () => new MediaForgeError('EME MediaKeys detach timed out', 'IO');
        const timer = setTimeout(() => deadline.abort(timeoutError()), this.attachTimeoutMs);
        this.closePromise = waitFor(cleanup, deadline.signal)
            .then(() => {
            if (expired())
                throw timeoutError();
        })
            .catch(reason => {
            throw this.error ?? outputError(reason, 'EME MediaKeys detach failed');
        })
            .finally(() => clearTimeout(timer));
        this.closePromise.catch(() => undefined);
        try {
            this.detachSignal();
        }
        catch { }
        try {
            this.element.removeEventListener('encrypted', this.encrypted);
        }
        catch { }
        this.lifetime.abort(error ?? aborted());
        for (const entry of [...this.entries])
            this.releaseEntry(entry, true);
        if (error)
            this.rejectDone(error);
        else
            this.resolveDone();
    }
    releaseEntry(entry, close) {
        if (entry.released)
            return;
        entry.released = true;
        entry.closeRequested = close;
        entry.initData = new Uint8Array(0);
        try {
            entry.session.removeEventListener('message', entry.message);
        }
        catch { }
        try {
            entry.session.removeEventListener('keystatuseschange', entry.statuses);
        }
        catch { }
        this.entries.delete(entry);
        entry.lifetime.abort(aborted());
        if (close && !entry.generating)
            this.closeSession(entry);
    }
    closeSession(entry) {
        if (entry.closeStarted)
            return;
        entry.closeStarted = true;
        try {
            Promise.resolve(entry.session.close()).catch(() => undefined);
        }
        catch { }
    }
    notifyStatuses(entry) {
        if (this.stopped || entry.released || !this.onKeyStatusesChange)
            return;
        try {
            const statuses = [];
            entry.session.keyStatuses.forEach((status, keyId) => {
                statuses.push({ keyId: keyIdSnapshot(keyId), status });
            });
            this.onKeyStatusesChange({ keySystem: this.keySystem, sessionId: entry.session.sessionId, statuses });
        }
        catch (error) {
            this.fail(error);
        }
    }
    enqueueMessage(entry, event) {
        if (this.stopped || entry.released)
            return;
        try {
            if (this.pendingMessages >= this.maxPendingMessages)
                throw new MediaForgeError('EME pending message limit exceeded', 'OOM');
            const message = snapshot(new Uint8Array(event.message), this.maxLicenseBytes, 'EME message');
            const messageType = event.messageType;
            if (!['license-request', 'license-renewal', 'license-release', 'individualization-request'].includes(messageType)) {
                throw new MediaForgeError('Invalid EME message type', 'IO');
            }
            this.pendingMessages++;
            entry.pending = entry.pending
                .then(() => this.exchange(entry, message, messageType))
                .catch(error => this.fail(error))
                .finally(() => {
                this.pendingMessages--;
            });
        }
        catch (error) {
            this.fail(error);
        }
    }
    async exchange(entry, message, messageType) {
        this.assertOpen();
        if (entry.released)
            return;
        const lease = new AbortController();
        const onAbort = () => lease.abort(this.lifetime.signal.reason ?? aborted());
        const onSessionClose = () => lease.abort(aborted());
        this.lifetime.signal.addEventListener('abort', onAbort, { once: true });
        entry.lifetime.signal.addEventListener('abort', onSessionClose, { once: true });
        const expired = createDeadline(this.licenseTimeoutMs);
        const onTimeout = () => {
            const error = new MediaForgeError('EME license exchange timed out', 'IO');
            if (!entry.released)
                this.fail(error);
            if (!lease.signal.aborted)
                lease.abort(error);
        };
        const timer = setTimeout(onTimeout, this.licenseTimeoutMs);
        const fail = (reason) => {
            if (!entry.released)
                this.fail(reason);
            return this.error ?? reason;
        };
        const observe = (operation) => {
            try {
                return Promise.resolve(operation()).catch(reason => {
                    throw fail(reason);
                });
            }
            catch (reason) {
                return Promise.reject(fail(reason));
            }
        };
        const check = () => {
            this.assertOpen();
            if (expired())
                onTimeout();
            if (lease.signal.aborted)
                throw lease.signal.reason;
        };
        try {
            const response = await waitFor(Promise.resolve().then(() => {
                check();
                return observe(() => this.license({
                    keySystem: this.keySystem,
                    message,
                    messageType,
                    sessionId: entry.session.sessionId,
                    signal: lease.signal,
                }));
            }), lease.signal);
            check();
            if (entry.released)
                return;
            const bytes = snapshot(response, this.maxLicenseBytes, 'EME license');
            check();
            await waitFor(observe(() => entry.session.update(bytes)), lease.signal);
            check();
        }
        catch (error) {
            if (!entry.released || this.stopped) {
                this.fail(error);
                throw this.error ?? error;
            }
        }
        finally {
            clearTimeout(timer);
            this.lifetime.signal.removeEventListener('abort', onAbort);
            entry.lifetime.signal.removeEventListener('abort', onSessionClose);
        }
    }
}
