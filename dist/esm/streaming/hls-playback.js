import { MediaForgeError } from '../core/errors.js';
import { hlsPlaybackBytes, hlsPlaybackTiming, hlsPlaybackTracks } from './hls-playback-mp4.js';
const activeMedia = new WeakSet();
function invalid(message) {
    throw new MediaForgeError(`HLS playback: ${message}`, 'FORMAT');
}
function mimeType(value, unit) {
    if (value !== undefined)
        return value;
    const codecs = unit.variant?.codecs;
    if (typeof codecs !== 'string' || !codecs.trim() || /["\r\n]/.test(codecs)) {
        invalid('mimeType with codecs is required when variant.codecs is unavailable');
    }
    const tokens = codecs.split(',').map(codec => codec.trim());
    if (tokens.some(codec => !/^(?:avc[13]\.[\da-fA-F]{6}|mp4a\.40\.\d+)$/.test(codec))) {
        invalid('automatic MIME inference supports AVC/AAC only; supply mimeType for other fMP4 codecs');
    }
    return `${tokens.some(codec => codec.startsWith('avc')) ? 'video' : 'audio'}/mp4; codecs="${tokens.join(',')}"`;
}
export async function playHls(media, units, options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options))
        invalid('options must be an object');
    const explicitMime = options.mimeType;
    const { autoplay = true, bufferAhead = 30, bufferBehind = 30, operationTimeoutMs = 30000 } = options;
    const signal = options.signal;
    if (typeof autoplay !== 'boolean')
        invalid('autoplay must be a boolean');
    if (typeof bufferAhead !== 'number' || !Number.isFinite(bufferAhead) || bufferAhead <= 0)
        invalid('bufferAhead must be positive seconds');
    if (typeof bufferBehind !== 'number' || !Number.isFinite(bufferBehind) || bufferBehind < 0)
        invalid('bufferBehind must be non-negative seconds');
    if (typeof operationTimeoutMs !== 'number' ||
        !Number.isFinite(operationTimeoutMs) ||
        operationTimeoutMs <= 0 ||
        operationTimeoutMs > 0x7fffffff) {
        invalid('operationTimeoutMs must be positive and at most 2147483647 milliseconds');
    }
    if (explicitMime !== undefined &&
        (typeof explicitMime !== 'string' ||
            !/^(?:audio|video)\/mp4\s*;\s*codecs\s*=\s*"[^"\r\n]+"\s*$/i.test(explicitMime))) {
        invalid('mimeType must be audio/mp4 or video/mp4 with an explicit codecs parameter');
    }
    if (!media ||
        ['play', 'load', 'getAttribute', 'removeAttribute', 'addEventListener', 'removeEventListener'].some(name => typeof media[name] !== 'function'))
        invalid('an HTMLMediaElement is required');
    if (media.srcObject != null)
        invalid('clear media.srcObject before attaching HLS playback');
    if (signal !== undefined &&
        (!signal || typeof signal.addEventListener !== 'function' || typeof signal.aborted !== 'boolean'))
        invalid('signal must be an AbortSignal');
    if (typeof globalThis.MediaSource !== 'function')
        invalid('MediaSource is unavailable in this environment');
    let failed = false;
    let failure;
    let iterator;
    let iteratorDone = false;
    let mse;
    let sourceBuffer;
    let objectUrl;
    let attached = false;
    let ended = false;
    let eos = false;
    let waitingForData = false;
    const listeners = new Set();
    const waiting = new Set();
    const record = (error) => {
        if (!failed) {
            failed = true;
            failure = error;
            for (const reject of waiting)
                reject(error);
            waiting.clear();
        }
        return failure;
    };
    const check = () => {
        if (!failed && signal?.aborted)
            record(new MediaForgeError('HLS playback aborted', 'ABORT'));
        if (failed)
            throw failure;
    };
    const listen = (target, event, callback) => {
        target.addEventListener(event, callback);
        const remove = () => {
            target.removeEventListener(event, callback);
            listeners.delete(remove);
        };
        listeners.add(remove);
        return remove;
    };
    const wait = async (pending) => {
        let rejectWait = () => undefined;
        const stopped = new Promise((_resolve, reject) => {
            rejectWait = reject;
            if (failed)
                reject(failure);
            else
                waiting.add(reject);
        });
        try {
            const result = await Promise.race([pending, stopped]);
            check();
            return result;
        }
        catch (error) {
            throw record(error);
        }
        finally {
            waiting.delete(rejectWait);
        }
    };
    const event = async (target, names, action, timeout = false) => {
        check();
        let removers = [];
        let timer;
        const pending = new Promise((resolve, reject) => {
            removers = names.map(name => listen(target, name, resolve));
            if (timeout)
                timer = setTimeout(() => reject(new MediaForgeError('HLS playback MSE operation timed out', 'IO')), operationTimeoutMs);
        });
        try {
            action?.();
            await wait(pending);
        }
        finally {
            for (const remove of removers)
                remove();
            if (timer !== undefined)
                clearTimeout(timer);
        }
    };
    const ownAttachment = () => attached && media.srcObject == null && media.getAttribute('src') === objectUrl;
    const skipGap = () => {
        if (failed || !ownAttachment() || media.paused || !sourceBuffer)
            return;
        const ranges = media.buffered;
        const time = media.currentTime;
        const tolerance = waitingForData ? 0.05 : 0.001;
        for (let index = 0; index < ranges.length; index++) {
            const start = ranges.start(index);
            if (start > time + 0.001) {
                if (index === 0 || time >= ranges.end(index - 1) - tolerance)
                    media.currentTime = start;
                return;
            }
            if (time < ranges.end(index) - tolerance)
                return;
        }
    };
    const safeSkipGap = () => {
        try {
            skipGap();
        }
        catch (error) {
            record(error);
        }
    };
    if (activeMedia.has(media))
        throw new MediaForgeError('HLS playback already owns this media element', 'INPUT');
    activeMedia.add(media);
    try {
        check();
        if (signal)
            listen(signal, 'abort', () => record(new MediaForgeError('HLS playback aborted', 'ABORT')));
        const getIterator = units?.[Symbol.asyncIterator];
        if (typeof getIterator !== 'function')
            invalid('units must be an async iterable');
        iterator = getIterator.call(units);
        const next = iterator?.next;
        if (typeof next !== 'function')
            invalid('units must provide an async iterator');
        const pull = async () => {
            check();
            const result = await wait(next.call(iterator));
            if (!result || typeof result !== 'object')
                invalid('invalid async iterator result');
            if (result.done)
                iteratorDone = true;
            return result;
        };
        let result = await pull();
        if (result.done)
            invalid('the stream contains no media units');
        let tracks;
        let previousDiscontinuity;
        let previousMap;
        let currentMime;
        let timelineEnd = 0;
        let timestampOffset = 0;
        let started = false;
        let randomAccess = [];
        const trim = async (retain) => {
            check();
            const currentTime = media.currentTime;
            const ranges = sourceBuffer.buffered;
            const first = ranges.length ? ranges.start(0) : Infinity;
            randomAccess = randomAccess.filter(time => time >= first);
            const target = currentTime - retain;
            let end = 0;
            for (const time of randomAccess)
                if (time <= target && time < currentTime)
                    end = Math.max(end, time);
            if (!ranges.length || end <= first || end >= currentTime)
                return false;
            await event(sourceBuffer, ['updateend'], () => sourceBuffer.remove(0, end), true);
            randomAccess = randomAccess.filter(time => time >= end);
            return true;
        };
        const append = async (data) => {
            try {
                await event(sourceBuffer, ['updateend'], () => sourceBuffer.appendBuffer(data), true);
            }
            catch (error) {
                if (!(error instanceof DOMException) || error.name !== 'QuotaExceededError')
                    throw error;
                if (!(await trim(0)))
                    throw error;
                await event(sourceBuffer, ['updateend'], () => sourceBuffer.appendBuffer(data), true);
            }
        };
        while (!result.done) {
            check();
            const unit = result.value;
            if (!unit || (unit.type !== 'part' && unit.type !== 'segment'))
                invalid('invalid HLS media unit');
            const entry = unit.type === 'part' ? unit.part : unit.segment;
            const discontinuity = unit.type === 'part' ? unit.discontinuitySequence : unit.segment.discontinuitySequence;
            if (!entry ||
                !Number.isFinite(entry.duration) ||
                entry.duration <= 0 ||
                !Number.isSafeInteger(discontinuity) ||
                discontinuity < 0) {
                invalid('media units require a positive duration and non-negative discontinuity sequence');
            }
            const map = entry.map;
            const mapKey = map
                ? `${map.uri}\n${map.byteRange?.offset ?? ''}\n${map.byteRange?.length ?? ''}`
                : undefined;
            const init = unit.initData === undefined ? undefined : hlsPlaybackBytes(unit.initData);
            if (init)
                tracks = hlsPlaybackTracks(init);
            if (!tracks || (mapKey !== previousMap && !init))
                invalid('fMP4 playback requires initData from EXT-X-MAP, including each changed map');
            const bytes = hlsPlaybackBytes(unit.data);
            const timing = hlsPlaybackTiming(bytes, tracks);
            const mime = mimeType(explicitMime, unit);
            if (!MediaSource.isTypeSupported(mime))
                invalid(`unsupported MSE MIME type: ${mime}`);
            if (!mse) {
                mse = new MediaSource();
                listen(media, 'error', () => record(media.error ?? new MediaForgeError('HLS media element failed', 'DECODE')));
                listen(media, 'ended', () => {
                    if (eos)
                        ended = true;
                });
                listen(mse, 'sourceclose', () => record(new MediaForgeError('HLS MediaSource was detached', 'ABORT')));
                listen(media, 'waiting', () => {
                    waitingForData = true;
                    safeSkipGap();
                });
                listen(media, 'playing', () => {
                    waitingForData = false;
                });
                for (const name of ['timeupdate', 'play', 'seeking', 'progress'])
                    listen(media, name, safeSkipGap);
                objectUrl = URL.createObjectURL(mse);
                await event(mse, ['sourceopen'], () => {
                    attached = true;
                    media.src = objectUrl;
                }, true);
                check();
                sourceBuffer = mse.addSourceBuffer(mime);
                sourceBuffer.mode = 'segments';
                listen(sourceBuffer, 'error', () => record(new MediaForgeError('HLS SourceBuffer append failed', 'DECODE')));
                listen(sourceBuffer, 'abort', () => record(new MediaForgeError('HLS SourceBuffer operation aborted', 'ABORT')));
                currentMime = mime;
            }
            else if (mime !== currentMime) {
                if (!init)
                    invalid('codec changes require new initData');
                if (typeof sourceBuffer.changeType !== 'function')
                    invalid('this browser cannot change HLS codecs during playback');
                sourceBuffer.changeType(mime);
                currentMime = mime;
            }
            if (previousDiscontinuity === undefined || discontinuity !== previousDiscontinuity) {
                timestampOffset = timelineEnd - timing.start || 0;
                sourceBuffer.timestampOffset = timestampOffset;
            }
            await trim(bufferBehind);
            if (init)
                await append(init);
            await append(bytes);
            timelineEnd = Math.max(timelineEnd, timing.end + timestampOffset);
            randomAccess.push(...timing.randomAccess.map(time => time + timestampOffset));
            previousDiscontinuity = discontinuity;
            previousMap = mapKey;
            safeSkipGap();
            if (!started) {
                started = true;
                if (autoplay) {
                    const playing = media.play();
                    void Promise.resolve(playing).catch(record);
                }
            }
            check();
            const ahead = () => {
                const ranges = sourceBuffer.buffered;
                let seconds = 0;
                for (let index = 0; index < ranges.length; index++)
                    seconds += Math.max(0, ranges.end(index) - Math.max(media.currentTime, ranges.start(index)));
                return seconds;
            };
            while (ahead() >= bufferAhead) {
                await event(media, ['timeupdate', 'seeking', 'play', 'progress']);
                await trim(bufferBehind);
            }
            result = await pull();
        }
        check();
        eos = true;
        mse.endOfStream();
        if (!ended && !media.ended)
            await event(media, ['ended']);
        check();
    }
    catch (error) {
        throw record(error);
    }
    finally {
        for (const remove of [...listeners]) {
            try {
                remove();
            }
            catch { }
        }
        if (iterator && !iteratorDone) {
            iteratorDone = true;
            try {
                void Promise.resolve(iterator.return?.()).catch(() => undefined);
            }
            catch { }
        }
        if (sourceBuffer && mse?.readyState === 'open' && sourceBuffer.updating) {
            try {
                sourceBuffer.abort();
            }
            catch { }
        }
        if (sourceBuffer && mse && mse.readyState !== 'closed') {
            try {
                mse.removeSourceBuffer(sourceBuffer);
            }
            catch { }
        }
        try {
            if (ownAttachment()) {
                try {
                    media.removeAttribute('src');
                }
                catch { }
                try {
                    media.load();
                }
                catch { }
            }
        }
        catch { }
        if (objectUrl) {
            try {
                URL.revokeObjectURL(objectUrl);
            }
            catch { }
        }
        activeMedia.delete(media);
    }
}
