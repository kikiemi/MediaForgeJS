import assert from 'node:assert/strict';
import { createCipheriv, webcrypto } from 'node:crypto';
import { describe, test } from 'node:test';
import {
    createSampleAesHandler,
    decryptSampleAesAac,
    decryptSampleAesAvc,
} from 'mediaforgejs-player';

// HLS SAMPLE-AES: AAC frames and AVC NAL units decrypted alone, and segments (ADTS, MPEG-TS)
// through the handler the HLS client takes.

describe('SAMPLE-AES', () => {
    globalThis.crypto ??= webcrypto;
    const api = { decryptSampleAesAac, decryptSampleAesAvc, createSampleAesHandler };
    const key = Uint8Array.from({ length: 16 }, (_, i) => i * 11 + 3);
    const iv = Uint8Array.from({ length: 16 }, (_, i) => 255 - i * 7);
    function encryptBlocks(data, initial = iv) {
        const cipher = createCipheriv('aes-128-cbc', key, initial);
        cipher.setAutoPadding(false);
        return new Uint8Array(Buffer.concat([cipher.update(data), cipher.final()]));
    }
    function addPrevention(data) {
        const result = [];
        let zeros = 0;
        for (const byte of data) {
            if (zeros >= 2 && byte <= 3) {
                result.push(3);
                zeros = 0;
            }
            result.push(byte);
            zeros = byte === 0 ? zeros + 1 : 0;
        }
        return Uint8Array.from(result);
    }
    function encryptAvc(nal, initial = iv) {
        const output = new Uint8Array(nal);
        if (![1, 5].includes(output[0] & 31) || output.length <= 48) return output;
        const offsets = [];
        for (let offset = 32; offset + 16 < output.length; offset += 160) offsets.push(offset);
        const blocks = new Uint8Array(offsets.length * 16);
        offsets.forEach((offset, i) => blocks.set(output.subarray(offset, offset + 16), i * 16));
        const encrypted = encryptBlocks(blocks, initial);
        offsets.forEach((offset, i) => output.set(encrypted.subarray(i * 16, i * 16 + 16), offset));
        return addPrevention(output);
    }
    function adtsFrame(length, crc = false, seed = 0) {
        const frame = Uint8Array.from({ length }, (_, i) => (i * 67 + seed * 13 + 5) & 255);
        frame.set([
            0xff,
            crc ? 0xf0 : 0xf1,
            0x50,
            0x80 | (length >> 11),
            length >> 3,
            ((length & 7) << 5) | 31,
            0xfc,
        ]);
        if (crc) frame.set([0x12, 0x34], 7);
        return frame;
    }
    function encryptAac(frame, initial = iv) {
        const out = new Uint8Array(frame);
        const offset = (out[1] & 1 ? 7 : 9) + 16;
        const count = Math.max(0, Math.floor((out.length - offset) / 16)) * 16;
        if (count) out.set(encryptBlocks(out.subarray(offset, offset + count), initial), offset);
        return out;
    }

    const escaped = new Uint8Array(450).fill(0x76);
    escaped[0] = 0x65;
    for (const position of [4, 25, 59, 190, 350]) escaped.set([0, 0, 3, 1, 0, 0, 3, 3], position);
    const handler = api.createSampleAesHandler();
    const request = {
        key: { method: 'SAMPLE-AES', uri: 'key', iv: '0x' + Buffer.from(iv).toString('hex') },
        kind: 'segment',
        sequence: 3,
        uri: 'segment.aac',
        signal: new AbortController().signal,
        loadKey: async () => key.slice(),
    };
    const frames = [adtsFrame(80, false, 1), adtsFrame(111, true, 2), adtsFrame(55, false, 3)];
    const clearAudio = new Uint8Array(Buffer.concat(frames));
    const encryptedAudio = new Uint8Array(Buffer.concat(frames.map(frame => encryptAac(frame))));
    const code = wanted => error => error?.name === 'MediaForgeError' && error.code === wanted;
    const ts = Uint8Array.from(
        Buffer.from(
            'R0AAEAAAsA0AAcEAAAAB8AAqsQSy///////////////////////////////////////////////////' +
                '///////////////////////////////////////////////////////////////////////////////' +
                '///////////////////////////////////////////////////////////////////////////////' +
                '/////////////9HUAAwgAD/////////////////////////////////////////////////////////' +
                '///////////////////////////////////////////////////////////////////////////////' +
                '/////////////////////////////////AAKwMwABwQAA4QDwANvhAPAGDwR6YXZjz+EB8BYPBGFhY2' +
                'QFDmFwYWR6YWFjAAABAhGQqtymtkdBAD4HEAAAAAB+AAAAAeAAAIAAAAAAAAFlcHBwAAADAwEAAAMDA' +
                'wAAAwMBAAADAwMAAAMDAQAAAwMDAAADAwFhQxmEELN2f7dQ5YnqWCNwAAADAwMAAAMDAQAAAwMDAAAD' +
                'AwEAAAMDAwAAAwMBAAADAwMAAAMDAQAAAwMDAAADAwEAAAMDAwAAAwMBAAADAwMAAAMDAQAAAwMDAAA' +
                'DAwEAAAMDAwAAAwMBAAADAwMAAAMDAQAAAwMDAAADRwEAHwMBAAADAwMAAAMDAQAAAwMDAAADAwEAAA' +
                'MDAwAAAwMBAAADAwMAAAMDAQAAAwMDAAADAwEAAAMDAwAAAwMBAAADAwMAAAMDAZB8VGgeCMJmzmupT' +
                'J0u43IAAAMDAwAAAwMBAAADAwMAAAMDAQAAAwMDAAADAwEAAAMDAwAAAwMBAAADAwMAAAMDAQAAAwMD' +
                'AAADAwEAAAMDAwAAAwMBAAADAwMAAAMDAQAAAwMDAAADAwEAAAMDAwBHAQAQAAMDAQAAAwMDAAADAwE' +
                'AAAMDAwAAAwMBAAADAwMAAAMDAQAAAwMDAAADAwEAAAMDAwAAAwMBAAADAwMAAAMDAQAAAwMDAAADAw' +
                'EAAAMDAwAAAwMBqNrVBgCE7Wh3V+lrkh5KSwAAAwMDAAADAwEAAAMDAwAAAwMBAAADAwMAAAMDAQAAA' +
                'wMDAAADAwEAAAMDAwAAAwMBAAADAwMAAAMDAQAAAwMDAAADAwEAAAMDAwAAAwMBAAADA0cBABEDAAAD' +
                'AwEAAAMDAwAAAwMBAAADAwMAAAMDAQAAAwMDAAADAwEAAAMDAwAAAwMBAAADAwMAAAMDAQAAAwMDAAA' +
                'DAwEAAAMDAwAAAwMBAAADAwMAAAMDAQAAAwMDAAADAwH7jM7HXN1AI9ioJlPCIk0JAAADAwMAAAMDAQ' +
                'AAAwMDAAADAwEAAAMDAwAAAwMBAAADAwMAAAMDAQAAAwMDAAADAwEAAAMDAwAAAwMBAAADAwMAAAMDA' +
                'QAARwEAEgMDAwAAAwMBAAADAwMAAAMDAQAAAwMDAAADAwEAAAMDAwAAAwMBAAADAwMAAAMDAQAAAwMD' +
                'AAADAwEAAAMDAwAAAwMBAAADAwMAAAMDAQAAAwMDAAADAwEAAAMDAwAAAwMBAAADAwMAAAMDAetkpOt' +
                'sHCm+iqj6ymrGwFoAAAMDAwAAAwMBAAADAwMAAAMDAQAAAwMDAAADAwEAAAMDAwAAAwMBAAADAwMAAA' +
                'MDAQAAAwMDAAADAwFHAQATAAADAwMAAAMDAQAAAwMDAAADAwEAAAMDAwAAAwMBAAADAwMAAAMDAQAAA' +
                'wMDAAADAwEAAAMDAwAAAwMBAAADAwMAAAMDAQAAAwMDAAADAwEAAAMDAwAAAwMBAAADAwMAAAMDAQAA' +
                'AwMDAAADAwEAAAMDAwAAAwMB14OdIoc9wQq2ZAqZNOFq8AAAAwMDAAADAwEAAAMDAwAAAwMBAAADAwM' +
                'AAAMDAQAAAwMDAAADAwEAAAMDAwAAA0cBADSoAP////////////////////////////////////////' +
                '///////////////////////////////////////////////////////////////////////////////' +
                '///////////////////////////////////////////////////////////////////////////////' +
                '////////////////////////AwEAAAMDA3BwcHBwcHBwR0EBNF4A///////////////////////////' +
                '///////////////////////////////////////////////////////////////////////////////' +
                '//////////////////AAABwABTgAAA//FQgAof/NodYKPmKWyv8jV4u/5BhMdl/rsaVeDNgCjnw988Y' +
                'SjnK8U559UDxlyqktkKwGdRA+bJV7RKERZvjIgM6tURLGea3SBjpuksb7I=',
            'base64',
        ),
    );
    const restore = () => handler.decrypt({ ...request, uri: 'mini.ts', data: ts });
    function payloads(bytes, pid) {
        const result = [];
        let previous;
        for (let at = 0; at < bytes.length; at += 188) {
            if ((((bytes[at + 1] & 31) << 8) | bytes[at + 2]) !== pid) continue;
            const hasPayload = (bytes[at + 3] & 0x10) !== 0;
            const count = bytes[at + 3] & 15;
            if (previous !== undefined)
                assert.equal(count, (previous + (hasPayload ? 1 : 0)) & 15, 'restored continuity');
            previous = count;
            if (hasPayload) {
                const begin = at + 4 + (bytes[at + 3] & 0x20 ? bytes[at + 4] + 1 : 0);
                result.push(bytes.subarray(begin, at + 188));
            }
        }
        return new Uint8Array(Buffer.concat(result));
    }
    const expectedNal = new Uint8Array(900).fill(0x70);
    expectedNal[0] = 0x65;
    for (let i = 4; i + 8 < expectedNal.length; i += 8)
        expectedNal.set([0, 0, 3, 1, 0, 0, 3, 3], i);
    function duplicatePacket(bytes, at, edit = () => {}, count = 1) {
        const duplicate = bytes.slice(at, at + 188);
        edit(duplicate);
        return new Uint8Array(
            Buffer.concat([
                bytes.subarray(0, at + 188),
                ...Array.from({ length: count }, () => duplicate),
                bytes.subarray(at + 188),
            ]),
        );
    }

    test('AAC frames decrypt at every length, with and without CRC', async () => {
        for (const crc of [false, true]) {
            for (const length of [9, 22, 23, 24, 38, 39, 40, 54, 55, 56, 8191]) {
                const clear = adtsFrame(length, crc);
                const encrypted = encryptAac(clear);
                assert.deepEqual(
                    await api.decryptSampleAesAac(encrypted, key, iv),
                    clear,
                    `AAC length=${length} crc=${crc}`,
                );
                assert.deepEqual(encrypted, encryptAac(clear), 'helper preserves encrypted input');
            }
        }
    });

    test('AVC NAL units decrypt at every length and type, leaving the input', async () => {
        for (const length of [1, 16, 31, 32, 47, 48, 49, 191, 192, 207, 208, 209, 500, 4096]) {
            for (const nalType of [1, 5, 7, 9]) {
                const clear = Uint8Array.from({ length }, (_, i) => ((i * 37 + 11) % 251) + 4);
                clear[0] = 0x60 | nalType;
                const encrypted = encryptAvc(clear);
                assert.deepEqual(
                    await api.decryptSampleAesAvc(encrypted, key, iv),
                    clear,
                    `AVC length=${length} type=${nalType}`,
                );
                assert.deepEqual(
                    encrypted,
                    encryptAvc(clear),
                    'helper preserves encrypted NAL input',
                );
            }
        }
    });

    test('prevention bytes that encryption added go; the original ones stay', async () => {
        assert.deepEqual(
            await api.decryptSampleAesAvc(encryptAvc(escaped), key, iv),
            escaped,
            'outer prevention is removed once, original prevention survives',
        );
    });

    test('the handler takes SAMPLE-AES segments of identity keys only', async () => {
        assert.equal(handler.supports(request), true);
        assert.equal(handler.supports({ ...request, kind: 'part' }), false);
        assert.equal(handler.supports({ ...request, kind: 'map' }), false);
        assert.equal(handler.supports({ ...request, map: { uri: 'init.mp4' } }), false);
        assert.equal(
            handler.supports({ ...request, key: { ...request.key, keyFormatVersions: '2' } }),
            false,
        );
        assert.equal(
            handler.supports({ ...request, key: { ...request.key, keyFormatVersions: '2/1' } }),
            true,
        );
        assert.equal(
            handler.supports({ ...request, key: { ...request.key, method: 'SAMPLE-AES-CTR' } }),
            false,
        );
        assert.equal(
            handler.supports({
                ...request,
                key: { ...request.key, keyFormat: 'com.apple.streamingkeydelivery' },
            }),
            false,
        );
    });

    test('the IV resets at each ADTS frame of a segment', async () => {
        assert.deepEqual(
            await handler.decrypt({ ...request, data: encryptedAudio }),
            clearAudio,
            'IV resets at each ADTS frame',
        );
        assert.deepEqual(
            encryptedAudio,
            new Uint8Array(Buffer.concat(frames.map(frame => encryptAac(frame)))),
        );
    });

    test('the IV defaults to the media sequence', async () => {
        const sequenceIv = new Uint8Array(16);
        sequenceIv[15] = 3;
        assert.deepEqual(
            await handler.decrypt({
                ...request,
                key: { method: 'SAMPLE-AES', uri: 'key' },
                data: encryptAac(frames[0], sequenceIv),
            }),
            frames[0],
            'implicit IV is media sequence',
        );
    });

    test('malformed keys, IVs and data are DEMUX, unplayed requests FORMAT', async () => {
        await assert.rejects(
            api.decryptSampleAesAac(frames[0], new Uint8Array(15), iv),
            code('DEMUX'),
        );
        await assert.rejects(
            api.decryptSampleAesAvc(escaped, key, new Uint8Array(15)),
            code('DEMUX'),
        );
        await assert.rejects(api.decryptSampleAesAac(new Uint8Array(20), key, iv), code('DEMUX'));
        await assert.rejects(
            handler.decrypt({
                ...request,
                data: encryptedAudio.subarray(0, encryptedAudio.length - 1),
            }),
            code('DEMUX'),
        );
        await assert.rejects(
            handler.decrypt({
                ...request,
                key: { ...request.key, iv: '0xgg' },
                data: encryptedAudio,
            }),
            code('DEMUX'),
        );
        await assert.rejects(
            handler.decrypt({ ...request, sequence: -1, data: encryptedAudio }),
            code('FORMAT'),
        );
        await assert.rejects(
            handler.decrypt({ ...request, kind: 'part', data: encryptedAudio }),
            code('FORMAT'),
        );
        await assert.rejects(
            handler.decrypt({
                ...request,
                data: Uint8Array.from([0, 0, 0, 8, 102, 116, 121, 112]),
            }),
            code('FORMAT'),
        );
    });

    test('abort stops a pending key load and a decryption', async () => {
        const controller = new AbortController();
        const pending = handler.decrypt({
            ...request,
            signal: controller.signal,
            data: encryptedAudio,
            loadKey: () => new Promise(() => {}),
        });
        controller.abort();
        await assert.rejects(pending, code('ABORT'));
        await assert.rejects(
            api.decryptSampleAesAvc(escaped, key, iv, controller.signal),
            code('ABORT'),
        );
    });

    test('an MPEG-TS segment decrypts with continuity, PMT CRC and PCR restored', async () => {
        const restoredTs = await restore();
        assert.equal(restoredTs.length, ts.length, 'TS packet count is stable');
        assert.deepEqual(
            payloads(restoredTs, 256).subarray(13),
            expectedNal,
            'TS removal of outer AVC emulation prevention',
        );
        assert.deepEqual(
            payloads(restoredTs, 257).subarray(9),
            adtsFrame(80),
            'TS AAC IV reset and final partial block',
        );
        const pmt = payloads(restoredTs, 4096).subarray(1);
        assert.equal(pmt[12], 0x1b);
        assert.equal(pmt[17], 0x0f);
        let crc = 0xffffffff;
        for (const byte of pmt) {
            crc ^= byte << 24;
            for (let bit = 0; bit < 8; bit++)
                crc = crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
        }
        assert.equal(crc >>> 0, 0, 'restored PMT CRC');
        assert.deepEqual(restoredTs.subarray(382, 388), ts.subarray(382, 388), 'PCR is preserved');
    });

    test('a damaged or cut MPEG-TS segment fails with DEMUX', async () => {
        const malformedTs = ts.slice();
        malformedTs[13] ^= 1;
        await assert.rejects(handler.decrypt({ ...request, data: malformedTs }), code('DEMUX'));
        await assert.rejects(
            handler.decrypt({ ...request, data: ts.subarray(0, -1) }),
            code('DEMUX'),
        );
    });

    test('a duplicated TS packet is consumed once, its PCR kept', async () => {
        for (const at of [0, 188, 376, 564, ts.length - 188]) {
            const duplicated = duplicatePacket(ts, at);
            const restoredDuplicate = await handler.decrypt({ ...request, data: duplicated });
            assert.equal(restoredDuplicate.length, duplicated.length);
            assert.deepEqual(
                payloads(restoredDuplicate, 256).subarray(13),
                expectedNal,
                'duplicate payload is consumed once',
            );
            assert.deepEqual(payloads(restoredDuplicate, 257).subarray(9), adtsFrame(80));
        }
        const pcrDuplicate = duplicatePacket(ts, 376, packet => {
            packet[11] = 1;
        });
        const restoredPcrDuplicate = await handler.decrypt({ ...request, data: pcrDuplicate });
        assert.deepEqual(
            restoredPcrDuplicate.subarray(570, 576),
            pcrDuplicate.subarray(570, 576),
            'duplicate PCR survives',
        );
        assert.deepEqual(payloads(restoredPcrDuplicate, 256).subarray(13), expectedNal);
    });

    test('duplicates that differ, or repeat twice, fail with DEMUX', async () => {
        await assert.rejects(
            handler.decrypt({
                ...request,
                data: duplicatePacket(ts, 564, packet => {
                    packet[25] ^= 1;
                }),
            }),
            code('DEMUX'),
        );
        await assert.rejects(
            handler.decrypt({
                ...request,
                data: duplicatePacket(ts, 564, packet => {
                    packet[1] ^= 0x20;
                }),
            }),
            code('DEMUX'),
        );
        await assert.rejects(
            handler.decrypt({ ...request, data: duplicatePacket(ts, 564, () => {}, 2) }),
            code('DEMUX'),
        );
    });

    test('a discontinuity indicator allows a duplicate only where the stream starts', async () => {
        const initialReset = ts.slice();
        initialReset[381] |= 0x80;
        assert.deepEqual(
            payloads(
                await handler.decrypt({ ...request, data: duplicatePacket(initialReset, 376) }),
                256,
            ).subarray(13),
            expectedNal,
        );
        await assert.rejects(
            handler.decrypt({ ...request, data: duplicatePacket(initialReset, 376, () => {}, 2) }),
            code('DEMUX'),
        );
        const insideReset = ts.slice();
        for (let at = 564; at < insideReset.length; at += 188) {
            if (
                (((insideReset[at + 1] & 31) << 8) | insideReset[at + 2]) === 256 &&
                insideReset[at + 3] & 0x20 &&
                insideReset[at + 4] > 0
            ) {
                insideReset[at + 5] |= 0x80;
                break;
            }
        }
        await assert.rejects(handler.decrypt({ ...request, data: insideReset }), code('DEMUX'));
    });

    test('an ID3 header without its footer fails with DEMUX', async () => {
        const badFooter = new Uint8Array(
            Buffer.concat([
                Buffer.from([0x49, 0x44, 0x33, 4, 0, 0x10, 0, 0, 0, 0]),
                Buffer.alloc(10),
                encryptAac(adtsFrame(80)),
            ]),
        );
        await assert.rejects(handler.decrypt({ ...request, data: badFooter }), code('DEMUX'));
    });

    test('a segment of too many frames reaches a size limit (OOM)', async () => {
        const manyFrames = new Uint8Array(700007);
        const emptyFrame = adtsFrame(7);
        for (let offset = 0; offset < manyFrames.length; offset += 7)
            manyFrames.set(emptyFrame, offset);
        await assert.rejects(handler.decrypt({ ...request, data: manyFrames }), code('OOM'));
    });
});
