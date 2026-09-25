import { assertSink, drainSink } from '../io/sink-backpressure.js';
import { linkAbortSignals } from '../core/abort.js';
import { assertSourceBytes } from '../io/source-read.js';
import { encodeEventMessage } from '../metadata/emsg.js';
import { fullBox, u32, join, integer, cmafAssert, buildCmafInit } from './cmaf-boxes.js';
import { validateMP4TrackMetadata } from '../core/mp4-metadata.js';
const MAX_U64 = 0xffffffffffffffffn;
const byteLengthOf = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength').get;
function byteCount(data) {
    let count;
    try {
        count = byteLengthOf.call(data);
    }
    catch {
        cmafAssert(false, 'sample/configuration bytes must be Uint8Array');
    }
    assertSourceBytes(data, count, 'fMP4');
    return count;
}
function timestamp(value, label = 'decode timestamp') {
    if (typeof value === 'number')
        integer(value, label, 0, Number.MAX_SAFE_INTEGER);
    cmafAssert(typeof value === 'bigint' || typeof value === 'number', `${label} must be bigint or number`);
    const result = BigInt(value);
    cmafAssert(result >= 0n && result <= MAX_U64, `${label} is outside the unsigned 64-bit range`);
    return result;
}
function secondsToTicks(seconds, scale, label) {
    cmafAssert(Number.isFinite(seconds), `${label} must be finite`);
    return integer(Math.round(seconds * scale), label, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
}
function validatePayload(track, data) {
    const kind = track.codec.split('.')[0];
    if (['avc1', 'avc3', 'hvc1', 'hev1'].includes(kind)) {
        const width = (track.codecConfig[kind.startsWith('avc') ? 4 : 21] & 3) + 1;
        let offset = 0;
        while (offset < data.length) {
            cmafAssert(offset + width <= data.length, 'truncated length-prefixed NAL sample');
            let size = 0;
            for (let index = 0; index < width; index++)
                size = size * 256 + data[offset++];
            cmafAssert(size > 0 && size <= data.length - offset, 'samples must use the configured NAL length prefix, not Annex B');
            offset += size;
        }
    }
    else if (kind === 'mp4a') {
        cmafAssert(data.length < 2 || data[0] !== 0xff || (data[1] & 0xf6) !== 0xf0, 'AAC samples must be raw access units, not ADTS');
    }
    else if (kind === 'wvtt') {
        let offset = 0;
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        while (offset < data.length) {
            cmafAssert(offset + 8 <= data.length, 'truncated WebVTT sample box');
            const size = view.getUint32(offset);
            const type = String.fromCharCode(...data.subarray(offset + 4, offset + 8));
            cmafAssert(size >= 8 && size <= data.length - offset && ['vttc', 'vtte', 'vtta'].includes(type), 'wvtt samples must contain MP4 WebVTT cue boxes');
            offset += size;
        }
    }
}
export class CmafWriter {
    states = new Map();
    init;
    maxBytes;
    maxSamples;
    maxEvents;
    events = [];
    eventBytes = 0;
    bytes = 0;
    samples = 0;
    sequence;
    writing = false;
    failure;
    failed = false;
    constructor(options) {
        cmafAssert(options && typeof options === 'object', 'invalid writer options');
        const { tracks, title, maxBufferedBytes, maxBufferedSamples, maxBufferedEvents, sequenceNumber } = options;
        cmafAssert(Array.isArray(tracks) && tracks.length > 0 && tracks.length <= 256, 'provide between 1 and 256 tracks');
        this.maxBytes = integer(maxBufferedBytes ?? 16 * 1024 * 1024, 'maxBufferedBytes', 1, 0x7f000000);
        this.maxSamples = integer(maxBufferedSamples ?? 100_000, 'maxBufferedSamples', 1, 1_000_000);
        this.maxEvents = integer(maxBufferedEvents ?? 1000, 'maxBufferedEvents', 0, 100_000);
        this.sequence = integer(sequenceNumber ?? 1, 'sequenceNumber', 1);
        for (const source of tracks.slice()) {
            cmafAssert(source && typeof source === 'object', 'invalid track configuration');
            const { id, type, codec, timescale, width, height, pixelAspectRatioNum, pixelAspectRatioDen, sampleRate, channelCount, codecConfig, language, default: defaultTrack, forced, commentary, name, title: trackTitle, namespace, schemaLocation, auxiliaryMimeTypes, } = source;
            integer(id, 'track ID', 1, 0xfffffffe);
            integer(timescale, 'timescale', 1);
            cmafAssert(['video', 'audio', 'subtitle'].includes(type), 'invalid track type');
            cmafAssert(typeof codec === 'string' && codec.length > 0, 'missing track codec');
            cmafAssert(!this.states.has(id), `duplicate track ID ${id}`);
            cmafAssert(codecConfig === undefined || byteCount(codecConfig) <= 1024 * 1024, 'decoder configuration must be at most 1 MiB');
            const track = {
                id,
                type,
                codec,
                timescale,
                width,
                height,
                pixelAspectRatioNum,
                pixelAspectRatioDen,
                sampleRate,
                channelCount,
                codecConfig: codecConfig === undefined ? undefined : new Uint8Array(codecConfig),
                language,
                default: defaultTrack,
                forced,
                commentary,
                name,
                title: trackTitle,
                namespace,
                schemaLocation,
                auxiliaryMimeTypes,
            };
            validateMP4TrackMetadata(track);
            this.states.set(track.id, { track, samples: [] });
        }
        this.init = buildCmafInit([...this.states.values()].map(state => state.track), title);
    }
    get bufferedBytes() {
        return this.bytes + this.eventBytes;
    }
    get bufferedSamples() {
        return this.samples;
    }
    get bufferedEvents() {
        return this.events.length;
    }
    createInitSegment() {
        this.assertReady();
        return this.init.slice();
    }
    async writeInitSegment(sink, signal) {
        this.assertReady();
        assertSink(sink);
        const linked = linkAbortSignals(signal, sink.signal);
        let started = false;
        let acquired = false;
        try {
            this.assertReady();
            this.writing = true;
            acquired = true;
            linked.signal.throwIfAborted();
            const data = this.init.slice();
            started = true;
            sink.write(data);
            await drainSink(sink, linked.signal);
            linked.signal.throwIfAborted();
        }
        catch (error) {
            if (started) {
                this.failed = true;
                this.failure = error;
            }
            throw error;
        }
        finally {
            linked.dispose();
            if (acquired)
                this.writing = false;
        }
    }
    addEvent(event) {
        this.assertReady();
        cmafAssert(event && typeof event === 'object', 'invalid event message');
        const { version, schemeIdUri, value, timescale, eventDuration, id, messageData } = event;
        const time = version === 0
            ? { version, presentationTimeDelta: event.presentationTimeDelta }
            : version === 1
                ? { version, presentationTime: event.presentationTime }
                : undefined;
        this.assertReady();
        cmafAssert(time, 'unsupported emsg version');
        const length = byteCount(messageData);
        const remaining = this.maxBytes - this.bufferedBytes;
        cmafAssert(this.events.length < this.maxEvents && length <= remaining, 'event buffer limit exceeded; flush the current fragment before adding this event');
        cmafAssert(typeof schemeIdUri === 'string' && typeof value === 'string', 'invalid emsg strings');
        cmafAssert(30 + (version === 1 ? 4 : 0) + schemeIdUri.length + value.length + length <= remaining, 'event buffer limit exceeded; flush the current fragment before adding this event');
        const encoded = encodeEventMessage({
            ...time,
            schemeIdUri,
            value,
            timescale,
            eventDuration,
            id,
            messageData: new Uint8Array(messageData),
        });
        cmafAssert(encoded.length <= remaining, 'event buffer limit exceeded; flush the current fragment before adding this event');
        this.events.push(encoded);
        this.eventBytes += encoded.length;
    }
    addChunk(trackId, chunk) {
        this.assertReady();
        cmafAssert(chunk.alphaData === undefined, 'VP8/VP9 alpha side data requires Matroska output');
        const { data, trackType, timestamp: pts, decodeTimestamp, compositionTimeOffset, duration, isKeyframe } = chunk;
        const state = this.getTrack(trackId);
        cmafAssert(trackType === state.track.type, 'chunk type does not match track');
        const scale = state.track.timescale;
        const dts = decodeTimestamp ?? pts;
        const ptsUnits = secondsToTicks(pts, scale, 'presentation timestamp');
        const dtsUnits = secondsToTicks(dts, scale, 'decode timestamp');
        const cto = compositionTimeOffset === undefined
            ? ptsUnits - dtsUnits
            : secondsToTicks(compositionTimeOffset, scale, 'composition offset');
        cmafAssert(compositionTimeOffset === undefined || Math.abs(ptsUnits - dtsUnits - cto) <= 1, 'composition offset disagrees with presentation timestamp');
        this.addSample({
            trackId,
            data,
            decodeTimestamp: dtsUnits,
            duration: secondsToTicks(duration, scale, 'duration'),
            compositionTimeOffset: cto,
            isKeyframe,
        });
    }
    addSample(sample) {
        this.assertReady();
        const { trackId, data, decodeTimestamp, duration: rawDuration, compositionTimeOffset, isKeyframe } = sample;
        const state = this.getTrack(trackId);
        const dts = timestamp(decodeTimestamp);
        const duration = integer(rawDuration, 'duration', 1);
        const cto = integer(compositionTimeOffset ?? 0, 'composition offset', -0x80000000, 0xffffffff);
        cmafAssert(!(cto < 0 && state.largeOffsets) && !(cto > 0x7fffffff && state.negativeOffsets), 'flush before mixing negative and large unsigned composition offsets');
        cmafAssert(typeof isKeyframe === 'boolean', 'isKeyframe must be boolean');
        const length = byteCount(data);
        cmafAssert(length > 0, 'sample bytes must be nonempty');
        const end = dts + BigInt(duration);
        cmafAssert(end <= MAX_U64 && dts + BigInt(cto) >= -0x8000000000000000n && end + BigInt(cto) <= MAX_U64, 'sample timeline exceeds 64-bit range');
        if (state.decodeEnd !== undefined) {
            cmafAssert(dts >= state.decodeEnd, 'decode timestamps must not overlap or regress');
            cmafAssert(state.samples.length === 0 || dts === state.decodeEnd, 'flush before a decode timeline gap');
        }
        cmafAssert(this.bufferedBytes + length <= this.maxBytes && this.samples < this.maxSamples, 'buffer limit exceeded; flush the current fragment before adding this sample');
        const copied = new Uint8Array(data);
        validatePayload(state.track, copied);
        state.samples.push({ data: copied, decodeTimestamp: dts, duration, compositionTimeOffset: cto, isKeyframe });
        state.decodeEnd = end;
        state.negativeOffsets ||= cto < 0;
        state.largeOffsets ||= cto > 0x7fffffff;
        this.bytes += length;
        this.samples++;
    }
    flush(options = {}) {
        this.assertReady();
        const plan = this.plan(options);
        const parts = [...plan.prefix, plan.moof, plan.mdatHeader];
        for (const state of plan.states)
            for (const sample of state.samples)
                parts.push(sample.data);
        const data = join(parts);
        this.commit();
        return { ...plan.info, data };
    }
    async flushTo(sink, options = {}, signal) {
        this.assertReady();
        assertSink(sink);
        const linked = linkAbortSignals(signal, sink.signal);
        let started = false;
        let acquired = false;
        try {
            const plan = this.plan(options);
            this.writing = true;
            acquired = true;
            const write = async (data) => {
                linked.signal.throwIfAborted();
                started = true;
                sink.write(data);
                await drainSink(sink, linked.signal);
                linked.signal.throwIfAborted();
            };
            for (const bytes of plan.prefix)
                await write(bytes);
            await write(plan.moof);
            await write(plan.mdatHeader);
            for (const state of plan.states)
                for (const sample of state.samples)
                    await write(sample.data);
            this.commit();
            return plan.info;
        }
        catch (error) {
            if (started) {
                this.failed = true;
                this.failure = error;
            }
            throw error;
        }
        finally {
            linked.dispose();
            if (acquired)
                this.writing = false;
        }
    }
    assertReady() {
        if (this.failed)
            throw this.failure;
        cmafAssert(!this.writing, 'await the pending sink write before mutating the writer');
        cmafAssert(this.sequence <= 0xffffffff, 'fragment sequence number exhausted');
    }
    getTrack(id) {
        const state = this.states.get(id);
        cmafAssert(state, `unknown track ID ${id}`);
        return state;
    }
    plan(options) {
        cmafAssert(options && typeof options === 'object', 'invalid flush options');
        const { requireKeyframe = true, producerReferenceTime } = options;
        let referenceTime;
        if (producerReferenceTime !== undefined) {
            cmafAssert(producerReferenceTime && typeof producerReferenceTime === 'object', 'invalid producer reference time');
            const { trackId, ntpTimestamp, mediaTime } = producerReferenceTime;
            referenceTime = { trackId, ntpTimestamp, mediaTime };
        }
        this.assertReady();
        cmafAssert(typeof requireKeyframe === 'boolean', 'requireKeyframe must be boolean');
        cmafAssert(this.samples > 0, 'cannot flush an empty fragment');
        integer(this.sequence, 'fragment sequence number', 1);
        const states = [...this.states.values()].filter(state => state.samples.length > 0);
        const tracks = states.map((state) => {
            const first = state.samples[0];
            const last = state.samples[state.samples.length - 1];
            const independent = state.track.type !== 'video' || first.isKeyframe;
            cmafAssert(!requireKeyframe || independent, `track ${state.track.id} must start on a keyframe`);
            return {
                trackId: state.track.id,
                timescale: state.track.timescale,
                baseDecodeTime: first.decodeTimestamp,
                duration: last.decodeTimestamp + BigInt(last.duration) - first.decodeTimestamp,
                sampleCount: state.samples.length,
                independent: independent && !['opus', 'Opus'].includes(state.track.codec),
            };
        });
        const prefix = this.events.slice();
        let prefixBytes = this.eventBytes;
        if (referenceTime !== undefined) {
            const { trackId, ntpTimestamp, mediaTime } = referenceTime;
            const state = this.getTrack(trackId);
            cmafAssert(state.samples.length > 0, 'producer reference track must have samples in this fragment');
            cmafAssert(typeof ntpTimestamp === 'bigint', 'NTP timestamp must be bigint');
            const payload = new Uint8Array(20);
            const reference = new DataView(payload.buffer);
            reference.setUint32(0, trackId);
            reference.setBigUint64(4, timestamp(ntpTimestamp, 'NTP timestamp'));
            reference.setBigUint64(12, timestamp(mediaTime, 'producer media time'));
            const prft = fullBox('prft', 1, 0, payload);
            prefix.push(prft);
            prefixBytes += prft.length;
        }
        const size = 24 + states.reduce((sum, state) => sum + 64 + state.samples.length * 16, 0);
        const byteLength = integer(prefixBytes + size + 8 + this.bytes, 'fragment size', 1, 0x7fffffff);
        const moof = new Uint8Array(size);
        const view = new DataView(moof.buffer);
        let cursor = 0;
        const header = (type, length, version, flags = 0) => {
            view.setUint32(cursor, length);
            for (let index = 0; index < 4; index++)
                moof[cursor + 4 + index] = type.charCodeAt(index);
            cursor += 8;
            if (version !== undefined) {
                view.setUint32(cursor, version * 0x1000000 + flags);
                cursor += 4;
            }
        };
        header('moof', size);
        header('mfhd', 16, 0);
        view.setUint32(cursor, this.sequence);
        cursor += 4;
        let dataOffset = size + 8;
        for (const state of states) {
            const count = state.samples.length;
            header('traf', 64 + count * 16);
            header('tfhd', 16, 0, 0x020000);
            view.setUint32(cursor, state.track.id);
            cursor += 4;
            header('tfdt', 20, 1);
            view.setBigUint64(cursor, state.samples[0].decodeTimestamp);
            cursor += 8;
            const signed = state.negativeOffsets === true;
            header('trun', 20 + count * 16, signed ? 1 : 0, 0x000f01);
            view.setUint32(cursor, count);
            view.setInt32(cursor + 4, dataOffset);
            cursor += 8;
            for (const sample of state.samples) {
                view.setUint32(cursor, sample.duration);
                view.setUint32(cursor + 4, sample.data.length);
                view.setUint32(cursor + 8, state.track.type !== 'video' || sample.isKeyframe ? 0x02000000 : 0x01010000);
                if (signed)
                    view.setInt32(cursor + 12, sample.compositionTimeOffset);
                else
                    view.setUint32(cursor + 12, sample.compositionTimeOffset);
                cursor += 16;
                dataOffset += sample.data.length;
            }
        }
        const mdatHeader = join([u32(this.bytes + 8), Uint8Array.of(109, 100, 97, 116)]);
        return {
            states,
            prefix,
            moof,
            mdatHeader,
            info: {
                sequenceNumber: this.sequence,
                byteLength,
                independent: tracks.every(track => track.independent),
                tracks,
            },
        };
    }
    commit() {
        for (const state of this.states.values()) {
            state.samples = [];
            state.negativeOffsets = false;
            state.largeOffsets = false;
        }
        this.bytes = 0;
        this.samples = 0;
        this.events = [];
        this.eventBytes = 0;
        this.sequence++;
    }
}
