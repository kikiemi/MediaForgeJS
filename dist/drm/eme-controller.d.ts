import { MediaForgeError } from '../core/errors.js';
export interface EmeLicenseRequest {
    readonly keySystem: string;
    readonly message: Uint8Array;
    readonly messageType: MediaKeyMessageType;
    readonly sessionId: string;
    readonly signal: AbortSignal;
}
/** The application performs any authorization/network exchange and returns the CDM response bytes. */
export type EmeLicenseCallback = (request: EmeLicenseRequest) => Uint8Array | PromiseLike<Uint8Array>;
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
/** Browser-native EME playback with application-owned licensing and temporary sessions only. */
export declare class EmeController {
    private readonly element;
    readonly keySystem: string;
    /** Resolves on close; rejects on abort, CDM or license failure. */
    readonly done: Promise<void>;
    private readonly lifetime;
    private readonly entries;
    private readonly license;
    private readonly maxSessions;
    private readonly maxInitDataBytes;
    private readonly maxLicenseBytes;
    private readonly maxPendingMessages;
    private readonly licenseTimeoutMs;
    private readonly attachTimeoutMs;
    private readonly onError;
    private readonly onKeyStatusesChange;
    private readonly detachSignal;
    private readonly encrypted;
    private keys;
    private selected;
    private attachment;
    private closePromise;
    private pendingMessages;
    private stopped;
    private error;
    private resolveDone;
    private rejectDone;
    private constructor();
    static isSupported(): boolean;
    /** Call before assigning the media URL. An element with existing MediaKeys is never taken over. */
    static attach(element: HTMLMediaElement, options: EmeControllerOptions): Promise<EmeController>;
    get failure(): MediaForgeError | null;
    get sessionCount(): number;
    get configuration(): MediaKeySystemConfiguration;
    /** Deduplicates exact init data. Resolves after generateRequest(), before any license response. */
    addSession(initDataType: string, initData: Uint8Array): Promise<MediaKeySession>;
    /** Stops work immediately. Detach continues after its deadline while ownership remains reserved. */
    close(): Promise<void>;
    private assertOpen;
    private fail;
    private stop;
    private releaseEntry;
    private closeSession;
    private notifyStatuses;
    private enqueueMessage;
    private exchange;
}
