import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { isDeepStrictEqual } from 'node:util';
import { MediaForge, open } from 'mediaforgejs';
import { WebMMuxer } from 'mediaforgejs/formats';
import { MemorySink } from 'mediaforgejs/io';
import {
    oggFixture,
    originalFixtures,
    tsFixture,
    waveFixture,
} from '../helpers/original-fixtures.mjs';
import { avcc, filler, idr, lengthPrefixed, predicted } from '../helpers/avi-h264-fixtures.mjs';
import { muxedWithAudio } from '../helpers/large-ts-matroska.mjs';

// What an open input keeps between operations, what closing it ends, and the bytes and warnings
// each operation hands out.

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc');

/**
 * A Blob that tells which of the bytes it handed out stay held: it holds each read itself until
 * kept() lets go of them, and a FinalizationRegistry, which keeps nothing alive, reports each one
 * the collector frees.
 */
class WatchedBlob extends Blob {
    #held = [];
    #reads = [];
    #pending = 0;
    #freed = new Set();
    #registry = new FinalizationRegistry(read => this.#freed.add(read));

    slice(start, end) {
        const part = super.slice(start, end);
        return {
            arrayBuffer: async () => {
                this.#pending++;
                try {
                    const buffer = await part.arrayBuffer();
                    const read = { range: `${start}-${end}` };
                    this.#registry.register(buffer, read);
                    this.#reads.push(read);
                    this.#held.push(buffer);
                    return buffer;
                } finally {
                    this.#pending--;
                }
            },
        };
    }

    /**
     * The ranges of the reads something other than this Blob still holds `seconds` after every
     * read is done, collecting the garbage meanwhile: a read of the input's own work in flight,
     * such as a read-ahead, is freed when that work ends, and one kept stays held.
     */
    async kept(seconds = 10) {
        while (this.#pending) await new Promise(setImmediate);
        this.#held = [];
        const deadline = Date.now() + seconds * 1000;
        const held = () => this.#reads.filter(read => !this.#freed.has(read));
        while (held().length && Date.now() < deadline) {
            gc();
            await new Promise(resolve => setTimeout(resolve, 1));
        }
        return held().map(read => read.range);
    }
}

describe('read: an open input over its life', () => {
    describe('an open input keeps its index, not the bytes it read', () => {
        // Each open input would otherwise keep the read windows and pages of its last scan or
        // pass (megabytes). An 8 MB MP3 without a seek table is scanned frame by frame when
        // opened, through the read windows of its Blob; a pass of its packets and a copy read it
        // again.
        const mp3 = () => {
            const frame = new Uint8Array(417).fill(0x20);
            frame.set([0xff, 0xfb, 0x90, 0xc0]);
            const bytes = new Uint8Array(frame.length * 20000);
            for (let at = 0; at < bytes.length; at += frame.length) bytes.set(frame, at);
            return new WatchedBlob([bytes]);
        };

        test('a watched Blob reports the reads that are still held', async () => {
            const blob = mp3();
            const held = await blob.slice(0, 4).arrayBuffer();
            await blob.slice(4, 8).arrayBuffer();
            assert.deepEqual(await blob.kept(0.2), ['0-4']);
            assert.equal(held.byteLength, 4);
        });

        for (const [after, use] of [
            ['its open', undefined],
            [
                'a pass over its packets',
                async media => {
                    for await (const _packet of media.packets());
                },
            ],
            ['a copy', media => media.convert('mp3', { copy: true })],
        ])
            test(`an MP3 Blob keeps none of its reads after ${after}`, async () => {
                const blob = mp3();
                const media = await open(blob);
                await use?.(media);
                assert.deepEqual(await blob.kept(), []);
                media.close();
            });

        test('a large Matroska input keeps neither its head nor its tail reads', async () => {
            // It is described from its head and tail: an open one keeps neither those reads nor
            // the reader that made them (its tracks' sample indexes do not hold it).
            const matroska = await muxedWithAudio(WebMMuxer, 'mkv', { pictures: 1200 });
            const blob = new WatchedBlob([await matroska.read(0, matroska.size)]);
            const media = await open(blob);
            assert.deepEqual(await blob.kept(), []);
            media.close();
        });
    });

    test('closing an input ends its packet access and keeps its tracks readable', async () => {
        const bytes = waveFixture();
        let sourceCloses = 0;
        const source = {
            size: bytes.length,
            async read(offset, length) {
                return bytes.slice(offset, offset + length);
            },
            async close() {
                sourceCloses++;
            },
        };
        const media = await open(source);
        const tracks = media.tracks;
        assert.equal((await media.packetAt(tracks[0].id, 0)).timestamp, 0);
        media.close();
        media.close();
        assert.equal(sourceCloses, 0);
        assert.deepEqual(media.tracks, tracks);
        await assert.rejects(media.packetAt(tracks[0].id, 0), error => error.code === 'ABORT');
        assert.equal((await media.check('wav', { copy: true })).code, 'ABORT');
        await assert.rejects(media.convert('wav'), error => error.code === 'ABORT');
        await assert.rejects(
            async () => {
                for await (const _packet of media.packets())
                    assert.fail('A closed input yielded a packet');
            },
            error => error.code === 'ABORT',
        );
    });

    test('the packets of an input share one copy of their configuration', async () => {
        // Sources of the caller's: a packet read before any pass is read for itself, and the
        // MPEG-TS one is gathered from its transport packets.
        for (const [name, bytes] of [
            ['Ogg', oggFixture()],
            ['MPEG-TS', tsFixture()],
        ])
            for (const first of ['packetAt', 'packets']) {
                const media = await open({
                    size: bytes.length,
                    read: async (offset, length) => bytes.slice(offset, offset + length),
                });
                const id = media.tracks[0].id;
                const original = media.tracks[0].codecConfig;
                const configs = [];
                if (first === 'packetAt')
                    configs.push((await media.packetAt(id, 0, { mode: 'after' })).codecConfig);
                const packets = [];
                for await (const packet of media.packets({ trackIds: [id] })) {
                    configs.push(packet.codecConfig);
                    packets.push(packet);
                }
                const again = await media.packetAt(id, packets[1].timestamp);
                assert.deepEqual(again.data, packets[1].data);
                configs.push(again.codecConfig);
                assert(configs[0] instanceof Uint8Array && configs[0].length > 0);
                assert(
                    configs.every(config => config === configs[0]),
                    `${name}, ${first} first: every packet carries the same copy`,
                );
                assert.deepEqual(configs[0], original);

                // Changing the copy changes neither the track nor what a copy of the input
                // writes.
                const before = await (await media.convert('mkv')).blob.arrayBuffer();
                configs[0].fill(0);
                assert.deepEqual(media.tracks[0].codecConfig, original);
                const after = await (await media.convert('mkv')).blob.arrayBuffer();
                assert.deepEqual(new Uint8Array(after), new Uint8Array(before), name);
                media.close();
            }
    });

    test('a pass reads the input in large spans and hands out bytes of their own', async () => {
        // 4 MiB of 16-bit stereo PCM at 48 kHz in a canonical WAVE file.
        const payload = 4 * 1024 * 1024;
        const bytes = new Uint8Array(44 + payload);
        const view = new DataView(bytes.buffer);
        const ascii = (at, text) =>
            [...text].forEach((character, index) => (bytes[at + index] = character.charCodeAt(0)));
        ascii(0, 'RIFF');
        view.setUint32(4, 36 + payload, true);
        ascii(8, 'WAVEfmt ');
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);
        view.setUint16(22, 2, true);
        view.setUint32(24, 48000, true);
        view.setUint32(28, 192000, true);
        view.setUint16(32, 4, true);
        view.setUint16(34, 16, true);
        ascii(36, 'data');
        view.setUint32(40, payload, true);
        for (let at = 44; at < bytes.length; at++) bytes[at] = at & 0xff;
        let reads = 0;
        const source = {
            size: bytes.length,
            async read(offset, length) {
                reads++;
                return bytes.slice(offset, offset + length);
            },
        };
        const media = await open(source);
        const opened = reads;
        let total = 0;
        for await (const packet of media.packets()) {
            assert.equal(packet.data.byteOffset, 0);
            assert.equal(packet.data.buffer.byteLength, packet.data.length);
            assert.equal(packet.data[0], (44 + total) & 0xff);
            packet.data.fill(0);
            total += packet.data.length;
        }
        assert.equal(total, payload);
        assert(reads - opened <= 8, `${reads - opened} source reads for 4 MiB of packets`);
        const again = await media.packetAt(media.tracks[0].id, 0);
        assert.equal(again.data[0], 44);
        media.close();
    });

    /** Whether `bytes` fill an ArrayBuffer of their own. */
    const fillsBuffer = bytes =>
        bytes.buffer instanceof ArrayBuffer &&
        bytes.byteOffset === 0 &&
        bytes.byteLength === bytes.buffer.byteLength;

    /** Asserts each packet owns its bytes, then transfers the first and checks the others. */
    function assertExclusive(name, packets, configs) {
        assert(packets.length >= 2, `${name}: ${packets.length} packets`);
        const buffers = new Set();
        for (const [index, packet] of packets.entries()) {
            assert(fillsBuffer(packet.data), `${name}: packet ${index} shares its buffer`);
            if (packet.alphaData) assert(fillsBuffer(packet.alphaData), `${name}: alpha ${index}`);
            assert(!buffers.has(packet.data.buffer), `${name}: packet ${index} reuses a buffer`);
            buffers.add(packet.data.buffer);
        }
        const copies = packets.map(packet => packet.data.slice());
        const sizes = configs.map(config => config.length);
        const moved = structuredClone(packets[0].data.buffer, {
            transfer: [packets[0].data.buffer],
        });
        assert.equal(packets[0].data.length, 0, `${name}: the transferred packet is detached`);
        assert.deepEqual(new Uint8Array(moved), copies[0]);
        for (let index = 1; index < packets.length; index++)
            assert.deepEqual(
                packets[index].data,
                copies[index],
                `${name}: packet ${index} changed`,
            );
        assert.deepEqual(
            configs.map(config => config.length),
            sizes,
            `${name}: codec configurations`,
        );
    }

    test('every packet user code receives owns a buffer it may transfer', async () => {
        // 64 MPEG-1 Layer III frames of 417 bytes, silent but numbered at byte 100, read through a
        // Source of the caller's.
        const frame = 417;
        const frames = new Uint8Array(frame * 64);
        for (let index = 0; index < 64; index++) {
            frames.set([0xff, 0xfb, 0x90, 0xc4], index * frame);
            frames[index * frame + 100] = index;
        }
        const inputs = [
            ...[
                'classic-aac.mp4',
                'audio-and-captions.mkv',
                'keyframe-and-deltas.webm',
                'aac-transport.ts',
                'four-frames.mp3',
                'four-frames.aac',
                'three-packets.opus',
            ].map(name => [name, originalFixtures[name]()]),
            [
                'numbered frames.mp3',
                { size: frames.length, read: async (at, length) => frames.slice(at, at + length) },
            ],
        ];
        for (const [name, input] of inputs) {
            const media = await open(input);
            const packets = [];
            for await (const packet of media.packets()) packets.push(packet);
            const configs = packets.map(packet => packet.codecConfig).filter(Boolean);
            const copies = packets.map(packet => packet.data.slice());
            // The bytes of the packets each track presents at each time.
            const shown = new Map();
            for (const [index, { trackId, timestamp }] of packets.entries()) {
                const key = `${trackId} ${timestamp}`;
                shown.set(key, [...(shown.get(key) ?? []), copies[index]]);
            }
            assertExclusive(name, packets, configs);
            // Packets read one by one own their bytes too, and the input reads the same after the
            // transfers.
            const read = [];
            for (const { trackId, timestamp } of packets) {
                const packet = await media.packetAt(trackId, timestamp);
                assert(
                    shown
                        .get(`${trackId} ${timestamp}`)
                        .some(bytes => isDeepStrictEqual(bytes, packet.data)),
                    `${name}: packetAt() reads the bytes of packets()`,
                );
                read.push(packet);
            }
            assertExclusive(`${name} packetAt()`, read, configs);
            let index = 0;
            for await (const packet of media.packets())
                assert.deepEqual(
                    packet.data,
                    copies[index++],
                    `${name}: packet ${index} read again`,
                );
            assert.equal(index, copies.length);
            media.close();
        }
    });

    test('an operation that reads the input again has its warnings in its result', async () => {
        // 360 pictures of 32 KiB (12 s, 11 MiB) with a keyframe each second: open() describes
        // the Matroska from its head and tail, and a range is copied from the input opened
        // again around it.
        const sink = new MemorySink();
        const muxer = new WebMMuxer(
            {
                format: 'mkv',
                mode: 'standard',
                video: {
                    id: 1,
                    type: 'video',
                    codec: 'avc1.42c00a',
                    codecConfig: avcc(),
                    width: 64,
                    height: 48,
                    framerate: 30,
                },
            },
            sink,
        );
        for (let index = 0; index < 360; index++)
            muxer.addVideoChunk({
                trackType: 'video',
                data: lengthPrefixed(4, index % 30 ? predicted : idr, filler(32 * 1024)),
                timestamp: index / 30,
                duration: 1 / 30,
                isKeyframe: index % 30 === 0,
            });
        await muxer.finalize();
        const bytes = sink.toUint8Array();
        const heard = [];
        const forge = new MediaForge({ onWarning: warning => heard.push(warning.code) });
        const codes = result => result.warnings.map(warning => warning.code);
        for (const target of [
            { start: 8.5, end: 10 },
            { to: 'mp4', start: 8.5, end: 10 },
        ]) {
            heard.length = 0;
            const expected = codes(await forge.convert(bytes, target));
            assert(expected.includes('TRIM_SNAPPED'), `${JSON.stringify(target)}: ${expected}`);
            assert.deepEqual(heard, expected);
            const media = await forge.open(bytes);
            // Each operation, also a repeated one, has the warnings the function has.
            for (const round of [1, 2]) {
                heard.length = 0;
                const result = await media.convert(target);
                assert.deepEqual(
                    codes(result),
                    expected,
                    `${JSON.stringify(target)} ${round}: result`,
                );
                assert.deepEqual(heard, expected, `${JSON.stringify(target)} ${round}: listener`);
            }
            media.close();
        }
    });
});
