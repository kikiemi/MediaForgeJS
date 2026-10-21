import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { classicMp4 } from './mp4-fixture.mjs';
import { concat, ebmlElement } from './original-fixtures.mjs';

const text = value => new TextEncoder().encode(value);
const uint = value => {
    const bytes = [];
    do {
        bytes.unshift(value & 255);
        value = Math.floor(value / 256);
    } while (value);
    return Uint8Array.from(bytes);
};
const elementUint = (id, value) => ebmlElement(id, uint(value));

export const packetSize = index => 4 + (index % 29);
export const packetByte = (index, byte) => (index * 37 + byte * 11 + 7) & 255;

export function pcmBenchmarkFixture(frames) {
    const bytes = new Uint8Array(44 + frames * 4);
    const view = new DataView(bytes.buffer);
    for (const [at, value] of [
        [0, 'RIFF'],
        [8, 'WAVE'],
        [12, 'fmt '],
        [36, 'data'],
    ])
        bytes.set(text(value), at);
    view.setUint32(4, bytes.length - 8, true);
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 2, true);
    view.setUint32(24, 48000, true);
    view.setUint32(28, 192000, true);
    view.setUint16(32, 4, true);
    view.setUint16(34, 16, true);
    view.setUint32(40, frames * 4, true);
    for (let index = 0; index < frames * 2; index++)
        view.setInt16(44 + index * 2, pcmSample(index), true);
    return bytes;
}

export const pcmSample = index => ((index * 613 + (index % 127) * 31) & 65535) - 32768;

export function packetBenchmarkFixture(format, count) {
    if (format === 'mp4') {
        return classicMp4({
            count,
            sizes: Array.from({ length: count }, (_, index) => packetSize(index)),
        }).bytes;
    }
    const header = ebmlElement(
        0x1a45dfa3,
        elementUint(0x4286, 1),
        elementUint(0x42f7, 1),
        elementUint(0x42f2, 4),
        elementUint(0x42f3, 8),
        ebmlElement(0x4282, text('matroska')),
        elementUint(0x4287, 4),
        elementUint(0x4285, 2),
    );
    const rate = new Uint8Array(8);
    new DataView(rate.buffer).setFloat64(0, 48000);
    const track = ebmlElement(
        0xae,
        elementUint(0xd7, 1),
        elementUint(0x73c5, 1),
        elementUint(0x83, 2),
        ebmlElement(0x86, text('A_AAC')),
        elementUint(0x23e383, 40000000),
        ebmlElement(0x63a2, [0x11, 0x88]),
        ebmlElement(0xe1, elementUint(0x9f, 1), ebmlElement(0xb5, rate)),
    );
    const clusters = [];
    for (let start = 0; start < count; start += 500) {
        const blocks = [];
        for (let index = start; index < Math.min(start + 500, count); index++) {
            const block = new Uint8Array(4 + packetSize(index));
            block[0] = 0x81;
            new DataView(block.buffer).setInt16(1, (index - start) * 40);
            block[3] = 0x80;
            for (let byte = 4; byte < block.length; byte++)
                block[byte] = packetByte(index, byte - 4);
            blocks.push(ebmlElement(0xa3, block));
        }
        clusters.push(ebmlElement(0x1f43b675, elementUint(0xe7, start * 40), ...blocks));
    }
    return concat(
        header,
        ebmlElement(
            0x18538067,
            ebmlElement(0x1549a966, elementUint(0x2ad7b1, 1000000)),
            ebmlElement(0x1654ae6b, track),
            ...clusters,
        ),
    );
}

export function verifyPcmOutput(bytes, { frames, sampleRate, channels, exact = false }) {
    assert.equal(Buffer.from(bytes.subarray(0, 4)).toString(), 'RIFF');
    assert.equal(Buffer.from(bytes.subarray(8, 12)).toString(), 'WAVE');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    assert.equal(view.getUint32(4, true) + 8, bytes.length);
    let data;
    let foundFormat = false;
    for (let at = 12; at < bytes.length;) {
        const size = view.getUint32(at + 4, true);
        assert(at + 8 + size <= bytes.length);
        const type = Buffer.from(bytes.subarray(at, at + 4)).toString();
        if (type === 'fmt ') {
            assert.equal(view.getUint16(at + 8, true), 1);
            assert.equal(view.getUint16(at + 10, true), channels);
            assert.equal(view.getUint32(at + 12, true), sampleRate);
            assert.equal(view.getUint16(at + 22, true), 16);
            foundFormat = true;
        }
        if (type === 'data') data = bytes.subarray(at + 8, at + 8 + size);
        at += 8 + size + (size & 1);
    }
    assert(foundFormat && data);
    assert.equal(data.length, frames * channels * 2);
    // WAV to WAV without new settings copies the samples.
    if (exact) {
        const pcm = new DataView(data.buffer, data.byteOffset, data.byteLength);
        for (let index = 0; index < frames * channels; index++)
            assert.equal(pcm.getInt16(index * 2, true), pcmSample(index));
    }
    return createHash('sha256').update(data).digest('hex');
}

function boxes(bytes, start = 0, end = bytes.length) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const output = [];
    for (let at = start; at < end;) {
        assert(at + 8 <= end);
        let size = view.getUint32(at);
        let header = 8;
        if (size === 1) {
            size = Number(view.getBigUint64(at + 8));
            header = 16;
        } else if (size === 0) size = end - at;
        assert(size >= header && at + size <= end);
        output.push({
            type: Buffer.from(bytes.subarray(at + 4, at + 8)).toString(),
            start: at + header,
            end: at + size,
        });
        at += size;
    }
    return output;
}

function mp4Packets(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let scope = { start: 0, end: bytes.length };
    let timescale;
    for (const type of ['moov', 'trak', 'mdia', 'minf', 'stbl']) {
        const matches = boxes(bytes, scope.start, scope.end).filter(box => box.type === type);
        assert.equal(matches.length, 1);
        scope = matches[0];
        if (type === 'mdia') {
            const mdhd = boxes(bytes, scope.start, scope.end).find(box => box.type === 'mdhd');
            timescale = view.getUint32(mdhd.start + (bytes[mdhd.start] === 1 ? 20 : 12));
            assert(timescale > 0);
        }
    }
    const tables = new Map(boxes(bytes, scope.start, scope.end).map(box => [box.type, box]));
    const stsz = tables.get('stsz').start;
    const count = view.getUint32(stsz + 8);
    const fixedSize = view.getUint32(stsz + 4);
    const offsets = tables.get('stco') ?? tables.get('co64');
    const offsetCount = view.getUint32(offsets.start + 4);
    const stsc = tables.get('stsc').start;
    const runCount = view.getUint32(stsc + 4);
    const stts = tables.get('stts').start;
    const timingRuns = view.getUint32(stts + 4);
    let timingRun = 0;
    let timingRemaining = view.getUint32(stts + 8);
    let timestamp = 0;
    let sample = 0;
    let run = 0;
    const output = [];
    for (let chunk = 1; chunk <= offsetCount; chunk++) {
        while (run + 1 < runCount && view.getUint32(stsc + 8 + (run + 1) * 12) <= chunk) run++;
        const length = view.getUint32(stsc + 12 + run * 12);
        let offset =
            offsets.type === 'co64'
                ? Number(view.getBigUint64(offsets.start + 8 + (chunk - 1) * 8))
                : view.getUint32(offsets.start + 8 + (chunk - 1) * 4);
        for (let index = 0; index < length; index++, sample++) {
            assert(sample < count);
            const size = fixedSize || view.getUint32(stsz + 12 + sample * 4);
            assert(offset + size <= bytes.length);
            while (!timingRemaining) {
                assert(++timingRun < timingRuns);
                timingRemaining = view.getUint32(stts + 8 + timingRun * 8);
            }
            const duration = view.getUint32(stts + 12 + timingRun * 8);
            assert(Math.abs(timestamp / timescale - sample * 0.04) < 0.000001);
            assert(Math.abs(duration / timescale - 0.04) < 0.000001);
            output.push(bytes.subarray(offset, offset + size));
            timestamp += duration;
            timingRemaining--;
            offset += size;
        }
    }
    assert.equal(sample, count);
    return output;
}

function elements(bytes, start = 0, end = bytes.length) {
    const result = [];
    const variable = (at, identifier) => {
        let width = 1;
        while (width <= 8 && !(bytes[at] & (128 >> (width - 1)))) width++;
        assert(width <= 8 && at + width <= end);
        let value = identifier ? bytes[at] : bytes[at] & ((128 >> (width - 1)) - 1);
        for (let index = 1; index < width; index++) value = value * 256 + bytes[at + index];
        return { value, width, unknown: !identifier && value === 2 ** (width * 7) - 1 };
    };
    for (let at = start; at < end;) {
        const id = variable(at, true);
        const size = variable(at + id.width, false);
        const payload = at + id.width + size.width;
        const next = size.unknown ? end : payload + size.value;
        assert(next >= payload && next <= end);
        result.push({ id: id.value, start: payload, end: next });
        at = next;
    }
    return result;
}

function matroskaPackets(bytes) {
    const segment = elements(bytes).find(element => element.id === 0x18538067);
    assert(segment);
    const integer = element => {
        let value = 0;
        for (let at = element.start; at < element.end; at++) value = value * 256 + bytes[at];
        return value;
    };
    const children = elements(bytes, segment.start, segment.end);
    const info = children.find(element => element.id === 0x1549a966);
    const scale =
        info && elements(bytes, info.start, info.end).find(element => element.id === 0x2ad7b1);
    const secondsPerUnit = (scale ? integer(scale) : 1000000) / 1000000000;
    const output = [];
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (const cluster of children.filter(element => element.id === 0x1f43b675)) {
        const contents = elements(bytes, cluster.start, cluster.end);
        const timestamp = integer(contents.find(element => element.id === 0xe7));
        for (const child of contents) {
            const block =
                child.id === 0xa3
                    ? child
                    : child.id === 0xa0
                      ? elements(bytes, child.start, child.end).find(element => element.id === 0xa1)
                      : undefined;
            if (!block) continue;
            assert.equal(bytes[block.start], 0x81);
            assert.equal(
                bytes[block.start + 3] & 6,
                0,
                'Benchmark writer output must use unlaced blocks',
            );
            const time = (timestamp + view.getInt16(block.start + 1)) * secondsPerUnit;
            assert(Math.abs(time - output.length * 0.04) < 0.000001);
            output.push(bytes.subarray(block.start + 4, block.end));
        }
    }
    return output;
}

export function verifyPacketOutput(bytes, format, count) {
    const packets = format === 'mp4' ? mp4Packets(bytes) : matroskaPackets(bytes);
    assert.equal(packets.length, count);
    const digest = createHash('sha256');
    const length = Buffer.alloc(4);
    packets.forEach((packet, index) => {
        assert.equal(packet.length, packetSize(index));
        for (let byte = 0; byte < packet.length; byte++)
            assert.equal(packet[byte], packetByte(index, byte));
        length.writeUInt32BE(packet.length);
        digest.update(length).update(packet);
    });
    return digest.digest('hex');
}
