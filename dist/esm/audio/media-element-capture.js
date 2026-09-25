import { MediaForgeError } from '../core/errors.js';
import { logger } from '../core/logger.js';
import { awaitWithAbort } from '../core/abort.js';
export async function captureViaMediaElement(file, preferredRate, allowAcceleration, callbacks = {}) {
    const throwIfAborted = () => {
        if (callbacks.signal?.aborted)
            throw new MediaForgeError('Aborted', 'ABORT');
    };
    throwIfAborted();
    const audio = document.createElement('audio');
    let url = null;
    const waitForLoaded = () => new Promise((resolve, reject) => {
        if (callbacks.signal?.aborted) {
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
        const onOk = () => finish(resolve);
        const onErr = () => finish(() => reject(new MediaForgeError('media element load failed', 'DECODE')));
        const onAbort = () => finish(() => reject(new MediaForgeError('Aborted', 'ABORT')));
        const timer = setTimeout(() => finish(() => reject(new MediaForgeError(`media element load timeout (${Math.round((callbacks.loadTimeoutMs ?? 15000) / 1000)}s)`, 'DECODE'))), callbacks.loadTimeoutMs ?? 15000);
        const cleanup = () => {
            clearTimeout(timer);
            audio.removeEventListener('loadeddata', onOk);
            audio.removeEventListener('error', onErr);
            callbacks.signal?.removeEventListener('abort', onAbort);
        };
        audio.addEventListener('loadeddata', onOk, { once: true });
        audio.addEventListener('error', onErr, { once: true });
        callbacks.signal?.addEventListener('abort', onAbort, { once: true });
        try {
            if (audio.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA)
                finish(resolve);
            else
                audio.load();
        }
        catch (error) {
            finish(() => reject(error));
        }
    });
    let ctx = null;
    let captureComplete = false;
    const hooks = {
        cleanup: null,
        flushAck: null,
        flushSend: null,
    };
    let timeoutHandle;
    let progressTimer;
    let flushTimeoutHandle;
    let cleanupEnded;
    let cleanupPlaying;
    try {
        throwIfAborted();
        url = URL.createObjectURL(file);
        audio.preload = 'auto';
        audio.setAttribute('playsinline', 'true');
        audio.src = url;
        if (audio.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
            await waitForLoaded();
        }
        throwIfAborted();
        const mediaSeconds = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
        let requestedSpeed = 1;
        if (allowAcceleration &&
            typeof AudioWorkletNode !== 'undefined' &&
            'preservesPitch' in audio &&
            mediaSeconds >= 1) {
            requestedSpeed = 2;
        }
        const doubledRate = preferredRate * 2;
        if (requestedSpeed > 1 && doubledRate <= 96000) {
            try {
                ctx = new AudioContext({ sampleRate: doubledRate });
            }
            catch {
                requestedSpeed = 1;
            }
        }
        if (!ctx) {
            requestedSpeed = 1;
            ctx = new AudioContext({ sampleRate: preferredRate });
        }
        const graph = ctx;
        const source = graph.createMediaElementSource(audio);
        const silentGain = graph.createGain();
        silentGain.gain.value = 0;
        const captured = [];
        let totalFrames = 0;
        let capturing = false;
        const collectChunk = (planes, copy) => {
            if (!capturing || planes.length === 0 || planes[0].length === 0)
                return;
            totalFrames += planes[0].length;
            captured.push(copy ? planes.map(p => new Float32Array(p)) : planes);
        };
        const attachWorkletCapture = async () => {
            const workletCode = `
                class MediaForgeJSCaptureProcessor extends AudioWorkletProcessor {
                    constructor() {
                        super();
                        this.batch = null;
                        this.fill = 0;
                        this.size = 8192;
                        this.port.onmessage = (e) => {
                            if (e.data === 'flush') { this.flush(); this.port.postMessage('flushed'); }
                        };
                    }
                    flush() {
                        if (!this.batch || this.fill === 0) return;
                        const out = this.batch.map((ch) => ch.subarray(0, this.fill).slice());
                        this.port.postMessage(out, out.map((ch) => ch.buffer));
                        this.fill = 0;
                    }
                    process(inputs, outputs) {
                        const input = inputs[0];
                        const output = outputs[0];
                        if (input && input.length) {
                            if (!this.batch || this.batch.length !== input.length) {
                                this.flush();
                                this.batch = input.map(() => new Float32Array(this.size));
                            }
                            const len = input[0].length;
                            if (this.fill + len > this.size) this.flush();
                            for (let ch = 0; ch < input.length; ch++) {
                                this.batch[ch].set(input[ch], this.fill);
                            }
                            this.fill += len;
                            for (let ch = 0; ch < output.length; ch++) {
                                if (input[ch]) output[ch].set(input[ch]);
                            }
                        }
                        return true;
                    }
                }
                registerProcessor('mediaforgejs-capture-processor', MediaForgeJSCaptureProcessor);
            `;
            const blobUrl = URL.createObjectURL(new Blob([workletCode], { type: 'application/javascript' }));
            try {
                await awaitWithAbort(graph.audioWorklet.addModule(blobUrl), callbacks.signal);
            }
            finally {
                URL.revokeObjectURL(blobUrl);
            }
            const node = new AudioWorkletNode(graph, 'mediaforgejs-capture-processor', {
                numberOfInputs: 1,
                numberOfOutputs: 1,
                outputChannelCount: [2],
            });
            node.port.onmessage = (event) => {
                if (event.data === 'flushed') {
                    hooks.flushAck?.();
                    return;
                }
                collectChunk(event.data, false);
            };
            hooks.flushSend = () => node.port.postMessage('flush');
            let cleaned = false;
            hooks.cleanup = () => {
                if (cleaned)
                    return;
                cleaned = true;
                node.port.onmessage = null;
                try {
                    source.disconnect(node);
                }
                catch { }
                try {
                    node.disconnect();
                }
                catch { }
            };
            source.connect(node);
            node.connect(silentGain);
        };
        const attachScriptProcessorCapture = () => {
            const processor = graph.createScriptProcessor(2048, 2, 2);
            processor.onaudioprocess = (event) => {
                const input = event.inputBuffer;
                if (input.numberOfChannels === 0)
                    return;
                const planes = [];
                for (let ch = 0; ch < input.numberOfChannels; ch++) {
                    planes.push(input.getChannelData(ch));
                }
                collectChunk(planes, true);
            };
            let cleaned = false;
            hooks.cleanup = () => {
                if (cleaned)
                    return;
                cleaned = true;
                processor.onaudioprocess = null;
                try {
                    source.disconnect(processor);
                }
                catch { }
                try {
                    processor.disconnect();
                }
                catch { }
            };
            source.connect(processor);
            processor.connect(silentGain);
        };
        let workletActive = false;
        try {
            if (typeof AudioWorkletNode !== 'undefined' && graph.audioWorklet) {
                await attachWorkletCapture();
                workletActive = true;
            }
            else {
                attachScriptProcessorCapture();
            }
        }
        catch (workletErr) {
            try {
                hooks.cleanup?.();
            }
            catch { }
            hooks.cleanup = null;
            hooks.flushAck = null;
            hooks.flushSend = null;
            throwIfAborted();
            logger.warn('[Converter] audioWorklet capture failed, falling back to ScriptProcessor:', workletErr);
            attachScriptProcessorCapture();
        }
        if (!workletActive)
            requestedSpeed = 1;
        silentGain.connect(graph.destination);
        await awaitWithAbort(graph.resume(), callbacks.signal);
        throwIfAborted();
        let endedCtxTime = 0;
        let playingCtxFrame = -1;
        const onPlaying = (e) => {
            if (playingCtxFrame >= 0)
                return;
            const lagSec = Math.max(0, (performance.now() - e.timeStamp) / 1000);
            playingCtxFrame = Math.round((graph.currentTime - lagSec) * graph.sampleRate);
        };
        cleanupPlaying = () => audio.removeEventListener('playing', onPlaying);
        audio.addEventListener('playing', onPlaying, { once: true });
        const captureStartCtxFrame = Math.round(graph.currentTime * graph.sampleRate);
        capturing = true;
        if (requestedSpeed > 1) {
            audio.preservesPitch = false;
            audio.playbackRate = requestedSpeed;
        }
        const wallStartSeconds = graph.currentTime;
        const timeoutMs = mediaSeconds > 0 ? Math.ceil((mediaSeconds / Math.max(1, requestedSpeed)) * 1500) + 15000 : 10 * 60 * 1000;
        let abortListener;
        try {
            await new Promise((resolve, reject) => {
                let settled = false;
                let started = false;
                let ended = false;
                const fail = (error) => {
                    if (settled)
                        return;
                    settled = true;
                    reject(error);
                };
                const finish = () => {
                    if (settled || !started || !ended)
                        return;
                    settled = true;
                    resolve();
                };
                const onEnded = () => {
                    endedCtxTime = graph.currentTime;
                    ended = true;
                    finish();
                };
                const onError = () => fail(new MediaForgeError('media playback failed', 'DECODE'));
                cleanupEnded = () => {
                    audio.removeEventListener('ended', onEnded);
                    audio.removeEventListener('error', onError);
                };
                audio.addEventListener('ended', onEnded, { once: true });
                audio.addEventListener('error', onError, { once: true });
                timeoutHandle = setTimeout(() => fail(new Error(`media decode timeout (${Math.round(timeoutMs / 1000)}s)`)), timeoutMs);
                progressTimer = setInterval(() => {
                    if (settled)
                        return;
                    try {
                        if (mediaSeconds > 0) {
                            const pct = 20 + Math.min(50, Math.round((audio.currentTime / mediaSeconds) * 50));
                            void Promise.resolve(callbacks.onProgress?.(pct, `Decoding audio ${audio.currentTime.toFixed(0)}/${mediaSeconds.toFixed(0)}s`)).catch(fail);
                        }
                    }
                    catch (error) {
                        fail(error);
                    }
                }, 1000);
                abortListener = () => fail(new MediaForgeError('Aborted', 'ABORT'));
                callbacks.signal?.addEventListener('abort', abortListener, { once: true });
                if (callbacks.signal?.aborted) {
                    abortListener();
                    return;
                }
                try {
                    void Promise.resolve(audio.play()).then(() => {
                        started = true;
                        finish();
                    }, fail);
                }
                catch (error) {
                    fail(error);
                }
            });
            throwIfAborted();
        }
        finally {
            if (timeoutHandle !== undefined)
                clearTimeout(timeoutHandle);
            if (progressTimer !== undefined)
                clearInterval(progressTimer);
            if (abortListener)
                callbacks.signal?.removeEventListener('abort', abortListener);
            cleanupEnded?.();
            cleanupEnded = undefined;
        }
        if (workletActive && hooks.flushSend) {
            await awaitWithAbort(new Promise(resolve => {
                hooks.flushAck = resolve;
                hooks.flushSend?.();
                flushTimeoutHandle = setTimeout(resolve, 60);
            }), callbacks.signal);
        }
        else {
            await awaitWithAbort(new Promise(resolve => {
                flushTimeoutHandle = setTimeout(resolve, 30);
            }), callbacks.signal);
        }
        capturing = false;
        hooks.cleanup?.();
        if (totalFrames === 0 || captured.length === 0) {
            throw new Error('media element produced no PCM');
        }
        const wallSeconds = Math.max(1e-3, (endedCtxTime || graph.currentTime) - wallStartSeconds);
        let effectiveSpeed = 1;
        if (requestedSpeed > 1 && mediaSeconds > 0) {
            const raw = mediaSeconds / wallSeconds;
            effectiveSpeed = Math.abs(raw - requestedSpeed) < Math.abs(raw - 1) ? requestedSpeed : 1;
        }
        logger.info(`[Converter] media capture: media=${mediaSeconds.toFixed(3)}s wall=${wallSeconds.toFixed(3)}s requested=${requestedSpeed} effective=${effectiveSpeed} frames=${totalFrames} ctxRate=${graph.sampleRate}`);
        const framesByChannels = new Map();
        for (let index = 0; index < captured.length; index++) {
            const planes = captured[index];
            framesByChannels.set(planes.length, (framesByChannels.get(planes.length) ?? 0) + planes[0].length);
            if ((index & 255) === 255) {
                throwIfAborted();
                await new Promise(resolve => setTimeout(resolve, 0));
                throwIfAborted();
            }
        }
        let channelCount = 1;
        let bestFrames = -1;
        for (const [cc, fr] of framesByChannels) {
            if (fr > bestFrames) {
                bestFrames = fr;
                channelCount = cc;
            }
        }
        const flat = [];
        for (let ch = 0; ch < channelCount; ch++)
            flat.push(new Float32Array(totalFrames));
        let writePos = 0;
        for (let index = 0; index < captured.length; index++) {
            const planes = captured[index];
            const len = planes[0].length;
            for (let ch = 0; ch < channelCount; ch++) {
                flat[ch].set(planes[Math.min(ch, planes.length - 1)], writePos);
            }
            writePos += len;
            if ((index & 255) === 255) {
                throwIfAborted();
                await new Promise(resolve => setTimeout(resolve, 0));
                throwIfAborted();
            }
        }
        const latencyFrames = playingCtxFrame >= 0 ? Math.max(0, Math.min(playingCtxFrame - captureStartCtxFrame, 8192)) : 0;
        let zeroRun = 0;
        const zeroCap = Math.min(totalFrames, latencyFrames);
        outer: for (; zeroRun < zeroCap; zeroRun++) {
            for (let ch = 0; ch < channelCount; ch++) {
                if (flat[ch][zeroRun] !== 0)
                    break outer;
            }
        }
        const lead = zeroRun;
        let frames = totalFrames - lead;
        if (mediaSeconds > 0) {
            frames = Math.min(frames, Math.round((mediaSeconds / effectiveSpeed) * graph.sampleRate));
        }
        frames = Math.max(frames, 1);
        const targetFrames = mediaSeconds > 0 ? Math.max(1, Math.round(mediaSeconds * preferredRate)) : 0;
        if (effectiveSpeed === 1 && graph.sampleRate === preferredRate) {
            const outFrames = targetFrames > 0 ? Math.min(frames, targetFrames) : frames;
            const direct = graph.createBuffer(channelCount, outFrames, preferredRate);
            for (let ch = 0; ch < channelCount; ch++) {
                direct.getChannelData(ch).set(flat[ch].subarray(lead, lead + outFrames));
            }
            captureComplete = true;
            return { buffer: direct, effectiveSpeed, wallSeconds, mediaSeconds };
        }
        const step = graph.sampleRate / (effectiveSpeed * preferredRate);
        let outFrames = Math.max(1, Math.floor((frames - 1) / step) + 1);
        if (targetFrames > 0)
            outFrames = Math.min(outFrames, targetFrames);
        const outBuf = new AudioBuffer({
            numberOfChannels: channelCount,
            length: outFrames,
            sampleRate: preferredRate,
        });
        for (let ch = 0; ch < channelCount; ch++) {
            const inp = flat[ch];
            const out = outBuf.getChannelData(ch);
            for (let n = 0; n < outFrames; n++) {
                if (n > 0 && (n & 0x3ffff) === 0) {
                    throwIfAborted();
                    await new Promise(resolve => setTimeout(resolve, 0));
                    throwIfAborted();
                }
                const pos = lead + n * step;
                const i = Math.floor(pos);
                const t = pos - i;
                const p0 = inp[i - 1] ?? inp[i];
                const p1 = inp[i] ?? 0;
                const p2 = inp[i + 1] ?? p1;
                const p3 = inp[i + 2] ?? p2;
                out[n] = p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
            }
        }
        captureComplete = true;
        return { buffer: outBuf, effectiveSpeed, wallSeconds, mediaSeconds };
    }
    finally {
        if (flushTimeoutHandle !== undefined)
            clearTimeout(flushTimeoutHandle);
        cleanupEnded?.();
        cleanupPlaying?.();
        try {
            hooks.cleanup?.();
        }
        catch { }
        try {
            audio.pause();
        }
        catch { }
        try {
            audio.removeAttribute('src');
        }
        catch { }
        try {
            audio.load();
        }
        catch { }
        if (url)
            URL.revokeObjectURL(url);
        if (ctx) {
            let closing;
            try {
                closing = ctx.close();
            }
            catch { }
            if (closing) {
                const settled = closing.catch(() => undefined);
                if (captureComplete) {
                    await awaitWithAbort(settled, callbacks.signal);
                    throwIfAborted();
                }
            }
        }
    }
}
