import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { MediaForge } from 'mediaforgejs';
import { CmafWriter } from 'mediaforgejs/streaming';
import { player } from 'mediaforgejs-player';
import { avcc } from '../../../test/helpers/mp4-preservation-fixture.mjs';

// play() and createPlayer() of mediaforgejs with the player plugin, through a model of Media
// Source Extensions: the protocol from the URL or the manifest, DASH video and audio in two
// SourceBuffers on one timeline, HLS through the same call, and a player that stops one stream
// for the next.

describe('play() and createPlayer() with the player plugin', () => {
    const forge = new MediaForge({ plugins: { add: [player] } });
    const saved = {
        MediaSource: globalThis.MediaSource,
        create: URL.createObjectURL,
        revoke: URL.revokeObjectURL,
    };
    const sources = [];
    class Buffer extends EventTarget {
        updating = false;
        mode = 'segments';
        timestampOffset = 0;
        appends = [];
        constructor(type) {
            super();
            this.type = type;
        }
        get buffered() {
            return { length: 0 };
        }
        appendBuffer(bytes) {
            assert.equal(this.updating, false);
            this.updating = true;
            this.appends.push({ bytes: new Uint8Array(bytes), offset: this.timestampOffset });
            queueMicrotask(() => {
                this.updating = false;
                this.dispatchEvent(new Event('updateend'));
            });
        }
        abort() {}
    }
    class Source extends EventTarget {
        static isTypeSupported(type) {
            return /^(?:audio|video)\/mp4; codecs="[^"]+"$/.test(type);
        }
        readyState = 'closed';
        buffers = [];
        constructor() {
            super();
            sources.push(this);
        }
        addSourceBuffer(type) {
            const buffer = new Buffer(type);
            this.buffers.push(buffer);
            return buffer;
        }
        removeSourceBuffer() {}
        endOfStream() {
            this.ended = true;
            this.readyState = 'ended';
        }
    }
    class Element extends EventTarget {
        srcObject = null;
        currentTime = 0;
        ended = false;
        paused = true;
        error = null;
        set src(value) {
            this.url = value;
            const source = sources[sources.length - 1];
            queueMicrotask(() => {
                source.readyState = 'open';
                source.dispatchEvent(new Event('sourceopen'));
            });
        }
        get buffered() {
            return { length: 0 };
        }
        getAttribute() {
            return this.url;
        }
        removeAttribute() {
            this.url = undefined;
        }
        load() {}
        play() {
            this.paused = false;
            return Promise.resolve();
        }
    }

    // One CMAF track as an initialization segment and two one-second media segments from `start`.
    const track = (type, timescale, start) => {
        const writer = new CmafWriter({
            tracks: [
                type === 'video'
                    ? {
                          id: 1,
                          type,
                          codec: 'avc1.42001e',
                          timescale,
                          width: 16,
                          height: 16,
                          codecConfig: avcc,
                      }
                    : {
                          id: 1,
                          type,
                          codec: 'mp4a.40.2',
                          timescale,
                          sampleRate: 48000,
                          channelCount: 1,
                          codecConfig: Uint8Array.of(0x11, 0x88),
                      },
            ],
        });
        const init = writer.createInitSegment();
        const segments = [0, 1].map(index => {
            writer.addSample({
                trackId: 1,
                // A length-prefixed IDR slice for the video, any bytes for the sound.
                data:
                    type === 'video' ? Uint8Array.of(0, 0, 0, 2, 0x65, 0x88) : Uint8Array.of(1, 2),
                decodeTimestamp: (start + index) * timescale,
                duration: timescale,
                isKeyframe: true,
            });
            return writer.flush().data;
        });
        return { init, segments };
    };
    // The video starts a quarter second after the audio: the streams keep that distance.
    const video = track('video', 1000, 10.25);
    const audio = track('audio', 48000, 10);
    const mpd =
        '<?xml version="1.0" encoding="UTF-8"?>\n<!-- packaged for the test -->\n' +
        '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" ' +
        'mediaPresentationDuration="PT2S" minBufferTime="PT1S" ' +
        'profiles="urn:mpeg:dash:profile:isoff-live:2011"><Period id="p0">' +
        '<AdaptationSet contentType="video" mimeType="video/mp4">' +
        '<SegmentTemplate timescale="1000" duration="1000" startNumber="1" ' +
        'initialization="$RepresentationID$-init.mp4" media="$RepresentationID$-$Number$.m4s"/>' +
        '<Representation id="low" bandwidth="100000" codecs="avc1.42001e" width="16" ' +
        'height="16"/>' +
        '<Representation id="high" bandwidth="300000" codecs="avc1.42001e" width="16" ' +
        'height="16"/></AdaptationSet>' +
        '<AdaptationSet contentType="audio" mimeType="audio/mp4" lang="en">' +
        '<SegmentTemplate timescale="48000" duration="48000" startNumber="1" ' +
        'initialization="a-init.mp4" media="a-$Number$.m4s"/>' +
        '<Representation id="a" bandwidth="64000" codecs="mp4a.40.2" audioSamplingRate="48000"/>' +
        '</AdaptationSet></Period></MPD>';
    const playlist =
        '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:1\n#EXT-X-PLAYLIST-TYPE:VOD\n' +
        '#EXT-X-MAP:URI="a-init.mp4"\n#EXTINF:1.0,\na-1.m4s\n#EXTINF:1.0,\na-2.m4s\n' +
        '#EXT-X-ENDLIST\n';
    const files = new Map([
        ['dash/stream.mpd', mpd],
        ['dash/manifest', mpd],
        ['dash/high-init.mp4', video.init],
        ['dash/high-1.m4s', video.segments[0]],
        ['dash/high-2.m4s', video.segments[1]],
        ['dash/a-init.mp4', audio.init],
        ['dash/a-1.m4s', audio.segments[0]],
        ['dash/a-2.m4s', audio.segments[1]],
        ['hls/channel', playlist],
        // The low variant is never asked for.
        [
            'hls/master.m3u8',
            '#EXTM3U\n#EXT-X-VERSION:7\n' +
                '#EXT-X-STREAM-INF:BANDWIDTH=64000,CODECS="mp4a.40.2"\nlow.m3u8\n' +
                '#EXT-X-STREAM-INF:BANDWIDTH=128000,CODECS="mp4a.40.2"\nchannel\n',
        ],
        ['hls/a-init.mp4', audio.init],
        ['hls/a-1.m4s', audio.segments[0]],
        ['hls/a-2.m4s', audio.segments[1]],
        ['notes.txt', 'not a manifest'],
    ]);
    const requested = [];
    const fetch = async (url, init = {}) => {
        const path = String(url).replace('https://media.test/', '');
        requested.push(path);
        if (path === 'stalled.mpd')
            return new Promise((_resolve, reject) =>
                init.signal.addEventListener('abort', () => reject(init.signal.reason)),
            );
        const body = files.get(path);
        return body === undefined
            ? new Response('missing', { status: 404 })
            : new Response(body, { status: 200 });
    };
    const settle = async media => {
        for (const end = Date.now() + 10000; !sources.at(-1)?.ended && Date.now() < end;)
            await new Promise(resolve => setTimeout(resolve, 5));
        assert.equal(sources.at(-1)?.ended, true, 'the stream reached its end');
        media.ended = true;
        media.dispatchEvent(new Event('ended'));
    };
    before(() => {
        globalThis.MediaSource = Source;
        URL.createObjectURL = () => 'blob:mediaforge-play';
        URL.revokeObjectURL = () => undefined;
    });
    after(() => {
        globalThis.MediaSource = saved.MediaSource;
        URL.createObjectURL = saved.create;
        URL.revokeObjectURL = saved.revoke;
    });

    test('DASH plays its highest video and its audio in two buffers on one timeline', async () => {
        // DASH from the .mpd extension: the highest representation of the video set and the audio
        // set, each in its own SourceBuffer, on the timeline of the earlier audio.
        const media = new Element();
        const playback = forge.play('https://media.test/dash/stream.mpd', media, { fetch });
        await settle(media);
        await playback.finished;
        const [videoBuffer, audioBuffer] = sources.at(-1).buffers;
        assert.equal(videoBuffer.type, 'video/mp4; codecs="avc1.42001e"');
        assert.equal(audioBuffer.type, 'audio/mp4; codecs="mp4a.40.2"');
        assert.deepEqual(
            videoBuffer.appends.map(append => append.bytes),
            [video.init, ...video.segments],
        );
        assert.deepEqual(
            audioBuffer.appends.map(append => append.bytes),
            [audio.init, ...audio.segments],
        );
        assert.deepEqual(
            [...videoBuffer.appends, ...audioBuffer.appends].map(append => append.offset),
            Array(6).fill(-10),
        );
        assert.ok(
            !requested.some(path => path.startsWith('dash/low')),
            'the lower video is unused',
        );
        assert.equal(media.url, undefined, 'the element is released');
    });

    test('DASH plays the highest representation the browser plays, as HLS does', async () => {
        // A higher HEVC representation this browser does not play gives way to the AVC one.
        files.set(
            'dash/hevc.mpd',
            mpd.replace(
                '</AdaptationSet><AdaptationSet contentType="audio"',
                '<Representation id="top" bandwidth="900000" codecs="hvc1.1.6.L93.B0" ' +
                    'width="16" height="16"/></AdaptationSet><AdaptationSet contentType="audio"',
            ),
        );
        const supported = Source.isTypeSupported;
        Source.isTypeSupported = type => !type.includes('hvc1') && supported(type);
        try {
            const media = new Element();
            const before = requested.length;
            const playback = forge.play('https://media.test/dash/hevc.mpd', media, { fetch });
            await settle(media);
            await playback.finished;
            const [videoBuffer] = sources.at(-1).buffers;
            assert.equal(videoBuffer.type, 'video/mp4; codecs="avc1.42001e"');
            assert.ok(
                requested.slice(before).some(path => path.startsWith('dash/high')) &&
                    !requested.slice(before).some(path => path.startsWith('dash/top')),
                'the AVC representation plays',
            );
        } finally {
            Source.isTypeSupported = supported;
            files.delete('dash/hevc.mpd');
        }
    });

    test('a URL without an extension is recognised from the start of its manifest', async () => {
        // A URL without an extension: the protocol comes from the start of the manifest.
        const sniffedMedia = new Element();
        const sniffed = forge.play('https://media.test/dash/manifest', sniffedMedia, { fetch });
        await settle(sniffedMedia);
        await sniffed.finished;
        assert.equal(sources.at(-1).buffers.length, 2);
    });

    test('HLS plays through the same call', async () => {
        const hls = new Element();
        const channel = forge.play('https://media.test/hls/channel', hls, {
            fetch,
            mimeType: 'audio/mp4; codecs="mp4a.40.2"',
        });
        await settle(hls);
        await channel.finished;
        assert.deepEqual(
            sources.at(-1).buffers[0].appends.map(append => append.bytes),
            [audio.init, ...audio.segments],
        );
    });

    test('a multivariant HLS playlist plays its highest variant, typed by its codecs', async () => {
        const hls = new Element();
        const before = requested.length;
        const master = forge.play('https://media.test/hls/master.m3u8', hls, { fetch });
        await settle(hls);
        await master.finished;
        const [buffer] = sources.at(-1).buffers;
        assert.equal(buffer.type, 'audio/mp4; codecs="mp4a.40.2"');
        assert.deepEqual(
            buffer.appends.map(append => append.bytes),
            [audio.init, ...audio.segments],
        );
        assert.deepEqual(requested.slice(before, before + 2), ['hls/master.m3u8', 'hls/channel']);
    });

    test('a stream that is neither HLS nor DASH fails with FORMAT', async () => {
        await assert.rejects(
            forge.play('https://media.test/notes.txt', new Element(), { fetch }).finished,
            error => error.code === 'FORMAT',
        );
    });

    test('DRM options for a DASH stream fail with INPUT', async () => {
        await assert.rejects(
            forge.play('https://media.test/dash/stream.mpd', new Element(), { fetch, drm: {} })
                .finished,
            error => error.code === 'INPUT',
        );
    });

    test('a player stops the stream it plays before the next starts in its element', async () => {
        // A player stops the stream it plays before the next one starts in the same element.
        const shared = new Element();
        const player = forge.createPlayer(shared, { fetch });
        const first = player.load('https://media.test/stalled.mpd');
        const second = player.load('https://media.test/dash/stream.mpd');
        await assert.rejects(first.finished, error => error.code === 'ABORT');
        await settle(shared);
        await second.finished;
        const third = player.load('https://media.test/stalled.mpd');
        player.stop();
        await assert.rejects(third.finished, error => error.code === 'ABORT');
    });
});
