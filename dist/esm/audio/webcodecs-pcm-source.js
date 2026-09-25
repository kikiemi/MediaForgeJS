import { webCodecsAudioCodec } from '../core/codec-strings.js';
import { MediaForgeError } from '../core/errors.js';
import { yieldEventLoop } from '../core/demux-guard.js';
import { linkAbortSignals } from '../core/abort.js';
import { CodecLifetime } from '../core/codec-lifetime.js';
import { sampleAt, sampleCount } from '../demux/sample-index.js';
import { opusPacketFrames } from '../core/opus-packet.js';
function decoderConfig(track) {
    const config = {
        codec: webCodecsAudioCodec(track.codec),
        sampleRate: track.sampleRate || 44100,
        numberOfChannels: track.channelCount || 2,
    };
    if (track.codecConfig) {
        config.description = track.codecConfig;
        if (track.codec === 'opus' &&
            track.codecConfig.length >= 19 &&
            String.fromCharCode(...track.codecConfig.subarray(0, 8)) === 'OpusHead') {
            const description = track.codecConfig.slice();
            description[10] = 0;
            description[11] = 0;
            config.description = description;
        }
    }
    return config;
}
function medianTimestampStep(track) {
    const available = Math.max(0, sampleCount(track) - 1);
    const count = Math.min(4096, available);
    const steps = [];
    for (let slot = 0; slot < count; slot++) {
        const index = 1 + Math.floor((slot * available) / count);
        const step = sampleAt(track, index).timestamp - sampleAt(track, index - 1).timestamp;
        if (Number.isFinite(step) && step > 0)
            steps.push(step);
    }
    if (steps.length === 0)
        return 0;
    steps.sort((a, b) => a - b);
    return steps[Math.floor(steps.length / 2)];
}
function codedSampleDuration(track, index, nominal, exact) {
    if (exact !== undefined)
        return exact;
    const sample = sampleAt(track, index);
    const next = sampleAt(track, index + 1);
    const step = next ? next.timestamp - sample.timestamp : 0;
    const foldedGap = nominal > 0 && step > nominal * 4 + 0.02 && sample.duration >= step - 0.002;
    return foldedGap ? nominal : Math.max(0, sample.duration || nominal);
}
async function presentationShape(track, readSample, lifetime) {
    const rate = track.sampleRate || 44100;
    const count = sampleCount(track);
    const first = sampleAt(track, 0)?.timestamp ?? 0;
    const last = sampleAt(track, count - 1);
    const nominal = medianTimestampStep(track);
    let codedSeconds = 0;
    let timelineFrames = 0;
    let previousDuration = 0;
    let finalCodedSeconds = last?.duration ?? nominal;
    for (let index = 0; index < count; index++) {
        lifetime.check();
        const sample = sampleAt(track, index);
        let exact;
        if (track.codec === 'opus') {
            const packet = sample.data ?? (await lifetime.waitFor(readSample(sample, index)));
            exact = opusPacketFrames(packet, packet.length) / 48000;
        }
        const duration = codedSampleDuration(track, index, nominal, exact);
        codedSeconds += duration;
        const gap = index > 0 ? sample.timestamp - sampleAt(track, index - 1).timestamp - previousDuration : 0;
        timelineFrames += Math.round(duration * rate) + (gap > 0.02 ? Math.round(gap * rate) : 0);
        previousDuration = duration;
        if (index === count - 1)
            finalCodedSeconds = duration;
        if ((index & 255) === 255)
            await lifetime.waitFor(yieldEventLoop());
    }
    const end = last ? last.timestamp + finalCodedSeconds : first;
    const spanSeconds = Math.max(0, end - first);
    const gapSeconds = Math.max(0, spanSeconds - codedSeconds);
    const maxGap = Math.max(3, codedSeconds * 4);
    if (gapSeconds > maxGap) {
        throw new MediaForgeError(`audio timeline is implausibly sparse: ${codedSeconds.toFixed(2)} s of coded audio spread over ${spanSeconds.toFixed(1)} s`, 'FORMAT');
    }
    const opusPreSkip = track.codec === 'opus' &&
        track.codecConfig &&
        track.codecConfig.length >= 19 &&
        String.fromCharCode(...track.codecConfig.subarray(0, 8)) === 'OpusHead'
        ? (track.codecConfig[10] | (track.codecConfig[11] << 8)) / 48000
        : 0;
    const codecDelay = track.codec === 'opus' ? Math.max(0, track.matroskaCodecDelaySeconds ?? opusPreSkip) : 0;
    const skipSeconds = codecDelay +
        Math.max(0, track.editMediaTimeSeconds ??
            (track.audioPrimingSamples
                ? track.audioPrimingSamples / rate
                : track.matroskaCodecDelaySeconds
                    ? 0
                    : Math.max(0, -first)));
    const headFrames = Math.max(0, Math.round(skipSeconds * rate));
    const tailFrames = Math.max(0, Math.round(track.audioTrailingPaddingSamples ?? track.opusTrailingPaddingSamples ?? 0));
    const finalCodedFrames = Math.max(0, Math.round(finalCodedSeconds * rate));
    if (tailFrames > finalCodedFrames) {
        throw new MediaForgeError(`audio trailing padding ${tailFrames} exceeds the final coded unit (${finalCodedFrames} samples)`, 'DEMUX');
    }
    if (headFrames + tailFrames > Math.max(1, Math.round(spanSeconds * rate)) + rate) {
        throw new MediaForgeError('audio trim metadata exceeds the coded presentation span', 'DEMUX');
    }
    return {
        estimatedFrames: Math.max(1, track.editPresentationDurationSeconds !== undefined
            ? Math.round(track.editPresentationDurationSeconds * rate)
            : timelineFrames - headFrames - tailFrames),
        headFrames,
        nominalSeconds: nominal,
    };
}
function nativeFailure(error, codec) {
    if (error instanceof MediaForgeError || (error instanceof DOMException && error.name === 'AbortError'))
        return error;
    return new MediaForgeError(`bounded AudioDecoder failed for '${codec}': ${error instanceof Error ? error.message : String(error)}`, 'DECODE');
}
export async function createWebCodecsTrackPcmSource(track, readSample, signal) {
    const factoryLifetime = new CodecLifetime(signal);
    try {
        factoryLifetime.check();
        if (typeof AudioDecoder === 'undefined')
            return null;
        const count = sampleCount(track);
        if (count === 0)
            return null;
        if (!(track.sampleRate > 0) || !(track.channelCount > 0))
            return null;
        if ((track.codecConfigurations?.length ?? 0) > 1)
            return null;
        for (let index = 0; index < count; index++)
            if ((sampleAt(track, index).codecConfigIndex ?? 0) !== 0)
                return null;
        const config = decoderConfig(track);
        const probe = async () => {
            try {
                return await AudioDecoder.isConfigSupported(config);
            }
            catch (error) {
                if ((error instanceof MediaForgeError && error.code !== 'DECODE') ||
                    (error instanceof DOMException && error.name === 'AbortError'))
                    throw error;
                return null;
            }
        };
        const support = await factoryLifetime.waitFor(probe());
        if (support?.supported === false)
            return null;
        const shape = await presentationShape(track, readSample, factoryLifetime);
        factoryLifetime.check();
        return {
            sampleRate: track.sampleRate,
            channels: track.channelCount,
            estimatedFrames: shape.estimatedFrames,
            async *chunks(replaySignal) {
                const linked = linkAbortSignals(signal, replaySignal);
                const lifetime = new CodecLifetime(linked.signal);
                let decoder = null;
                let decodedRate = 0;
                let decodedChannels = 0;
                let remainingHead = shape.headFrames;
                let emittedFrames = 0;
                const decoded = [];
                const callNative = (action) => {
                    lifetime.check();
                    try {
                        return action();
                    }
                    catch (error) {
                        throw lifetime.record(nativeFailure(error, track.codec));
                    }
                };
                const waitNative = (action) => lifetime.waitFor(Promise.resolve(callNative(action)).catch(error => {
                    throw nativeFailure(error, track.codec);
                }));
                const queue = (planes) => {
                    const frames = planes[0]?.length ?? 0;
                    if (frames === 0)
                        return [];
                    const drop = Math.min(remainingHead, frames);
                    remainingHead -= drop;
                    if (drop === frames)
                        return [];
                    const available = frames - drop;
                    const count = Math.min(available, shape.estimatedFrames - emittedFrames);
                    if (count <= 0)
                        return [];
                    const ready = planes.map(plane => plane.subarray(drop, drop + count));
                    emittedFrames += count;
                    return [ready];
                };
                const drainDecoded = () => {
                    const ready = [];
                    for (const planes of decoded)
                        ready.push(...queue(planes));
                    decoded.length = 0;
                    return ready;
                };
                try {
                    decoder = callNative(() => new AudioDecoder({
                        output: (audioData) => {
                            try {
                                if (!lifetime.acceptingOutput)
                                    return;
                                if (decodedRate !== 0 && decodedRate !== audioData.sampleRate) {
                                    throw new MediaForgeError(`decoded audio sample rate changed (${decodedRate} -> ${audioData.sampleRate})`, 'DECODE');
                                }
                                if (decodedChannels !== 0 && decodedChannels !== audioData.numberOfChannels) {
                                    throw new MediaForgeError(`decoded audio channel count changed (${decodedChannels} -> ${audioData.numberOfChannels})`, 'DECODE');
                                }
                                decodedRate = audioData.sampleRate;
                                decodedChannels = audioData.numberOfChannels;
                                if (decodedRate !== track.sampleRate ||
                                    decodedChannels !== track.channelCount) {
                                    throw new MediaForgeError(`decoder returned ${decodedRate}Hz/${decodedChannels}ch; track declares ${track.sampleRate}Hz/${track.channelCount}ch`, 'DECODE');
                                }
                                const planes = [];
                                for (let channel = 0; channel < decodedChannels; channel++) {
                                    const plane = new Float32Array(audioData.numberOfFrames);
                                    audioData.copyTo(plane, { planeIndex: channel, format: 'f32-planar' });
                                    planes.push(plane);
                                }
                                lifetime.check();
                                decoded.push(planes);
                            }
                            catch (error) {
                                lifetime.record(nativeFailure(error, track.codec));
                            }
                            finally {
                                try {
                                    audioData.close();
                                }
                                catch (error) {
                                    lifetime.record(nativeFailure(error, track.codec));
                                }
                            }
                        },
                        error: (error) => {
                            lifetime.record(nativeFailure(error, track.codec));
                        },
                    }));
                    const activeDecoder = decoder;
                    const checkDecoder = () => {
                        lifetime.check();
                        if (activeDecoder.state === 'closed') {
                            throw lifetime.record(new MediaForgeError('AudioDecoder closed before decoding completed', 'DECODE'));
                        }
                    };
                    callNative(() => activeDecoder.configure(config));
                    let previousTimestamp = 0;
                    let previousCodedSeconds = 0;
                    for (let start = 0; start < count; start += 8) {
                        checkDecoder();
                        const end = Math.min(count, start + 8);
                        for (let index = start; index < end; index++) {
                            checkDecoder();
                            const sample = sampleAt(track, index);
                            const data = sample.data ?? (await lifetime.waitFor(readSample(sample, index)));
                            checkDecoder();
                            const exact = track.codec === 'opus' ? opusPacketFrames(data, data.length) / 48000 : undefined;
                            const codedSeconds = codedSampleDuration(track, index, shape.nominalSeconds, exact);
                            const gapSeconds = index === 0 ? 0 : sample.timestamp - previousTimestamp - previousCodedSeconds;
                            const gap = gapSeconds > 0.02 ? Math.round(gapSeconds * track.sampleRate) : 0;
                            if (gap > 0) {
                                await waitNative(() => activeDecoder.flush());
                                checkDecoder();
                                for (const planes of drainDecoded()) {
                                    lifetime.check();
                                    yield planes;
                                }
                                let remaining = gap;
                                while (remaining > 0) {
                                    lifetime.check();
                                    const count = Math.min(remaining, 16384);
                                    for (const planes of queue(Array.from({ length: track.channelCount }, () => new Float32Array(count)))) {
                                        lifetime.check();
                                        yield planes;
                                    }
                                    remaining -= count;
                                }
                            }
                            callNative(() => activeDecoder.decode(new EncodedAudioChunk({
                                type: 'key',
                                timestamp: Math.round(sample.timestamp * 1e6),
                                duration: Math.max(0, Math.round(codedSeconds * 1e6)),
                                data,
                            })));
                            checkDecoder();
                            previousTimestamp = sample.timestamp;
                            previousCodedSeconds = codedSeconds;
                        }
                        await waitNative(() => activeDecoder.flush());
                        checkDecoder();
                        for (const planes of drainDecoded()) {
                            lifetime.check();
                            yield planes;
                        }
                        await lifetime.waitFor(yieldEventLoop());
                    }
                    lifetime.check();
                    if (remainingHead !== 0 || emittedFrames !== shape.estimatedFrames) {
                        throw new MediaForgeError(`AudioDecoder produced ${emittedFrames}/${shape.estimatedFrames} valid PCM samples`, 'DECODE');
                    }
                }
                catch (error) {
                    throw lifetime.record(error);
                }
                finally {
                    lifetime.stop();
                    linked.dispose();
                    decoded.length = 0;
                    if (decoder && decoder.state !== 'closed') {
                        try {
                            decoder.close();
                        }
                        catch { }
                    }
                }
            },
        };
    }
    finally {
        factoryLifetime.stop();
    }
}
