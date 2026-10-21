import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
    atom,
    atomList,
    avcc,
    preservationFixture,
    preservationSource,
} from '../helpers/mp4-preservation-fixture.mjs';

import { Mp4Demuxer, Mp4Muxer } from 'mediaforgejs/formats';
import { CmafWriter } from 'mediaforgejs/streaming';
import { MemorySink } from 'mediaforgejs/io';
import { encodeAacLc } from 'mediaforgejs/codecs';
import { convert } from 'mediaforgejs';
import { differentialFixtures } from '../helpers/differential-fixtures.mjs';
import { readAll } from '../helpers/read-media.mjs';
import { deinterleave } from '../helpers/pcm.mjs';

const encoded = await encodeAacLc(
    deinterleave(
        Float32Array.from({ length: 4096 }, (_, index) => Math.sin(index * 0.07) * 0.1),
        2,
    ),
    { sampleRate: 48000 },
);

describe('mp4: titles other programs read', () => {
    const movieTitle = 'Original movie — 日本語 🎬';
    const tracks = [
        { id: 11, name: 'Main 日本語', title: 'Soundtrack 日本語', default: false },
        {
            id: 22,
            name: 'Commentary é',
            title: 'Commentary title é',
            default: true,
            commentary: true,
        },
    ].map(track => ({
        ...track,
        type: 'audio',
        codec: 'mp4a.40.2',
        sampleRate: 48000,
        channelCount: 2,
    }));
    const text = value => Buffer.from(value, 'utf8');
    const u32 = value => {
        const bytes = Buffer.alloc(4);
        bytes.writeUInt32BE(value);
        return bytes;
    };
    const childBoxes = (bytes, parent) => atomList(bytes, parent.payload, parent.end);
    const bytesOf = async sink => Buffer.from(await sink.toBlob().arrayBuffer());
    const demux = bytes => new Mp4Demuxer().demux(preservationSource(bytes));

    for (const override of [undefined, 'deu'])
        test(
            `primary and extra track languages use the same configuration fields ` +
                `(${override ?? 'track'})`,
            async () => {
                const sink = new MemorySink();
                const muxer = new Mp4Muxer(
                    {
                        format: 'mp4',
                        mode: 'standard',
                        autoSync: true,
                        maxFragmentDuration: 2,
                        audioLanguage: override,
                        videoLanguage: override,
                        video: {
                            id: 7,
                            type: 'video',
                            codec: 'avc1.42001e',
                            width: 32,
                            height: 24,
                            framerate: 25,
                            codecConfig: avcc,
                            language: 'fra',
                        },
                        audio: {
                            ...tracks[0],
                            codecConfig: encoded.audioSpecificConfig,
                            language: 'eng',
                        },
                        extraAudioTracks: [
                            {
                                ...tracks[1],
                                codecConfig: encoded.audioSpecificConfig,
                                language: 'jpn',
                            },
                        ],
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
                const chunk = {
                    trackType: 'audio',
                    data: encoded.frames[0],
                    timestamp: 0,
                    duration: 1024 / 48000,
                    isKeyframe: true,
                };
                muxer.addAudioChunk(chunk);
                muxer.addExtraAudioChunk(0, chunk);
                await muxer.finalize();
                const result = await demux(await bytesOf(sink));
                assert.deepEqual(
                    result.audioTracks.map(t => t.language),
                    [override ?? 'eng', 'jpn'],
                );
                assert.equal(result.videoTracks[0].language, override ?? 'fra');
            },
        );

    function conventionalTitles(bytes) {
        const moov = atomList(bytes).find(box => box.type === 'moov');
        const children = parent => childBoxes(bytes, parent);
        const userData = parent =>
            children(parent)
                .filter(box => box.type === 'udta')
                .flatMap(children);
        let movie;
        for (const box of userData(moov)) {
            if (box.type === '©nam') {
                const length = bytes.readUInt16BE(box.payload);
                assert.equal(bytes.readUInt16BE(box.payload + 2), 0x55c4);
                assert.equal(box.payload + 4 + length, box.end);
                movie = bytes.toString('utf8', box.payload + 4, box.end);
            } else if (box.type === 'meta') {
                assert.equal(bytes.readUInt32BE(box.payload), 0);
                const parts = atomList(bytes, box.payload + 4, box.end);
                const list = parts.find(part => part.type === 'ilst');
                if (!list) continue;
                const title = children(list).find(part => part.type === '©nam');
                if (!title) continue;
                const value = children(title).find(part => part.type === 'data');
                assert.equal(bytes.readUInt32BE(value.payload), 1);
                movie = bytes.toString('utf8', value.payload + 8, value.end);
            }
        }
        return {
            movie,
            tracks: children(moov)
                .filter(box => box.type === 'trak')
                .map(trak => {
                    const title = userData(trak).find(box => box.type === 'name');
                    return title && bytes.toString('utf8', title.payload, title.end);
                }),
        };
    }

    function externalTitles(title, trackTitles, mode = 'ilst') {
        const fixture = preservationFixture({
            title,
            titleMode: mode,
            tracks: tracks.map(track => ({ ...track, title: undefined, packets: encoded.frames })),
        });
        const bytes = Buffer.from(fixture.bytes);
        let trackIndex = 0;
        return Buffer.concat(
            atomList(bytes).map(box => {
                if (box.type !== 'moov') return bytes.subarray(box.offset, box.end);
                return atom(
                    'moov',
                    ...childBoxes(bytes, box).map(child => {
                        if (child.type !== 'trak') return bytes.subarray(child.offset, child.end);
                        const title = trackTitles[trackIndex++];
                        return atom(
                            'trak',
                            ...childBoxes(bytes, child).map(part =>
                                part.type === 'udta' && title !== undefined
                                    ? atom(
                                          'udta',
                                          bytes.subarray(part.payload, part.end),
                                          atom('name', text(title)),
                                      )
                                    : bytes.subarray(part.offset, part.end),
                            ),
                        );
                    }),
                );
            }),
        );
    }

    for (const mode of ['ilst', 'legacy'])
        test(
            `demux reads external ${mode} movie titles and track name atoms ` + `independently`,
            async () => {
                for (const title of [movieTitle, '']) {
                    const titles = [title, ''];
                    const parsed = await demux(externalTitles(title, titles, mode));
                    assert.equal(parsed.title, title);
                    assert.deepEqual(
                        parsed.audioTracks.map(track => track.title),
                        titles,
                    );
                    assert.deepEqual(
                        parsed.audioTracks.map(track => track.name),
                        tracks.map(track => track.name),
                    );
                    assert.deepEqual(
                        parsed.audioTracks.map(track => track.default),
                        [false, true],
                    );
                }
            },
        );

    test('demux recognizes the plain title key used by mdta metadata writers', async () => {
        const fixture = preservationFixture({ tracks: [{ type: 'audio' }] });
        const bytes = Buffer.from(fixture.bytes);
        const meta = atom(
            'meta',
            u32(0),
            atom('hdlr', u32(0), u32(0), text('mdta'), Buffer.alloc(13)),
            atom('keys', u32(0), u32(1), atom('mdta', text('title'))),
            atom('ilst', atom(1, atom('data', u32(1), u32(0), text(movieTitle)))),
        );
        const input = Buffer.concat(
            atomList(bytes).map(box =>
                box.type === 'moov'
                    ? atom('moov', bytes.subarray(box.payload, box.end), atom('udta', meta))
                    : bytes.subarray(box.offset, box.end),
            ),
        );
        assert.equal((await demux(input)).title, movieTitle);
    });

    async function writeMovie(format, mode, buffered, title = movieTitle, audioTracks = tracks) {
        const sink = new MemorySink();
        const output = buffered
            ? { write: data => sink.write(data), close: () => sink.close() }
            : sink;
        const muxer = new Mp4Muxer(
            {
                format,
                mode,
                maxFragmentDuration: 2,
                autoSync: false,
                title,
                audio: audioTracks[0],
                extraAudioTracks: audioTracks.slice(1),
            },
            output,
        );
        for (const [index, data] of encoded.frames.entries()) {
            const chunk = {
                trackType: 'audio',
                data,
                timestamp: (index * 1024) / 48000,
                duration: 1024 / 48000,
                isKeyframe: true,
            };
            muxer.addAudioChunk(chunk, encoded.audioSpecificConfig);
            for (let track = 1; track < audioTracks.length; track++)
                muxer.addExtraAudioChunk(track - 1, chunk, encoded.audioSpecificConfig);
        }
        await muxer.finalize();
        return bytesOf(sink);
    }

    for (const format of ['mp4', 'mov'])
        for (const [mode, buffered] of [
            ['standard', false],
            ['standard', true],
            ['fragmented', false],
        ])
            test(
                `${format} ${mode} ${buffered ? 'buffered' : 'seekable'} exposes conventional ` +
                    `movie ` +
                    `and track titles`,
                async () => {
                    const selected = mode === 'fragmented' ? tracks.slice(0, 1) : tracks;
                    const bytes = await writeMovie(format, mode, buffered, movieTitle, selected);
                    assert.deepEqual(conventionalTitles(bytes), {
                        movie: movieTitle,
                        tracks: selected.map(track => track.title),
                    });
                    const parsed = await demux(bytes);
                    assert.equal(parsed.title, movieTitle);
                    assert.deepEqual(
                        parsed.audioTracks.map(track => track.title),
                        selected.map(track => track.title),
                    );
                    assert.deepEqual(
                        parsed.audioTracks.map(track => track.name),
                        selected.map(track => track.name),
                    );
                    assert.deepEqual(
                        parsed.audioTracks.map(track => track.default),
                        selected.map(track => track.default),
                    );
                    if (selected.length > 1) assert.equal(parsed.audioTracks[1].commentary, true);
                },
            );

    test('CMAF init exposes movie and each audio title in conventional metadata', () => {
        const writer = new CmafWriter({
            title: movieTitle,
            tracks: tracks.map(track => ({
                ...track,
                timescale: 48000,
                codecConfig: encoded.audioSpecificConfig,
            })),
        });
        assert.deepEqual(conventionalTitles(Buffer.from(writer.createInitSegment())), {
            movie: movieTitle,
            tracks: tracks.map(track => track.title),
        });
    });

    for (const format of ['mp4', 'mov'])
        test(
            `${format} preserves empty titles and titles beyond the legacy 16-bit string ` +
                `limit`,
            async () => {
                for (const title of ['', '日本語'.repeat(7300)]) {
                    const audio = [{ ...tracks[0], title, name: 'Distinct name' }];
                    const bytes = await writeMovie(format, 'standard', false, title, audio);
                    assert.deepEqual(conventionalTitles(bytes), { movie: title, tracks: [title] });
                    const parsed = await demux(bytes);
                    assert.equal(parsed.title, title);
                    assert.equal(parsed.audioTracks[0].title, title);
                    assert.equal(parsed.audioTracks[0].name, 'Distinct name');
                }
            },
        );

    test(
        'a NUL-padded track name and a pasp with a zero spacing still copy into ' + 'Matroska',
        async () => {
            const { bytes } = preservationFixture({
                tracks: [
                    { type: 'video', entryBoxes: [atom('pasp', u32(0), u32(1))] },
                    { type: 'audio', userBoxes: [atom('name', Buffer.alloc(4))] },
                ],
            });
            const parsed = await demux(bytes);
            assert.equal(parsed.audioTracks[0].title, '', 'the name ends at its first NUL');
            assert.equal(
                parsed.videoTracks[0].pixelAspectRatioNum,
                1,
                'a zero spacing states no pixel aspect',
            );
            assert.equal(parsed.videoTracks[0].pixelAspectRatioDen, 1);
            assert.equal(parsed.videoTracks[0].displayWidth, 32);
            const { plan, blob } = await convert(bytes, 'mkv');
            assert.deepEqual(
                plan.tracks.map(track => track.action),
                ['copy', 'copy'],
            );
            assert(blob.size > 0);
        },
    );

    test('a QuickTime title whose length counts a C terminator ends there', async () => {
        const terminated = differentialFixtures['mov-maclang.mov']();
        terminated[Buffer.from(terminated).indexOf('Mac') + 2] = 0;
        assert.equal((await readAll(terminated)).title, 'Ma');
    });
});
