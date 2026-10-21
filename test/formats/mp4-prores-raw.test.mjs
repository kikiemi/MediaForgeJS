import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
    atom,
    atomList,
    preservationFixture,
    preservationSource,
    inspectMovie,
} from '../helpers/mp4-preservation-fixture.mjs';
import { proResRawFrames } from '../helpers/prores-raw-fixtures.mjs';
import { capabilities, check, convert, open } from 'mediaforgejs';
import { MemorySink } from 'mediaforgejs/io';

describe('mp4: ProRes RAW in MOV', () => {
    const bytesOf = async blob => new Uint8Array(await blob.arrayBuffer());
    const track = (codec, data = proResRawFrames[codec]) => ({
        id: codec === 'aprn' ? 7 : 9,
        type: 'video',
        codec,
        width: 32,
        height: 24,
        framerate: 25,
        default: codec === 'aprn',
        forced: false,
        name: `${codec} sensor`,
        title: 'Original Bayer pattern',
        language: 'eng',
        packets: [data, data],
    });

    test('ProRes RAW capability queries distinguish RAW from ordinary ProRes', async () => {
        const { videoCopy } = await capabilities();
        for (const codec of ['aprn', 'aprh']) {
            assert.equal(videoCopy.mov.includes(codec), true);
            for (const format of ['mp4', 'mkv', 'webm', 'ts'])
                assert.equal(videoCopy[format].includes(codec), false);
        }
    });

    for (const codec of ['aprn', 'aprh']) {
        for (const copy of [true, undefined]) {
            test(
                `convert (copy ${copy}) copies complete ${codec} packets and track metadata to ` +
                    `MOV`,
                async () => {
                    const input = rawMovie([track(codec)]);
                    const checked = await check(input, 'mov', { copy });
                    assert.equal(checked.supported, true, checked.reason);
                    assert.equal(checked.plan.action, 'copy');
                    const output = await bytesOf((await convert(input, 'mov', { copy })).blob);
                    const parsed = inspectMovie(output);
                    const actual = parsed.tracks[0];
                    for (const name of ['codec', 'name', 'title', 'default', 'forced'])
                        assert.equal(actual[name], track(codec)[name], name);
                    assert.deepEqual(movieLanguages(output), ['eng']);
                    assert.deepEqual(
                        actual.packets,
                        track(codec).packets.map(data => [...data]),
                    );
                },
            );
        }
        test(`${codec} copies into a standard MOV through a sink`, async () => {
            const input = new Blob([rawMovie([track(codec)])]);
            const sink = new MemorySink();
            await convert(input, 'mov', { sink });
            const parsed = inspectMovie(await bytesOf(sink.toBlob()));
            assert.deepEqual(
                parsed.tracks[0].packets,
                track(codec).packets.map(data => [...data]),
            );
        });
    }

    test('MOV retains independent ProRes RAW video tracks', async () => {
        const original = ['aprn', 'aprh'].map(codec => track(codec));
        const media = await open(rawMovie(original));
        try {
            const checked = await media.check('mov', { copy: true });
            assert.equal(checked.supported, true, checked.reason);
            const output = inspectMovie(
                await bytesOf((await media.convert('mov', { copy: true })).blob),
            );
            assert.equal(output.tracks.length, 2);
            for (let i = 0; i < 2; i++) {
                assert.equal(output.tracks[i].codec, original[i].codec);
                assert.equal(output.tracks[i].default, original[i].default);
                assert.deepEqual(
                    output.tracks[i].packets,
                    original[i].packets.map(data => [...data]),
                );
            }
        } finally {
            media.close();
        }
    });

    test('check and output both reject damaged ProRes RAW headers or tiles', async () => {
        for (const mutate of [
            data => {
                data[4] = 0;
            },
            data => {
                data[10] = 1;
            },
            data => {
                data[19] = 25;
            },
            data => {
                data[80] = 0xff;
                data[81] = 0xff;
            },
        ]) {
            const data = proResRawFrames.aprn.slice();
            mutate(data);
            const input = rawMovie([track('aprn', data)]);
            const checked = await check(input, 'mov', { copy: true });
            assert.equal(checked.supported, false);
            assert.match(checked.reason, /ProRes RAW/);
            await assert.rejects(convert(input, 'mov', { copy: true }), /ProRes RAW/);
        }
    });

    for (const codec of ['aprn', 'aprh']) {
        test(
            `${codec} unsupported destinations reject actual checks and writes without ` + `output`,
            async () => {
                const input = rawMovie([track(codec)]);
                const media = await open(preservationSource(input));
                try {
                    for (const format of [
                        'mp4',
                        'm4v',
                        '3gp',
                        'mkv',
                        'webm',
                        'ts',
                        'flv',
                        'avi',
                        'fmp4',
                    ]) {
                        const validated = await media.check(format, { copy: true });
                        assert.equal(validated.supported, false, format);
                        const failure = { code: validated.code, message: validated.reason };
                        await assert.rejects(media.convert(format, { copy: true }), failure);
                        let written = 0;
                        const sink = {
                            write(data) {
                                written += data.length;
                            },
                            async close() {},
                            async abort() {},
                        };
                        await assert.rejects(media.convert(format, { copy: true, sink }), failure);
                        assert.equal(written, 0, `${format} must reject before emitting bytes`);
                        const supported = await check(preservationSource(input), format, {
                            copy: true,
                        });
                        assert.equal(supported.supported, false, format);
                        assert.equal(supported.code, validated.code, format);
                        assert.equal(supported.reason, validated.reason, format);
                        await assert.rejects(
                            convert(preservationSource(input), format, { copy: true }),
                            failure,
                        );
                        await assert.rejects(
                            convert(preservationSource(input), format, { copy: true, sink }),
                            failure,
                        );
                        assert.equal(written, 0, `${format} must reject before emitting bytes`);
                    }
                } finally {
                    media.close();
                }
            },
        );

        test(
            `${codec} Source copy preserves MOV edit lists, composition offsets, and variable ` +
                `sample durations`,
            async () => {
                const input = timedRawMovie(codec);
                const media = await open(preservationSource(input));
                try {
                    const packets = await Array.fromAsync(media.packets());
                    assertPacketTimes(packets);
                    assert.equal(media.tracks[0].timescale, 1000);
                    assert.equal(Math.round(media.tracks[0].duration * 1000), 180);
                    const validated = await media.check('mov', { copy: true });
                    assert.equal(validated.supported, true, validated.reason);
                    const outputs = [
                        await bytesOf((await media.convert('mov', { copy: true })).blob),
                    ];
                    for (const copy of [true, undefined]) {
                        const checked = await check(preservationSource(input), 'mov', { copy });
                        assert.equal(checked.supported, true, checked.reason);
                        outputs.push(
                            await bytesOf(
                                (await convert(preservationSource(input), 'mov', { copy })).blob,
                            ),
                        );
                    }
                    for (const bytes of outputs) {
                        const parsed = inspectMovie(bytes);
                        assert.equal(parsed.tracks[0].codec, codec);
                        assert.deepEqual(
                            parsed.tracks[0].packets,
                            Array.from({ length: 3 }, () => [...proResRawFrames[codec]]),
                        );
                        assert.equal(parsed.tracks[0].name, `${codec} sensor`);
                        assert.equal(parsed.tracks[0].title, 'Original Bayer pattern');
                        assert.deepEqual(movieLanguages(bytes), ['eng']);
                        assert.deepEqual(movieTiming(bytes), {
                            mediaTimescale: 1000,
                            durations: [40, 60, 80],
                            compositionOffsets: [20, 0, 10],
                            edits: [
                                [80, -1, 1],
                                [100, 40, 1],
                            ],
                        });
                        const output = await open(preservationSource(bytes));
                        try {
                            assertPacketTimes(await Array.fromAsync(output.packets()));
                            assert.equal(Math.round(output.tracks[0].duration * 1000), 180);
                        } finally {
                            output.close();
                        }
                    }
                } finally {
                    media.close();
                }
            },
        );
    }

    const words = values => {
        const bytes = Buffer.alloc(values.length * 4);
        values.forEach((value, index) => bytes.writeUInt32BE(value >>> 0, index * 4));
        return bytes;
    };

    function mediaHeaders(bytes) {
        const child = (parent, type) =>
            atomList(bytes, parent.payload, parent.end).find(entry => entry.type === type);
        const movie = atomList(bytes).find(entry => entry.type === 'moov');
        return atomList(bytes, movie.payload, movie.end)
            .filter(entry => entry.type === 'trak')
            .map(track => child(child(track, 'mdia'), 'mdhd'));
    }

    function rawMovie(tracks) {
        const bytes = preservationFixture({ mov: true, tracks }).bytes;
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        for (const header of mediaHeaders(bytes))
            view.setUint16(header.payload + (bytes[header.payload] === 1 ? 32 : 20), 0x15c7);
        return bytes;
    }

    function movieLanguages(input) {
        const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
        return mediaHeaders(bytes).map(header => {
            const code = bytes.readUInt16BE(
                header.payload + (bytes[header.payload] === 1 ? 32 : 20),
            );
            return String.fromCharCode(
                0x60 + ((code >> 10) & 31),
                0x60 + ((code >> 5) & 31),
                0x60 + (code & 31),
            );
        });
    }

    function timedRawMovie(codec) {
        const original = track(codec);
        original.packets.push(proResRawFrames[codec]);
        const bytes = rawMovie([original]);
        const rewrite = entry => {
            if (['moov', 'trak', 'mdia', 'minf', 'stbl'].includes(entry.type)) {
                const children = atomList(bytes, entry.payload, entry.end).map(rewrite);
                if (entry.type === 'stbl')
                    children.push(atom('ctts', words([0, 3, 1, 20, 1, 0, 1, 10])));
                if (entry.type === 'trak')
                    children.push(
                        atom(
                            'edts',
                            atom('elst', words([0, 2, 80, -1, 0x10000, 100, 40, 0x10000])),
                        ),
                    );
                return atom(entry.type, ...children);
            }
            if (entry.type === 'stts') return atom('stts', words([0, 3, 1, 40, 1, 60, 1, 80]));
            const data = Buffer.from(bytes.subarray(entry.offset, entry.end));
            if (entry.type === 'mvhd' || entry.type === 'mdhd') data.writeUInt32BE(180, 24);
            if (entry.type === 'tkhd') data.writeUInt32BE(180, 28);
            return data;
        };
        return new Uint8Array(Buffer.concat(atomList(bytes).map(rewrite)));
    }

    function assertPacketTimes(packets) {
        assert.deepEqual(
            packets.map(packet => Math.round(packet.timestamp * 1000)),
            [60, 80, 150],
        );
        assert.deepEqual(
            packets.map(packet => Math.round(packet.decodeTimestamp * 1000)),
            [40, 80, 140],
        );
        assert.deepEqual(
            packets.map(packet => Math.round(packet.duration * 1000)),
            [40, 60, 80],
        );
    }

    function movieTiming(input) {
        const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
        const child = (parent, type) =>
            atomList(bytes, parent.payload, parent.end).find(entry => entry.type === type);
        const movie = atomList(bytes).find(entry => entry.type === 'moov');
        const track = child(movie, 'trak');
        const media = child(track, 'mdia');
        const mediaHeader = child(media, 'mdhd');
        const mediaTimescale = bytes.readUInt32BE(
            mediaHeader.payload + (bytes[mediaHeader.payload] === 1 ? 20 : 12),
        );
        const movieHeader = child(movie, 'mvhd');
        const movieTimescale = bytes.readUInt32BE(
            movieHeader.payload + (bytes[movieHeader.payload] === 1 ? 20 : 12),
        );
        const table = child(child(media, 'minf'), 'stbl');
        const expand = name => {
            const box = child(table, name);
            const values = [];
            for (
                let index = 0, count = bytes.readUInt32BE(box.payload + 4);
                index < count;
                index++
            ) {
                const offset = box.payload + 8 + index * 8;
                const value =
                    name === 'ctts' && bytes[box.payload] === 1
                        ? bytes.readInt32BE(offset + 4)
                        : bytes.readUInt32BE(offset + 4);
                values.push(
                    ...Array(bytes.readUInt32BE(offset)).fill(
                        Math.round((value * 1000) / mediaTimescale),
                    ),
                );
            }
            return values;
        };
        const editList = child(child(track, 'edts'), 'elst');
        const wide = bytes[editList.payload] === 1;
        const edits = [];
        for (
            let index = 0, count = bytes.readUInt32BE(editList.payload + 4);
            index < count;
            index++
        ) {
            const offset = editList.payload + 8 + index * (wide ? 20 : 12);
            const duration = wide
                ? Number(bytes.readBigUInt64BE(offset))
                : bytes.readUInt32BE(offset);
            const time = wide
                ? Number(bytes.readBigInt64BE(offset + 8))
                : bytes.readInt32BE(offset + 4);
            const rateOffset = offset + (wide ? 16 : 8);
            const rate = bytes.readInt16BE(rateOffset) + bytes.readUInt16BE(rateOffset + 2) / 65536;
            edits.push([
                Math.round((duration * 1000) / movieTimescale),
                time === -1 ? -1 : Math.round((time * 1000) / mediaTimescale),
                rate,
            ]);
        }
        return {
            mediaTimescale,
            durations: expand('stts'),
            compositionOffsets: expand('ctts'),
            edits,
        };
    }
});
