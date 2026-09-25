import { MediaForgeError } from '../core/errors.js';
import { linkAbortSignals } from '../core/abort.js';
import { CodecLifetime } from '../core/codec-lifetime.js';
import { assertSink } from '../io/sink-backpressure.js';
import { OGGMuxer } from '../mux/ogg-muxer.js';
import { InterleavedPcmQueue } from './streaming-pcm.js';
import { yieldToEventLoop } from './audio-buffer-tools.js';
function decoderDescriptionBytes(description) {
    if (ArrayBuffer.isView(description)) {
        return new Uint8Array(description.buffer, description.byteOffset, description.byteLength).slice();
    }
    return new Uint8Array(description).slice();
}
const typedArrayPrototype = Object.getPrototypeOf(Float32Array.prototype);
const typedArrayTag = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag).get;
const typedArrayLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'length').get;
const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer').get;
const typedArrayOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset').get;
const typedArrayValues = typedArrayPrototype.values;
function pcmPlanes(value, channels) {
    if (!Array.isArray(value) || value.length !== channels) {
        throw new MediaForgeError('PCM replay changed channel count during Opus encoding', 'ENCODE');
    }
    const planes = [];
    try {
        for (const plane of value) {
            if (typedArrayTag.call(plane) !== 'Float32Array')
                throw new TypeError('not Float32 PCM');
            typedArrayValues.call(plane);
            const frames = typedArrayLength.call(plane);
            if (planes.length && planes[0].length !== frames)
                throw new TypeError('uneven PCM planes');
            planes.push(new Float32Array(typedArrayBuffer.call(plane), typedArrayOffset.call(plane), frames));
        }
    }
    catch {
        throw new MediaForgeError('PCM replay must return attached, equally sized Float32Array planes', 'ENCODE');
    }
    return planes;
}
export async function encodeReplayableOpusToSink(source, sink, options = {}) {
    assertSink(sink);
    const stop = new AbortController();
    const linked = linkAbortSignals(options.signal, sink.signal, stop.signal);
    const lifetime = new CodecLifetime(linked.signal);
    let encoder;
    let iterator;
    let inputDone = false;
    const invoke = (action) => {
        lifetime.check();
        try {
            return action();
        }
        catch (error) {
            throw lifetime.record(error);
        }
    };
    const perform = (action) => {
        const value = invoke(action);
        lifetime.check();
        return value;
    };
    const waitFor = (action) => lifetime.waitFor(invoke(action));
    try {
        lifetime.check();
        const sampleRate = source?.sampleRate;
        const channels = source?.channels;
        const estimatedFrames = source?.estimatedFrames;
        const chunks = source?.chunks;
        const bitrate = options.bitrateBps ?? 128000;
        if (sampleRate !== 48000) {
            throw new MediaForgeError(`streaming Opus source must be 48000 Hz (got ${sampleRate})`, 'ENCODE');
        }
        if (!Number.isInteger(channels) || channels < 1 || channels > 2) {
            throw new MediaForgeError('streaming Opus encoder supports mono/stereo only', 'ENCODE');
        }
        if (!Number.isSafeInteger(estimatedFrames) || estimatedFrames < 0 || typeof chunks !== 'function') {
            throw new MediaForgeError('streaming Opus requires a replayable source with a non-negative safe frame estimate', 'ENCODE');
        }
        if (!Number.isSafeInteger(bitrate) || bitrate <= 0) {
            throw new MediaForgeError('Opus bitrate must be a positive safe integer in bits per second', 'ENCODE');
        }
        if (typeof AudioEncoder === 'undefined' || typeof AudioData === 'undefined') {
            throw new MediaForgeError('Opus sink output requires WebCodecs AudioEncoder', 'ENCODE');
        }
        const config = {
            codec: 'opus',
            sampleRate: 48000,
            numberOfChannels: channels,
            bitrate,
        };
        const probe = Promise.resolve()
            .then(() => {
            lifetime.check();
            try {
                return AudioEncoder.isConfigSupported?.(config);
            }
            catch (error) {
                if (error instanceof MediaForgeError)
                    throw lifetime.record(error);
                return undefined;
            }
        })
            .catch(error => {
            if (error instanceof MediaForgeError)
                throw lifetime.record(error);
            return undefined;
        });
        const supported = await lifetime.waitFor(probe);
        if (supported?.supported === false) {
            throw new MediaForgeError('This browser does not support WebCodecs Opus encoding', 'ENCODE');
        }
        const muxer = new OGGMuxer({
            oggCommentPayload: options.commentPayload,
            format: 'ogg',
            mode: 'standard',
            maxFragmentDuration: 2,
            autoSync: true,
            audio: { id: 1, type: 'audio', codec: 'opus', sampleRate: 48000, channelCount: channels },
        }, {
            write: bytes => perform(() => sink.write(bytes)),
            close: () => waitFor(() => sink.close()),
        });
        let packets = 0;
        encoder = new AudioEncoder({
            output: (chunk, metadata) => {
                if (!lifetime.acceptingOutput)
                    return;
                try {
                    const description = metadata?.decoderConfig?.description;
                    if (description)
                        perform(() => muxer.setCodecConfig(decoderDescriptionBytes(description)));
                    const data = new Uint8Array(chunk.byteLength);
                    perform(() => chunk.copyTo(data));
                    perform(() => muxer.addAudioChunk({
                        data,
                        timestamp: chunk.timestamp / 1e6,
                        duration: (chunk.duration ?? 0) / 1e6,
                        isKeyframe: true,
                        trackType: 'audio',
                    }));
                    packets++;
                }
                catch (error) {
                    lifetime.record(error);
                }
            },
            error: error => {
                lifetime.record(error);
            },
        });
        lifetime.check();
        perform(() => encoder.configure(config));
        const queue = new InterleavedPcmQueue(channels);
        let inputFrames = 0;
        let encodedFrames = 0;
        const encodeFrames = async (frames) => {
            try {
                lifetime.check();
                const interleaved = queue.takeFrames(frames);
                const audioData = new AudioData({
                    format: 'f32',
                    sampleRate: 48000,
                    numberOfFrames: frames,
                    numberOfChannels: channels,
                    timestamp: Math.round((encodedFrames / 48000) * 1e6),
                    data: interleaved.buffer,
                });
                try {
                    perform(() => encoder.encode(audioData));
                }
                finally {
                    audioData.close();
                }
                lifetime.check();
                encodedFrames += frames;
                while (encoder.encodeQueueSize > 8) {
                    await waitFor(() => yieldToEventLoop());
                }
            }
            catch (error) {
                throw lifetime.record(error);
            }
        };
        const iterable = perform(() => chunks.call(source, linked.signal));
        if (!iterable || typeof iterable[Symbol.asyncIterator] !== 'function') {
            throw new MediaForgeError('PCM replay must provide an async iterable', 'ENCODE');
        }
        iterator = iterable[Symbol.asyncIterator]();
        if (!iterator || typeof iterator.next !== 'function') {
            throw new MediaForgeError('PCM replay must provide an async iterator', 'ENCODE');
        }
        while (true) {
            const result = await waitFor(() => iterator.next());
            if (!result || typeof result !== 'object') {
                throw new MediaForgeError('PCM replay returned an invalid iterator result', 'ENCODE');
            }
            if (result.done) {
                inputDone = true;
                break;
            }
            const planes = perform(() => pcmPlanes(result.value, channels));
            const frames = planes[0].length;
            if (frames > Number.MAX_SAFE_INTEGER - inputFrames) {
                throw new MediaForgeError('Opus input frame count exceeds safe integer range', 'ENCODE');
            }
            queue.pushPlanar(planes);
            inputFrames += frames;
            while (queue.bufferedFrames >= 960)
                await encodeFrames(960);
            await waitFor(() => Promise.resolve(sink.drain?.()));
            perform(() => options.onProgress?.(Math.max(0, Math.min(0.98, inputFrames / Math.max(1, estimatedFrames))), `Encoding Opus ${inputFrames}/${estimatedFrames}`));
        }
        if (queue.bufferedFrames > 0)
            await encodeFrames(queue.bufferedFrames);
        await waitFor(() => encoder.flush());
        if (encodedFrames !== inputFrames || inputFrames <= 0 || packets === 0) {
            throw new MediaForgeError(`Opus encoded ${encodedFrames}/${inputFrames} PCM frames in ${packets} packets`, 'ENCODE');
        }
        perform(() => muxer.setValidSamples(inputFrames));
        perform(() => options.onProgress?.(1, 'Finalizing output...'));
        await waitFor(() => muxer.finalize());
        return { inputFrames, packets, peakPcmFrames: queue.peakBufferedFrames };
    }
    catch (error) {
        throw lifetime.record(error);
    }
    finally {
        lifetime.stop();
        if (encoder && encoder.state !== 'closed') {
            try {
                encoder.close();
            }
            catch { }
        }
        stop.abort();
        linked.dispose();
        if (iterator && !inputDone) {
            try {
                void Promise.resolve(iterator.return?.()).catch(() => undefined);
            }
            catch { }
        }
    }
}
