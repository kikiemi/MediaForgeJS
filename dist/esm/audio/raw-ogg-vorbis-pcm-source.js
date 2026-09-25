import { DemuxError, MediaForgeError } from '../core/errors.js';
import { linkAbortSignals } from '../core/abort.js';
import { CodecLifetime } from '../core/codec-lifetime.js';
import { BlobSource } from '../io/sources.js';
import { ChunkReader } from '../io/chunk-reader.js';
import { readOggPage } from './raw-ogg-opus-pcm-source.js';
import { yieldToEventLoop } from './audio-buffer-tools.js';
import { vorbisModes, vorbisPacketBlock } from '../demux/vorbis-headers.js';
function signature(bytes, packetType) {
    if (bytes.length < 7 || bytes[0] !== packetType)
        return false;
    const text = 'vorbis';
    for (let index = 0; index < text.length; index++) {
        if (bytes[index + 1] !== text.charCodeAt(index))
            return false;
    }
    return true;
}
function u32le(bytes, offset) {
    return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}
function xiphDescription(headers) {
    const lacing = [];
    let payloadBytes = 0;
    for (const header of headers) {
        let remaining = header.length;
        while (remaining >= 255) {
            lacing.push(255);
            remaining -= 255;
        }
        lacing.push(remaining);
        payloadBytes += header.length;
    }
    if (lacing.length > 255)
        throw new DemuxError('Vorbis headers exceed the Xiph extradata lacing limit');
    const out = new Uint8Array(1 + lacing.length + payloadBytes);
    out[0] = lacing.length;
    out.set(lacing, 1);
    let offset = 1 + lacing.length;
    for (const header of headers) {
        out.set(header, offset);
        offset += header.length;
    }
    return out;
}
function legacyXiphDescription(headers) {
    const lacing = [];
    for (const header of headers.slice(0, 2)) {
        let remaining = header.length;
        while (remaining >= 255) {
            lacing.push(255);
            remaining -= 255;
        }
        lacing.push(remaining);
    }
    const payloadBytes = headers.reduce((sum, header) => sum + header.length, 0);
    const out = new Uint8Array(1 + lacing.length + payloadBytes);
    out[0] = headers.length - 1;
    out.set(lacing, 1);
    let offset = 1 + lacing.length;
    for (const header of headers) {
        out.set(header, offset);
        offset += header.length;
    }
    return out;
}
function combine(parts, bytes) {
    const packet = new Uint8Array(bytes);
    let offset = 0;
    for (const part of parts) {
        packet.set(part, offset);
        offset += part.length;
    }
    return packet;
}
async function scanVorbis(reader, signal) {
    const states = new Map();
    const sequences = new Map();
    let selected = null;
    let headers = [];
    let sampleRate = 0;
    let channels = 0;
    let finalGranule = -1;
    let audioPackets = 0;
    let sawEos = false;
    let offset = 0;
    let pages = 0;
    let modes = [];
    let smallBlock = 0;
    let largeBlock = 0;
    let previousBlock = 0;
    let decodedFrames = 0;
    let firstOverlap = 0;
    let origin;
    while (offset < reader.size) {
        signal?.throwIfAborted();
        const page = await readOggPage(reader, offset);
        offset = page.nextOffset;
        const previous = sequences.get(page.serial);
        if (previous !== undefined && page.sequence !== previous + 1) {
            throw new DemuxError(`Ogg page sequence jumps ${previous} -> ${page.sequence}`);
        }
        sequences.set(page.serial, page.sequence);
        let state = states.get(page.serial);
        if (!state) {
            if ((page.flags & 0x02) === 0)
                throw new DemuxError('Ogg logical stream has no BOS page');
            if (states.size >= 64)
                throw new DemuxError('Ogg contains too many logical streams');
            state = { index: 0, size: 0, open: false, ignored: false, parts: [] };
            states.set(page.serial, state);
        }
        if (((page.flags & 0x01) !== 0) !== state.open) {
            throw new DemuxError('Ogg Vorbis packet continuation flag is inconsistent');
        }
        const packetsBeforePage = audioPackets;
        let bodyOffset = 0;
        for (const lace of page.lacing) {
            const capture = !state.ignored && (state.index === 0 || selected === page.serial);
            if (capture && lace > 0) {
                const captureBytes = state.index < 3 ? lace : Math.min(lace, Math.max(0, 2 - state.size));
                if (captureBytes)
                    state.parts.push(page.payload.slice(bodyOffset, bodyOffset + captureBytes));
            }
            state.size += lace;
            bodyOffset += lace;
            if (state.size > 4 * 1024 * 1024)
                throw new DemuxError('Vorbis header exceeds the 4 MiB safety limit');
            state.open = lace === 255;
            if (state.open)
                continue;
            if (state.index === 0) {
                const packet = combine(state.parts, state.size);
                if (signature(packet, 1)) {
                    if (selected !== null && selected !== page.serial) {
                        throw new DemuxError('Multiple/chained Vorbis logical streams are not supported');
                    }
                    if (packet.length < 30 || u32le(packet, 7) !== 0 || (packet[29] & 1) === 0) {
                        throw new DemuxError('Vorbis identification header is invalid');
                    }
                    channels = packet[11];
                    sampleRate = u32le(packet, 12);
                    const block = packet[28];
                    smallBlock = 1 << (block & 0x0f);
                    largeBlock = 1 << (block >> 4);
                    if (channels < 1 ||
                        channels > 8 ||
                        sampleRate < 1 ||
                        smallBlock < 64 ||
                        largeBlock < smallBlock ||
                        largeBlock > 8192) {
                        throw new DemuxError('Vorbis identification header declares an invalid audio shape');
                    }
                    selected = page.serial;
                    headers = [packet];
                }
                else {
                    state.ignored = true;
                }
            }
            else if (selected === page.serial && state.index < 3) {
                const packet = combine(state.parts, state.size);
                const expectedType = state.index === 1 ? 3 : 5;
                if (!signature(packet, expectedType)) {
                    throw new DemuxError(`Vorbis header packet ${state.index} is invalid`);
                }
                headers.push(packet);
                if (state.index === 2)
                    modes = vorbisModes(packet, channels);
            }
            else if (selected === page.serial && state.index >= 3) {
                if (state.size === 0) {
                    if (page.flags !== 4 ||
                        page.lacing.length !== 1 ||
                        audioPackets === 0 ||
                        page.granule !== finalGranule)
                        throw new DemuxError('Vorbis audio packet is empty');
                }
                else {
                    const block = vorbisPacketBlock(combine(state.parts, Math.min(state.size, 2)), modes, smallBlock, largeBlock);
                    if (previousBlock) {
                        const frames = (previousBlock + block) / 4;
                        if (audioPackets === 1)
                            firstOverlap = frames;
                        decodedFrames += frames;
                    }
                    previousBlock = block;
                    audioPackets++;
                }
            }
            state.index++;
            state.size = 0;
            state.parts = [];
        }
        if (selected === page.serial) {
            if (origin === undefined &&
                audioPackets > packetsBeforePage &&
                page.granule !== null &&
                (audioPackets >= 2 || page.granule > 0)) {
                origin = (page.flags & 4) === 0 ? page.granule - decodedFrames : 0;
                if (origin < -firstOverlap)
                    throw new DemuxError('Initial Vorbis granule trims beyond the first overlap-add span');
            }
            if (page.granule !== null)
                finalGranule = page.granule;
            if ((page.flags & 0x04) !== 0)
                sawEos = true;
        }
        if ((++pages & 255) === 0)
            await new Promise(resolve => setTimeout(resolve, 0));
    }
    if (selected === null)
        return null;
    const state = states.get(selected);
    if (state.open || !sawEos)
        throw new DemuxError('Ogg Vorbis stream is truncated');
    if (headers.length !== 3 || state.index < 4 || audioPackets === 0 || finalGranule <= 0) {
        throw new DemuxError('Ogg Vorbis stream has incomplete headers or audio');
    }
    return {
        serial: selected,
        sampleRate,
        channels,
        description: xiphDescription(headers),
        legacyDescription: legacyXiphDescription(headers),
        finalGranule: finalGranule - Math.max(0, origin ?? 0),
        leadingTrim: Math.max(0, -(origin ?? 0)),
        audioPackets,
    };
}
async function* vorbisPackets(reader, serial, signal) {
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
            throw new DemuxError('Ogg Vorbis continuation changed between replay passes');
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
            if (packetIndex >= 3 && bytes > 0)
                yield combine(parts, bytes);
            packetIndex++;
            parts = [];
            bytes = 0;
        }
    }
    if (open)
        throw new DemuxError('Ogg Vorbis final packet is truncated');
}
function nativeFailure(error) {
    if (error instanceof MediaForgeError || (error instanceof DOMException && error.name === 'AbortError'))
        return error;
    return new MediaForgeError(`bounded Ogg Vorbis decode failed: ${error instanceof Error ? error.message : String(error)}`, 'DECODE');
}
async function probeVorbisConfig(file, scan, description, signal) {
    const lifetime = new CodecLifetime(signal);
    let decoder = null;
    let iterator = null;
    const config = {
        codec: 'vorbis',
        sampleRate: scan.sampleRate,
        numberOfChannels: scan.channels,
        description,
    };
    const callNative = (action) => {
        lifetime.check();
        try {
            return action();
        }
        catch (error) {
            throw lifetime.record(nativeFailure(error));
        }
    };
    try {
        lifetime.check();
        const supported = await lifetime.waitFor(AudioDecoder.isConfigSupported(config));
        if (supported?.supported === false)
            return null;
        iterator = vorbisPackets(new ChunkReader(new BlobSource(file)), scan.serial, signal)[Symbol.asyncIterator]();
        const first = await lifetime.waitFor(iterator.next());
        if (first.done)
            return null;
        decoder = callNative(() => new AudioDecoder({
            output: (data) => {
                try {
                    data.close();
                }
                catch (error) {
                    lifetime.record(nativeFailure(error));
                }
            },
            error: (error) => {
                lifetime.record(nativeFailure(error));
            },
        }));
        const activeDecoder = decoder;
        callNative(() => activeDecoder.configure(config));
        const encoded = callNative(() => new EncodedAudioChunk({ type: 'key', timestamp: 0, data: first.value }));
        callNative(() => activeDecoder.decode(encoded));
        await lifetime.waitFor(Promise.resolve(callNative(() => activeDecoder.flush())).catch(error => {
            throw nativeFailure(error);
        }));
        return config;
    }
    catch (error) {
        const failure = lifetime.record(error);
        if ((failure instanceof MediaForgeError && failure.code !== 'DECODE') ||
            (failure instanceof DOMException && failure.name === 'AbortError'))
            throw failure;
        return null;
    }
    finally {
        lifetime.stop();
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
}
export async function createRawOggVorbisPcmSource(file, signal) {
    const factoryLifetime = new CodecLifetime(signal);
    try {
        factoryLifetime.check();
        if (typeof AudioDecoder === 'undefined')
            return null;
        const scan = await factoryLifetime.waitFor(scanVorbis(new ChunkReader(new BlobSource(file)), signal));
        if (!scan)
            return null;
        factoryLifetime.stop();
        const config = (await probeVorbisConfig(file, scan, scan.description, signal)) ??
            (await probeVorbisConfig(file, scan, scan.legacyDescription, signal));
        if (signal?.aborted)
            throw new MediaForgeError('Aborted', 'ABORT');
        if (!config)
            return null;
        return {
            sampleRate: scan.sampleRate,
            channels: scan.channels,
            estimatedFrames: scan.finalGranule,
            async *chunks(replaySignal) {
                const linked = linkAbortSignals(signal, replaySignal);
                const lifetime = new CodecLifetime(linked.signal);
                const decoded = [];
                let decoder = null;
                let iterator = null;
                let emittedFrames = 0;
                let trimRemaining = scan.leadingTrim;
                let packets = 0;
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
                const drain = () => {
                    const ready = [];
                    for (const planes of decoded) {
                        if (emittedFrames >= scan.finalGranule)
                            break;
                        const available = planes[0]?.length ?? 0;
                        const skip = Math.min(available, trimRemaining);
                        trimRemaining -= skip;
                        const count = Math.min(available - skip, scan.finalGranule - emittedFrames);
                        if (count > 0) {
                            ready.push(skip === 0 && count === available
                                ? planes
                                : planes.map(plane => plane.subarray(skip, skip + count)));
                            emittedFrames += count;
                        }
                    }
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
                                if (audioData.sampleRate !== scan.sampleRate ||
                                    audioData.numberOfChannels !== scan.channels) {
                                    throw new MediaForgeError('Vorbis decoder changed the declared audio shape', 'DECODE');
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
                            throw lifetime.record(new MediaForgeError('Vorbis decoder closed before replay completed', 'DECODE'));
                        }
                    };
                    callNative(() => activeDecoder.configure(config));
                    iterator = vorbisPackets(reader, scan.serial, linked.signal)[Symbol.asyncIterator]();
                    while (true) {
                        checkDecoder();
                        const next = await lifetime.waitFor(iterator.next());
                        if (next.done)
                            break;
                        const encoded = callNative(() => new EncodedAudioChunk({
                            type: 'key',
                            timestamp: packets,
                            data: next.value,
                        }));
                        callNative(() => activeDecoder.decode(encoded));
                        checkDecoder();
                        packets++;
                        if ((packets & 7) === 0) {
                            while (activeDecoder.decodeQueueSize > 0) {
                                checkDecoder();
                                await lifetime.waitFor(yieldToEventLoop());
                            }
                            await lifetime.waitFor(yieldToEventLoop());
                            checkDecoder();
                            for (const planes of drain()) {
                                lifetime.check();
                                yield planes;
                            }
                        }
                    }
                    await waitNative(() => activeDecoder.flush());
                    checkDecoder();
                    for (const planes of drain()) {
                        lifetime.check();
                        yield planes;
                    }
                    lifetime.check();
                    if (packets !== scan.audioPackets || emittedFrames !== scan.finalGranule) {
                        throw new MediaForgeError(`Ogg Vorbis replay produced ${emittedFrames}/${scan.finalGranule} samples`, 'DECODE');
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
