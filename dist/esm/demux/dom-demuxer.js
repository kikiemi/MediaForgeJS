import { MediaForgeError } from '../core/errors.js';
import { logger } from '../core/logger.js';
import { awaitWithAbort } from '../core/abort.js';
export class DOMDemuxer {
    fps;
    signal;
    onProgress;
    loadTimeoutMs;
    seekTimeoutMs;
    video = null;
    url = null;
    info = null;
    cachedAudio = null;
    constructor(cfg = {}) {
        this.fps = cfg.fps || 30;
        this.signal = cfg.signal;
        this.onProgress = cfg.onProgress;
        this.loadTimeoutMs = cfg.loadTimeoutMs ?? 15000;
        this.seekTimeoutMs = cfg.seekTimeoutMs ?? 10000;
    }
    async open(input) {
        this.throwIfAborted();
        this.close();
        const v = document.createElement('video');
        v.muted = true;
        v.preload = 'auto';
        v.playsInline = true;
        const url = URL.createObjectURL(input);
        this.video = v;
        this.url = url;
        try {
            v.src = url;
            await this.waitForLoad(v);
            this.throwIfAborted();
            const dur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : -1;
            let sr = 48000, ch = 2, hasAudio = false;
            const elementAudio = this.elementAudioPresence(v);
            if (elementAudio !== false) {
                try {
                    const decoded = await this.decodeAudioBuffer(input);
                    sr = decoded.sampleRate;
                    ch = decoded.numberOfChannels;
                    hasAudio = true;
                    this.cachedAudio = decoded;
                }
                catch (error) {
                    if (this.isAbort(error))
                        throw new MediaForgeError('Aborted', 'ABORT');
                    logger.warn('[DOMDemuxer] Audio detection failed:', error);
                    throw new MediaForgeError(elementAudio === true
                        ? 'Media element reports an audio track, but decodeAudioData could not decode it'
                        : 'Could not determine whether the media contains audio; refusing to silently drop a possible audio track', 'DECODE');
                }
            }
            this.info = {
                hasVideo: v.videoWidth > 0 && v.videoHeight > 0,
                hasAudio,
                videoWidth: v.videoWidth || 0,
                videoHeight: v.videoHeight || 0,
                duration: dur,
                audioSampleRate: sr,
                audioChannels: ch,
            };
            return this.info;
        }
        catch (error) {
            this.close();
            throw error;
        }
    }
    async *videoFrames() {
        const v = this.video;
        if (!v || !this.info?.hasVideo)
            return;
        const fps = this.fps;
        const dur = this.info.duration;
        if (dur <= 0)
            throw new MediaForgeError('Cannot read video frames without a finite positive duration', 'DECODE');
        const total = Math.ceil(dur * fps);
        for (let i = 0; i < total; i++) {
            if (this.signal?.aborted)
                throw new MediaForgeError('Aborted', 'ABORT');
            v.currentTime = i / fps;
            await this.waitSeek(v);
            this.throwIfAborted();
            const pending = createImageBitmap(v).then(bitmap => {
                if (this.signal?.aborted) {
                    bitmap.close();
                    throw new MediaForgeError('Aborted', 'ABORT');
                }
                return bitmap;
            });
            const bmp = await awaitWithAbort(pending, this.signal);
            let f;
            try {
                this.throwIfAborted();
                f = new VideoFrame(bmp, { timestamp: Math.round((i / fps) * 1e6) });
            }
            finally {
                bmp.close();
            }
            yield f;
            this.onProgress?.(10 + Math.round((i / total) * 70), `Frame ${i + 1}/${total}`);
        }
    }
    async decodeAudio(_input) {
        if (!this.info?.hasAudio)
            return null;
        if (this.cachedAudio) {
            const buf = this.cachedAudio;
            this.cachedAudio = null;
            return buf;
        }
        try {
            return await this.decodeAudioBuffer(_input);
        }
        catch (error) {
            if (this.isAbort(error))
                throw new MediaForgeError('Aborted', 'ABORT');
            logger.warn('[DOMDemuxer] Audio decode failed:', error);
            throw new MediaForgeError(`Audio track was detected but could not be decoded: ${error instanceof Error ? error.message : String(error)}`, 'DECODE');
        }
    }
    close() {
        const video = this.video;
        const url = this.url;
        this.video = null;
        this.url = null;
        this.info = null;
        this.cachedAudio = null;
        if (video) {
            try {
                video.pause();
            }
            catch { }
            try {
                video.removeAttribute('src');
            }
            catch { }
            try {
                video.load();
            }
            catch { }
        }
        if (url) {
            try {
                URL.revokeObjectURL(url);
            }
            catch { }
        }
    }
    waitSeek(v) {
        return new Promise((resolve, reject) => {
            if (this.signal?.aborted) {
                reject(new MediaForgeError('Aborted', 'ABORT'));
                return;
            }
            let settled = false;
            let waitingForPaint = false;
            let firstFrame = -1;
            let secondFrame = -1;
            const finish = (fn) => {
                if (settled)
                    return;
                settled = true;
                rm();
                fn();
            };
            const t = setTimeout(() => finish(() => reject(new MediaForgeError('Seek timeout', 'DECODE'))), this.seekTimeoutMs);
            const afterPaint = () => {
                if (waitingForPaint || settled)
                    return;
                waitingForPaint = true;
                firstFrame = requestAnimationFrame(() => {
                    secondFrame = requestAnimationFrame(() => finish(resolve));
                });
            };
            const ok = () => afterPaint();
            const ng = () => finish(() => reject(new MediaForgeError('Seek error', 'DECODE')));
            const aborted = () => finish(() => reject(new MediaForgeError('Aborted', 'ABORT')));
            const rm = () => {
                clearTimeout(t);
                if (firstFrame >= 0)
                    cancelAnimationFrame(firstFrame);
                if (secondFrame >= 0)
                    cancelAnimationFrame(secondFrame);
                v.removeEventListener('seeked', ok);
                v.removeEventListener('error', ng);
                this.signal?.removeEventListener('abort', aborted);
            };
            v.addEventListener('seeked', ok);
            v.addEventListener('error', ng);
            this.signal?.addEventListener('abort', aborted, { once: true });
            if (!v.seeking)
                afterPaint();
        });
    }
    waitForLoad(v) {
        return new Promise((resolve, reject) => {
            if (this.signal?.aborted) {
                reject(new MediaForgeError('Aborted', 'ABORT'));
                return;
            }
            let settled = false;
            const finish = (fn) => {
                if (settled)
                    return;
                settled = true;
                cleanup();
                fn();
            };
            const timer = setTimeout(() => finish(() => reject(new MediaForgeError(`Media element load timeout (${Math.round(this.loadTimeoutMs / 1000)}s)`, 'DECODE'))), this.loadTimeoutMs);
            const loaded = () => finish(resolve);
            const failed = () => finish(() => reject(new MediaForgeError('Failed to load video', 'DECODE')));
            const aborted = () => finish(() => reject(new MediaForgeError('Aborted', 'ABORT')));
            const cleanup = () => {
                clearTimeout(timer);
                v.removeEventListener('loadeddata', loaded);
                v.removeEventListener('error', failed);
                this.signal?.removeEventListener('abort', aborted);
            };
            v.addEventListener('loadeddata', loaded, { once: true });
            v.addEventListener('error', failed, { once: true });
            this.signal?.addEventListener('abort', aborted, { once: true });
            if (v.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA)
                finish(resolve);
            else
                v.load();
        });
    }
    async decodeAudioBuffer(input) {
        this.throwIfAborted();
        const ctx = new AudioContext();
        try {
            const encoded = await awaitWithAbort(input.arrayBuffer(), this.signal);
            return await awaitWithAbort(ctx.decodeAudioData(encoded), this.signal);
        }
        finally {
            try {
                await ctx.close();
            }
            catch { }
        }
    }
    elementAudioPresence(v) {
        const withTracks = v;
        if (withTracks.audioTracks && Number.isInteger(withTracks.audioTracks.length)) {
            return withTracks.audioTracks.length > 0;
        }
        if (typeof withTracks.mozHasAudio === 'boolean')
            return withTracks.mozHasAudio;
        if ((withTracks.webkitAudioDecodedByteCount ?? 0) > 0)
            return true;
        return null;
    }
    throwIfAborted() {
        if (this.signal?.aborted)
            throw new MediaForgeError('Aborted', 'ABORT');
    }
    isAbort(error) {
        return (this.signal?.aborted ||
            (error instanceof MediaForgeError && error.code === 'ABORT') ||
            (error instanceof DOMException && error.name === 'AbortError'));
    }
}
