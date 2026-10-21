import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, test } from 'node:test';
import { convert, frames, inspect, open } from 'mediaforgejs';
import * as lite from 'mediaforgejs/lite';
import { aac } from 'mediaforgejs/plugins';
import { BufferSource, MemorySink } from 'mediaforgejs/io';
import { Mp4Demuxer, Mp4Muxer, WebMDemuxer, WebMMuxer } from 'mediaforgejs/formats';
import { CmafWriter } from 'mediaforgejs/streaming';
import { proresFrames } from '../helpers/prores-fixtures.mjs';
import {
    preservationFixture,
    preservationSource,
    inspectMovie,
    atom,
    atomList,
    avcc,
    asc,
} from '../helpers/mp4-preservation-fixture.mjs';
import { classicMp4, fixtureSource } from '../helpers/mp4-fixture.mjs';
import { MAIN_FIXTURE, avccPackets } from '../helpers/h264-fixtures.mjs';
import { readMedia } from '../helpers/read-media.mjs';
import { encodeAacLc } from 'mediaforgejs/codecs';

// What MP4 and MOV copies keep of their input: titles and track metadata, sample tables, edit
// lists and timing, codec records, and what a copy elsewhere must report lost.

describe('mp4: what copies keep', () => {
    const metadata = track => ({
        default: track.default,
        forced: track.forced,
        name: track.name,
        title: track.title,
    });
    const demux = bytes => new Mp4Demuxer().demux(preservationSource(bytes));

    function sampleTables(bytes, trackIndex = 0) {
        const child = (parent, type) =>
            atomList(bytes, parent.payload, parent.end).find(atom => atom.type === type);
        const moov = atomList(bytes).find(atom => atom.type === 'moov');
        const trak = atomList(bytes, moov.payload, moov.end).filter(atom => atom.type === 'trak')[
            trackIndex
        ];
        const stbl = child(child(child(trak, 'mdia'), 'minf'), 'stbl');
        return new Map(atomList(bytes, stbl.payload, stbl.end).map(atom => [atom.type, atom]));
    }

    function editLists(bytes) {
        const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const child = (parent, type) =>
            atomList(data, parent.payload, parent.end).find(atom => atom.type === type);
        const timescale = header =>
            data.readUInt32BE(header.payload + (data[header.payload] === 1 ? 20 : 12));
        const moov = atomList(data).find(atom => atom.type === 'moov');
        const movieTimescale = timescale(child(moov, 'mvhd'));
        return atomList(data, moov.payload, moov.end)
            .filter(atom => atom.type === 'trak')
            .map(trak => {
                const mediaTimescale = timescale(child(child(trak, 'mdia'), 'mdhd'));
                const edts = child(trak, 'edts');
                if (!edts)
                    return { movieTimescale, mediaTimescale, version: undefined, entries: [] };
                const elst = child(edts, 'elst');
                const version = data[elst.payload];
                const entries = [];
                for (
                    let index = 0, count = data.readUInt32BE(elst.payload + 4);
                    index < count;
                    index++
                ) {
                    const at = elst.payload + 8 + index * (version === 1 ? 20 : 12);
                    entries.push(
                        version === 1
                            ? [
                                  Number(data.readBigUInt64BE(at)),
                                  Number(data.readBigInt64BE(at + 8)),
                                  data.readUInt32BE(at + 16),
                              ]
                            : [
                                  data.readUInt32BE(at),
                                  data.readInt32BE(at + 4),
                                  data.readUInt32BE(at + 8),
                              ],
                    );
                }
                return { movieTimescale, mediaTimescale, version, entries };
            });
    }

    function timingValues(bytes, atom) {
        if (!atom) return [];
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const values = [];
        const signed = atom.type === 'ctts' && bytes[atom.payload] === 1;
        const count = view.getUint32(atom.payload + 4);
        for (let i = 0; i < count; i++) {
            const offset = atom.payload + 8 + i * 8;
            const length = view.getUint32(offset);
            const value = signed ? view.getInt32(offset + 4) : view.getUint32(offset + 4);
            for (let j = 0; j < length; j++) values.push(value);
        }
        return values;
    }

    test('independent fixture is structurally valid', async () => {
        const fixture = preservationFixture({ title: 'Original movie — 東京' });
        const parsed = inspectMovie(fixture.bytes);
        assert.equal(parsed.title, 'Original movie — 東京');
        assert.deepEqual(
            parsed.tracks.map(track => track.packets),
            fixture.tracks.map(track => track.packets.map(packet => [...packet])),
        );
        assert.deepEqual(
            parsed.tracks.map(track => track.default),
            [false, true, true, true],
        );
    });

    test('demux reads independent multiple audio/video metadata', async () => {
        const fixture = preservationFixture({ title: 'Original movie — 東京' });
        const expected = inspectMovie(fixture.bytes);
        const actual = await demux(fixture.bytes);
        assert.equal(actual.title, expected.title);
        const tracks = [...actual.videoTracks, ...actual.audioTracks];
        for (const track of expected.tracks)
            assert.deepEqual(
                metadata(tracks.find(value => value.id === track.id)),
                metadata(track),
            );
        assert.equal(tracks.find(track => track.id === 14).commentary, true);
    });

    for (const titleMode of ['legacy', 'ilst', 'mdta']) {
        test(`demux reads ${titleMode} titles independently of names`, async () => {
            for (const title of ['Track title — 日本語', '']) {
                const fixture = preservationFixture({
                    title,
                    titleMode,
                    tracks: [{ type: 'audio', title, titleMode, name: 'Independent name' }],
                });
                const result = await demux(fixture.bytes);
                assert.equal(result.title, title);
                assert.equal(result.audioTracks[0].title, title);
                assert.equal(result.audioTracks[0].name, 'Independent name');
            }
        });
    }

    for (const options of [
        { nameMode: 'utf16' },
        { nameMode: 'hdlr' },
        { nameMode: 'hdlr', pascalHandler: true },
    ]) {
        test(`demux reads name ${JSON.stringify(options)}`, async () => {
            const fixture = preservationFixture({
                tracks: [{ type: 'audio', name: 'Música 日本語', ...options }],
            });
            assert.equal((await demux(fixture.bytes)).audioTracks[0].name, 'Música 日本語');
        });
    }

    test('demux accepts a legacy MacRoman QuickTime handler name', async () => {
        const fixture = preservationFixture({
            tracks: [
                {
                    type: 'audio',
                    nameMode: 'hdlr',
                    name: 'Café',
                    pascalHandler: true,
                    handlerBytes: Buffer.from([67, 97, 102, 0x8e]),
                },
            ],
        });
        assert.equal((await demux(fixture.bytes)).audioTracks[0].name, 'Café');
    });

    test(
        'demux reads handler names in either string layout without rejecting the ' + 'file',
        async () => {
            const utf8 = text => Buffer.from(text, 'utf8');
            const pascal = text => Buffer.concat([Buffer.of(utf8(text).length), utf8(text)]);
            const cases = [
                [
                    'QuickTime component with a C string',
                    { handlerComponent: 'mhlr', handlerField: utf8('Core Media Audio\0') },
                ],
                ['ISO handler with a Pascal string', { handlerField: pascal('SoundHandler') }],
                [
                    'Pascal string padded with NULs',
                    {
                        handlerComponent: 'mhlr',
                        handlerField: Buffer.concat([pascal('Stereo'), Buffer.alloc(5)]),
                    },
                ],
                [
                    'Pascal length that overruns the box',
                    {
                        handlerComponent: 'mhlr',
                        handlerField: Buffer.concat([Buffer.of(16), utf8('Short')]),
                    },
                ],
                ['unterminated ISO C string', { handlerField: utf8('Dialogue') }],
                ['version 1 hdlr', { handlerVersion: 1, handlerField: utf8('Dialogue\0') }],
                ['Latin-1 ISO name', { handlerField: Buffer.of(0x43, 0x61, 0x66, 0xe9, 0) }],
                [
                    'Pascal length low byte of a 300-byte name',
                    {
                        handlerComponent: 'mhlr',
                        handlerField: Buffer.concat([Buffer.of(300 & 0xff), utf8('N'.repeat(300))]),
                    },
                ],
            ];
            const expected = [
                'Core Media Audio',
                'SoundHandler',
                'Stereo',
                'Short',
                'Dialogue',
                'Dialogue',
                'Café',
                'N'.repeat(300),
            ];
            for (const [index, [label, options]] of cases.entries()) {
                const fixture = preservationFixture({
                    mov: !!options.handlerComponent,
                    tracks: [{ type: 'audio', ...options }],
                });
                const result = await demux(fixture.bytes);
                assert.equal(result.audioTracks[0].name, expected[index], label);
                assert.equal(result.audioTracks[0].samples.length, 3, label);
            }
            const short = await demux(
                preservationFixture({ tracks: [{ type: 'audio', shortHandler: true }] }).bytes,
            );
            assert.equal(short.audioTracks[0].name, undefined);
            assert.equal(short.audioTracks[0].samples.length, 3);
        },
    );

    test('one-byte G.711 samples are not mistaken for a flooded sample table', async () => {
        const base = Buffer.alloc(28);
        base.writeUInt16BE(1, 6);
        base.writeUInt16BE(1, 16);
        base.writeUInt16BE(16, 18);
        base.writeUInt32BE(8000 * 65536, 24);
        const packets = Array.from({ length: 4096 }, (_, index) => Buffer.of(index & 255));
        const fixture = preservationFixture({
            mov: true,
            tracks: [{ type: 'audio', audioEntry: atom('ulaw', base), packets }],
        });
        assert.equal((await demux(fixture.bytes)).audioTracks[0].samples.length, 4096);
        const media = await open(fixture.bytes);
        assert.deepEqual(
            (await inspect(fixture.bytes)).tracks.map(track => [track.codec, track.sampleCount]),
            [['ulaw', 4096]],
        );
        media.close();
    });

    test('MOV writes QuickTime Pascal handler names and MP4 writes C strings', async () => {
        const name = 'Voix 日本語';
        for (const format of ['mov', 'mp4']) {
            const sink = new MemorySink();
            const muxer = new Mp4Muxer(
                {
                    format,
                    mode: 'standard',
                    autoSync: true,
                    audio: {
                        type: 'audio',
                        codec: 'mp4a.40.2',
                        sampleRate: 48000,
                        channelCount: 2,
                        codecConfig: asc,
                        name,
                    },
                },
                sink,
            );
            muxer.addAudioChunk({
                trackType: 'audio',
                data: Uint8Array.of(0x21, 1, 2),
                timestamp: 0,
                duration: 1024 / 48000,
                isKeyframe: true,
            });
            await muxer.finalize();
            const bytes = Buffer.from(await sink.toBlob().arrayBuffer());
            const child = (parent, type) =>
                atomList(bytes, parent.payload, parent.end).find(atom => atom.type === type);
            const moov = atomList(bytes).find(atom => atom.type === 'moov');
            const hdlr = child(child(child(moov, 'trak'), 'mdia'), 'hdlr');
            const encoded = Buffer.from(name, 'utf8');
            const field = bytes.subarray(hdlr.payload + 24, hdlr.end);
            if (format === 'mov') {
                assert.equal(bytes.toString('latin1', hdlr.payload + 4, hdlr.payload + 8), 'mhlr');
                assert.deepEqual(field, Buffer.concat([Buffer.of(encoded.length), encoded]));
            } else {
                assert.equal(bytes.readUInt32BE(hdlr.payload + 4), 0);
                assert.deepEqual(field, Buffer.concat([encoded, Buffer.of(0)]));
            }
            assert.equal((await demux(bytes)).audioTracks[0].name, name);
        }
    });

    test('demux forced subtitle role and tx3g forced-all', async () => {
        for (const codec of ['wvtt', 'tx3g']) {
            const fixture = preservationFixture({
                tracks: [
                    {
                        type: 'subtitle',
                        codec,
                        forced: true,
                        default: false,
                        title: 'Translations',
                        name: 'Foreign dialogue',
                    },
                ],
            });
            const result = await demux(fixture.bytes);
            assert.equal(result.subtitleTracks[0].forced, true);
            assert.equal(result.subtitleTracks[0].default, false);
            assert.equal(result.subtitleTracks[0].title, 'Translations');
        }
    });

    test(
        'fragmented copies keep the AAC priming and presented length as an edit ' + 'list',
        async () => {
            // 1024 samples of priming, then 4800 presented samples (100 ms) of the 6144 coded ones.
            const { bytes } = classicMp4({
                timescale: 48000,
                movieTimescale: 1000,
                sampleRate: 48000,
                timing: [[6, 1024]],
                edits: [[100, 1024]],
            });
            const warnings = [];
            const media = await open(new Blob([bytes]), {
                onWarning: warning => warnings.push(warning.code),
            });
            let init;
            try {
                for await (const segment of media.segments({ targetDuration: 1 }))
                    if (segment.kind === 'init') init = Buffer.from(segment.data);
            } finally {
                media.close();
            }
            const elst = init.indexOf('elst');
            assert(elst > 0, 'the init segment has an edit list');
            // Version 0: one entry, segment duration in 1/1000 s, media time in the 48 kHz track
            // timescale.
            assert.deepEqual(
                [
                    init.readUInt32BE(elst + 8),
                    init.readUInt32BE(elst + 12),
                    init.readUInt32BE(elst + 16),
                ],
                [1, 100, 1024],
            );
            assert(!warnings.includes('FMP4_PRESENTATION_WINDOW'), warnings.join());
        },
    );

    test('an MP4 timed-text track is copied into Matroska as UTF-8 cues', async () => {
        const cue = text =>
            Buffer.concat([Buffer.from([0, Buffer.byteLength(text)]), Buffer.from(text)]);
        // A styl box: records of start and end character, font 1, face flags (1 bold, 2 italic),
        // size and colour.
        const styl = records => {
            const body = Buffer.alloc(2 + records.length * 12);
            body.writeUInt16BE(records.length);
            records.forEach(([start, end, face], index) => {
                body.writeUInt16BE(start, 2 + index * 12);
                body.writeUInt16BE(end, 4 + index * 12);
                body.writeUInt16BE(1, 6 + index * 12);
                body[8 + index * 12] = face;
            });
            return atom('styl', body);
        };
        const fixture = preservationFixture({
            tracks: [
                { type: 'video' },
                { type: 'audio' },
                {
                    type: 'subtitle',
                    codec: 'tx3g',
                    packets: [
                        cue('Hello'),
                        Buffer.from([0, 0]),
                        Buffer.concat([
                            cue('Big world'),
                            styl([
                                [0, 3, 1],
                                [4, 9, 2],
                            ]),
                        ]),
                    ],
                },
            ],
        });
        const job = await open(new Blob([fixture.bytes]));
        let copy;
        try {
            copy = (await job.convert('mkv')).blob;
        } finally {
            job.close();
        }
        const media = await open(copy);
        try {
            const track = media.tracks.find(candidate => candidate.type === 'subtitle');
            assert.equal(track.codec, 'text/utf8');
            const cues = [];
            for await (const packet of media.packets({ trackIds: [track.id] }))
                cues.push(new TextDecoder().decode(packet.data));
            assert.deepEqual(
                cues,
                ['Hello', '<b>Big</b> <i>world</i>'],
                'the empty sample that ends a cue is dropped; bold and italic style records ' +
                    'become ' +
                    'SubRip tags',
            );
        } finally {
            media.close();
        }
        // MOV keeps the timed text as it is.
        const mov = await convert(new Blob([fixture.bytes]), 'mov');
        const movCopy = await open(mov.blob);
        assert.equal(movCopy.tracks.find(track => track.type === 'subtitle')?.codec, 'tx3g');
        movCopy.close();
        // Containers without a text subtitle format leave the track out and say so; the rest is
        // still written.
        for (const format of ['ts']) {
            const result = await convert(new Blob([fixture.bytes]), format);
            assert(
                result.warnings.some(
                    w => w.code === 'TARGET_TRACKS_DROPPED' && /subtitle/.test(w.message),
                ),
                format,
            );
            const written = await open(result.blob);
            assert(!written.tracks.some(track => track.type === 'subtitle'), format);
            // An undetermined language has no ISO 639 descriptor in MPEG-TS, so it reads back as
            // unknown.
            if (format === 'ts')
                assert.equal(
                    written.tracks.find(track => track.type === 'audio').language,
                    undefined,
                );
            written.close();
        }
    });

    test('an MP4 copy keeps a 3GPP timed-text track beside audio and video', async () => {
        const fixture = preservationFixture({
            tracks: [{ type: 'video' }, { type: 'audio' }, { type: 'subtitle', codec: 'tx3g' }],
        });
        const source = await demux(fixture.bytes);
        const job = await open(new Blob([fixture.bytes]));
        let copy;
        try {
            copy = new Uint8Array(await (await job.convert('mp4')).blob.arrayBuffer());
        } finally {
            job.close();
        }
        const copied = await demux(copy);
        assert.equal(copied.subtitleTracks.length, 1);
        assert.equal(copied.subtitleTracks[0].codec, 'tx3g');
        assert.deepEqual(
            copied.subtitleTracks[0].codecConfig,
            source.subtitleTracks[0].codecConfig,
        );
        assert.equal(
            copied.subtitleTracks[0].samples.length,
            source.subtitleTracks[0].samples.length,
        );
    });

    test('demux preserves explicit disabled flags and absent versus empty text', async () => {
        const fixture = preservationFixture({
            tracks: [
                { type: 'audio', flags: 0 },
                { type: 'audio', flags: 2, name: '', title: '' },
                { type: 'video', flags: 7, version1: true },
            ],
        });
        const actual = await demux(fixture.bytes);
        assert.deepEqual(actual.audioTracks.map(metadata), [
            { default: false, forced: false, name: undefined, title: undefined },
            { default: false, forced: false, name: '', title: '' },
        ]);
        assert.equal(actual.videoTracks[0].default, true);
        assert.equal(actual.title, undefined);
    });

    async function writeTracks(fixture, options = {}) {
        const videos = fixture.tracks.filter(track => track.type === 'video');
        const audios = fixture.tracks.filter(track => track.type === 'audio');
        const config = track =>
            track && {
                ...track,
                codec:
                    track.codec === 'avc1'
                        ? 'avc1.42001e'
                        : track.codec === 'mp4a'
                          ? 'mp4a.40.2'
                          : track.codec,
                width: 32,
                height: 24,
                framerate: 25,
                sampleRate: 48000,
                channelCount: 2,
            };
        const sink = new MemorySink();
        const output = options.buffered
            ? { write: data => sink.write(data), close: () => sink.close() }
            : sink;
        const muxer = new Mp4Muxer(
            {
                format: 'mp4',
                mode: 'standard',
                maxFragmentDuration: 2,
                autoSync: false,
                title: 'Original movie — 東京',
                video: config(videos[0]),
                audio: config(audios[0]),
                extraVideoTracks: videos.slice(1).map(config),
                extraAudioTracks: audios.slice(1).map(config),
                ...options,
            },
            output,
        );
        for (let sample = 0; sample < 3; sample++) {
            for (const track of fixture.tracks) {
                const chunk = {
                    trackType: track.type,
                    data: track.packets[sample],
                    timestamp: sample * (track.type === 'audio' ? 1024 / 48000 : 0.04),
                    duration: track.type === 'audio' ? 1024 / 48000 : 0.04,
                    isKeyframe: true,
                };
                const index = (track.type === 'video' ? videos : audios).indexOf(track);
                const configBytes =
                    track.type === 'audio' ? asc : track.codec.startsWith('ap') ? undefined : avcc;
                if (track.type === 'video') {
                    if (index) muxer.addExtraVideoChunk(index - 1, chunk, configBytes);
                    else muxer.addVideoChunk(chunk, configBytes);
                } else {
                    if (index) muxer.addExtraAudioChunk(index - 1, chunk, configBytes);
                    else muxer.addAudioChunk(chunk, configBytes);
                }
            }
        }
        await muxer.finalize();
        return new Uint8Array(await sink.toBlob('video/mp4').arrayBuffer());
    }

    for (const format of ['mp4', 'mov'])
        for (const buffered of [false, true]) {
            test(
                `mux ${format} ${buffered ? 'buffered' : 'seekable'} writes independent metadata ` +
                    `and ` +
                    `packets`,
                async () => {
                    const fixture = preservationFixture({ title: 'Original movie — 東京' });
                    const actual = inspectMovie(await writeTracks(fixture, { format, buffered }));
                    const expected = inspectMovie(fixture.bytes);
                    assert.equal(actual.title, expected.title);
                    const sort = tracks =>
                        tracks.slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
                    assert.deepEqual(
                        sort(actual.tracks).map(metadata),
                        sort(expected.tracks).map(metadata),
                    );
                    assert.deepEqual(
                        sort(actual.tracks).map(track => track.packets),
                        sort(expected.tracks).map(track => track.packets),
                    );
                },
            );
        }

    for (const buffered of [false, true]) {
        test(
            `mux ${buffered ? 'buffered' : 'seekable'} preserves long variable timing and ` +
                `packets`,
            async () => {
                const sink = new MemorySink();
                const outputSink = buffered
                    ? { write: bytes => sink.write(bytes), close: () => sink.close() }
                    : sink;
                const muxer = new Mp4Muxer(
                    {
                        mode: 'standard',
                        format: 'mp4',
                        video: {
                            type: 'video',
                            codec: 'avc1',
                            codecConfig: avcc,
                            width: 32,
                            height: 24,
                        },
                    },
                    outputSink,
                );
                const count = 8205;
                const packets = [];
                const decode = [];
                const composition = [];
                const sync = [];
                let units = 0;
                for (let i = 0; i < count; i++) {
                    if (i > 0 && i !== 4096) units += i % 2 ? 3003 : 3600;
                    decode.push(units);
                    const inferred = i < 4095 ? 0 : [0, 3003, -3003][i % 3];
                    const explicit = i === 8192 ? -9000 : undefined;
                    composition.push(explicit ?? inferred);
                    const packet = Buffer.alloc(6 + (i % 4), i & 255);
                    packet.writeUInt32BE(packet.length - 4);
                    packet[4] = 0x65;
                    packets.push([...packet]);
                    const isKeyframe = i % 97 === 0;
                    if (isKeyframe) sync.push(i + 1);
                    muxer.addVideoChunk({
                        trackType: 'video',
                        data: packet,
                        timestamp: (units + inferred) / 90000,
                        ...(i >= 4095 ? { decodeTimestamp: units / 90000 } : {}),
                        ...(explicit === undefined
                            ? {}
                            : { compositionTimeOffset: explicit / 90000 }),
                        duration: 0.04,
                        isKeyframe,
                    });
                    packet.fill(0);
                }
                await muxer.finalize();
                const bytes = new Uint8Array(await sink.toBlob('video/mp4').arrayBuffer());
                assert.deepEqual(inspectMovie(bytes).tracks[0].packets, packets);
                const tables = sampleTables(bytes);
                let debt = 0;
                const durations = decode.map((value, i) => {
                    const delta = (i + 1 < count ? decode[i + 1] - value : 3600) - debt;
                    debt = Math.max(0, 1 - delta);
                    return Math.max(1, delta);
                });
                assert.deepEqual(timingValues(bytes, tables.get('stts')), durations);
                // A decode time moved a tick later to keep decode times increasing keeps its
                // presentation time.
                let written = 0;
                const presented = composition.map((offset, i) => {
                    const value = decode[i] + offset - written;
                    written += durations[i];
                    return value;
                });
                assert.deepEqual(timingValues(bytes, tables.get('ctts')), presented);
                const stss = tables.get('stss');
                const view = new DataView(bytes.buffer);
                assert.equal(view.getUint32(stss.payload + 4), sync.length);
                assert.deepEqual(
                    sync.map((_, i) => view.getUint32(stss.payload + 8 + i * 4)),
                    sync,
                );
            },
        );
    }

    test(
        'mux audio presentation trims only the final sample of a repeated timing ' + 'run',
        async () => {
            for (const count of [1, 3, 4097]) {
                const sink = new MemorySink();
                const muxer = new Mp4Muxer(
                    {
                        mode: 'standard',
                        format: 'mp4',
                        audio: {
                            type: 'audio',
                            codec: 'mp4a.40.2',
                            codecConfig: asc,
                            sampleRate: 48000,
                            channels: 2,
                        },
                    },
                    sink,
                );
                muxer.setAudioPriming(100, count * 1024 - 125);
                for (let i = 0; i < count; i++) {
                    muxer.addAudioChunk({
                        trackType: 'audio',
                        timestamp: (i * 1024) / 48000,
                        duration: 1024 / 48000,
                        isKeyframe: true,
                        data: Uint8Array.of(0x21, i & 255),
                    });
                }
                await muxer.finalize();
                const bytes = new Uint8Array(await sink.toBlob('audio/mp4').arrayBuffer());
                const expected = new Array(count).fill(1024);
                expected[count - 1] = 999;
                assert.deepEqual(timingValues(bytes, sampleTables(bytes).get('stts')), expected);
                assert.equal(inspectMovie(bytes).tracks[0].packets.length, count);
            }
        },
    );

    test('seekable mux keeps exact 64-bit sample offsets above 4 GiB', async () => {
        let bytesWritten = 0;
        let headerBytes = 0;
        let writes = 0;
        let moov;
        let mdatSize;
        const sink = {
            write(bytes) {
                if (writes++ < 2) headerBytes += bytes.length;
                if (String.fromCharCode(...bytes.subarray(4, 8)) === 'moov') moov = bytes;
                bytesWritten += bytes.length;
            },
            patchAt(offset, bytes) {
                assert.equal(offset, headerBytes - 8);
                mdatSize = new DataView(
                    bytes.buffer,
                    bytes.byteOffset,
                    bytes.byteLength,
                ).getBigUint64(0);
            },
            async close() {},
        };
        const muxer = new Mp4Muxer(
            {
                mode: 'standard',
                format: 'mp4',
                video: { type: 'video', codec: 'avc1', codecConfig: avcc, width: 32, height: 24 },
            },
            sink,
        );
        const packet = new Uint8Array(1024 * 1024);
        new DataView(packet.buffer).setUint32(0, packet.length - 4);
        packet[4] = 0x65;
        const count = 4097;
        for (let i = 0; i < count; i++) {
            muxer.addVideoChunk({
                trackType: 'video',
                data: packet,
                timestamp: i / 25,
                duration: 0.04,
                isKeyframe: true,
            });
        }
        await muxer.finalize();
        assert.equal(mdatSize, 16n + BigInt(count * packet.length));
        assert.equal(bytesWritten, headerBytes + count * packet.length + moov.length);
        const offsets = sampleTables(moov).get('co64');
        assert.ok(offsets, 'large output requires co64');
        const view = new DataView(moov.buffer, moov.byteOffset, moov.byteLength);
        assert.equal(view.getUint32(offsets.payload + 4), count);
        for (let i = 0; i < count; i++) {
            assert.equal(
                view.getBigUint64(offsets.payload + 8 + i * 8),
                BigInt(headerBytes + i * packet.length),
            );
        }
    });

    test('seekable mux snapshots sample sizes before a sink transfers input bytes', async () => {
        const sink = new MemorySink();
        const muxer = new Mp4Muxer(
            {
                mode: 'standard',
                format: 'mp4',
                video: { type: 'video', codec: 'avc1', codecConfig: avcc, width: 32, height: 24 },
            },
            {
                write(bytes) {
                    sink.write(bytes);
                    structuredClone(bytes, { transfer: [bytes.buffer] });
                },
                patchAt: (offset, bytes) => sink.patchAt(offset, bytes),
                close: () => sink.close(),
            },
        );
        const packet = Uint8Array.of(0, 0, 0, 2, 0x65, 0x80);
        const expected = [...packet];
        muxer.addVideoChunk({
            trackType: 'video',
            data: packet,
            timestamp: 0,
            duration: 0.04,
            isKeyframe: true,
        });
        assert.equal(packet.byteLength, 0);
        await muxer.finalize();
        const bytes = new Uint8Array(await sink.toBlob('video/mp4').arrayBuffer());
        assert.deepEqual(inspectMovie(bytes).tracks[0].packets, [expected]);
    });

    test('seekable mux excludes a sample rejected by a synchronous sink write', async () => {
        const sink = new MemorySink();
        let rejectPacket = true;
        const muxer = new Mp4Muxer(
            {
                mode: 'standard',
                format: 'mp4',
                video: { type: 'video', codec: 'avc1', codecConfig: avcc, width: 32, height: 24 },
            },
            {
                write(bytes) {
                    if (bytes.length === 6 && rejectPacket) throw new Error('packet rejected');
                    sink.write(bytes);
                },
                patchAt: (offset, bytes) => sink.patchAt(offset, bytes),
                close: () => sink.close(),
            },
        );
        const chunk = {
            trackType: 'video',
            data: Uint8Array.of(0, 0, 0, 2, 0x65, 0x80),
            timestamp: 0,
            duration: 0.04,
            isKeyframe: true,
        };
        assert.throws(() => muxer.addVideoChunk(chunk), /packet rejected/);
        rejectPacket = false;
        muxer.addVideoChunk(chunk);
        await muxer.finalize();
        const bytes = new Uint8Array(await sink.toBlob('video/mp4').arrayBuffer());
        assert.deepEqual(inspectMovie(bytes).tracks[0].packets, [[...chunk.data]]);
    });

    test('fragmented MP4 standard muxer writes metadata', async () => {
        const fixture = preservationFixture({
            tracks: [{ type: 'video', name: 'Angle B', title: 'Wide', default: false }],
        });
        const output = inspectMovie(await writeTracks(fixture, { mode: 'fragmented' }));
        assert.equal(output.title, 'Original movie — 東京');
        assert.deepEqual(metadata(output.tracks[0]), {
            default: false,
            forced: false,
            name: 'Angle B',
            title: 'Wide',
        });
    });

    test('CMAF init independently preserves subtitle role and all metadata', async () => {
        const tracks = [
            {
                id: 7,
                type: 'audio',
                codec: 'mp4a.40.2',
                codecConfig: asc,
                timescale: 48000,
                sampleRate: 48000,
                channelCount: 2,
                default: true,
                name: 'Stereo',
                title: 'Original audio',
            },
            {
                id: 8,
                type: 'subtitle',
                codec: 'wvtt',
                timescale: 1000,
                default: false,
                forced: true,
                name: 'Forced 日本語',
                title: '',
            },
            {
                id: 9,
                type: 'subtitle',
                codec: 'wvtt',
                timescale: 1000,
                default: true,
                forced: false,
                name: '',
                title: 'Full captions',
            },
        ];
        const writer = new CmafWriter({ tracks, title: 'Movie title' });
        const output = inspectMovie(writer.createInitSegment());
        assert.equal(output.title, 'Movie title');
        assert.deepEqual(
            output.tracks.map(metadata),
            tracks.map(track => metadata({ forced: false, ...track })),
        );
    });

    test(
        'writers preserve empty movie titles and commentary without inventing track ' + 'names',
        async () => {
            const fixture = preservationFixture({ tracks: [{ type: 'audio', commentary: false }] });
            const output = inspectMovie(await writeTracks(fixture, { title: '' }));
            assert.equal(output.title, '');
            assert.equal(output.tracks[0].name, undefined);
            assert.equal(output.tracks[0].title, undefined);
            const read = await demux(await writeTracks(fixture, { title: undefined }));
            assert.equal(read.title, undefined);
            assert.equal(read.audioTracks[0].commentary, false);
        },
    );

    for (const codec of ['apco', 'apcs', 'apcn', 'apch', 'ap4h', 'ap4x']) {
        test(`MOV ProRes ${codec} packet copy has no decoder configuration`, async () => {
            const fixture = preservationFixture({
                mov: true,
                tracks: [
                    {
                        type: 'video',
                        codec,
                        name: codec,
                        default: true,
                        packets: [proresFrames[codec], proresFrames[codec], proresFrames[codec]],
                    },
                ],
            });
            const output = inspectMovie(await writeTracks(fixture, { format: 'mov' }));
            assert.equal(output.tracks[0].codec, codec);
            assert.deepEqual(
                output.tracks[0].packets,
                fixture.tracks[0].packets.map(packet => [...packet]),
            );
            assert.deepEqual(output.tracks[0].sampleEntryChildren, []);
        });
    }

    test('unsupported forced audio/video and ProRes MP4 fail clearly', async () => {
        await assert.rejects(
            writeTracks(preservationFixture({ tracks: [{ type: 'video', codec: 'apch' }] })),
            /ProRes.*MOV/i,
        );
        await assert.rejects(
            writeTracks(preservationFixture({ tracks: [{ type: 'audio', forced: true }] })),
            /forced.*subtitle/i,
        );
        assert.throws(
            () =>
                new CmafWriter({
                    tracks: [
                        {
                            id: 1,
                            type: 'audio',
                            codec: 'mp4a.40.2',
                            codecConfig: asc,
                            timescale: 48000,
                            sampleRate: 48000,
                            channelCount: 2,
                            forced: true,
                        },
                    ],
                }),
            /forced.*subtitle/i,
        );
    });

    test(
        'metadata child boxes extending past the parent are skipped unless metadataPolicy is ' +
            'error',
        async () => {
            for (const type of ['tnam', 'kind', 'keys', 'data']) {
                const fixture = preservationFixture({
                    title: 'Movie',
                    tracks: [{ type: 'subtitle', forced: true, name: 'A', title: 'B' }],
                });
                const data = Buffer.from(fixture.bytes);
                const position = data.indexOf(type);
                assert.ok(position > 4);
                data.writeUInt32BE(data.length, position - 4);
                const { tracks, warnings } = await readMedia(new Uint8Array(data));
                const subtitles = tracks.find(entry => entry.track.type === 'subtitle');
                assert.equal(subtitles.packets.length, 3, type);
                assert.ok(warnings.includes('MP4_METADATA_SKIPPED'), type);
                await assert.rejects(open(new Uint8Array(data), { metadataPolicy: 'error' }), {
                    code: 'FORMAT',
                });
            }
        },
    );

    test('engine remux preserves independent MP4 metadata', async () => {
        const fixture = preservationFixture({ title: 'Original movie — 東京' });
        const file = await open(preservationSource(fixture.bytes));
        const sink = new MemorySink();
        await file.convert('mp4', { copy: true, sink });
        file.close();
        const actual = inspectMovie(new Uint8Array(await sink.toBlob('video/mp4').arrayBuffer()));
        const expected = inspectMovie(fixture.bytes);
        assert.equal(actual.title, expected.title);
        for (const input of expected.tracks) {
            const output = actual.tracks.find(track => track.name === input.name);
            assert.ok(output, `missing track ${input.name}`);
            assert.deepEqual(metadata(output), metadata(input));
            assert.deepEqual(output.packets, input.packets);
        }
    });

    test(
        'engine fragmented MP4 copy preserves forced subtitles with multiple audio/video ' +
            'tracks',
        async () => {
            const fixture = preservationFixture({
                title: 'Subtitle movie',
                tracks: [
                    { type: 'video', default: true, name: 'Main video', title: 'Scene' },
                    { type: 'video', default: false, name: 'Other video', title: '' },
                    { type: 'audio', default: true, name: 'Audio one' },
                    { type: 'audio', default: false, name: 'Audio two' },
                    {
                        type: 'subtitle',
                        default: false,
                        forced: true,
                        name: 'Translations',
                        title: 'Forced lines',
                    },
                ],
            });
            const file = await open(preservationSource(fixture.bytes));
            const sink = new MemorySink();
            await file.convert('mp4', { copy: true, sink });
            file.close();
            const outputBytes = new Uint8Array(await sink.toBlob('video/mp4').arrayBuffer());
            const actual = inspectMovie(outputBytes);
            const expected = inspectMovie(fixture.bytes);
            assert.equal(actual.title, expected.title);
            for (const track of expected.tracks) {
                const output = actual.tracks.find(value => value.name === track.name);
                assert.ok(output, `missing track ${track.name}`);
                assert.deepEqual(metadata(output), metadata(track));
            }
            const restored = await demux(outputBytes);
            for (const track of [
                ...restored.videoTracks,
                ...restored.audioTracks,
                ...restored.subtitleTracks,
            ]) {
                const original = fixture.tracks.find(value => value.name === track.name);
                assert.deepEqual(
                    track.samples.map(sample => [
                        ...outputBytes.subarray(sample.offset, sample.offset + sample.size),
                    ]),
                    original.packets.map(packet => [...packet]),
                );
            }
        },
    );

    test('engine MOV copy supports all six ProRes tags and interleaved routing', async () => {
        const fixture = preservationFixture({
            mov: true,
            tracks: ['apco', 'apcs', 'apcn', 'apch', 'ap4h', 'ap4x'].map((codec, index) => ({
                type: 'video',
                codec,
                packets: [proresFrames[codec], proresFrames[codec], proresFrames[codec]],
                name: codec,
                default: index % 2 === 0,
            })),
        });
        const file = await open(preservationSource(fixture.bytes));
        const sink = new MemorySink();
        await file.convert('mov', { copy: true, sink });
        file.close();
        const output = inspectMovie(
            new Uint8Array(await sink.toBlob('video/quicktime').arrayBuffer()),
        );
        assert.deepEqual(
            output.tracks.map(track => track.codec),
            fixture.tracks.map(track => track.codec),
        );
        assert.deepEqual(
            output.tracks.map(track => track.packets),
            fixture.tracks.map(track => track.packets.map(packet => [...packet])),
        );
        assert.deepEqual(
            output.tracks.map(track => track.default),
            fixture.tracks.map(track => track.default),
        );
        assert.ok(output.tracks.every(track => !track.sampleEntryChildren.includes('avcC')));
    });

    /** Copies `bytes` to MP4, failing on any metadata the output cannot hold. */
    const strictMp4Copy = async bytes =>
        new Uint8Array(
            await (
                await convert(new Blob([bytes]), 'mp4', { open: { metadataPolicy: 'error' } })
            ).blob.arrayBuffer(),
        );
    test('conversion copies independent names, titles and disabled defaults', async () => {
        const fixture = preservationFixture({ title: 'Copied movie' });
        const output = inspectMovie(await strictMp4Copy(fixture.bytes));
        const expected = inspectMovie(fixture.bytes);
        assert.equal(output.title, expected.title);
        for (const track of expected.tracks)
            assert.deepEqual(
                metadata(output.tracks.find(value => value.name === track.name)),
                metadata(track),
            );
    });

    test('direct M4A copy preserves selected and extra track metadata', async () => {
        const fixture = preservationFixture({
            title: 'Extracted movie',
            tracks: [
                { type: 'audio', default: false, name: 'Left 日本語', title: '' },
                { type: 'audio', default: true, name: 'Right é', title: 'Second mix' },
            ],
        });
        const input = new Blob([fixture.bytes]);
        const ids = (await lite.inspect(input)).tracks.map(track => track.id);
        for (const audioTrackIndex of [undefined, 1]) {
            const { blob: converted } = await convert(input, 'm4a', {
                open: { metadataPolicy: 'error' },
                ...(audioTrackIndex === undefined ? {} : { trackIds: [ids[audioTrackIndex]] }),
            });
            const output = inspectMovie(new Uint8Array(await converted.arrayBuffer()));
            const expected = inspectMovie(fixture.bytes);
            assert.equal(output.title, expected.title);
            assert.deepEqual(
                output.tracks.map(metadata),
                (audioTrackIndex === undefined
                    ? expected.tracks
                    : [expected.tracks[audioTrackIndex]]
                ).map(metadata),
            );
        }
    });

    for (const mode of ['buffered', 'sink', 'lite'])
        test(`${mode} M4A transcode retains metadata`, async () => {
            const silence = [new Float32Array(2048), new Float32Array(2048)];
            const encoded = await encodeAacLc(silence, { sampleRate: 48000 });
            const fixture = preservationFixture({
                title: 'Converted movie',
                tracks: [
                    {
                        type: 'audio',
                        default: false,
                        name: 'Studio 日本語',
                        title: '',
                        packets: encoded.frames,
                    },
                ],
            });
            const target = {
                to: 'm4a',
                open: { metadataPolicy: 'error' },
                audio: { sampleRate: 24000 },
            };
            let converted;
            if (mode === 'sink') {
                const sink = new MemorySink();
                await convert(new Blob([fixture.bytes]), { ...target, sink });
                converted = sink.toBlob();
            } else {
                // Node has no AudioDecoder: the lite entry decodes AAC with the aac plugin.
                const forge =
                    mode === 'lite' ? new lite.MediaForge({ plugins: [aac] }) : { convert };
                converted = (await forge.convert(new Blob([fixture.bytes]), target)).blob;
            }
            const output = inspectMovie(new Uint8Array(await converted.arrayBuffer()));
            assert.equal(output.title, 'Converted movie');
            assert.deepEqual(metadata(output.tracks[0]), {
                default: false,
                forced: false,
                name: 'Studio 日本語',
                title: '',
            });
        });

    const editTiming = track => ({
        timescale: track.timescale,
        duration: track.duration,
        editLeadTimeSeconds: track.editLeadTimeSeconds,
        editMediaTimeSeconds: track.editMediaTimeSeconds,
        editPresentationDurationSeconds: track.editPresentationDurationSeconds,
    });
    const awkwardEdits = [
        {
            name: 'media 44100 with movie 600',
            options: {
                timescale: 44100,
                movieTimescale: 600,
                sampleRate: 44100,
                timing: [[6, 1024]],
                edits: [[81, 1024]],
            },
        },
        {
            name: 'media 44100 with movie 24000',
            options: {
                timescale: 44100,
                movieTimescale: 24000,
                sampleRate: 44100,
                timing: [[6, 1024]],
                edits: [[1003, 1024]],
            },
        },
        {
            name: 'media 90000 with movie 1000',
            options: {
                timescale: 90000,
                movieTimescale: 1000,
                timing: [[6, 3003]],
                edits: [[189, 1001]],
            },
        },
        {
            name: 'version-1 elst with 64-bit values',
            options: {
                timescale: 90000,
                movieTimescale: 1000,
                timing: [[6, 3003]],
                editVersion: 1,
                edits: [
                    [0x100000007, -1],
                    [0x100000005, 1001],
                ],
            },
        },
        {
            name: 'leading empty edit with media 44100 and movie 600',
            options: {
                timescale: 44100,
                movieTimescale: 600,
                sampleRate: 44100,
                timing: [[6, 1024]],
                edits: [
                    [7, -1],
                    [81, 1024],
                ],
            },
        },
    ];
    for (const { name, options } of awkwardEdits) {
        test(`engine remux keeps the exact elst for ${name}`, async () => {
            const { bytes } = classicMp4(options);
            const expected = editLists(bytes);
            assert.deepEqual(
                expected[0].entries,
                options.edits.map(([duration, media]) => [duration, media, 0x10000]),
            );
            const source = await demux(bytes);
            for (const format of ['mp4', 'mov']) {
                const { blob: output } = await convert(fixtureSource(bytes), format, {
                    copy: true,
                });
                const outputBytes = new Uint8Array(await output.arrayBuffer());
                assert.deepEqual(editLists(outputBytes), expected, format);
                const restored = await demux(outputBytes);
                assert.deepEqual(
                    editTiming(restored.audioTracks[0]),
                    editTiming(source.audioTracks[0]),
                    format,
                );
                assert.deepEqual(
                    restored.audioTracks[0].samples.map(sample => sample.timestamp),
                    source.audioTracks[0].samples.map(sample => sample.timestamp),
                    format,
                );
            }
        });
    }

    test('a strict MP4 copy keeps the exact elst for a leading empty edit', async () => {
        const { bytes } = classicMp4(awkwardEdits[4].options);
        const outputBytes = await strictMp4Copy(bytes);
        assert.deepEqual(editLists(outputBytes), editLists(bytes));
        assert.deepEqual(
            editTiming((await demux(outputBytes)).audioTracks[0]),
            editTiming((await demux(bytes)).audioTracks[0]),
        );
    });

    test(
        'mux rescales exact edits from different source movie timescales by whole ' + 'factors',
        async () => {
            const sink = new MemorySink();
            const audio = presentationEdit => ({
                type: 'audio',
                codec: 'mp4a.40.2',
                codecConfig: asc,
                sampleRate: 48000,
                channelCount: 2,
                mediaTimescale: 48000,
                presentationEdit,
            });
            const muxer = new Mp4Muxer(
                {
                    mode: 'standard',
                    format: 'mp4',
                    audio: audio({
                        leadMovieUnits: 7,
                        movieDuration: 81,
                        mediaTimeUnits: 1024,
                        movieTimescale: 600,
                        mediaTimescale: 48000,
                    }),
                    extraAudioTracks: [
                        audio({
                            leadMovieUnits: 0,
                            movieDuration: 1003,
                            mediaTimeUnits: 0,
                            movieTimescale: 24000,
                            mediaTimescale: 48000,
                            version: 1,
                        }),
                    ],
                },
                sink,
            );
            for (let i = 0; i < 3; i++) {
                const chunk = {
                    trackType: 'audio',
                    timestamp: (i * 1024) / 48000,
                    duration: 1024 / 48000,
                    isKeyframe: true,
                    data: Uint8Array.of(0x21, i),
                };
                muxer.addAudioChunk(chunk);
                muxer.addExtraAudioChunk(0, chunk);
            }
            await muxer.finalize();
            const bytes = new Uint8Array(await sink.toBlob('audio/mp4').arrayBuffer());
            assert.deepEqual(editLists(bytes), [
                {
                    movieTimescale: 48000,
                    mediaTimescale: 48000,
                    version: 0,
                    entries: [
                        [7 * 80, -1, 0x10000],
                        [81 * 80, 1024, 0x10000],
                    ],
                },
                {
                    movieTimescale: 48000,
                    mediaTimescale: 48000,
                    version: 1,
                    entries: [[1003 * 2, 0, 0x10000]],
                },
            ]);
        },
    );

    const editWindow = async (bytes, expectedCodes) => {
        const codes = [];
        const job = await open(fixtureSource(bytes), {
            onWarning: warning => codes.push(warning.code),
        });
        try {
            assert.deepEqual(codes, expectedCodes);
            const track = job.tracks[0];
            for (const format of ['mkv', 'mp4']) {
                assert.equal((await job.check(format, { copy: true })).supported, true, format);
                const { blob: output } = await job.convert(format, { copy: true });
                const file = await open(output);
                try {
                    const counted = await inspect(output, { sampleCounts: true });
                    assert.equal(counted.tracks[0].sampleCount, 6, format);
                    assert.deepEqual(
                        file.warnings.map(warning => warning.code),
                        format === 'mp4'
                            ? expectedCodes.filter(code => code === 'MP4_EDIT_EXCEEDS_MEDIA')
                            : [],
                        format,
                    );
                } finally {
                    file.close();
                }
                if (format === 'mp4')
                    return {
                        track,
                        elst: editLists(new Uint8Array(await output.arrayBuffer()))[0],
                    };
            }
        } finally {
            job.close();
        }
    };

    test(
        'an edit ending less than one movie tick past the coded audio is the coded audio, ' +
            'without a ' +
            'warning',
        async () => {
            const { bytes } = classicMp4({
                timescale: 44100,
                movieTimescale: 1000,
                sampleRate: 44100,
                timing: [[6, 1024]],
                edits: [[140, 0]],
            });
            const { track, elst } = await editWindow(bytes, []);
            assert.equal(track.duration, 6144 / 44100);
            assert.deepEqual(elst.entries, [[140, 0, 0x10000]]);
        },
    );

    test(
        'an edit ending a movie tick or more past the coded audio is limited with a warning and ' +
            'still copied verbatim',
        async () => {
            const aac = { timescale: 44100, sampleRate: 44100, timing: [[6, 1024]] };
            for (const [movieTimescale, duration] of [
                [1000, 141],
                [44100, 6145],
                [600, 400],
            ]) {
                const { bytes } = classicMp4({ ...aac, movieTimescale, edits: [[duration, 0]] });
                const { elst } = await editWindow(bytes, ['MP4_EDIT_EXCEEDS_MEDIA']);
                assert.deepEqual(
                    elst.entries,
                    [[duration, 0, 0x10000]],
                    `${movieTimescale}/${duration}`,
                );
                const source = await demux(bytes);
                assert.equal(source.audioTracks[0].editPresentationDurationUnits, 6144);
                assert.equal(source.audioTracks[0].editPresentationDurationSeconds, 6144 / 44100);
            }
            const { bytes } = classicMp4({ ...aac, movieTimescale: 44100, edits: [[6144, 0]] });
            await editWindow(bytes, []);
        },
    );

    test(
        'an edit ending at the last composition end of reordered samples is not ' + 'limited',
        async () => {
            const { bytes } = classicMp4({
                timescale: 12800,
                movieTimescale: 1000,
                timing: [[6, 512]],
                composition: [
                    [1, 512],
                    [1, 1024],
                    [1, 0],
                    [1, 1024],
                    [1, 0],
                    [1, 512],
                ],
                edits: [[240, 512]],
            });
            await editWindow(bytes, []);
            const source = await demux(bytes);
            assert.equal(source.audioTracks[0].editPresentationDurationUnits, 3072);
            assert.equal(source.audioTracks[0].editPresentationDurationSeconds, 0.24);
            const { bytes: longer } = classicMp4({
                timescale: 12800,
                movieTimescale: 1000,
                timing: [[6, 512]],
                composition: [[6, 512]],
                edits: [[280, 512]],
            });
            await editWindow(longer, ['MP4_EDIT_EXCEEDS_MEDIA']);
            assert.equal((await demux(longer)).audioTracks[0].editPresentationDurationUnits, 3072);
        },
    );

    test('an edit starting beyond the coded media is ignored with a warning', async () => {
        const { bytes } = classicMp4({
            timescale: 44100,
            movieTimescale: 1000,
            sampleRate: 44100,
            timing: [[6, 1024]],
            edits: [[100, 7000]],
        });
        const { track } = await editWindow(bytes, ['MP4_EDIT_OUTSIDE_MEDIA']);
        assert.equal(track.duration, 6144 / 44100);
        const source = await demux(bytes);
        assert.equal(source.audioTracks[0].editList, undefined);
        assert.equal(source.audioTracks[0].editPresentationDurationSeconds, undefined);
        assert.equal(source.audioTracks[0].samples[0].timestamp, 0);
    });

    /**
     * Two GOPs of the Main-profile fixture (B-pyramid, decode order [0, 4, 2, 1, 3, 8, 6, 5, 7]
     * each) at 25 fps, with `edits` over its presentation, which starts two pictures after its
     * decode.
     */
    function splicedMovie(edits) {
        const { description, packets } = avccPackets(MAIN_FIXTURE);
        const order = [...MAIN_FIXTURE.order, ...MAIN_FIXTURE.order.map(picture => picture + 9)];
        return preservationFixture({
            tracks: [
                {
                    type: 'video',
                    width: 64,
                    height: 48,
                    codecConfig: description,
                    packets: [...packets, ...packets].map(packet => Buffer.from(packet)),
                    sync: [1, 10],
                    compositionOffsets: order.map((picture, index) => (picture + 2 - index) * 40),
                    edits,
                },
            ],
        }).bytes;
    }

    const pictureHashes = async input => {
        const hashes = [];
        for await (const frame of frames(new Blob([input])))
            hashes.push({
                time: Math.round(frame.timestamp * 1000),
                md5: createHash('md5').update(frame.data).digest('hex'),
            });
        return hashes;
    };

    test(
        'an edit list that skips media presents each edit and decodes the skipped references ' +
            'only',
        async () => {
            // Pictures 0-2, then 10-15: the P picture 4 and the IDR picture 9 are decoded but not
            // presented, and the pictures 3, 5-8 nothing needs are left out.
            const spliced = splicedMovie([
                { duration: 120, mediaTime: 80 },
                { duration: 240, mediaTime: 480 },
            ]);
            const plain = await pictureHashes(splicedMovie([{ duration: 720, mediaTime: 80 }]));
            const expected = [0, 1, 2, 10, 11, 12, 13, 14, 15].map((picture, index) => ({
                time: index * 40,
                md5: plain[picture].md5,
            }));
            assert.equal(plain.length, 18);
            const media = await open(new Blob([spliced]));
            const listed = [];
            for await (const packet of media.packets()) listed.push(packet);
            media.close();
            assert.equal(listed.length, 13);
            assert.deepEqual(
                listed.filter(packet => packet.decodeOnly).map(packet => packet.isKeyframe),
                [false, true],
                'the reference P picture and the IDR picture the second edit decodes from',
            );
            assert.ok(
                listed.every(
                    (packet, index) =>
                        index === 0 || packet.decodeTimestamp > listed[index - 1].decodeTimestamp,
                ),
                'decode times increase',
            );
            assert.ok(listed.every(packet => packet.decodeTimestamp <= packet.timestamp + 1e-9));
            assert.deepEqual(await pictureHashes(spliced), expected);

            // An MP4 copy keeps both edits and presents the same pictures; Matroska shows the
            // decode-only ones and says so.
            const copy = await convert(new Blob([spliced]), 'mp4');
            const output = new Uint8Array(await copy.blob.arrayBuffer());
            const elst = Buffer.from(output).indexOf('elst');
            assert.ok(elst > 0);
            const view = new DataView(output.buffer, output.byteOffset + elst + 8);
            assert.equal(view.getUint32(0), 2, 'two media edits');
            assert.deepEqual(await pictureHashes(output), expected);
            const mkv = await convert(new Blob([spliced]), 'mkv');
            assert.ok(mkv.warnings.some(warning => warning.code === 'MP4_EDIT_SPLICE_NOT_KEPT'));
        },
    );

    test(
        'mdhd codes below 0x400 are Macintosh languages in every MP4 file, and copies keep ' +
            'them',
        async () => {
            const read = async (mov, languageCode) =>
                (
                    await demux(
                        preservationFixture({ mov, tracks: [{ type: 'audio', languageCode }] })
                            .bytes,
                    )
                ).audioTracks[0].language;
            for (const mov of [true, false]) {
                assert.equal(await read(mov, 0), 'eng', `Macintosh code 0, ${mov ? 'qt' : 'isom'}`);
                assert.equal(
                    await read(mov, 11),
                    'jpn',
                    `Macintosh code 11, ${mov ? 'qt' : 'isom'}`,
                );
                assert.equal(await read(mov, 0x7fff), undefined, 'unspecified Macintosh code');
                assert.equal(await read(mov, 0x55c4), undefined, 'und');
                assert.equal(await read(mov, (6 << 10) | (18 << 5) | 1), 'fra');
            }
            const fixture = preservationFixture({
                tracks: [
                    { type: 'audio', languageCode: 0 },
                    { type: 'audio', languageCode: 0x55c4 },
                ],
            });
            for (const to of ['mp4', 'mov', 'mkv']) {
                const media = await open((await convert(new Blob([fixture.bytes]), to)).blob);
                assert.deepEqual(
                    media.tracks.map(track => track.language ?? 'und'),
                    ['eng', 'und'],
                    to,
                );
                media.close();
            }
        },
    );

    test(
        'an unknown language reaches Matroska as und and default handler names name no ' + 'track',
        async () => {
            const fixture = preservationFixture({
                tracks: [
                    { type: 'audio', languageCode: 0x55c4, handlerName: 'SoundHandler' },
                    {
                        type: 'audio',
                        languageCode: (10 << 10) | (16 << 5) | 14,
                        handlerName: 'Commentary',
                    },
                ],
            });
            const { blob } = await convert(new Blob([fixture.bytes]), 'mkv');
            const bytes = new Uint8Array(await blob.arrayBuffer());
            const languages = [];
            const names = [];
            for (let at = 0; at + 3 < bytes.length; at++) {
                const length = bytes[at + 3] & 0x7f;
                const text = () =>
                    new TextDecoder().decode(bytes.subarray(at + 4, at + 4 + length));
                if (bytes[at] === 0x22 && bytes[at + 1] === 0xb5 && bytes[at + 2] === 0x9c)
                    languages.push(text());
                if (bytes[at] === 0x53 && bytes[at + 1] === 0x6e)
                    names.push(
                        new TextDecoder().decode(
                            bytes.subarray(at + 3, at + 3 + (bytes[at + 2] & 0x7f)),
                        ),
                    );
            }
            assert.deepEqual(
                languages,
                ['und', 'jpn'],
                'a missing Language element would read as eng',
            );
            assert.deepEqual(names, ['Commentary']);
            const media = await open(blob);
            assert.deepEqual(
                media.tracks.map(track => track.language),
                ['und', 'jpn'],
            );
            media.close();
        },
    );

    test(
        'MP4 and MOV keep HDR colour, an unknown range, the field order and a BCP 47 ' + 'language',
        async () => {
            const colour = {
                primaries: 9,
                transfer: 18,
                matrix: 9,
                mastering: {
                    red: [0.68, 0.32],
                    green: [0.265, 0.69],
                    blue: [0.15, 0.06],
                    whitePoint: [0.3127, 0.329],
                    maxLuminance: 1000,
                    minLuminance: 0.005,
                },
                contentLight: { maxContent: 1000, maxAverage: 400 },
            };
            for (const [format, mode] of [
                ['mp4', 'standard'],
                ['mov', 'standard'],
                ['mp4', 'fragmented'],
            ]) {
                const sink = new MemorySink();
                const muxer = new Mp4Muxer(
                    {
                        mode,
                        format,
                        maxFragmentDuration: 1,
                        autoSync: true,
                        video: {
                            type: 'video',
                            codec: 'avc1',
                            codecConfig: avcc,
                            width: 32,
                            height: 24,
                            colour,
                            fieldOrder: 'tt',
                            language: 'zh-Hant',
                        },
                        audio: {
                            type: 'audio',
                            codec: 'mp4a.40.2',
                            codecConfig: asc,
                            sampleRate: 48000,
                            channelCount: 2,
                        },
                        audioLanguage: 'fra',
                    },
                    sink,
                );
                muxer.addVideoChunk({
                    trackType: 'video',
                    data: Uint8Array.of(0, 0, 0, 2, 0x65, 0x80),
                    timestamp: 0,
                    duration: 0.04,
                    isKeyframe: true,
                });
                muxer.addAudioChunk({
                    trackType: 'audio',
                    data: Uint8Array.of(1, 2),
                    timestamp: 0,
                    duration: 0.02,
                    isKeyframe: true,
                });
                await muxer.finalize();
                const result = await demux(
                    new Uint8Array(await sink.toBlob('video/mp4').arrayBuffer()),
                );
                const video = result.videoTracks[0];
                const label = `${format} ${mode}`;
                // QuickTime's nclc leaves the range open; nclx states limited range for an unknown
                // one, as ffmpeg writes it.
                assert.equal(video.colour.fullRange, format === 'mov' ? undefined : false, label);
                assert.deepEqual(
                    [video.colour.primaries, video.colour.transfer, video.colour.matrix],
                    [9, 18, 9],
                    label,
                );
                assert.deepEqual(video.colour.contentLight, colour.contentLight, label);
                assert(Math.abs(video.colour.mastering.minLuminance - 0.005) < 1e-4, label);
                assert.deepEqual(video.colour.mastering.red, [0.68, 0.32], label);
                assert.equal(video.fieldOrder, 'tt', label);
                assert.equal(
                    video.language,
                    'zh-Hant',
                    `${label}: elng keeps the tag beside mdhd 'zho'`,
                );
                assert.equal(
                    result.audioTracks[0].language,
                    'fra',
                    `${label}: the audio language stays on audio`,
                );
            }
        },
    );

    test(
        'fragmented MP4 copies of reordered video and primed audio keep their presentation ' +
            'times',
        async () => {
            // Matroska states presentation times only: B-frame video decodes before zero and AAC
            // priming is presented there.
            const sink = new MemorySink();
            const muxer = new WebMMuxer(
                {
                    format: 'mkv',
                    mode: 'standard',
                    maxFragmentDuration: 2,
                    autoSync: true,
                    video: {
                        type: 'video',
                        codec: 'avc1.42001e',
                        codecConfig: avcc,
                        width: 32,
                        height: 24,
                        framerate: 25,
                    },
                    audio: {
                        type: 'audio',
                        codec: 'mp4a.40.2',
                        codecConfig: asc,
                        sampleRate: 48000,
                        channelCount: 2,
                    },
                    subtitleTracks: [{ codec: 'text/utf8', language: 'pt-BR' }],
                },
                sink,
            );
            const frame = Uint8Array.of(0, 0, 0, 2, 0x65, 0x80);
            for (const [pts, key] of [
                [0, true],
                [0.12, false],
                [0.04, false],
                [0.08, false],
            ])
                muxer.addVideoChunk({
                    trackType: 'video',
                    data: frame,
                    timestamp: pts,
                    duration: 0.04,
                    isKeyframe: key,
                });
            for (let index = 0; index < 8; index++)
                muxer.addAudioChunk({
                    trackType: 'audio',
                    data: Uint8Array.of(1, 2),
                    timestamp: (index * 1024 - 1024) / 48000,
                    duration: 1024 / 48000,
                    isKeyframe: true,
                });
            for (const [time, text] of [
                [0.02, 'one <i>two</i>'],
                [0.1, 'three'],
            ])
                muxer.addSubtitleChunk(
                    {
                        trackType: 'subtitle',
                        data: new TextEncoder().encode(text),
                        timestamp: time,
                        duration: 0.03,
                        isKeyframe: true,
                    },
                    0,
                );
            await muxer.finalize();
            const { blob } = await convert(
                new Blob([await sink.toBlob('video/x-matroska').arrayBuffer()]),
                'fmp4',
            );
            const media = await open(blob);
            try {
                const first = {};
                const cues = [];
                for await (const packet of media.packets()) {
                    const track = media.tracks.find(item => item.id === packet.trackId);
                    first[track.type] = Math.min(first[track.type] ?? Infinity, packet.timestamp);
                    if (track.type === 'subtitle')
                        cues.push([[...packet.data], packet.timestamp, packet.duration]);
                }
                assert(Math.abs(first.video) < 1e-6, `video starts at ${first.video}`);
                // Matroska keeps the priming at its millisecond clock.
                assert(Math.abs(first.audio + 0.021) < 1e-6, `audio starts at ${first.audio}`);
                const subtitle = media.tracks.find(track => track.type === 'subtitle');
                assert.equal(subtitle.codec, 'tx3g');
                assert.equal(subtitle.language, 'pt-BR');
                const text = data =>
                    new TextDecoder().decode(
                        Uint8Array.from(data.slice(2, 2 + ((data[0] << 8) | data[1]))),
                    );
                assert.deepEqual(
                    cues.map(([data, time, duration]) => [
                        text(data),
                        Number(time.toFixed(3)),
                        Number(duration.toFixed(3)),
                    ]),
                    [
                        ['one two', 0.02, 0.03],
                        ['', 0.05, 0.05],
                        ['three', 0.1, 0.03],
                    ],
                    'cues keep their times; an empty sample fills the gap between them',
                );
                // The italic run is a tx3g style record over characters 4 to 7.
                assert.deepEqual(
                    cues[0][0].slice(9),
                    [
                        0, 0, 0, 22, 115, 116, 121, 108, 0, 1, 0, 4, 0, 7, 0, 1, 2, 18, 255, 255,
                        255, 255,
                    ],
                );
            } finally {
                media.close();
            }
        },
    );

    test(
        'a display matrix that scales one axis more than the other states the pixel ' + 'aspect',
        async () => {
            const video = matrix => ({
                type: 'video',
                name: 'V',
                title: 'V',
                default: true,
                width: 32,
                height: 24,
                matrix,
            });
            const identity = [1, 0, 0, 1];
            // A track matrix twice as wide (white_zombie_scrunch.mov): 2:1, as ffmpeg reads it.
            const wide = preservationFixture({
                tracks: [video([2, 0, 0, 1])],
                movieMatrix: identity,
            }).bytes;
            let track = (await demux(wide)).videoTracks[0];
            assert.deepEqual(
                [
                    track.pixelAspectRatioNum,
                    track.pixelAspectRatioDen,
                    track.displayWidth,
                    track.displayHeight,
                ],
                [2, 1, 64, 24],
            );
            // A rotation in the track and a vertical stretch in the movie header
            // (displaymatrix.mov): 1:2, rotated.
            const turned = preservationFixture({
                tracks: [video([0, 1, -1, 0])],
                movieMatrix: [1, 0, 0, 2],
            }).bytes;
            track = (await demux(turned)).videoTracks[0];
            assert.deepEqual(
                [track.pixelAspectRatioNum, track.pixelAspectRatioDen, track.rotation],
                [1, 2, 270],
            );
            // Within 1% both axes scale alike, and a plain matrix states nothing.
            for (const matrix of [[1.005, 0, 0, 1], identity]) {
                track = (
                    await demux(
                        preservationFixture({ tracks: [video(matrix)], movieMatrix: identity })
                            .bytes,
                    )
                ).videoTracks[0];
                assert.deepEqual(
                    [track.pixelAspectRatioNum, track.pixelAspectRatioDen, track.displayWidth],
                    [1, 1, 32],
                );
            }
            // Copies write it as a pixel aspect ratio.
            const copy = await convert(new Blob([wide]), 'mp4');
            const copied = (await demux(new Uint8Array(await copy.blob.arrayBuffer())))
                .videoTracks[0];
            assert.deepEqual([copied.pixelAspectRatioNum, copied.pixelAspectRatioDen], [2, 1]);
        },
    );

    test('movie tags, cover art and chapters survive MP4, MOV and Matroska copies', async () => {
        const data = (type, ...parts) =>
            atom('data', Buffer.of(0, 0, 0, type, 0, 0, 0, 0), ...parts);
        const text = value => Buffer.from(value, 'utf8');
        const png = Buffer.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4);
        // Nero chapters: version 1, a reserved word, the count, then each start in 100 ns units and
        // its title.
        const chapter = (start, title) => {
            const entry = Buffer.alloc(9 + title.length);
            entry.writeBigUInt64BE(start);
            entry[8] = title.length;
            entry.write(title, 9);
            return entry;
        };
        const chpl = Buffer.concat([
            Buffer.of(1, 0, 0, 0, 0, 0, 0, 0, 2),
            chapter(0n, 'One'),
            chapter(500000n, 'Two'),
        ]);
        const udta = atom(
            'udta',
            atom(
                'meta',
                Buffer.alloc(4),
                atom('hdlr', Buffer.alloc(8), text('mdirappl'), Buffer.alloc(9)),
                atom(
                    'ilst',
                    atom('©ART', data(1, text('Artist'))),
                    atom('©alb', data(1, text('Album'))),
                    atom('desc', data(1, text('A description'))),
                    // gnre numbers the ID3v1 genres from 1: 18 is Rock.
                    atom('gnre', data(0, Buffer.of(0, 18))),
                    atom('trkn', data(0, Buffer.of(0, 0, 0, 3, 0, 12, 0, 0))),
                    atom('covr', data(14, png)),
                ),
            ),
            atom('chpl', chpl),
        );
        const tracks = [
            { type: 'video', name: 'V', title: 'V', default: true },
            { type: 'audio', name: 'A', title: 'A', default: true },
        ];
        const input = preservationFixture({
            tracks,
            title: 'Movie',
            titleMode: 'ilst',
            movieBoxes: [udta],
        }).bytes;
        const expected = [
            { key: 'title', value: 'Movie' },
            { key: 'artist', value: 'Artist' },
            { key: 'album', value: 'Album' },
            { key: 'description', value: 'A description' },
            { key: 'genre', value: 'Rock' },
            { key: 'track', value: '3/12' },
        ];
        const sorted = entries => [...entries].sort((a, b) => a.key.localeCompare(b.key));
        const parsed = await demux(input);
        assert.deepEqual(sorted(parsed.tags.entries), sorted(expected));
        assert.deepEqual(parsed.tags.chapters, [
            { start: 0, end: 0.05, title: 'One' },
            { start: 0.05, title: 'Two' },
        ]);
        assert.deepEqual(parsed.tags.pictures, [
            { data: Uint8Array.from(png), mimeType: 'image/png', type: 3 },
        ]);
        for (const format of ['mkv', 'mov', 'mp4']) {
            const output = await convert(new Blob([input]), format);
            assert(
                !output.warnings.some(w => w.code === 'CONTAINER_METADATA_LOSS'),
                `${format}: nothing lost`,
            );
            const bytes = new Uint8Array(await output.blob.arrayBuffer());
            const result =
                format === 'mkv'
                    ? await new WebMDemuxer().demux(new BufferSource(bytes))
                    : await demux(bytes);
            const tags = result.tags;
            assert.deepEqual(sorted(tags.entries), sorted(expected), `${format} tags`);
            // The last chapter ends with the file.
            assert.deepEqual(
                tags.chapters.map(item => [item.start, item.title]),
                [
                    [0, 'One'],
                    [0.05, 'Two'],
                ],
                `${format} chapters`,
            );
            assert.deepEqual(tags.pictures[0].data, Uint8Array.from(png), `${format} cover`);
            assert.equal(tags.pictures[0].mimeType, 'image/png');
        }
    });

    test('a QuickTime chapter track is read as chapters, not as a subtitle track', async () => {
        const sample = value => Buffer.concat([Buffer.of(0, value.length), Buffer.from(value)]);
        const tracks = [
            { type: 'video', name: 'V', title: 'V', default: true, chapters: [3] },
            { type: 'audio', name: 'A', title: 'A', default: true },
            {
                type: 'subtitle',
                id: 3,
                codec: 'tx3g',
                default: false,
                packets: [sample('Intro'), sample('Middle'), sample('End')],
            },
        ];
        const parsed = await demux(preservationFixture({ tracks }).bytes);
        assert.equal(parsed.subtitleTracks?.length ?? 0, 0);
        assert.deepEqual(
            parsed.tags.chapters.map(item => [item.start, item.title]),
            [
                [0, 'Intro'],
                [0.04, 'Middle'],
                [0.08, 'End'],
            ],
        );
    });

    /**
     * A Matroska file of H.264 video, AAC audio primed before zero and the given text subtitle
     * tracks and cues.
     */
    async function matroskaWith(subtitleTracks = [], cues = [], { video = true } = {}) {
        const sink = new MemorySink();
        const muxer = new WebMMuxer(
            {
                format: 'mkv',
                mode: 'standard',
                maxFragmentDuration: 2,
                autoSync: true,
                ...(video
                    ? {
                          video: {
                              type: 'video',
                              codec: 'avc1.42001e',
                              codecConfig: avcc,
                              width: 32,
                              height: 24,
                              framerate: 25,
                          },
                          audio: {
                              type: 'audio',
                              codec: 'mp4a.40.2',
                              codecConfig: asc,
                              sampleRate: 48000,
                              channelCount: 2,
                          },
                      }
                    : {}),
                subtitleTracks,
            },
            sink,
        );
        if (video) {
            for (let index = 0; index < 4; index++)
                muxer.addVideoChunk({
                    trackType: 'video',
                    data: Uint8Array.of(0, 0, 0, 2, 0x65, 0x80),
                    timestamp: index * 0.04,
                    duration: 0.04,
                    isKeyframe: index === 0,
                });
            for (let index = 0; index < 8; index++)
                muxer.addAudioChunk({
                    trackType: 'audio',
                    data: Uint8Array.of(1, 2),
                    timestamp: (index * 1024 - 1024) / 48000,
                    duration: 1024 / 48000,
                    isKeyframe: true,
                });
        }
        for (const [time, text] of cues)
            muxer.addSubtitleChunk(
                {
                    trackType: 'subtitle',
                    data: new TextEncoder().encode(text),
                    timestamp: time,
                    duration: 0.03,
                    isKeyframe: true,
                },
                0,
            );
        await muxer.finalize();
        return new Blob([await sink.toBlob('video/x-matroska').arrayBuffer()]);
    }

    test('a copy that moves every timestamp says so and keeps the tracks aligned', async () => {
        // Matroska output cannot start before zero: the primed audio moves later and the video with
        // it.
        const { blob, warnings } = await convert(await matroskaWith(), 'mkv');
        assert(
            warnings.some(w => w.code === 'TIMESTAMPS_REALIGNED' && /later/.test(w.message)),
            'the shift is reported',
        );
        const media = await open(blob);
        try {
            const first = {};
            for await (const packet of media.packets()) {
                const track = media.tracks.find(item => item.id === packet.trackId);
                first[track.type] = Math.min(first[track.type] ?? Infinity, packet.timestamp);
            }
            assert(
                Math.abs(first.video - first.audio - 0.021) < 0.0015,
                `${first.video} vs ${first.audio}`,
            );
        } finally {
            media.close();
        }
        // An MP4 copy keeps the times as they are and says nothing.
        const mp4 = await convert(await matroskaWith(), 'mp4');
        assert(!mp4.warnings.some(w => w.code === 'TIMESTAMPS_REALIGNED'));
    });

    test(
        'WebVTT blocks become timed text without their identifier and settings ' + 'lines',
        async () => {
            // A Matroska WebVTT block holds the cue identifier line, the settings line and then the
            // text.
            const input = await matroskaWith(
                [{ codec: 'text/webvtt' }],
                [[0.02, 'cue-1\nline:90%\nHello <b>there</b>']],
            );
            const { blob } = await convert(input, 'mp4');
            const media = await open(blob);
            try {
                const texts = [];
                for await (const packet of media.packets()) {
                    if (media.tracks.find(item => item.id === packet.trackId).type !== 'subtitle')
                        continue;
                    const length = (packet.data[0] << 8) | packet.data[1];
                    if (length)
                        texts.push(new TextDecoder().decode(packet.data.slice(2, 2 + length)));
                }
                assert.deepEqual(texts, ['Hello there']);
            } finally {
                media.close();
            }
        },
    );

    test('a file of subtitles alone keeps its cue times in MP4', async () => {
        const input = await matroskaWith([{ codec: 'text/utf8' }], [[0.97, 'Late cue']], {
            video: false,
        });
        const { blob, warnings } = await convert(input, 'mp4');
        assert(!warnings.some(w => w.code === 'TIMESTAMPS_REALIGNED'));
        const output = await demux(new Uint8Array(await blob.arrayBuffer()));
        const cue = output.subtitleTracks[0].samples.find(sample => sample.size > 2);
        assert(Math.abs(cue.timestamp - 0.97) < 1e-6, `the cue starts at ${cue.timestamp}`);
    });

    test('a subtitle cut short by its edit keeps that end in an MP4 copy', async () => {
        const sample = value => Buffer.concat([Buffer.of(0, value.length), Buffer.from(value)]);
        const tracks = [
            { type: 'video', name: 'V', title: 'V', default: true },
            { type: 'audio', name: 'A', title: 'A', default: true },
            // Three 40 ms cues, the edit presenting 100 ms of them.
            {
                type: 'subtitle',
                codec: 'tx3g',
                default: true,
                packets: [sample('One'), sample('Two'), sample('')],
                edit: { duration: 100, mediaTime: 0 },
            },
        ];
        const input = preservationFixture({ tracks }).bytes;
        assert.equal((await demux(input)).subtitleTracks[0].duration, 0.1);
        const { blob, warnings } = await convert(new Blob([input]), 'mp4');
        assert(!warnings.some(w => w.code === 'TIMESTAMPS_REALIGNED'));
        const output = await demux(new Uint8Array(await blob.arrayBuffer()));
        assert.equal(output.subtitleTracks[0].duration, 0.1);
        // Into Matroska, timed text becomes SubRip, and its styling beyond bold, italic and
        // underline is reported lost.
        const mkv = await convert(new Blob([input]), 'mkv');
        assert(mkv.warnings.some(w => w.code === 'SUBTITLE_SETTINGS_LOSS'));
    });

    test('MPEG-TS output reports the display metadata it cannot store', async () => {
        const tracks = [
            { type: 'video', name: 'V', title: 'V', default: true, matrix: [0, 1, -1, 0] },
            { type: 'audio', name: 'A', title: 'A', default: true },
        ];
        const input = preservationFixture({ tracks, movieMatrix: [1, 0, 0, 2] }).bytes;
        const { warnings } = await convert(new Blob([input]), 'ts');
        const loss = warnings.find(
            w => w.code === 'TRACK_METADATA_LOSS' && /video track/.test(w.message),
        );
        assert(
            loss &&
                /display rotation/.test(loss.message) &&
                /pixel aspect ratio/.test(loss.message),
            loss?.message,
        );
        // MP4 stores both, and reports nothing.
        const mp4 = await convert(new Blob([input]), 'mp4');
        assert(!mp4.warnings.some(w => w.code === 'TRACK_METADATA_LOSS'));
    });
});
