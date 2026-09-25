import { MediaForgeError } from '../core/errors.js';
import { adtsFrameLength, decodeAacFrame, decodeAvcNal, sampleAesAbort, sampleAesYield, } from './sample-aes-crypto.js';
const failure = (message) => new MediaForgeError(`SAMPLE-AES MPEG-TS: ${message}`, 'DEMUX');
const unsupported = (message) => new MediaForgeError(`SAMPLE-AES MPEG-TS: ${message}`, 'FORMAT');
function crc32(data) {
    let crc = 0xffffffff;
    for (const byte of data) {
        crc ^= byte << 24;
        for (let bit = 0; bit < 8; bit++)
            crc = crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
    }
    return crc >>> 0;
}
function adaptationEnd(data, offset, control) {
    if (!(control & 2))
        return offset + 4;
    const end = offset + 5 + data[offset + 4];
    if (end > offset + 188 || (control === 2 && end !== offset + 188) || (control === 3 && end === offset + 188))
        throw failure('invalid adaptation field length');
    if (data[offset + 4] === 0)
        return end;
    const flags = data[offset + 5];
    let pos = offset + 6;
    if (flags & 0x10) {
        if (pos + 6 > end || (data[pos + 4] & 0x7e) !== 0x7e || (((data[pos + 4] & 1) << 8) | data[pos + 5]) >= 300)
            throw failure('invalid PCR field');
        pos += 6;
    }
    if (flags & 0x08)
        pos += 6;
    if (flags & 0x04)
        pos++;
    if (pos > end)
        throw failure('incomplete adaptation field');
    for (const flag of [0x02, 0x01]) {
        if (flags & flag) {
            if (pos >= end)
                throw failure('incomplete adaptation extension');
            pos += 1 + data[pos];
            if (pos > end)
                throw failure('invalid adaptation extension length');
        }
    }
    return end;
}
function sameTransportPacket(data, previous, current) {
    const pcr = data[previous + 3] & 0x20 && data[previous + 4] >= 7 && data[previous + 5] & 0x10;
    for (let i = 0; i < 188; i++) {
        if (pcr && i >= 6 && i < 12)
            continue;
        if (data[previous + i] !== data[current + i])
            return false;
    }
    return true;
}
async function parsePackets(data, signal) {
    if (data.length % 188 !== 0)
        throw failure('requires complete 188-byte packets');
    const result = [];
    const previousPackets = new Map();
    for (let offset = 0; offset < data.length; offset += 188) {
        if (data[offset] !== 0x47 || data[offset + 1] & 0x80 || data[offset + 3] & 0xc0)
            throw failure('invalid, damaged or transport-scrambled packet');
        const control = (data[offset + 3] >> 4) & 3;
        if (!control)
            throw failure('reserved adaptation field control');
        const payload = adaptationEnd(data, offset, control);
        const pid = ((data[offset + 1] & 31) << 8) | data[offset + 2];
        const start = (data[offset + 1] & 0x40) !== 0;
        if (start && !(control & 1))
            throw failure('payload start without payload');
        const discontinuity = !!(control & 2 && data[offset + 4] > 0 && data[offset + 5] & 0x80);
        let duplicate = false;
        if (pid !== 0x1fff) {
            const cc = data[offset + 3] & 15;
            const previous = previousPackets.get(pid);
            if (previous) {
                const previousCc = data[previous.offset + 3] & 15;
                duplicate =
                    !!(control & 1) &&
                        previous.payload < previous.end &&
                        cc === previousCc &&
                        sameTransportPacket(data, previous.offset, offset);
                if (duplicate && previous.duplicate)
                    throw failure('more than two duplicate packets');
                if (!duplicate && !discontinuity && cc !== ((previousCc + (control & 1)) & 15))
                    throw failure('packet continuity gap or changed duplicate');
            }
        }
        const packet = {
            offset,
            pid,
            start,
            payload: control & 1 ? payload : offset + 188,
            end: offset + 188,
            duplicate,
            discontinuity,
        };
        result.push(packet);
        if (pid !== 0x1fff)
            previousPackets.set(pid, packet);
        if ((result.length & 4095) === 0)
            await sampleAesYield(signal);
    }
    return result;
}
function section(data, packet, tableId) {
    if (!packet.start || packet.payload >= packet.end || data[packet.payload] !== 0)
        throw unsupported('fragmented PAT/PMT tables are unsupported');
    const start = packet.payload + 1;
    const length = 3 + (((data[start + 1] & 15) << 8) | data[start + 2]);
    if (start + 3 > packet.end ||
        data[start] !== tableId ||
        (data[start + 1] & 0xf0) !== 0xb0 ||
        length < 12 ||
        length > 1024 ||
        start + length > packet.end)
        throw failure('incomplete or invalid PAT/PMT section');
    const bytes = data.slice(start, start + length);
    if (crc32(bytes) !== 0)
        throw failure('PAT/PMT CRC mismatch');
    if (!(bytes[5] & 1) || bytes[6] !== 0 || bytes[7] !== 0)
        throw unsupported('only current, single-section PAT/PMT tables are supported');
    for (let i = start + length; i < packet.end; i++)
        if (data[i] !== 0xff)
            throw unsupported('multiple PAT/PMT sections in one packet are unsupported');
    return bytes;
}
function programFromPat(bytes) {
    if ((bytes.length - 12) % 4)
        throw failure('invalid PAT entry length');
    let result;
    for (let pos = 8; pos < bytes.length - 4; pos += 4) {
        const program = (bytes[pos] << 8) | bytes[pos + 1];
        if (!program)
            continue;
        if (result)
            throw unsupported('multiple programs are unsupported');
        const pid = ((bytes[pos + 2] & 31) << 8) | bytes[pos + 3];
        if (pid === 0 || pid === 0x1fff)
            throw failure('invalid PMT PID');
        result = { program, pid };
    }
    if (!result)
        throw failure('PAT contains no program');
    return result;
}
function descriptorBytes(bytes, start, end, codec) {
    const result = new Uint8Array(end - start);
    let size = 0;
    let indicator = false;
    let setup = false;
    for (let pos = start; pos < end;) {
        if (pos + 2 > end || pos + 2 + bytes[pos + 1] > end)
            throw failure('descriptor exceeds its parent');
        const stop = pos + 2 + bytes[pos + 1];
        const value = bytes.subarray(pos + 2, stop);
        const name = value.length >= 4 ? String.fromCharCode(...value.subarray(0, 4)) : '';
        let remove = false;
        if (codec && bytes[pos] === 0x0f) {
            if (value.length !== 4 || name !== (codec === 'avc' ? 'zavc' : 'aacd') || indicator)
                throw failure('invalid encryption private data indicator');
            indicator = true;
            remove = true;
        }
        if (codec === 'aac' && bytes[pos] === 5 && name === 'apad') {
            const audioType = String.fromCharCode(...value.subarray(4, 8));
            if (setup ||
                value.length < 12 ||
                value[10] !== 1 ||
                value.length !== 12 + value[11] ||
                !['zaac', 'zach', 'zacp'].includes(audioType))
                throw failure('invalid encrypted AAC setup descriptor');
            setup = true;
            remove = true;
        }
        if (!remove) {
            result.set(bytes.subarray(pos, stop), size);
            size += stop - pos;
        }
        pos = stop;
    }
    if (codec && !indicator)
        throw failure('encrypted stream has no private data indicator');
    if (codec === 'aac' && !setup)
        throw failure('encrypted AAC stream has no audio setup descriptor');
    return result.slice(0, size);
}
function restorePmt(bytes, program) {
    if (bytes.length < 16 || ((bytes[3] << 8) | bytes[4]) !== program)
        throw failure('PMT program does not match PAT');
    const infoEnd = 12 + (((bytes[10] & 15) << 8) | bytes[11]);
    if (infoEnd > bytes.length - 4)
        throw failure('invalid PMT program descriptor length');
    descriptorBytes(bytes, 12, infoEnd);
    const result = new Uint8Array(bytes.length);
    result.set(bytes.subarray(0, infoEnd));
    const streams = new Map();
    const seen = new Set();
    let size = infoEnd;
    for (let pos = infoEnd; pos < bytes.length - 4;) {
        if (pos + 5 > bytes.length - 4)
            throw failure('incomplete PMT stream entry');
        const type = bytes[pos];
        const pid = ((bytes[pos + 1] & 31) << 8) | bytes[pos + 2];
        const end = pos + 5 + (((bytes[pos + 3] & 15) << 8) | bytes[pos + 4]);
        if (end > bytes.length - 4 || pid === 0 || pid === 0x1fff || seen.has(pid))
            throw failure('invalid PMT elementary stream');
        seen.add(pid);
        if ([0xc1, 0xc2, 0x24, 0x81, 0x87].includes(type))
            throw unsupported('Dolby and HEVC streams are unsupported');
        const codec = type === 0xdb ? 'avc' : type === 0xcf ? 'aac' : undefined;
        if (codec)
            streams.set(pid, codec);
        const descriptors = descriptorBytes(bytes, pos + 5, end, codec);
        result.set(bytes.subarray(pos, pos + 5), size);
        result[size] = codec === 'avc' ? 0x1b : codec === 'aac' ? 0x0f : type;
        result[size + 3] = 0xf0 | (descriptors.length >> 8);
        result[size + 4] = descriptors.length & 255;
        result.set(descriptors, size + 5);
        size += 5 + descriptors.length;
        pos = end;
    }
    if (!streams.size)
        throw unsupported('PMT must signal encrypted AVC (0xdb) or AAC (0xcf)');
    const sectionLength = size + 1;
    result[1] = 0xb0 | (sectionLength >> 8);
    result[2] = sectionLength & 255;
    const crc = crc32(result.subarray(0, size));
    result[size++] = crc >>> 24;
    result[size++] = crc >>> 16;
    result[size++] = crc >>> 8;
    result[size++] = crc;
    return { bytes: result.slice(0, size), streams };
}
function writePayload(data, packet, bytes) {
    if (bytes.length > packet.end - packet.payload)
        throw failure('restored payload exceeds packet capacity');
    const free = 184 - bytes.length;
    const adaptation = packet.payload - packet.offset - 4;
    const previous = data.slice(packet.offset + 4, packet.payload);
    data[packet.offset + 3] = (data[packet.offset + 3] & 0xcf) | (bytes.length ? (free ? 0x30 : 0x10) : 0x20);
    if (!bytes.length)
        data[packet.offset + 1] &= ~0x40;
    if (free) {
        data.fill(0xff, packet.offset + 4, packet.offset + 4 + free);
        data[packet.offset + 4] = free - 1;
        if (free > 1) {
            data[packet.offset + 5] = adaptation > 1 ? previous[1] : 0;
            if (adaptation > 2)
                data.set(previous.subarray(2), packet.offset + 6);
        }
    }
    data.set(bytes, packet.offset + 4 + free);
}
function finishPes(data, packets, codec, reset) {
    const size = packets.reduce((total, packet) => total + packet.end - packet.payload, 0);
    const bytes = new Uint8Array(size);
    let position = 0;
    for (const packet of packets) {
        bytes.set(data.subarray(packet.payload, packet.end), position);
        position += packet.end - packet.payload;
    }
    if (size < 9 || bytes[0] !== 0 || bytes[1] !== 0 || bytes[2] !== 1 || (bytes[6] & 0xc0) !== 0x80 || bytes[6] & 0x30)
        throw failure('invalid or scrambled PES header');
    const stream = bytes[3];
    if (codec === 'avc' ? stream < 0xe0 || stream > 0xef : (stream < 0xc0 || stream > 0xdf) && stream !== 0xbd)
        throw failure('PES stream ID does not match PMT');
    const declared = (bytes[4] << 8) | bytes[5];
    if (declared ? declared + 6 !== size : codec !== 'avc')
        throw failure('incomplete or unbounded audio PES');
    const header = 9 + bytes[8];
    const pts = bytes[7] >> 6;
    if (pts === 1 || header >= size || (pts === 2 && bytes[8] < 5) || (pts === 3 && bytes[8] < 10))
        throw failure('incomplete PES optional header');
    for (let pos = 9; pos < 9 + (pts === 3 ? 10 : pts === 2 ? 5 : 0); pos += 5) {
        const marker = pos === 9 ? pts : 1;
        if (bytes[pos] >> 4 !== marker || !(bytes[pos] & 1) || !(bytes[pos + 2] & 1) || !(bytes[pos + 4] & 1))
            throw failure('invalid PES timestamp markers');
    }
    return { packets, data: bytes, header, reset };
}
async function collectPes(data, packets, streams, signal) {
    const active = new Map();
    const resetPending = new Set();
    const result = new Map();
    for (let i = 0; i < packets.length; i++) {
        if ((i & 4095) === 4095)
            await sampleAesYield(signal);
        const packet = packets[i];
        const codec = streams.get(packet.pid);
        if (!codec || packet.duplicate)
            continue;
        if (packet.discontinuity)
            resetPending.add(packet.pid);
        if (packet.payload === packet.end)
            continue;
        if (resetPending.has(packet.pid) && !packet.start)
            throw failure('transport discontinuity inside a PES');
        if (packet.start) {
            const previous = active.get(packet.pid);
            if (previous)
                result.get(packet.pid).push(finishPes(data, previous.packets, codec, previous.reset));
            active.set(packet.pid, { packets: [], reset: resetPending.delete(packet.pid) });
            if (!result.has(packet.pid))
                result.set(packet.pid, []);
        }
        const entry = active.get(packet.pid);
        if (!entry)
            throw failure('resource starts inside a PES; continuous or incomplete resources are unsupported');
        entry.packets.push(packet);
    }
    for (const [pid, entry] of active)
        result.get(pid).push(finishPes(data, entry.packets, streams.get(pid), entry.reset));
    for (const pid of streams.keys())
        if (!result.has(pid))
            throw failure('PMT encrypted stream has no complete PES');
    return result;
}
async function findStartCode(data, from, signal) {
    let zeros = 0;
    for (let pos = from; pos < data.length; pos++) {
        const byte = data[pos];
        if (byte === 1 && zeros >= 2)
            return { start: pos - zeros, body: pos + 1 };
        zeros = byte === 0 ? zeros + 1 : 0;
        if ((pos & 0x3ffff) === 0x3ffff)
            await sampleAesYield(signal);
    }
    return undefined;
}
async function decryptElementary(data, codec, crypto, signal) {
    if (codec === 'aac') {
        let frames = 0;
        for (let pos = 0; pos < data.length;) {
            const length = adtsFrameLength(data, pos);
            const frame = data.slice(pos, pos + length);
            await decodeAacFrame(frame, crypto);
            sampleAesAbort(signal);
            data.set(frame, pos);
            pos += length;
            if ((++frames & 255) === 0)
                await sampleAesYield(signal);
        }
        return undefined;
    }
    const removed = new Uint8Array(data.length);
    let current = await findStartCode(data, 0, signal);
    if (!current || current.start !== 0)
        throw failure('AVC elementary stream must start with an Annex B start code');
    let nals = 0;
    while (current) {
        const next = await findStartCode(data, current.body, signal);
        let end = next?.start ?? data.length;
        if (!next)
            while (end > current.body && data[end - 1] === 0)
                end--;
        const start = current.body;
        const clear = await decodeAvcNal(data.slice(start, end), crypto, signal, offset => {
            removed[start + offset] = 1;
        });
        sampleAesAbort(signal);
        let position = 0;
        for (let pos = start; pos < end; pos++) {
            if (!removed[pos])
                data[pos] = clear[position++];
            if ((pos & 0x3ffff) === 0x3ffff)
                await sampleAesYield(signal);
        }
        current = next;
        if ((++nals & 255) === 0)
            await sampleAesYield(signal);
    }
    return removed;
}
async function restoreStream(data, entries, codec, crypto, signal) {
    const size = entries.reduce((total, entry) => total + entry.data.length - entry.header, 0);
    const elementary = new Uint8Array(size);
    let position = 0;
    for (const entry of entries) {
        elementary.set(entry.data.subarray(entry.header), position);
        position += entry.data.length - entry.header;
    }
    const removed = await decryptElementary(elementary, codec, crypto, signal);
    position = 0;
    let packetCount = 0;
    for (const entry of entries) {
        const end = position + entry.data.length - entry.header;
        let size = entry.header;
        for (let pos = position; pos < end; pos++) {
            if (!removed?.[pos])
                entry.data[size++] = elementary[pos];
            if ((pos & 0x3ffff) === 0x3ffff)
                await sampleAesYield(signal);
        }
        position = end;
        if (entry.data[4] || entry.data[5]) {
            entry.data[4] = (size - 6) >> 8;
            entry.data[5] = (size - 6) & 255;
        }
        let read = 0;
        for (const packet of entry.packets) {
            const count = Math.min(size - read, packet.end - packet.payload);
            writePayload(data, packet, entry.data.subarray(read, read + count));
            read += count;
            if ((++packetCount & 4095) === 0)
                await sampleAesYield(signal);
        }
    }
    sampleAesAbort(signal);
}
export async function decryptSampleAesTs(data, crypto, signal) {
    const packets = await parsePackets(data, signal);
    for (const packet of packets)
        if (packet.duplicate)
            writePayload(data, packet, new Uint8Array(0));
    let program;
    for (let i = 0; i < packets.length; i++) {
        if ((i & 4095) === 4095)
            await sampleAesYield(signal);
        const packet = packets[i];
        if (packet.duplicate || packet.pid !== 0 || packet.payload === packet.end)
            continue;
        const next = programFromPat(section(data, packet, 0));
        if (program && (program.pid !== next.pid || program.program !== next.program))
            throw unsupported('program changes inside a resource are unsupported');
        program = next;
    }
    if (!program)
        throw failure('complete PAT and PMT are required in each resource');
    let streams;
    for (let i = 0; i < packets.length; i++) {
        if ((i & 4095) === 4095)
            await sampleAesYield(signal);
        const packet = packets[i];
        if (packet.duplicate || packet.pid !== program.pid || packet.payload === packet.end)
            continue;
        const restored = restorePmt(section(data, packet, 2), program.program);
        if (streams &&
            (streams.size !== restored.streams.size ||
                [...streams].some(([pid, codec]) => restored.streams.get(pid) !== codec)))
            throw unsupported('encrypted stream changes inside a resource are unsupported');
        streams = restored.streams;
        const payload = new Uint8Array(1 + restored.bytes.length);
        payload.set(restored.bytes, 1);
        writePayload(data, packet, payload);
    }
    if (!streams)
        throw failure('complete PMT is required in each resource');
    const pes = await collectPes(data, packets, streams, signal);
    for (const [pid, entries] of pes) {
        let start = 0;
        for (let i = 1; i <= entries.length; i++) {
            if (i === entries.length || entries[i].reset) {
                await restoreStream(data, entries.slice(start, i), streams.get(pid), crypto, signal);
                start = i;
            }
        }
    }
    const counters = new Map();
    for (const packet of packets) {
        if (!streams.has(packet.pid))
            continue;
        const payload = (data[packet.offset + 3] & 0x10) !== 0;
        const previous = counters.get(packet.pid);
        const count = previous === undefined ? data[packet.offset + 3] & 15 : (previous + (payload ? 1 : 0)) & 15;
        data[packet.offset + 3] = (data[packet.offset + 3] & 0xf0) | count;
        counters.set(packet.pid, count);
    }
    sampleAesAbort(signal);
}
