import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { webcrypto } from 'node:crypto';
import { MediaForge, check, open, packageMedia } from 'mediaforgejs';
import { MemorySink } from 'mediaforgejs/io';
import { WebMMuxer } from 'mediaforgejs/formats';
import { parseHlsPlaylist, sequenceIv } from 'mediaforgejs/streaming';
import { atom, preservationFixture } from '../helpers/mp4-preservation-fixture.mjs';
import { avcc, filler, idr, lengthPrefixed, predicted } from '../helpers/avi-h264-fixtures.mjs';
import { opusHead } from '../helpers/multitrack-pcm-fixtures.mjs';
import { joined, packageMovie, readBack } from '../helpers/package-movie.mjs';
import { openFile } from '../helpers/engine.mjs';
import { distUrl } from '../helpers/dist-paths.mjs';

// HLS packages of a file: fMP4 or MPEG-TS segments cut at keyframes, the media and master
// playlists, demuxed renditions, subtitles, AES-128 and the limits of a package.

const { packageHls, hlsMasterPlaylist } = await import(distUrl('esm/pipeline/package/hls.js'));
const { collectPackage } = await import(distUrl('esm/pipeline/package/segments.js'));

const text = file => new TextDecoder().decode(file.data);
const strict = file => parseHlsPlaylist(text(file), { validation: 'strict' });
const segmentsOf = files => files.filter(file => file.kind === 'segment');

/** The files packageHls() yields for the package movie with `options`, and its summary. */
async function collect(options, bytes = packageMovie()) {
    const file = await openFile(bytes);
    try {
        const files = [];
        const generator = packageHls(file, options);
        for (;;) {
            const step = await generator.next();
            if (step.done) return { files, summary: step.value };
            files.push(step.value);
        }
    } finally {
        file.close();
    }
}

describe('package: HLS', () => {
    describe('fMP4 segments', () => {
        test('come as the init segment, the segments and both playlists', async () => {
            const { files } = await collect({ targetDuration: 0.16 });
            assert.deepEqual(
                files.map(file => file.name),
                [
                    'init.mp4',
                    'segment-00000.m4s',
                    'segment-00001.m4s',
                    'segment-00002.m4s',
                    'index.m3u8',
                    'master.m3u8',
                ],
            );
        });

        test('are cut at the keyframes and timed in milliseconds', async () => {
            const { files } = await collect({ targetDuration: 0.16 });
            assert.deepEqual(
                segmentsOf(files).map(file => [
                    file.number,
                    Number(file.timing.duration),
                    file.timing.timescale,
                ]),
                [
                    [0, 160, 1000],
                    [1, 160, 1000],
                    [2, 160, 1000],
                ],
            );
        });

        test('the media playlist is a strict VOD list of the segments and their map', async () => {
            const { files } = await collect({ targetDuration: 0.16 });
            const media = strict(files[4]);
            assert.deepEqual(
                [media.type, media.targetDuration, media.playlistType, media.endList],
                ['media', 1, 'VOD', true],
            );
            assert.deepEqual(
                media.segments.map(segment => [segment.uri, segment.duration, segment.map?.uri]),
                segmentsOf(files).map(file => [file.name, 0.16, 'init.mp4']),
            );
        });

        test('the master playlist states size, codecs, frame rate and bandwidth', async () => {
            const { files } = await collect({ targetDuration: 0.16 });
            const master = strict(files[5]);
            assert.equal(master.type, 'master');
            assert.equal(master.variants.length, 1);
            const [variant] = master.variants;
            assert.equal(variant.uri, 'index.m3u8');
            assert.deepEqual(variant.resolution, { width: 64, height: 48 });
            assert.equal(variant.codecs, 'avc1.42000a,mp4a.40.2');
            assert.equal(variant.frameRate, 25);
            assert.ok(variant.bandwidth > 0 && variant.averageBandwidth > 0);
        });

        test('the summary counts the muxed representation, files and bytes', async () => {
            const { files, summary } = await collect({ targetDuration: 0.16 });
            assert.deepEqual(
                summary.representations.map(representation => representation.type),
                ['muxed'],
            );
            assert.deepEqual(
                [summary.duration, summary.targetDuration, summary.files],
                [0.48, 1, files.length],
            );
            assert.equal(
                summary.bytes,
                files.reduce((sum, file) => sum + file.data.length, 0),
            );
        });

        test('the init segment and the segments joined read as the input', async () => {
            const { files } = await collect({ targetDuration: 0.16 });
            const restored = await readBack(
                joined(files.filter(file => file.kind !== 'playlist').map(file => file.data)),
            );
            assert.deepEqual(restored, await readBack(packageMovie()));
        });
    });

    describe('MPEG-TS segments', () => {
        test('each start with the PAT and hold whole transport packets', async () => {
            const { files } = await collect({ targetDuration: 0.16, container: 'ts' });
            assert.deepEqual(
                files.map(file => file.name),
                [
                    'segment-00000.ts',
                    'segment-00001.ts',
                    'segment-00002.ts',
                    'index.m3u8',
                    'master.m3u8',
                ],
            );
            for (const file of segmentsOf(files)) {
                assert.equal(file.data.length % 188, 0, file.name);
                assert.equal(file.data[0], 0x47, file.name);
                assert.equal(((file.data[1] & 0x1f) << 8) | file.data[2], 0, file.name);
            }
            assert.equal(strict(files[3]).segments[0].map, undefined);
        });

        test('joined read as the input', async () => {
            const { files } = await collect({ targetDuration: 0.16, container: 'ts' });
            const restored = await readBack(joined(segmentsOf(files).map(file => file.data)));
            const original = await readBack(packageMovie());
            assert.deepEqual(restored.tracks, original.tracks);
            const of = (read, type) => read.result.filter(packet => packet.type === type);
            assert.deepEqual(of(restored, 'audio'), of(original, 'audio'));
            const timing = packets => packets.map(packet => [packet.time, packet.key]);
            assert.deepEqual(timing(of(restored, 'video')), timing(of(original, 'video')));
        });

        test('a target longer than the input makes one segment', async () => {
            const { files } = await collect({ targetDuration: 10, container: 'ts' });
            assert.equal(segmentsOf(files).length, 1);
        });
    });

    describe('demuxed renditions', () => {
        test('give the video and the audio their own init, segments and playlist', async () => {
            const { files, summary } = await collect({ targetDuration: 0.16, demuxed: true });
            const names = files.map(file => file.name);
            assert.deepEqual(names.slice(0, 2), ['init-video11.mp4', 'init-audio12.mp4']);
            assert.deepEqual(names.slice(-3), ['video11.m3u8', 'audio12.m3u8', 'master.m3u8']);
            assert.equal(names.filter(name => name.startsWith('seg-video11-')).length, 3);
            assert.ok(names.filter(name => name.startsWith('seg-audio12-')).length >= 3);
            assert.deepEqual(
                summary.representations.map(representation => representation.type),
                ['video', 'audio'],
            );
        });

        test('the master playlist names the audio group of the variant', async () => {
            const { files } = await collect({ targetDuration: 0.16, demuxed: true });
            const master = strict(files.at(-1));
            assert.deepEqual(
                master.renditions.map(({ groupId, uri, name }) => [groupId, uri, name]),
                [['audio', 'audio12.m3u8', 'Main']],
            );
            assert.deepEqual(
                [master.variants[0].uri, master.variants[0].audio],
                ['video11.m3u8', 'audio'],
            );
        });

        test('the video rendition joined reads as the video of the input', async () => {
            const { files } = await collect({ targetDuration: 0.16, demuxed: true });
            const video = files.filter(
                file => file.representation === 'video11' && file.kind !== 'playlist',
            );
            assert.deepEqual(
                (await readBack(joined(video.map(file => file.data)))).result,
                (await readBack(packageMovie())).result.filter(packet => packet.type === 'video'),
            );
        });

        test('a master playlist of several packages gives each its audio group', async () => {
            const { summary } = await collect({ targetDuration: 0.16, demuxed: true });
            const combined = hlsMasterPlaylist([
                { summary, uri: 'a/' },
                { summary, uri: 'b/' },
            ]);
            assert.deepEqual(
                strict(combined).variants.map(variant => [variant.uri, variant.audio]),
                [
                    ['a/video11.m3u8', 'audio-0'],
                    ['b/video11.m3u8', 'audio-1'],
                ],
            );
        });
    });

    describe('limits and options', () => {
        const withFile = async run => {
            const file = await openFile(packageMovie());
            try {
                return await run(file);
            } finally {
                file.close();
            }
        };

        test('more segments than allowed fail with OUTPUT', async () => {
            await withFile(file =>
                assert.rejects(
                    collectPackage(packageHls(file, { targetDuration: 0.16, maxSegments: 2 })),
                    { code: 'OUTPUT' },
                ),
            );
        });

        test('more bytes than allowed fail with OOM', async () => {
            await withFile(file =>
                assert.rejects(
                    collectPackage(packageHls(file, { targetDuration: 0.16, maxTotalBytes: 300 })),
                    { code: 'OOM' },
                ),
            );
        });

        test('an abort stops the package after the file in hand', async () => {
            await withFile(async file => {
                const controller = new AbortController();
                let seen = 0;
                const options = { targetDuration: 0.16, signal: controller.signal };
                await assert.rejects(
                    (async () => {
                        for await (const packaged of packageHls(file, options)) {
                            seen++;
                            if (packaged.kind === 'segment') controller.abort();
                        }
                    })(),
                    { code: 'ABORT' },
                );
                assert.equal(seen, 2);
            });
        });

        test('a zero target duration and demuxed MPEG-TS fail with INPUT', async () => {
            await withFile(async file => {
                await assert.rejects(packageHls(file, { targetDuration: 0 }).next(), {
                    code: 'INPUT',
                });
                await assert.rejects(packageHls(file, { container: 'ts', demuxed: true }).next(), {
                    code: 'INPUT',
                });
            });
        });

        test('an audio-only package states no resolution', async () => {
            await withFile(async file => {
                const audioOnly = await collectPackage(
                    packageHls(file, { trackIds: [12], targetDuration: 0.2 }),
                );
                const [variant] = strict(audioOnly.get('master.m3u8')).variants;
                assert.deepEqual([variant.codecs, variant.resolution], ['mp4a.40.2', undefined]);
            });
        });
    });

    describe('packageMedia()', () => {
        const REQUEST = { container: 'ts', targetDuration: 0.16 };
        const NAMES = [
            'segment-00000.ts',
            'segment-00001.ts',
            'segment-00002.ts',
            'index.m3u8',
            'master.m3u8',
        ];

        test('returns the files by name with the master playlist as the entry', async () => {
            const { files, entry } = await packageMedia(new Blob([packageMovie()]), 'hls', REQUEST);
            assert.equal(entry, 'master.m3u8');
            assert.deepEqual([...files.keys()], NAMES);
        });

        test('hands files to onFile without keeping them, and reports progress', async () => {
            const names = [];
            const progress = [];
            const media = await open(packageMovie());
            try {
                const streamed = await media.packageMedia('hls', {
                    ...REQUEST,
                    onFile: file => names.push(file.name),
                    onProgress: value => progress.push(value),
                });
                assert.equal(streamed.files.size, 0);
                assert.deepEqual(names, NAMES);
                const last = progress.at(-1);
                assert.deepEqual([last.fraction, last.packets, last.segments], [1, 35, 2]);
            } finally {
                media.close();
            }
        });

        test('HLS is no convert() target, and MP4 no package', async () => {
            const media = await open(packageMovie());
            try {
                await assert.rejects(media.convert('hls'), { code: 'INPUT' });
                await assert.rejects(media.packageMedia('mp4'), { code: 'INPUT' });
            } finally {
                media.close();
            }
        });

        test('DASH ignores an MPEG-TS container, unless options are strict', async () => {
            const lenient = await packageMedia(packageMovie(), 'dash', REQUEST);
            assert.ok(
                lenient.warnings.some(
                    ({ code, message }) => code === 'OPTION_IGNORED' && /container/.test(message),
                ),
            );
            const media = await open(packageMovie(), { optionPolicy: 'strict' });
            try {
                await assert.rejects(media.packageMedia('dash', { container: 'ts' }), {
                    code: 'INPUT',
                });
            } finally {
                media.close();
            }
        });
    });

    describe('AES-128', () => {
        const KEY = Uint8Array.from({ length: 16 }, (_, index) => index * 17 + 3);
        const decrypt = async (data, sequence) => {
            const handle = await webcrypto.subtle.importKey(
                'raw',
                KEY,
                { name: 'AES-CBC' },
                false,
                ['decrypt'],
            );
            const iv = sequenceIv(sequence);
            return new Uint8Array(
                await webcrypto.subtle.decrypt({ name: 'AES-CBC', iv }, handle, data),
            );
        };
        const secured = () =>
            collect({
                targetDuration: 0.16,
                encryption: { method: 'AES-128', key: KEY, keyUri: 'key.bin', keyFile: 'key.bin' },
                programDateTime: '2026-02-02T02:02:02Z',
            });

        test('writes the key file and states the key and the date in the playlist', async () => {
            const { files } = await secured();
            assert.deepEqual(
                files.map(file => file.name),
                [
                    'init.mp4',
                    'segment-00000.m4s',
                    'segment-00001.m4s',
                    'segment-00002.m4s',
                    'key.bin',
                    'index.m3u8',
                    'master.m3u8',
                ],
            );
            const playlist = text(files.find(file => file.name === 'index.m3u8'));
            assert.match(
                playlist,
                new RegExp(
                    String.raw`#EXT-X-KEY:METHOD=AES-128,URI="key\.bin"\n` +
                        String.raw`#EXT-X-PROGRAM-DATE-TIME:2026-02-02T02:02:02\.000Z\n#EXTINF`,
                ),
            );
            parseHlsPlaylist(playlist, { validation: 'strict' });
        });

        test('encrypts each segment with the IV of its sequence, not the init', async () => {
            const plain = (await collect({ targetDuration: 0.16 })).files;
            const { files } = await secured();
            const named = (list, name) => list.find(file => file.name === name).data;
            for (let index = 0; index < 3; index++) {
                const name = `segment-0000${index}.m4s`;
                assert.deepEqual(await decrypt(named(files, name), index), named(plain, name));
            }
            assert.deepEqual(named(files, 'init.mp4'), named(plain, 'init.mp4'));
        });

        test('an unreadable program date fails with INPUT', async () => {
            await assert.rejects(collect({ targetDuration: 0.16, programDateTime: 'soon' }), {
                code: 'INPUT',
            });
        });

        test('packageMedia() writes no key file unless asked', async () => {
            const { files } = await packageMedia(packageMovie(), {
                to: 'hls',
                targetDuration: 0.16,
                encryption: { method: 'AES-128', key: KEY, keyUri: 'key.bin' },
            });
            assert.match(text(files.get('index.m3u8')), /EXT-X-KEY/);
            assert.equal(files.has('key.bin'), false);
        });

        test('DASH drops the HLS-only settings with warnings', async () => {
            const warnings = [];
            const forge = new MediaForge({ onWarning: warning => warnings.push(warning.code) });
            const { files } = await forge.packageMedia(packageMovie(), {
                to: 'dash',
                targetDuration: 0.16,
                encryption: { method: 'AES-128', key: KEY, keyUri: 'key.bin' },
                programDateTime: 'not a date',
            });
            assert.ok(files.has('manifest.mpd'));
            assert.deepEqual(warnings, ['OPTION_IGNORED', 'OPTION_IGNORED']);
        });
    });

    describe('text subtitles', () => {
        // An Opus track of two seconds and two UTF-8 cues in Japanese, in Matroska.
        async function subtitled() {
            const sink = new MemorySink();
            const muxer = new WebMMuxer(
                {
                    format: 'mkv',
                    mode: 'standard',
                    autoSync: false,
                    audio: {
                        id: 1,
                        type: 'audio',
                        codec: 'opus',
                        sampleRate: 48000,
                        channelCount: 2,
                        codecConfig: opusHead(2),
                    },
                    subtitleTracks: [
                        { id: 2, type: 'subtitle', codec: 'text/utf8', language: 'jpn' },
                    ],
                },
                sink,
            );
            for (let index = 0; index < 100; index++)
                muxer.addAudioChunk({
                    trackType: 'audio',
                    data: Uint8Array.of(0xfc, 0xff, 0xfe),
                    timestamp: index * 0.02,
                    duration: 0.02,
                    isKeyframe: true,
                });
            for (const [start, end, cue] of [
                [0.2, 0.6, 'First cue'],
                [1.2, 1.9, 'Second\n\nline'],
            ])
                muxer.addSubtitleChunk({
                    trackType: 'subtitle',
                    data: new TextEncoder().encode(cue),
                    timestamp: start,
                    duration: end - start,
                    isKeyframe: true,
                });
            await muxer.finalize();
            return sink.toBlob();
        }

        test('check() accepts a subtitled input for HLS', async () => {
            assert.equal((await check(await subtitled(), 'hls')).supported, true);
        });

        test('become a WebVTT rendition cut on the media segment grid', async () => {
            const { files } = await packageMedia(await subtitled(), 'hls', { targetDuration: 1 });
            const playlist = name => parseHlsPlaylist(text(files.get(name)));
            const master = playlist('master.m3u8');
            const subtitles = master.renditions.filter(({ type }) => type === 'SUBTITLES');
            assert.equal(subtitles.length, 1);
            assert.equal(subtitles[0].language, 'jpn');
            assert.equal(master.variants[0].subtitles, subtitles[0].groupId);
            assert.deepEqual(
                playlist(subtitles[0].uri).segments.map(segment => segment.duration),
                playlist('index.m3u8').segments.map(segment => segment.duration),
            );
        });

        test('the WebVTT segments map the timestamps and keep the cues', async () => {
            const { files } = await packageMedia(await subtitled(), 'hls', { targetDuration: 1 });
            const master = parseHlsPlaylist(text(files.get('master.m3u8')));
            const { uri } = master.renditions.find(({ type }) => type === 'SUBTITLES');
            const vtt = parseHlsPlaylist(text(files.get(uri)))
                .segments.map(segment => text(files.get(segment.uri)))
                .join('');
            assert.match(vtt, /^WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00\.000\n/);
            assert.match(vtt, /00:00:00\.200 --> 00:00:00\.600\nFirst cue\n/);
            // A blank line inside a cue is dropped.
            assert.match(vtt, /00:00:01\.200 --> 00:00:01\.900\nSecond\nline\n/);
        });

        test('a subtitle track trackIds names is a rendition, not FORMAT', async () => {
            const languages = async trackIds => {
                const { files } = await packageMedia(await subtitled(), 'hls', {
                    targetDuration: 1,
                    trackIds,
                });
                const master = parseHlsPlaylist(text(files.get('master.m3u8')));
                return master.renditions
                    .filter(({ type }) => type === 'SUBTITLES')
                    .map(({ language }) => language);
            };
            assert.deepEqual(await languages([1, 2]), ['jpn']);
            assert.deepEqual(await languages([1]), [], 'only the tracks it names');
        });

        test('DASH leaves out subtitles trackIds names, refused strictly', async () => {
            const warnings = [];
            const { files } = await packageMedia(await subtitled(), 'dash', {
                trackIds: [1, 2],
                onWarning: warning => warnings.push(warning),
            });
            assert.deepEqual(
                warnings.map(warning => [warning.code, warning.trackId]),
                [['TARGET_TRACKS_DROPPED', 2]],
            );
            assert.ok(files.has('manifest.mpd'));
            await assert.rejects(
                packageMedia(await subtitled(), 'dash', {
                    trackIds: [1, 2],
                    optionPolicy: 'strict',
                }),
                error => error.code === 'FORMAT' && /track 2 \(subtitle\)/.test(error.message),
            );
        });

        test("the HLS playlists of 'hls+dash' carry them too, the DASH manifest not", async () => {
            const { files } = await packageMedia(await subtitled(), 'hls+dash', {
                targetDuration: 1,
            });
            const master = parseHlsPlaylist(text(files.get('master.m3u8')));
            const subtitles = master.renditions.filter(({ type }) => type === 'SUBTITLES');
            assert.deepEqual(
                subtitles.map(({ language }) => language),
                ['jpn'],
            );
            assert.equal(master.variants[0].subtitles, subtitles[0].groupId);
            const vtt = parseHlsPlaylist(text(files.get(subtitles[0].uri)))
                .segments.map(segment => text(files.get(segment.uri)))
                .join('');
            assert.match(vtt, /00:00:00\.200 --> 00:00:00\.600\nFirst cue\n/);
            assert.doesNotMatch(text(files.get('manifest.mpd')), /vtt|contentType="text"/);
        });
    });

    describe('what a player cannot start with', () => {
        // Pictures before the first keyframe, and cover art in the init segment, which ffmpeg's
        // HLS reader fails on when it holds megabytes.
        function coveredMovie() {
            const box = (type, ...parts) => {
                const payload = Buffer.concat(parts.map(part => Buffer.from(part)));
                const head = Buffer.alloc(8);
                head.writeUInt32BE(payload.length + 8);
                head.write(type, 4, 'latin1');
                return Buffer.concat([head, payload]);
            };
            const png = Buffer.from(
                '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489',
                'hex',
            );
            const handler = box('hdlr', Buffer.alloc(8), Buffer.from('mdir'), Buffer.alloc(13));
            const cover = box(
                'udta',
                box(
                    'meta',
                    Buffer.alloc(4),
                    handler,
                    box('ilst', box('covr', box('data', [0, 0, 0, 14, 0, 0, 0, 0], png))),
                ),
            );
            const video = Array.from({ length: 12 }, (_, index) =>
                lengthPrefixed(4, index % 4 === 2 ? idr : predicted, filler(4 + index)),
            );
            return preservationFixture({
                tracks: [
                    {
                        type: 'video',
                        packets: video,
                        sync: [3, 7, 11],
                        width: 64,
                        height: 48,
                        codecConfig: avcc(),
                    },
                ],
                movieBoxes: [cover],
            }).bytes;
        }

        test('the init segment leaves the cover art out, with a warning', async () => {
            const { files, warnings } = await packageMedia(coveredMovie(), 'hls', {
                targetDuration: 0.1,
            });
            assert.equal(Buffer.from(files.get('init.mp4').data).indexOf('covr'), -1);
            assert.deepEqual(warnings.map(warning => warning.code).sort(), [
                'CONTAINER_METADATA_LOSS',
                'REMUX_VIDEO_SAMPLES_DROPPED',
            ]);
        });

        test('pictures before the first keyframe are left out', async () => {
            const { files } = await packageMedia(coveredMovie(), 'hls', { targetDuration: 0.1 });
            const segments = [...files.values()].filter(file => file.name.endsWith('.m4s'));
            const first = await readBack(joined([files.get('init.mp4').data, segments[0].data]));
            assert.equal(first.result[0].key, true);
            assert.equal(segments.filter(file => file.data.length > 0).length, 3);
        });
    });

    describe('xHE-AAC beside video', () => {
        // Its frames depend on earlier ones except immediate playout frames (the first bit set;
        // the MP4 lists them as sync samples), so each audio segment starts at one; video still
        // cuts at its keyframes. The IPFs (packets 1, 10 and 18) fall after the video keyframes
        // at 0.16 and 0.32 s.
        const IPFS = [1, 10, 18];
        function usacMovie() {
            // The AudioSpecificConfig of FATE's aac/usac/Fd_1_c1_0x03.mp4 (mono, 48 kHz).
            const usac = [249, 70, 35, 33, 16, 192, 0];
            const audioFields = Buffer.alloc(28);
            audioFields.writeUInt16BE(1, 6);
            audioFields.writeUInt16BE(1, 16);
            audioFields.writeUInt16BE(16, 18);
            audioFields.writeUInt32BE(48000 * 65536, 24);
            const descriptor = Buffer.from([
                ...[3, 23 + usac.length, 0, 1, 0],
                ...[4, 15 + usac.length, 0x40, 0x15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
                ...[5, usac.length, ...usac],
                ...[6, 1, 2],
            ]);
            return preservationFixture({
                tracks: [
                    {
                        type: 'video',
                        packets: Array.from({ length: 12 }, (_, index) =>
                            lengthPrefixed(4, index % 4 ? predicted : idr, filler(4 + index)),
                        ),
                        sync: [1, 5, 9],
                        width: 64,
                        height: 48,
                        codecConfig: avcc(),
                    },
                    {
                        type: 'audio',
                        audioEntry: atom(
                            'mp4a',
                            audioFields,
                            atom('esds', Buffer.alloc(4), descriptor),
                        ),
                        sync: IPFS,
                        packets: Array.from({ length: 23 }, (_, index) =>
                            Buffer.of(IPFS.includes(index + 1) ? 0xc0 : 0x40, index, 1, 2),
                        ),
                    },
                ],
            }).bytes;
        }
        /** The number of the first audio packet of each segment of the audio's representation. */
        async function audioStarts(files) {
            const audio = files.find(file => file.kind === 'init' && !/video/.test(file.name));
            const starts = [];
            for (const segment of segmentsOf(files))
                if (segment.representation === audio.representation) {
                    const read = await readBack(joined([audio.data, segment.data]));
                    const video = read.result.find(packet => packet.type === 'video');
                    if (video) assert.equal(video.key, true, 'video segments start at keyframes');
                    starts.push(read.result.find(packet => packet.type === 'audio').data[1] + 1);
                }
            return starts;
        }

        for (const layout of ['demuxed', 'muxed'])
            test(`${layout} audio starts each segment at a playout frame`, async () => {
                const demuxed = layout === 'demuxed';
                const { files } = await collect({ targetDuration: 0.16, demuxed }, usacMovie());
                assert.deepEqual(await audioStarts(files), IPFS);
            });
    });
});
