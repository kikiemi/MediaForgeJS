import { CodecLifetime } from '../core/codec-lifetime.js';
import { EncodeError, MediaForgeError } from '../core/errors.js';
import { mp4aAudioObjectType } from '../core/codec-strings.js';
import { buildAacAsc, readAacAudioObjectType } from './adts.js';
import { encodeAudioBufferWithEncoder, yieldToEventLoop } from './audio-buffer-tools.js';
export async function tryEncodeBufferedAac(buffer, bitrate, codec, signal) {
    const lifetime = new CodecLifetime(signal, new EncodeError('AAC native encoder stopped'));
    const frames = [];
    const requestedObjectType = mp4aAudioObjectType(codec);
    let encoder = null;
    let asc = null;
    let fallbackFailure = null;
    const recordNative = (caught) => {
        const accepting = lifetime.acceptingOutput;
        const error = caught instanceof MediaForgeError || (caught instanceof DOMException && caught.name === 'AbortError')
            ? caught
            : new EncodeError(caught instanceof Error ? caught.message : String(caught));
        const first = lifetime.record(error);
        if (accepting && first === error)
            fallbackFailure = error;
        return first;
    };
    try {
        lifetime.check();
        if (typeof AudioEncoder === 'undefined')
            return null;
        try {
            encoder = new AudioEncoder({
                output: (chunk, metadata) => {
                    if (!lifetime.acceptingOutput)
                        return;
                    try {
                        const description = metadata?.decoderConfig?.description;
                        if (description) {
                            const view = ArrayBuffer.isView(description)
                                ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength)
                                : new Uint8Array(description);
                            const nextAsc = asc ? view : new Uint8Array(view);
                            const actualObjectType = readAacAudioObjectType(nextAsc);
                            if (requestedObjectType !== null && actualObjectType !== requestedObjectType) {
                                throw recordNative(new EncodeError(`AudioEncoder returned AAC object type ${actualObjectType ?? 'unknown'} for requested '${codec}'`));
                            }
                            if (!asc)
                                asc = nextAsc;
                        }
                        if (requestedObjectType !== null && requestedObjectType !== 2 && !asc) {
                            throw recordNative(new EncodeError(`AudioEncoder did not provide AudioSpecificConfig for '${codec}'`));
                        }
                        const data = new Uint8Array(chunk.byteLength);
                        chunk.copyTo(data);
                        lifetime.check();
                        frames.push(data);
                    }
                    catch (error) {
                        lifetime.record(error);
                    }
                },
                error: recordNative,
            });
            lifetime.check();
            encoder.configure({
                codec,
                sampleRate: buffer.sampleRate,
                numberOfChannels: buffer.numberOfChannels,
                bitrate,
            });
            lifetime.check();
        }
        catch (error) {
            throw recordNative(error);
        }
        await lifetime.waitFor(yieldToEventLoop());
        await encodeAudioBufferWithEncoder(buffer, 1024, async (audioData) => {
            lifetime.check();
            while (encoder.encodeQueueSize > 8) {
                if (encoder.state === 'closed')
                    throw recordNative(new EncodeError('AAC native encoder closed'));
                await lifetime.waitFor(yieldToEventLoop());
            }
            lifetime.check();
            try {
                encoder.encode(audioData);
            }
            catch (error) {
                throw recordNative(error);
            }
            lifetime.check();
        });
        lifetime.check();
        try {
            await lifetime.waitFor(encoder.flush().catch(error => {
                throw recordNative(error);
            }));
        }
        catch (error) {
            throw recordNative(error);
        }
        lifetime.check();
        if (frames.length === 0)
            return null;
        return {
            frames,
            asc: asc ?? buildAacAsc(buffer.sampleRate, buffer.numberOfChannels),
            sampleRate: buffer.sampleRate,
            channels: buffer.numberOfChannels,
        };
    }
    catch (caught) {
        const error = lifetime.record(caught);
        if (frames.length === 0 &&
            error instanceof MediaForgeError &&
            (error.code === 'ENCODE' || error.code === 'DECODE') &&
            error === fallbackFailure)
            return null;
        throw error;
    }
    finally {
        lifetime.stop();
        if (encoder && encoder.state !== 'closed') {
            try {
                encoder.close();
            }
            catch { }
        }
    }
}
