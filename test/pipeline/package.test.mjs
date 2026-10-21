import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { convert, inspect, packageMedia } from 'mediaforgejs';
import { MemorySink } from 'mediaforgejs/io';
import { WebMMuxer } from 'mediaforgejs/formats';
import { iterateDashSegments, parseDashManifest, parseHlsPlaylist } from 'mediaforgejs/streaming';
import { webmClip } from '../helpers/webm-clip-fixture.mjs';
import { allPackets, readAll } from '../helpers/read-media.mjs';
import { holdsSpatialBoxes, spatialMp4 } from '../helpers/spatial-video.mjs';

const text = bytes => new TextDecoder().decode(bytes);
/** The initialization segment and the media segments of `files` whose names start `prefix`. */
const fragmentsOf = (files, init, prefix) =>
    new Uint8Array(
        Buffer.concat([
            files.get(init).data,
            ...[...files.keys()]
                .filter(name => name.startsWith(prefix))
                .sort()
                .map(name => files.get(name).data),
        ]),
    );
/** The four-letter box types `bytes` hold anywhere. */
function boxNames(bytes) {
    const names = new Set();
    for (let offset = 0; offset + 8 <= bytes.length; offset++) {
        const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
        if (/^[a-zA-Z0-9 ]{4}$/.test(type)) names.add(type);
    }
    return names;
}

describe('package', () => {
    describe('WebM as browsers write it', () => {
        test('VP9 without CodecPrivate packages with a vpcC built for it', async () => {
            const { files } = await packageMedia(webmClip({ opus: false }), 'hls', {
                targetDuration: 0.5,
            });
            assert.match(text(files.get('master.m3u8').data), /CODECS="vp09\.00\.10\.08"/);
            assert.ok(boxNames(files.get('init.mp4').data).has('vpcC'));
            const { tracks } = await readAll(fragmentsOf(files, 'init.mp4', 'segment-'));
            assert.equal(tracks[0].codec, 'vp09.00.10.08');
            assert.equal(tracks[0].codecConfig?.length, 12);
            assert.equal(tracks[0].codecConfig[0], 1, 'vpcC version 1');
            const { blob } = await convert(webmClip({ opus: false }), 'mp4');
            assert.equal((await inspect(blob)).tracks[0].codec, 'vp09.00.10.08');
        });

        test('VP9 profile features go from WebM to DASH and back through vpcC', async () => {
            // WebM stores the feature list, not the vpcC record.
            const profile2 = Uint8Array.of(1, 1, 2, 2, 1, 51, 3, 1, 10, 4, 1, 1);
            const { files } = await packageMedia(
                webmClip({ opus: false, codecPrivate: profile2 }),
                'dash',
                { targetDuration: 0.5 },
            );
            assert.ok(boxNames(files.get('init-video1.mp4').data).has('vpcC'));
            const fragmented = fragmentsOf(files, 'init-video1.mp4', 'seg-');
            assert.equal((await inspect(fragmented)).tracks[0].codec, 'vp09.02.51.10');
            const { tracks } = await readAll((await convert(fragmented, 'webm')).blob);
            assert.equal(tracks[0].codec, 'vp09.02.51.10');
            assert.deepEqual(tracks[0].codecConfig, profile2);
        });

        test('millisecond times with nominal durations package without gaps', async () => {
            const { files } = await packageMedia(webmClip({ frames: 60 }), 'hls', {
                targetDuration: 0.5,
            });
            const playlist = parseHlsPlaylist(text(files.get('index.m3u8').data), {
                validation: 'strict',
            });
            assert.ok(playlist.segments.length >= 3, 'keyframe-aligned segments');
            const fragmented = fragmentsOf(files, 'init.mp4', 'segment-');
            const { tracks } = await readAll(fragmented);
            const video = tracks.find(track => track.type === 'video');
            const pictures = (await allPackets(fragmented)).filter(
                packet => packet.trackId === video.id,
            );
            assert.equal(pictures.length, 60);
            pictures.slice(1).forEach((packet, index) => {
                const before = pictures[index];
                const end = (before.decodeTimestamp ?? before.timestamp) + before.duration;
                assert.ok(Math.abs((packet.decodeTimestamp ?? packet.timestamp) - end) < 1e-9);
            });
            // The durations follow the millisecond times.
            assert.deepEqual(
                [...new Set(pictures.map(packet => Math.round(packet.duration * 1000)))].sort(),
                [33, 34],
            );
        });

        test('the Opus representation of a DASH package keeps the CMAF timescale', async () => {
            const { files } = await packageMedia(webmClip({ frames: 60 }), 'dash', {
                targetDuration: 0.5,
            });
            const manifest = parseDashManifest(text(files.get('manifest.mpd').data), {
                baseUrl: 'http://127.0.0.1/pkg/manifest.mpd',
            });
            const audio = manifest.periods[0].adaptationSets
                .flatMap(set => set.representations)
                .find(representation => representation.codecs === 'opus');
            assert.equal(audio.segmentInfo.timescale, 48000);
            assert.ok([...iterateDashSegments(audio, { maxSegments: 100 })].length >= 3);
        });
    });

    test('AC-3 timed in milliseconds is timed by its sample counts', async () => {
        // Rounded times would read as overlapping decode times.
        const sink = new MemorySink();
        const muxer = new WebMMuxer(
            {
                format: 'mkv',
                mode: 'standard',
                maxFragmentDuration: 2,
                autoSync: true,
                audio: { id: 1, type: 'audio', codec: 'ac-3', sampleRate: 44100, channelCount: 2 },
            },
            sink,
        );
        // 32 kbit/s at 44.1 kHz: 69 16-bit words a frame; bsid 8, acmod 2 (stereo).
        const frame = new Uint8Array(138);
        frame.set([0x0b, 0x77, 0, 0, 0x40, 0x40, 0x40]);
        for (let index = 0; index < 20; index++)
            muxer.addAudioChunk({
                trackType: 'audio',
                data: frame,
                timestamp: Math.round((index * 1536) / 44.1) / 1000,
                duration: 1536 / 44100,
                isKeyframe: true,
            });
        await muxer.finalize();
        const { files } = await packageMedia(sink.toUint8Array(), 'hls', { container: 'fmp4' });
        const packets = await allPackets(fragmentsOf(files, 'init.mp4', 'segment-'));
        assert.equal(packets.length, 20);
        assert.ok(Math.abs(packets[19].timestamp - (19 * 1536) / 44100) < 0.001);
    });

    describe('spatial video', () => {
        test('HLS states the stereo views; its init segments keep the boxes', async () => {
            const { files } = await packageMedia(spatialMp4(), { to: 'hls' });
            assert.match(
                text(files.get('master.m3u8').data),
                /REQ-VIDEO-LAYOUT="CH-STEREO\/PROJ-HEQU"/,
            );
            assert.ok(holdsSpatialBoxes(files.get('init.mp4').data));
        });

        test('HLS of MPEG-TS segments states no video layout', async () => {
            const { files } = await packageMedia(spatialMp4(), { to: 'hls', container: 'ts' });
            assert.doesNotMatch(text(files.get('master.m3u8').data), /REQ-VIDEO-LAYOUT/);
        });
    });
});
