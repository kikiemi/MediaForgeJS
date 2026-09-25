import { DemuxError, MediaForgeError } from '../core/errors.js';
import { linkAbortSignals } from '../core/abort.js';
import { CodecLifetime } from '../core/codec-lifetime.js';
import { oggCrc32 } from '../core/ogg-crc.js';
import { BlobSource } from '../io/sources.js';
import { ChunkReader } from '../io/chunk-reader.js';
import { opusPacketFrames } from '../core/opus-packet.js';
export { opusPacketFrames } from '../core/opus-packet.js';
function startsWith(bytes, text) {
    if (bytes.length < text.length)
        return false;
    for (let index = 0; index < text.length; index++) {
        if (bytes[index] !== text.charCodeAt(index))
            return false;
    }
    return true;
}
function u32le(bytes, offset) {
    return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}
export async function readOggPage(reader, offset) {
    if (offset + 27 > reader.size)
        throw new DemuxError(`Ogg page header at ${offset} is truncated`);
    const header = await reader.bytes(offset, 27);
    if (!startsWith(header, 'OggS') || header[4] !== 0) {
        throw new DemuxError(`Invalid Ogg page header at ${offset}`);
    }
    const flags = header[5];
    if ((flags & 0xf8) !== 0)
        throw new DemuxError('Ogg page sets reserved header flags');
    const segmentCount = header[26];
    const lacing = await reader.bytes(offset + 27, segmentCount);
    let payloadBytes = 0;
    for (const length of lacing)
        payloadBytes += length;
    const pageBytes = 27 + segmentCount + payloadBytes;
    if (offset + pageBytes > reader.size)
        throw new DemuxError('Ogg page body is truncated');
    const encoded = (await reader.bytes(offset, pageBytes)).slice();
    const declaredCrc = u32le(encoded, 22);
    encoded[22] = 0;
    encoded[23] = 0;
    encoded[24] = 0;
    encoded[25] = 0;
    if (oggCrc32(encoded) !== declaredCrc)
        throw new DemuxError('Ogg page CRC mismatch');
    const lo = u32le(header, 6);
    const hi = u32le(header, 10);
    const granule = lo === 0xffffffff && hi === 0xffffffff ? null : hi * 0x100000000 + lo;
    if (granule !== null && !Number.isSafeInteger(granule)) {
        throw new DemuxError('Ogg granule position exceeds the exact integer range');
    }
    return {
        nextOffset: offset + pageBytes,
        flags,
        serial: u32le(header, 14),
        sequence: u32le(header, 18),
        granule,
        lacing,
        payload: encoded.subarray(27 + segmentCount),
    };
}
async function scanOpus(reader, signal) {
    const states = new Map();
    const sequences = new Map();
    let selected = null;
    let channels = 0;
    let preSkip = 0;
    let totalPacketFrames = 0;
    let finalGranule = -1;
    let audioPackets = 0;
    let sawEos = false;
    let previousGranule = 0;
    let offset = 0;
    let pages = 0;
    while (offset < reader.size) {
        signal?.throwIfAborted();
        const page = await readOggPage(reader, offset);
        if (selected === page.serial && sawEos) {
            throw new DemuxError('Ogg Opus contains data after its EOS page');
        }
        const previousSequence = sequences.get(page.serial);
        if (previousSequence !== undefined && page.sequence !== previousSequence + 1) {
            throw new DemuxError(`Ogg page sequence jumps ${previousSequence} -> ${page.sequence}`);
        }
        sequences.set(page.serial, page.sequence);
        let state = states.get(page.serial);
        if (!state) {
            if ((page.flags & 0x02) === 0)
                throw new DemuxError('Ogg logical stream has no BOS page');
            if (states.size >= 64)
                throw new DemuxError('Ogg contains too many logical streams');
            state = { index: 0, size: 0, open: false, ignored: false, capture: [] };
            states.set(page.serial, state);
        }
        const continued = (page.flags & 0x01) !== 0;
        if (continued !== state.open) {
            throw new DemuxError(`Ogg packet continuation flag is inconsistent in stream ${page.serial}`);
        }
        let bodyOffset = 0;
        let pageAudioFrames = 0;
        for (const lace of page.lacing) {
            const captureLimit = state.index === 0 ? 65536 : 16;
            if (!state.ignored && state.capture.length < captureLimit) {
                const count = Math.min(lace, captureLimit - state.capture.length);
                for (let index = 0; index < count; index++) {
                    state.capture.push(page.payload[bodyOffset + index]);
                }
            }
            state.size += lace;
            if (state.size > 16 * 1024 * 1024)
                throw new DemuxError('Ogg packet exceeds the 16 MiB safety limit');
            bodyOffset += lace;
            state.open = lace === 255;
            if (state.open)
                continue;
            if (state.index === 0) {
                if (startsWith(state.capture, 'OpusHead')) {
                    if (state.size < 19 || state.capture.length < 19) {
                        throw new DemuxError('Ogg OpusHead is truncated');
                    }
                    if (selected !== null && selected !== page.serial) {
                        throw new DemuxError('Multiple/chained Opus logical streams are not supported');
                    }
                    channels = state.capture[9];
                    preSkip = state.capture[10] | (state.capture[11] << 8);
                    const mappingFamily = state.capture[18];
                    if (channels < 1 || channels > 2 || mappingFamily !== 0)
                        return null;
                    selected = page.serial;
                }
                else {
                    state.ignored = true;
                }
            }
            else if (selected === page.serial && state.index === 1) {
                if (!startsWith(state.capture, 'OpusTags')) {
                    throw new DemuxError('Ogg OpusTags packet is missing');
                }
            }
            else if (selected === page.serial && state.index >= 2) {
                const frames = opusPacketFrames(state.capture, state.size, true);
                totalPacketFrames += frames;
                pageAudioFrames += frames;
                audioPackets++;
            }
            state.index++;
            state.size = 0;
            state.capture = [];
        }
        if (selected === page.serial) {
            if (page.granule !== null) {
                if (page.granule < previousGranule) {
                    throw new DemuxError(`Ogg Opus granule position regresses ${previousGranule} -> ${page.granule}`);
                }
                if (page.granule > totalPacketFrames) {
                    throw new DemuxError('Ogg Opus granule exceeds decoded packet duration');
                }
                if ((page.flags & 0x04) !== 0 && totalPacketFrames - page.granule > pageAudioFrames) {
                    throw new DemuxError('Ogg Opus EOS trims audio before the final page');
                }
                previousGranule = page.granule;
                finalGranule = page.granule;
            }
            if ((page.flags & 0x04) !== 0)
                sawEos = true;
        }
        offset = page.nextOffset;
        if ((++pages & 255) === 0)
            await new Promise(resolve => setTimeout(resolve, 0));
    }
    if (selected === null)
        return null;
    const state = states.get(selected);
    if (state.open || !sawEos)
        throw new DemuxError('Ogg Opus stream is truncated');
    if (state.index < 3 || audioPackets === 0)
        throw new DemuxError('Ogg Opus stream has no audio packets');
    if (finalGranule <= preSkip || finalGranule > totalPacketFrames) {
        throw new DemuxError(`Ogg Opus granule ${finalGranule} is inconsistent with pre-skip ${preSkip} and ${totalPacketFrames} coded samples`);
    }
    return { serial: selected, channels, preSkip, totalPacketFrames, finalGranule, audioPackets };
}
async function* audioPackets(reader, serial, signal) {
    let offset = 0;
    let packetIndex = 0;
    let parts = [];
    let bytes = 0;
    let open = false;
    while (offset < reader.size) {
        signal?.throwIfAborted();
        const page = await readOggPage(reader, offset);
        offset = page.nextOffset;
        if (page.serial !== serial)
            continue;
        if (((page.flags & 0x01) !== 0) !== open) {
            throw new DemuxError('Ogg Opus continuation changed between replay passes');
        }
        let bodyOffset = 0;
        for (const lace of page.lacing) {
            if (lace > 0)
                parts.push(page.payload.slice(bodyOffset, bodyOffset + lace));
            bytes += lace;
            bodyOffset += lace;
            if (bytes > 16 * 1024 * 1024)
                throw new DemuxError('Ogg packet exceeds the 16 MiB safety limit');
            open = lace === 255;
            if (open)
                continue;
            const packet = new Uint8Array(bytes);
            let cursor = 0;
            for (const part of parts) {
                packet.set(part, cursor);
                cursor += part.length;
            }
            if (packetIndex >= 2)
                yield { data: packet, frames: opusPacketFrames(packet, packet.length, true) };
            packetIndex++;
            parts = [];
            bytes = 0;
        }
    }
    if (open)
        throw new DemuxError('Ogg Opus final packet is truncated');
}
function nativeFailure(error) {
    if (error instanceof MediaForgeError || (error instanceof DOMException && error.name === 'AbortError'))
        return error;
    return new MediaForgeError(`bounded Ogg Opus decode failed: ${error instanceof Error ? error.message : String(error)}`, 'DECODE');
}
export async function createRawOggOpusPcmSource(file, signal) {
    const factoryLifetime = new CodecLifetime(signal);
    try {
        factoryLifetime.check();
        if (typeof AudioDecoder === 'undefined')
            return null;
        const scanReader = new ChunkReader(new BlobSource(file));
        const scan = await factoryLifetime.waitFor(scanOpus(scanReader, signal));
        if (!scan)
            return null;
        const config = {
            codec: 'opus',
            sampleRate: 48000,
            numberOfChannels: scan.channels,
        };
        const probe = async () => {
            try {
                return await AudioDecoder.isConfigSupported(config);
            }
            catch (error) {
                if ((error instanceof MediaForgeError && error.code !== 'DECODE') ||
                    (error instanceof DOMException && error.name === 'AbortError')) {
                    throw factoryLifetime.record(error);
                }
                return null;
            }
        };
        const support = await factoryLifetime.waitFor(probe());
        if (support?.supported === false)
            return null;
        const estimatedFrames = scan.finalGranule - scan.preSkip;
        const tailFrames = scan.totalPacketFrames - scan.finalGranule;
        return {
            sampleRate: 48000,
            channels: scan.channels,
            estimatedFrames,
            async *chunks(replaySignal) {
                const linked = linkAbortSignals(signal, replaySignal);
                const lifetime = new CodecLifetime(linked.signal);
                const decoded = [];
                let decoder = null;
                let iterator = null;
                let remainingHead = scan.preSkip;
                let emittedFrames = 0;
                let postHeadFrames = 0;
                let packet = 0;
                let timestampFrames = 0;
                const callNative = (action) => {
                    lifetime.check();
                    try {
                        return action();
                    }
                    catch (error) {
                        throw lifetime.record(nativeFailure(error));
                    }
                };
                const waitNative = (action) => lifetime.waitFor(Promise.resolve(callNative(action)).catch(error => {
                    throw nativeFailure(error);
                }));
                const queue = (planes) => {
                    const frames = planes[0]?.length ?? 0;
                    const drop = Math.min(remainingHead, frames);
                    remainingHead -= drop;
                    if (drop === frames)
                        return [];
                    const available = frames - drop;
                    postHeadFrames += available;
                    const count = Math.min(available, estimatedFrames - emittedFrames);
                    if (count <= 0)
                        return [];
                    const ready = planes.map(plane => plane.subarray(drop, drop + count));
                    emittedFrames += count;
                    return [ready];
                };
                const drain = () => {
                    const ready = [];
                    for (const planes of decoded)
                        ready.push(...queue(planes));
                    decoded.length = 0;
                    return ready;
                };
                try {
                    lifetime.check();
                    const reader = new ChunkReader(new BlobSource(file));
                    decoder = callNative(() => new AudioDecoder({
                        output: (audioData) => {
                            try {
                                if (!lifetime.acceptingOutput)
                                    return;
                                if (audioData.sampleRate !== 48000 ||
                                    audioData.numberOfChannels !== scan.channels) {
                                    throw new MediaForgeError('Opus decoder changed the declared audio shape', 'DECODE');
                                }
                                const planes = [];
                                for (let channel = 0; channel < scan.channels; channel++) {
                                    const plane = new Float32Array(audioData.numberOfFrames);
                                    audioData.copyTo(plane, { planeIndex: channel, format: 'f32-planar' });
                                    planes.push(plane);
                                }
                                lifetime.check();
                                decoded.push(planes);
                            }
                            catch (error) {
                                lifetime.record(nativeFailure(error));
                            }
                            finally {
                                try {
                                    audioData.close();
                                }
                                catch (error) {
                                    lifetime.record(nativeFailure(error));
                                }
                            }
                        },
                        error: (error) => {
                            lifetime.record(nativeFailure(error));
                        },
                    }));
                    const activeDecoder = decoder;
                    const checkDecoder = () => {
                        lifetime.check();
                        if (activeDecoder.state === 'closed') {
                            throw lifetime.record(new MediaForgeError('Opus decoder closed before replay completed', 'DECODE'));
                        }
                    };
                    callNative(() => activeDecoder.configure(config));
                    iterator = audioPackets(reader, scan.serial, linked.signal)[Symbol.asyncIterator]();
                    while (true) {
                        checkDecoder();
                        const next = await lifetime.waitFor(iterator.next());
                        if (next.done)
                            break;
                        const unit = next.value;
                        const encoded = callNative(() => new EncodedAudioChunk({
                            type: 'key',
                            timestamp: Math.round((timestampFrames / 48000) * 1e6),
                            duration: Math.round((unit.frames / 48000) * 1e6),
                            data: unit.data,
                        }));
                        callNative(() => activeDecoder.decode(encoded));
                        checkDecoder();
                        timestampFrames += unit.frames;
                        packet++;
                        if ((packet & 7) === 0) {
                            await waitNative(() => activeDecoder.flush());
                            checkDecoder();
                            for (const planes of drain()) {
                                lifetime.check();
                                yield planes;
                            }
                            await lifetime.waitFor(new Promise(resolve => setTimeout(resolve, 0)));
                        }
                    }
                    await waitNative(() => activeDecoder.flush());
                    checkDecoder();
                    for (const planes of drain()) {
                        lifetime.check();
                        yield planes;
                    }
                    lifetime.check();
                    if (packet !== scan.audioPackets ||
                        remainingHead !== 0 ||
                        emittedFrames !== estimatedFrames ||
                        postHeadFrames - emittedFrames !== tailFrames) {
                        throw new MediaForgeError(`Ogg Opus replay produced ${emittedFrames}/${estimatedFrames} valid samples`, 'DECODE');
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
                    if (iterator?.return) {
                        try {
                            void Promise.resolve(iterator.return()).catch(() => undefined);
                        }
                        catch { }
                    }
                }
            },
        };
    }
    catch (error) {
        throw factoryLifetime.record(error);
    }
    finally {
        factoryLifetime.stop();
    }
}
