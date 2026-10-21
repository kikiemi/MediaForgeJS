import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { describe, test } from 'node:test';
import { seededRandom } from '../helpers/pcm.mjs';
import { distUrl } from '../helpers/dist-paths.mjs';

const bytes = path => import(distUrl(`esm/core/bytes/${path}.js`));
const { BinaryWriter, BitSink } = await bytes('binary-writer');
const { BufferPool, ByteArena, isPooledBytes } = await bytes('buffer-pool');
const fields = await bytes('byte-fields');
const { holdBytes, releaseBytes, trackHolds } = await bytes('byte-holds');
const { concatBytes, sameBytes } = await bytes('bytes');
const { crc32 } = await bytes('crc32');
const { gcd } = await bytes('gcd');
const { inflateBase64, inflateRaw } = await bytes('inflate-raw');
const output = await bytes('output-data');
const { copiedBytes, ownBytes, packetBytes } = await bytes('shared-bytes');
const { attachedLength, attachedView } = await bytes('typed-array');
const { readerInto, registerReadInto } = await bytes('read-into');

describe('bytes', () => {
    describe('writers', () => {
        test('the binary writer grows as needed and returns a copy', () => {
            const writer = new BinaryWriter(1);
            writer.writeU8(0x1ff);
            writer.writeU16LE(0x0102);
            writer.writeU32LE(0xa0b0c0d0);
            writer.writeASCII('ok');
            writer.writeBytes(Uint8Array.of(7));
            writer.writeZeros(2);
            const written = writer.toUint8Array();
            assert.deepEqual(
                [...written],
                [0xff, 2, 1, 0xd0, 0xc0, 0xb0, 0xa0, 0x6f, 0x6b, 7, 0, 0],
            );
            writer.writeU8(9);
            assert.equal(written.length, 12, 'an earlier result is independent');
            assert.equal(writer.size, 13);
        });

        test('the binary writer refuses non-numbers and bad sizes', () => {
            const writer = new BinaryWriter();
            assert.throws(() => writer.writeU8('1'), { code: 'INPUT' });
            assert.throws(() => writer.writeZeros(-1), { code: 'INPUT' });
            assert.throws(() => new BinaryWriter(-1), { code: 'INPUT' });
        });

        test('the bit sink packs fields MSB first and pads to a byte', () => {
            const sink = new BitSink();
            sink.writeBits(0b101, 3);
            sink.writeBits(0x3ff, 10);
            sink.alignByte();
            sink.writeBits(0x12345678, 32);
            assert.deepEqual(
                [...sink.toUint8Array()],
                [0b10111111, 0b11111000, 0x12, 0x34, 0x56, 0x78],
            );
        });

        test('the bit sink writes wide fields, negatives sign-extended', () => {
            const sink = new BitSink();
            sink.writeBits(-1, 40);
            assert.deepEqual([...sink.toUint8Array()], [255, 255, 255, 255, 255]);
            assert.throws(() => sink.writeBits(1, -1), { code: 'INPUT' });
        });
    });

    describe('fields and checks', () => {
        test('reads big- and little-endian fields', () => {
            const data = Uint8Array.of(1, 2, 3, 4);
            assert.deepEqual(
                [
                    fields.u16be(data, 0),
                    fields.u32be(data, 0),
                    fields.u16le(data, 0),
                    fields.u24le(data, 0),
                    fields.u32le(data, 0),
                ],
                [0x0102, 0x01020304, 0x0201, 0x030201, 0x04030201],
            );
            assert.equal(fields.dataView(data.subarray(2)).getUint8(0), 3);
        });

        test('CRC-32 matches the IEEE check value and continues across blocks', () => {
            const text = new TextEncoder().encode('123456789');
            assert.equal(crc32(text), 0xcbf43926);
            assert.equal(crc32(text.subarray(4), crc32(text.subarray(0, 4))), 0xcbf43926);
        });

        test('gcd rounds to integers and is never zero', () => {
            assert.deepEqual([gcd(12, 18), gcd(-12, 18), gcd(0, 0), gcd(7.4, 0)], [6, 6, 1, 7]);
            assert.throws(() => gcd(Infinity, 1), { code: 'INPUT' });
        });

        test('compares and joins byte arrays', () => {
            assert.equal(sameBytes(Uint8Array.of(1, 2), Uint8Array.of(1, 2)), true);
            assert.equal(sameBytes(Uint8Array.of(1, 2), Uint8Array.of(1)), false);
            assert.equal(sameBytes(undefined, undefined), true);
            assert.equal(sameBytes(undefined, new Uint8Array(0)), false);
            assert.deepEqual(
                concatBytes([Uint8Array.of(1), new Uint8Array(0), Uint8Array.of(2, 3)]),
                Uint8Array.of(1, 2, 3),
            );
        });
    });

    describe('raw DEFLATE', () => {
        test('inflates stored, fixed and dynamic blocks', () => {
            const random = seededRandom(7);
            for (const input of [
                new Uint8Array(0),
                Uint8Array.from({ length: 70000 }, () => 65 + Math.floor(random() * 4)),
                Uint8Array.from({ length: 5000 }, () => Math.floor(random() * 256)),
                new TextEncoder().encode('abc'.repeat(1000)),
            ])
                for (const options of [{ level: 0 }, { strategy: 4 }, {}])
                    assert.deepEqual(
                        inflateRaw(deflateRawSync(input, options)),
                        input,
                        `${input.length} ${JSON.stringify(options)}`,
                    );
        });

        test('refuses cut data', () => {
            assert.throws(() => inflateRaw(deflateRawSync(new Uint8Array(4000)).subarray(0, 4)));
        });

        test('inflates base64 text', () => {
            const text = deflateRawSync(Buffer.from('hello')).toString('base64');
            assert.deepEqual(inflateBase64(text), new TextEncoder().encode('hello'));
        });
    });

    describe('buffer reuse', () => {
        test('a pooled buffer returns to its pool once every hold is released', () => {
            const pool = new BufferPool(16);
            const first = pool.acquire();
            assert.equal(isPooledBytes(first), true);
            assert.equal(holdBytes(first.subarray(4)), true, 'a view takes a hold');
            releaseBytes(first);
            assert.notEqual(pool.acquire(), first, 'still held by the view');
            releaseBytes(first.subarray(4));
            assert.equal(pool.acquire(), first, 'reused once free');
        });

        test('bytes of a buffer no one reuses take no hold', () => {
            assert.equal(holdBytes(new Uint8Array(4)), false);
            releaseBytes(new Uint8Array(4));
        });

        test('holds count down to the owner callback', () => {
            const buffer = new ArrayBuffer(4);
            let freed = 0;
            trackHolds(buffer, () => freed++);
            holdBytes(new Uint8Array(buffer));
            releaseBytes(new Uint8Array(buffer));
            assert.equal(freed, 0);
            releaseBytes(new Uint8Array(buffer));
            assert.equal(freed, 1);
        });

        test('an arena hands out bytes of pooled buffers until reset', () => {
            const pool = new BufferPool(8);
            const arena = new ByteArena(pool);
            const a = arena.allocate(5);
            const b = arena.allocate(3);
            const c = arena.allocate(4);
            assert.equal(a.buffer, b.buffer);
            assert.notEqual(a.buffer, c.buffer);
            assert.equal(
                arena.allocate(20).buffer.byteLength,
                20,
                'larger requests own their bytes',
            );
            arena.reset();
            assert.equal(pool.acquire().buffer, c.buffer, 'the last buffer comes back first');
        });

        test('small packets share buffers; large ones and kept ones get their own', () => {
            const small = packetBytes(10);
            const next = packetBytes(10);
            assert.equal(small.buffer, next.buffer);
            assert.notEqual(packetBytes(20000).buffer, small.buffer);
            const kept = ownBytes(small);
            assert.notEqual(kept.buffer, small.buffer, 'a copy does not keep the shared buffer');
            assert.deepEqual(copiedBytes(Uint8Array.of(4, 5)), Uint8Array.of(4, 5));
        });
    });

    describe('output bytes', () => {
        test('handed-off bytes may be adopted once, whole buffers only', () => {
            const whole = output.handOffOutput(new Uint8Array(8));
            assert.equal(output.adoptOutputBuffer(whole), whole.buffer);
            assert.equal(output.adoptOutputBuffer(whole), undefined, 'once');
            const part = output.handOffOutput(new Uint8Array(8).subarray(2));
            assert.equal(output.adoptOutputBuffer(part), undefined);
            assert.equal(output.adoptOutputBuffer(new Uint8Array(4)), undefined, 'not handed off');
        });

        test('a marked packet is retained as it is; anything else is copied', () => {
            const marked = new Uint8Array(512);
            output.markUnchangingBytes(marked);
            assert.equal(output.retainedBytes(marked).buffer, marked.buffer);
            const other = new Uint8Array(512);
            assert.notEqual(output.retainedBytes(other).buffer, other.buffer);
            output.forgetUnchangingBytes();
            assert.notEqual(output.retainedBytes(marked).buffer, marked.buffer);
        });

        test('output lengths need attached Uint8Arrays; limits need safe integers', () => {
            assert.equal(output.outputByteLength(new Uint8Array(3)), 3);
            assert.throws(() => output.outputByteLength(new Int8Array(3)), { code: 'IO' });
            assert.equal(output.outputByteLimit(undefined), Number.MAX_SAFE_INTEGER);
            assert.throws(() => output.outputByteLimit(-1), { code: 'INPUT' });
        });

        test('sink failures become IO errors with their context', () => {
            const error = output.outputError(new Error('disk full'), 'write failed');
            assert.deepEqual([error.code, error.message], ['IO', 'write failed: disk full']);
            assert.equal(output.outputError(error), error);
            assert.equal(output.outputError('gone', undefined, 'ABORT').code, 'ABORT');
        });

        test('typed arrays are read through the engine, not their own properties', () => {
            const fake = Uint8Array.of(1, 2, 3);
            Object.defineProperty(fake, 'length', { value: 99 });
            assert.equal(attachedLength(fake), 3);
            assert.throws(() => attachedLength(new Float32Array(1)), { code: 'INPUT' });
            assert.deepEqual(attachedView(fake), Uint8Array.of(1, 2, 3));
            const buffer = new ArrayBuffer(4);
            const view = new Uint8Array(buffer);
            structuredClone(buffer, { transfer: [buffer] });
            assert.throws(() => attachedLength(view), { code: 'INPUT' }, 'a detached buffer');
        });
    });

    describe('reads into caller bytes', () => {
        test('a declared read-into serves only while the source keeps its read', async () => {
            const source = {
                size: 4,
                async read(offset, length) {
                    return Uint8Array.of(1, 2, 3, 4).subarray(offset, offset + length);
                },
            };
            registerReadInto(source, source.read, async function (offset, target) {
                target.set((await this.read(offset, target.length)).slice());
            });
            const into = readerInto(source);
            const target = new Uint8Array(2);
            await into(1, target);
            assert.deepEqual(target, Uint8Array.of(2, 3));
            source.read = async () => new Uint8Array(0);
            assert.equal(readerInto(source), undefined);
        });
    });
});
