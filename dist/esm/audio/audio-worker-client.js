import { MEDIAFORGE_AUDIO_WORKER_SOURCE } from './audio-worker-inline-source.js';
const READY_TIMEOUT_MS = 5000;
export class AudioWorkerClient {
    static sharedClient = null;
    static canUseWorker() {
        return typeof Worker !== 'undefined' && MEDIAFORGE_AUDIO_WORKER_SOURCE.length > 0;
    }
    static getShared() {
        if (!AudioWorkerClient.canUseWorker())
            return null;
        AudioWorkerClient.sharedClient ??= new AudioWorkerClient();
        return AudioWorkerClient.sharedClient;
    }
    session = null;
    activeJob = null;
    firstQueued = null;
    lastQueued = null;
    nextJobId = 1;
    async encode(request, onProgress, signal) {
        if (signal?.aborted)
            throw new DOMException('Aborted', 'AbortError');
        return new Promise((resolve, reject) => {
            let settled = false;
            const cleanup = () => {
                if (settled)
                    return false;
                settled = true;
                signal?.removeEventListener('abort', onAbort);
                return true;
            };
            const job = {
                jobId: this.nextJobId++,
                request,
                onProgress,
                resolve: data => {
                    if (cleanup())
                        resolve(data);
                },
                reject: error => {
                    if (cleanup())
                        reject(error);
                },
                previous: this.lastQueued,
                next: null,
                queued: true,
            };
            const onAbort = () => {
                const error = new DOMException('Aborted', 'AbortError');
                if (job.queued) {
                    this.removeQueued(job);
                    job.reject(error);
                }
                else if (this.activeJob === job) {
                    this.failJob(job, error);
                }
            };
            if (this.lastQueued)
                this.lastQueued.next = job;
            else
                this.firstQueued = job;
            this.lastQueued = job;
            signal?.addEventListener('abort', onAbort, { once: true });
            if (signal?.aborted)
                onAbort();
            this.dispatchNext();
        });
    }
    removeQueued(job) {
        if (job.previous)
            job.previous.next = job.next;
        else
            this.firstQueued = job.next;
        if (job.next)
            job.next.previous = job.previous;
        else
            this.lastQueued = job.previous;
        job.previous = null;
        job.next = null;
        job.queued = false;
    }
    dispatchNext() {
        const job = this.firstQueued;
        if (this.activeJob || !job)
            return;
        this.removeQueued(job);
        this.activeJob = job;
        void (async () => {
            try {
                const session = this.ensureWorker();
                await session.ready;
                if (this.activeJob !== job || this.session !== session)
                    return;
                session.worker.postMessage({ kind: 'encode', jobId: job.jobId, request: job.request }, [
                    job.request.pcm.buffer,
                ]);
            }
            catch (error) {
                this.failJob(job, error instanceof Error ? error : new Error(String(error)));
            }
        })();
    }
    onMessage(session, message) {
        if (this.session !== session || !message)
            return;
        if (message.kind === 'ready') {
            this.clearReadyTimer(session);
            const ready = session.markReady;
            session.markReady = null;
            session.markFailed = null;
            ready?.();
            return;
        }
        const job = this.activeJob;
        if (!job || job.jobId !== message.jobId)
            return;
        if (message.kind === 'progress') {
            try {
                job.onProgress?.(message.progress);
            }
            catch (error) {
                this.failJob(job, error instanceof Error ? error : new Error(String(error)));
            }
        }
        else if (message.kind === 'result' || message.kind === 'error') {
            this.activeJob = null;
            if (message.kind === 'result')
                job.resolve(message.data);
            else
                job.reject(new Error(message.errorMessage));
            this.dispatchNext();
        }
    }
    failSession(session, error) {
        if (this.session !== session)
            return;
        if (this.activeJob)
            this.failJob(this.activeJob, error);
        else
            this.teardownWorkerOnly(error);
    }
    failJob(job, error) {
        if (this.activeJob !== job)
            return;
        this.activeJob = null;
        this.teardownWorkerOnly(error);
        job.reject(error);
        queueMicrotask(() => this.dispatchNext());
    }
    ensureWorker() {
        if (this.session)
            return this.session;
        if (MEDIAFORGE_AUDIO_WORKER_SOURCE.length === 0) {
            throw new Error('Audio worker source was not injected into this build');
        }
        const url = URL.createObjectURL(new Blob([MEDIAFORGE_AUDIO_WORKER_SOURCE], { type: 'text/javascript' }));
        let worker;
        try {
            worker = new Worker(url);
        }
        catch (error) {
            try {
                URL.revokeObjectURL(url);
            }
            catch { }
            throw error;
        }
        let markReady;
        let markFailed;
        const ready = new Promise((resolve, reject) => {
            markReady = resolve;
            markFailed = reject;
        });
        void ready.catch(() => undefined);
        const session = {
            worker,
            url,
            ready,
            markReady,
            markFailed,
            onMessage: event => this.onMessage(session, event.data),
            onError: event => this.failSession(session, new Error(event.message || 'Audio worker crashed')),
            onMessageError: () => this.failSession(session, new Error('Audio worker message could not be deserialized')),
        };
        this.session = session;
        try {
            worker.addEventListener('message', session.onMessage);
            worker.addEventListener('error', session.onError);
            worker.addEventListener('messageerror', session.onMessageError);
            session.timer = setTimeout(() => {
                if (this.session === session && session.markReady) {
                    this.disposeWorker(new Error(`Audio worker did not become ready within ${READY_TIMEOUT_MS}ms`));
                }
            }, READY_TIMEOUT_MS);
        }
        catch (error) {
            this.teardownWorkerOnly(error instanceof Error ? error : new Error(String(error)));
            throw error;
        }
        return session;
    }
    clearReadyTimer(session) {
        if (session.timer === undefined)
            return;
        clearTimeout(session.timer);
        session.timer = undefined;
    }
    teardownWorkerOnly(error) {
        const session = this.session;
        if (!session)
            return;
        this.session = null;
        this.clearReadyTimer(session);
        session.markFailed?.(error);
        session.markReady = null;
        session.markFailed = null;
        try {
            session.worker.removeEventListener('message', session.onMessage);
        }
        catch { }
        try {
            session.worker.removeEventListener('error', session.onError);
        }
        catch { }
        try {
            session.worker.removeEventListener('messageerror', session.onMessageError);
        }
        catch { }
        try {
            session.worker.terminate();
        }
        catch { }
        try {
            URL.revokeObjectURL(session.url);
        }
        catch { }
    }
    disposeWorker(error = new Error('Audio worker terminated')) {
        const active = this.activeJob;
        this.activeJob = null;
        this.teardownWorkerOnly(error);
        active?.reject(error);
        while (this.firstQueued) {
            const job = this.firstQueued;
            this.removeQueued(job);
            job.reject(error);
        }
        if (AudioWorkerClient.sharedClient === this)
            AudioWorkerClient.sharedClient = null;
    }
}
