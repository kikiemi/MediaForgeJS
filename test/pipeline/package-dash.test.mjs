import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { packageMedia } from 'mediaforgejs';
import { iterateDashSegments, parseDashManifest, parseHlsPlaylist } from 'mediaforgejs/streaming';
import { joined, packageMovie, readBack } from '../helpers/package-movie.mjs';
import { openFile } from '../helpers/engine.mjs';
import { distUrl } from '../helpers/dist-paths.mjs';

// DASH packages of a file: one adaptation set per track, segment timelines, the manifest's
// duration, and HLS playlists of the same segments.

const { packageDash } = await import(distUrl('esm/pipeline/package/dash.js'));
const { collectPackage } = await import(distUrl('esm/pipeline/package/segments.js'));

const text = file => new TextDecoder().decode(file.data);
const BASE = 'https://example.test/pkg/';

/** The files packageDash() yields for `bytes` with `options`, and its summary. */
async function collect(options, bytes = packageMovie()) {
    const file = await openFile(bytes);
    try {
        const files = [];
        const generator = packageDash(file, options);
        for (;;) {
            const step = await generator.next();
            if (step.done) return { files, summary: step.value };
            files.push(step.value);
        }
    } finally {
        file.close();
    }
}

/** The package movie's video starting 0.2 s after its audio, through an empty edit. */
const lateVideo = () =>
    packageMovie({
        edits: [
            { duration: 200, mediaTime: -1 },
            { duration: 480, mediaTime: 0 },
        ],
    });

describe('package: DASH', () => {
    test('writes an init segment per track, the segments and the manifest last', async () => {
        const { files, summary } = await collect({ targetDuration: 0.16 });
        const names = files.map(file => file.name);
        assert.deepEqual(names.slice(0, 2), ['init-video11.mp4', 'init-audio12.mp4']);
        assert.equal(names.at(-1), 'manifest.mpd');
        assert.deepEqual([summary.manifest, summary.hls], ['manifest.mpd', undefined]);
        assert.equal(summary.files, files.length);
    });

    test('the manifest is static, with an adaptation set for each track', async () => {
        const { files } = await collect({ targetDuration: 0.16 });
        const manifest = parseDashManifest(text(files.at(-1)), { baseUrl: `${BASE}manifest.mpd` });
        assert.equal(manifest.type, 'static');
        assert.equal(manifest.periods.length, 1);
        const sets = manifest.periods[0].adaptationSets;
        assert.deepEqual(
            sets.map(set =>
                set.representations.map(({ id, mimeType, codecs }) => [id, mimeType, codecs]),
            ),
            [[['video11', 'video/mp4', 'avc1.42000a']], [['audio12', 'audio/mp4', 'mp4a.40.2']]],
        );
        const [[video], [audio]] = sets.map(set => set.representations);
        assert.deepEqual([video.width, video.height, audio.audioSamplingRate], [64, 48, 48000]);
    });

    test('the segments the manifest lists are the files written, at their times', async () => {
        const { files } = await collect({ targetDuration: 0.16 });
        const manifest = parseDashManifest(text(files.at(-1)), { baseUrl: `${BASE}manifest.mpd` });
        for (const set of manifest.periods[0].adaptationSets)
            for (const representation of set.representations) {
                const written = files.filter(
                    file => file.representation === representation.id && file.kind === 'segment',
                );
                const listed = [...iterateDashSegments(representation, { maxSegments: 1000 })];
                assert.deepEqual(
                    listed.map(segment => segment.url),
                    written.map(file => `${BASE}${file.name}`),
                );
                const timing = ({ time, duration, timescale }) => [
                    Number(time),
                    Number(duration),
                    timescale,
                ];
                assert.deepEqual(
                    listed.map(timing),
                    written.map(file => timing(file.timing)),
                );
                assert.equal(
                    representation.initialization?.url,
                    `${BASE}init-${representation.id}.mp4`,
                );
            }
    });

    test('each representation joined reads as its track of the input', async () => {
        const { files } = await collect({ targetDuration: 0.16 });
        const original = (await readBack(packageMovie())).result;
        for (const [id, type] of [
            ['video11', 'video'],
            ['audio12', 'audio'],
        ]) {
            const parts = files.filter(file => file.representation === id).map(file => file.data);
            assert.deepEqual(
                (await readBack(joined(parts))).result,
                original.filter(packet => packet.type === type),
            );
        }
    });

    test('states the presentation duration and a timeline of repeated segments', async () => {
        const { files, summary } = await collect({ targetDuration: 0.16 });
        assert.equal(summary.duration, (23 * 1024) / 48000);
        const mpd = text(files.at(-1));
        assert.match(mpd, /mediaPresentationDuration="PT0\.490667S"/);
        assert.match(mpd, /<SegmentTimeline><S t="0" d="160" r="2"\/><\/SegmentTimeline>/);
    });

    test('video starting after the audio lasts until the video ends', async () => {
        // The video ends at 0.68 s, after the 0.49 s of audio: the presentation lasts until then,
        // not for the longest sum of segment durations.
        const { files } = await collect({ targetDuration: 0.16 }, lateVideo());
        const mpd = text(files.at(-1));
        assert.match(mpd, /<SegmentTimeline><S t="200" d="320"\/><S t="520" d="160"\/>/);
        assert.match(mpd, /mediaPresentationDuration="PT0\.680000S"/);
        assert.equal(parseDashManifest(mpd).duration, 0.68);
    });

    describe('HLS playlists of the same segments', () => {
        test('follow the manifest, a media playlist per representation', async () => {
            const { files, summary } = await collect({ targetDuration: 0.16, hlsPlaylists: true });
            assert.deepEqual(
                files.slice(-4).map(file => file.name),
                ['manifest.mpd', 'video11.m3u8', 'audio12.m3u8', 'master.m3u8'],
            );
            assert.equal(summary.hls.masterPlaylist, 'master.m3u8');
            const master = parseHlsPlaylist(text(files.at(-1)), { validation: 'strict' });
            assert.equal(master.variants[0].uri, 'video11.m3u8');
            assert.equal(master.renditions[0].uri, 'audio12.m3u8');
        });

        test('list the DASH segments with their init segment as the map', async () => {
            const { files } = await collect({ targetDuration: 0.16, hlsPlaylists: true });
            const media = parseHlsPlaylist(text(files.at(-3)), { validation: 'strict' });
            assert.deepEqual(
                media.segments.map(segment => segment.uri),
                files
                    .filter(file => file.representation === 'video11' && file.kind === 'segment')
                    .map(file => file.name),
            );
            assert.equal(media.segments[0].map.uri, 'init-video11.mp4');
        });
    });

    test('more segments than allowed fail with OUTPUT; a bad option with INPUT', async () => {
        const file = await openFile(packageMovie());
        try {
            await assert.rejects(
                collectPackage(packageDash(file, { targetDuration: 0.16, maxSegments: 3 })),
                { code: 'OUTPUT' },
            );
            await assert.rejects(packageDash(file, { hlsPlaylists: 'yes' }).next(), {
                code: 'INPUT',
            });
        } finally {
            file.close();
        }
    });

    test("packageMedia() 'hls+dash' writes both, entered at the master playlist", async () => {
        const { files, entry } = await packageMedia(new Blob([packageMovie()]), 'hls+dash', {
            targetDuration: 0.16,
        });
        assert.equal(entry, 'master.m3u8');
        assert.ok(
            ['manifest.mpd', 'master.m3u8', 'init-video11.mp4'].every(name => files.has(name)),
        );
    });

    test("packageMedia() 'dash' writes no HLS playlists, entered at the manifest", async () => {
        const { files, entry } = await packageMedia(new Blob([packageMovie()]), 'dash', {
            targetDuration: 0.16,
        });
        assert.equal(entry, 'manifest.mpd');
        assert.ok(files.has('manifest.mpd') && !files.has('master.m3u8'));
    });
});
