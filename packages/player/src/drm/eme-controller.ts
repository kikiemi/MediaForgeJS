import { MediaForgeError } from 'mediaforgejs/plugins';
import {
    copyOutputBytes,
    createDeadline,
    outputByteLength,
    outputError,
    positiveLimit,
    typedArrayBuffer,
    typedArrayByteLength as typedArrayLength,
    typedArrayOffset,
} from '../support.js';

export interface EmeLicenseRequest {
    readonly keySystem: string;
    readonly message: Uint8Array;
    readonly messageType: MediaKeyMessageType;
    readonly sessionId: string;
    readonly signal: AbortSignal;
}

/**
 * The application performs any authorization/network exchange and returns the CDM response bytes.
 */
export type EmeLicenseCallback = (
    request: EmeLicenseRequest,
) => Uint8Array | PromiseLike<Uint8Array>;

export interface EmeKeyStatus {
    /** Owned copy of the key ID; changing these bytes never changes CDM state. */
    readonly keyId: Uint8Array;
    readonly status: MediaKeyStatus;
}

export interface EmeKeyStatusesChange {
    readonly keySystem: string;
    readonly sessionId: string;
    readonly statuses: readonly EmeKeyStatus[];
}

export interface EmeControllerOptions {
    readonly keySystem: string;
    readonly configurations: readonly MediaKeySystemConfiguration[];
    readonly license: EmeLicenseCallback;
    readonly signal?: AbortSignal;
    /** Reuses a capability selection for this key system without another browser request. */
    readonly keySystemAccess?: MediaKeySystemAccess;
    /** Copied during attach and installed before any sessions are created. */
    readonly serverCertificate?: Uint8Array;
    /** Bounds attachment setup and the wait for MediaKeys detach; defaults to 30 seconds. */
    readonly attachTimeoutMs?: number;
    /** Concurrent temporary sessions, including pending generateRequest calls; defaults to 8. */
    readonly maxSessions?: number;
    /** Retained init data per session; defaults to 1 MiB. */
    readonly maxInitDataBytes?: number;
    /** Per-message and per-license byte limit; defaults to 1 MiB. */
    readonly maxLicenseBytes?: number;
    /** Queued and active messages across all sessions; defaults to 16. */
    readonly maxPendingMessages?: number;
    /** Bounds each license callback plus session.update(); defaults to 30 seconds. */
    readonly licenseTimeoutMs?: number;
    readonly onError?: (error: MediaForgeError) => void;
    /** Receives a fresh snapshot on each keystatuseschange; callback errors fail the controller. */
    readonly onKeyStatusesChange?: (change: EmeKeyStatusesChange) => void;
}

interface AccessSnapshot {
    readonly getConfiguration: () => MediaKeySystemConfiguration;
    readonly createMediaKeys: () => Promise<MediaKeys>;
}

interface ResolvedOptions extends EmeControllerOptions {
    readonly configurations: MediaKeySystemConfiguration[];
    readonly serverCertificate?: Uint8Array<ArrayBuffer>;
    readonly maxSessions: number;
    readonly maxInitDataBytes: number;
    readonly maxLicenseBytes: number;
    readonly maxPendingMessages: number;
    readonly licenseTimeoutMs: number;
    readonly attachTimeoutMs: number;
    readonly access?: AccessSnapshot;
}

interface SessionEntry {
    readonly session: MediaKeySession;
    readonly lifetime: AbortController;
    readonly initDataType: string;
    initData: Uint8Array<ArrayBuffer>;
    ready: Promise<MediaKeySession>;
    pending: Promise<void>;
    readonly message: (event: Event) => void;
    readonly statuses: () => void;
    released: boolean;
    generating: boolean;
    closeRequested: boolean;
    closeStarted: boolean;
}

const owners = new WeakMap<HTMLMediaElement, EmeController>();
const aborted = (): MediaForgeError =>
    new MediaForgeError('EME controller was aborted or closed', 'ABORT');
const dataViewBuffer = Object.getOwnPropertyDescriptor(DataView.prototype, 'buffer')!.get!;
const dataViewOffset = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteOffset')!.get!;
const dataViewLength = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteLength')!.get!;

function keyIdSnapshot(input: BufferSource): Uint8Array<ArrayBuffer> {
    let bytes: Uint8Array;
    if (!ArrayBuffer.isView(input)) bytes = new Uint8Array(input);
    else {
        try {
            bytes = new Uint8Array(
                dataViewBuffer.call(input),
                dataViewOffset.call(input),
                dataViewLength.call(input),
            );
        } catch {
            bytes = new Uint8Array(
                typedArrayBuffer.call(input),
                typedArrayOffset.call(input),
                typedArrayLength.call(input),
            );
        }
    }
    return copyOutputBytes(bytes);
}

function timeout(value: number | undefined, name: string): number {
    const result = positiveLimit(value, 30000, name);
    if (result > 0x7fffffff) throw new MediaForgeError(`${name} exceeds the timer range`, 'INPUT');
    return result;
}

function accessSnapshot(access: MediaKeySystemAccess, expected: string): AccessSnapshot {
    if (!access || typeof access !== 'object')
        throw new MediaForgeError('Invalid EME keySystemAccess', 'INPUT');
    const { keySystem, getConfiguration, createMediaKeys } = access;
    if (
        keySystem !== expected ||
        typeof getConfiguration !== 'function' ||
        typeof createMediaKeys !== 'function'
    ) {
        throw new MediaForgeError(
            'EME keySystemAccess must match the configured key system',
            'INPUT',
        );
    }
    return {
        getConfiguration: getConfiguration.bind(access),
        createMediaKeys: createMediaKeys.bind(access),
    };
}

function stringList(value: string[] | undefined, name: string): string[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value))
        throw new MediaForgeError(`${name} must be an array of strings`, 'INPUT');
    const items = [...value];
    if (items.some(item => typeof item !== 'string')) {
        throw new MediaForgeError(`${name} must be an array of strings`, 'INPUT');
    }
    return items;
}

function capabilities(
    value: MediaKeySystemMediaCapability[] | undefined,
): MediaKeySystemMediaCapability[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value))
        throw new MediaForgeError('EME capabilities must be an array', 'INPUT');
    return value.map(capability => {
        if (!capability || typeof capability !== 'object')
            throw new MediaForgeError('Invalid EME capability', 'INPUT');
        const { contentType, robustness, encryptionScheme } = capability;
        if (
            (contentType !== undefined && typeof contentType !== 'string') ||
            (robustness !== undefined && typeof robustness !== 'string') ||
            (encryptionScheme !== undefined &&
                encryptionScheme !== null &&
                typeof encryptionScheme !== 'string')
        ) {
            throw new MediaForgeError('Invalid EME capability values', 'INPUT');
        }
        return { contentType, robustness, encryptionScheme };
    });
}

function configurationSnapshot(
    configuration: MediaKeySystemConfiguration,
): MediaKeySystemConfiguration {
    if (!configuration || typeof configuration !== 'object')
        throw new MediaForgeError('Invalid EME configuration', 'INPUT');
    const {
        label,
        initDataTypes,
        audioCapabilities,
        videoCapabilities,
        distinctiveIdentifier,
        persistentState,
        sessionTypes,
    } = configuration;

    const sessions = stringList(sessionTypes, 'sessionTypes');
    if (
        sessions !== undefined &&
        (sessions.length === 0 || sessions.some(type => type !== 'temporary'))
    ) {
        throw new MediaForgeError('EME supports temporary session configurations only', 'FORMAT');
    }

    if (
        (label !== undefined && typeof label !== 'string') ||
        (distinctiveIdentifier !== undefined &&
            !['required', 'optional', 'not-allowed'].includes(distinctiveIdentifier)) ||
        (persistentState !== undefined &&
            !['required', 'optional', 'not-allowed'].includes(persistentState))
    ) {
        throw new MediaForgeError('Invalid EME configuration values', 'INPUT');
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

function resolveOptions(options: EmeControllerOptions): ResolvedOptions {
    if (!options || typeof options !== 'object')
        throw new MediaForgeError('EME requires options', 'INPUT');
    const {
        keySystem,
        configurations,
        license,
        signal,
        maxSessions,
        maxInitDataBytes,
        maxLicenseBytes,
        maxPendingMessages,
        licenseTimeoutMs,
        onError,
        serverCertificate,
        attachTimeoutMs,
        onKeyStatusesChange,
        keySystemAccess,
    } = options;

    if (
        typeof keySystem !== 'string' ||
        !keySystem ||
        typeof license !== 'function' ||
        (onError !== undefined && typeof onError !== 'function') ||
        (onKeyStatusesChange !== undefined && typeof onKeyStatusesChange !== 'function')
    ) {
        throw new MediaForgeError('EME requires a keySystem and license callback', 'INPUT');
    }

    if (
        signal !== undefined &&
        (!signal ||
            typeof signal.aborted !== 'boolean' ||
            typeof signal.addEventListener !== 'function' ||
            typeof signal.removeEventListener !== 'function')
    ) {
        throw new MediaForgeError('EME requires a valid AbortSignal', 'INPUT');
    }

    if (signal?.aborted) throw aborted();
    if (!Array.isArray(configurations) || configurations.length === 0) {
        throw new MediaForgeError('EME requires at least one MediaKeySystemConfiguration', 'INPUT');
    }

    let certificate: Uint8Array<ArrayBuffer> | undefined;
    if (serverCertificate !== undefined) {
        let length: number;
        try {
            length = outputByteLength(serverCertificate);
        } catch {
            throw new MediaForgeError('serverCertificate must be an attached Uint8Array', 'INPUT');
        }
        if (!length) throw new MediaForgeError('serverCertificate must not be empty', 'INPUT');
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
        access:
            keySystemAccess === undefined ? undefined : accessSnapshot(keySystemAccess, keySystem),
        maxSessions: positiveLimit(maxSessions, 8, 'maxSessions'),
        maxInitDataBytes: positiveLimit(maxInitDataBytes, 1024 * 1024, 'maxInitDataBytes'),
        maxLicenseBytes: positiveLimit(maxLicenseBytes, 1024 * 1024, 'maxLicenseBytes'),
        maxPendingMessages: positiveLimit(maxPendingMessages, 16, 'maxPendingMessages'),
        licenseTimeoutMs: timeout(licenseTimeoutMs, 'licenseTimeoutMs'),
        attachTimeoutMs: timeout(attachTimeoutMs, 'attachTimeoutMs'),
    };
}

function snapshot(bytes: Uint8Array, limit: number, label: string): Uint8Array<ArrayBuffer> {
    const length = outputByteLength(bytes);
    if (length === 0) throw new MediaForgeError(`${label} must not be empty`, 'IO');
    if (length > limit) throw new MediaForgeError(`${label} exceeds its byte limit`, 'OOM');
    return copyOutputBytes(bytes);
}

async function waitFor<T>(pending: PromiseLike<T>, signal: AbortSignal): Promise<T> {
    let rejectAbort: (reason: unknown) => void = () => undefined;
    const interruption = new Promise<never>((_resolve, reject) => {
        rejectAbort = reject;
    });
    const onAbort = (): void => rejectAbort(signal.reason ?? aborted());
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    try {
        const result = await Promise.race([pending, interruption]);
        if (signal.aborted) throw signal.reason ?? aborted();
        return result;
    } finally {
        signal.removeEventListener('abort', onAbort);
    }
}

/** Browser-native EME playback with application-owned licensing and temporary sessions only. */
export class EmeController {
    readonly keySystem: string;
    /** Resolves on close; rejects on abort, CDM or license failure. */
    readonly done: Promise<void>;
    private readonly lifetime = new AbortController();
    private readonly entries = new Set<SessionEntry>();
    private readonly license: EmeLicenseCallback;
    private readonly maxSessions: number;
    private readonly maxInitDataBytes: number;
    private readonly maxLicenseBytes: number;
    private readonly maxPendingMessages: number;
    private readonly licenseTimeoutMs: number;
    private readonly attachTimeoutMs: number;
    private readonly onError: EmeControllerOptions['onError'];
    private readonly onKeyStatusesChange: EmeControllerOptions['onKeyStatusesChange'];
    private readonly detachSignal: () => void;
    private readonly encrypted: (event: Event) => void;
    private keys: MediaKeys | null = null;
    private selected: MediaKeySystemConfiguration | null = null;
    private attachment: Promise<void> | null = null;
    private closePromise: Promise<void> | null = null;
    private pendingMessages = 0;
    private stopped = false;
    private error: MediaForgeError | null = null;
    private resolveDone: () => void = () => undefined;
    private rejectDone: (error: MediaForgeError) => void = () => undefined;

    private constructor(
        private readonly element: HTMLMediaElement,
        options: ResolvedOptions,
    ) {
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

        this.done = new Promise<void>((resolve, reject) => {
            this.resolveDone = resolve;
            this.rejectDone = reject;
        });
        this.done.catch(() => undefined);

        this.encrypted = event => {
            if (this.stopped) return;
            try {
                const { initData, initDataType } = event as MediaEncryptedEvent;
                if (!initData) throw new MediaForgeError('Encrypted event has no init data', 'IO');
                this.addSession(initDataType, new Uint8Array(initData)).catch(error =>
                    this.fail(error),
                );
            } catch (error) {
                this.fail(error);
            }
        };

        const signal = options.signal;
        const onAbort = (): void => this.fail(aborted());
        this.detachSignal = () => signal?.removeEventListener('abort', onAbort);
        owners.set(element, this);
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
    }

    static isSupported(): boolean {
        return (
            typeof navigator !== 'undefined' &&
            typeof navigator.requestMediaKeySystemAccess === 'function'
        );
    }

    /**
     * Call before assigning the media URL. An element with existing MediaKeys is never taken over.
     */
    static async attach(
        element: HTMLMediaElement,
        options: EmeControllerOptions,
    ): Promise<EmeController> {
        const resolved = resolveOptions(options);
        if (!resolved.access && !EmeController.isSupported())
            throw new MediaForgeError('Native EME is unavailable in this environment', 'FORMAT');
        if (
            !element ||
            typeof element.setMediaKeys !== 'function' ||
            typeof element.addEventListener !== 'function' ||
            typeof element.removeEventListener !== 'function'
        ) {
            throw new MediaForgeError('EME requires a media element with setMediaKeys', 'INPUT');
        }

        if (element.mediaKeys || owners.has(element))
            throw new MediaForgeError('Media element already has a MediaKeys owner', 'IO');

        const controller = new EmeController(element, resolved);
        const expired = createDeadline(resolved.attachTimeoutMs);
        const onTimeout = (): void =>
            controller.fail(new MediaForgeError('EME attachment timed out', 'IO'));
        const timer = setTimeout(onTimeout, resolved.attachTimeoutMs);

        const check = (): void => {
            if (expired()) onTimeout();
            controller.assertOpen();
        };

        const initialize = Promise.resolve().then(async () => {
            check();
            const access =
                resolved.access ??
                accessSnapshot(
                    await navigator.requestMediaKeySystemAccess(
                        controller.keySystem,
                        resolved.configurations,
                    ),
                    controller.keySystem,
                );
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
                    throw new MediaForgeError('EME server certificate is not supported', 'IO');
            }

            controller.attachment = Promise.resolve().then(() => {
                check();
                if (element.mediaKeys || owners.get(element) !== controller) {
                    throw new MediaForgeError(
                        'MediaKeys ownership changed during EME initialization',
                        'IO',
                    );
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
        } catch (error) {
            controller.fail(error);
            throw controller.failure ?? error;
        } finally {
            clearTimeout(timer);
        }
    }

    get failure(): MediaForgeError | null {
        return this.error;
    }
    get sessionCount(): number {
        return this.entries.size;
    }
    get configuration(): MediaKeySystemConfiguration {
        if (!this.selected)
            throw new MediaForgeError('EME configuration has not been selected', 'IO');
        return configurationSnapshot(this.selected);
    }

    /**
     * Deduplicates exact init data. Resolves after generateRequest(), before any license response.
     */
    async addSession(initDataType: string, initData: Uint8Array): Promise<MediaKeySession> {
        this.assertOpen();
        if (!this.keys) throw new MediaForgeError('MediaKeys are not attached', 'IO');
        if (typeof initDataType !== 'string' || !initDataType || initDataType.length > 128) {
            throw new MediaForgeError('Invalid EME initDataType', 'IO');
        }
        const bytes = snapshot(initData, this.maxInitDataBytes, 'EME init data');

        for (const entry of this.entries) {
            if (
                entry.initDataType === initDataType &&
                entry.initData.length === bytes.length &&
                entry.initData.every((byte, index) => byte === bytes[index])
            )
                return entry.ready;
        }

        if (this.entries.size >= this.maxSessions)
            throw new MediaForgeError('EME session limit exceeded', 'OOM');
        let session: MediaKeySession;
        try {
            session = this.keys.createSession('temporary');
        } catch (error) {
            this.fail(error);
            throw this.error;
        }

        const entry: SessionEntry = {
            session,
            lifetime: new AbortController(),
            initDataType,
            initData: bytes,
            ready: Promise.resolve(session),
            pending: Promise.resolve(),
            message: event => this.enqueueMessage(entry, event as MediaKeyMessageEvent),
            statuses: () => this.notifyStatuses(entry),
            released: false,
            generating: true,
            closeRequested: false,
            closeStarted: false,
        };

        this.entries.add(entry);
        session.addEventListener('message', entry.message);
        session.addEventListener('keystatuseschange', entry.statuses);
        session.closed.then(
            () => this.releaseEntry(entry, false),
            error => this.fail(error),
        );

        const generation = Promise.resolve()
            .then(() => {
                this.assertOpen();
                return session.generateRequest(initDataType, bytes);
            })
            .then(
                () => {
                    entry.generating = false;
                    if (entry.closeRequested) this.closeSession(entry);
                    return session;
                },
                error => {
                    entry.generating = false;
                    if (entry.closeRequested) this.closeSession(entry);
                    throw error;
                },
            );

        entry.ready = waitFor(generation, entry.lifetime.signal).catch(error => {
            if (!entry.released) this.fail(error);
            throw this.error ?? error;
        });
        return entry.ready;
    }

    /**
     * Stops work immediately. Detach continues after its deadline while ownership remains reserved.
     */
    close(): Promise<void> {
        if (!this.closePromise) this.stop();
        return this.closePromise!;
    }

    private assertOpen(): void {
        if (this.error) throw this.error;
        if (this.stopped) throw aborted();
    }

    private fail(reason: unknown): void {
        if (this.stopped) return;
        this.error = outputError(reason, 'EME failed');
        this.stop(this.error);
        try {
            this.onError?.(this.error);
        } catch {}
    }

    private stop(error?: MediaForgeError): void {
        this.stopped = true;

        const detach = async (): Promise<void> => {
            try {
                if (this.keys && this.element.mediaKeys === this.keys)
                    await this.element.setMediaKeys(null);
            } finally {
                if (owners.get(this.element) === this) owners.delete(this.element);
            }
        };

        const cleanup = (this.attachment ?? Promise.resolve()).then(detach, detach);
        const deadline = new AbortController();
        const expired = createDeadline(this.attachTimeoutMs);
        const timeoutError = (): MediaForgeError =>
            new MediaForgeError('EME MediaKeys detach timed out', 'IO');
        const timer = setTimeout(() => deadline.abort(timeoutError()), this.attachTimeoutMs);

        this.closePromise = waitFor(cleanup, deadline.signal)
            .then(() => {
                if (expired()) throw timeoutError();
            })
            .catch(reason => {
                throw this.error ?? outputError(reason, 'EME MediaKeys detach failed');
            })
            .finally(() => clearTimeout(timer));
        this.closePromise.catch(() => undefined);

        try {
            this.detachSignal();
        } catch {}
        try {
            this.element.removeEventListener('encrypted', this.encrypted);
        } catch {}

        this.lifetime.abort(error ?? aborted());
        for (const entry of [...this.entries]) this.releaseEntry(entry, true);
        if (error) this.rejectDone(error);
        else this.resolveDone();
    }

    private releaseEntry(entry: SessionEntry, close: boolean): void {
        if (entry.released) return;
        entry.released = true;
        entry.closeRequested = close;
        entry.initData = new Uint8Array(0);
        try {
            entry.session.removeEventListener('message', entry.message);
        } catch {}
        try {
            entry.session.removeEventListener('keystatuseschange', entry.statuses);
        } catch {}
        this.entries.delete(entry);
        entry.lifetime.abort(aborted());
        if (close && !entry.generating) this.closeSession(entry);
    }

    private closeSession(entry: SessionEntry): void {
        if (entry.closeStarted) return;
        entry.closeStarted = true;
        try {
            Promise.resolve(entry.session.close()).catch(() => undefined);
        } catch {}
    }

    private notifyStatuses(entry: SessionEntry): void {
        if (this.stopped || entry.released || !this.onKeyStatusesChange) return;
        try {
            const statuses: EmeKeyStatus[] = [];
            entry.session.keyStatuses.forEach((status, keyId) => {
                statuses.push({ keyId: keyIdSnapshot(keyId), status });
            });
            this.onKeyStatusesChange({
                keySystem: this.keySystem,
                sessionId: entry.session.sessionId,
                statuses,
            });
        } catch (error) {
            this.fail(error);
        }
    }

    private enqueueMessage(entry: SessionEntry, event: MediaKeyMessageEvent): void {
        if (this.stopped || entry.released) return;
        try {
            if (this.pendingMessages >= this.maxPendingMessages)
                throw new MediaForgeError('EME pending message limit exceeded', 'OOM');

            const message = snapshot(
                new Uint8Array(event.message),
                this.maxLicenseBytes,
                'EME message',
            );
            const messageType = event.messageType;
            if (
                ![
                    'license-request',
                    'license-renewal',
                    'license-release',
                    'individualization-request',
                ].includes(messageType)
            ) {
                throw new MediaForgeError('Invalid EME message type', 'IO');
            }

            this.pendingMessages++;
            entry.pending = entry.pending
                .then(() => this.exchange(entry, message, messageType))
                .catch(error => this.fail(error))
                .finally(() => {
                    this.pendingMessages--;
                });
        } catch (error) {
            this.fail(error);
        }
    }

    private async exchange(
        entry: SessionEntry,
        message: Uint8Array,
        messageType: MediaKeyMessageType,
    ): Promise<void> {
        this.assertOpen();
        if (entry.released) return;

        const lease = new AbortController();
        const onAbort = (): void => lease.abort(this.lifetime.signal.reason ?? aborted());
        const onSessionClose = (): void => lease.abort(aborted());
        this.lifetime.signal.addEventListener('abort', onAbort, { once: true });
        entry.lifetime.signal.addEventListener('abort', onSessionClose, { once: true });

        const expired = createDeadline(this.licenseTimeoutMs);
        const onTimeout = (): void => {
            const error = new MediaForgeError('EME license exchange timed out', 'IO');
            if (!entry.released) this.fail(error);
            if (!lease.signal.aborted) lease.abort(error);
        };
        const timer = setTimeout(onTimeout, this.licenseTimeoutMs);

        const fail = (reason: unknown): unknown => {
            if (!entry.released) this.fail(reason);
            return this.error ?? reason;
        };

        const observe = <T>(operation: () => T | PromiseLike<T>): Promise<T> => {
            try {
                return Promise.resolve(operation()).catch(reason => {
                    throw fail(reason);
                });
            } catch (reason) {
                return Promise.reject(fail(reason));
            }
        };

        const check = (): void => {
            this.assertOpen();
            if (expired()) onTimeout();
            if (lease.signal.aborted) throw lease.signal.reason;
        };

        try {
            const response = await waitFor(
                Promise.resolve().then(() => {
                    check();
                    return observe(() =>
                        this.license({
                            keySystem: this.keySystem,
                            message,
                            messageType,
                            sessionId: entry.session.sessionId,
                            signal: lease.signal,
                        }),
                    );
                }),
                lease.signal,
            );
            check();
            if (entry.released) return;
            const bytes = snapshot(response, this.maxLicenseBytes, 'EME license');
            check();
            await waitFor(
                observe(() => entry.session.update(bytes)),
                lease.signal,
            );
            check();
        } catch (error) {
            if (!entry.released || this.stopped) {
                this.fail(error);
                throw this.error ?? error;
            }
        } finally {
            clearTimeout(timer);
            this.lifetime.signal.removeEventListener('abort', onAbort);
            entry.lifetime.signal.removeEventListener('abort', onSessionClose);
        }
    }
}
