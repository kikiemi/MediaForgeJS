import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { MediaForge } from 'mediaforgejs';
import { CmafWriter, parseHlsPlaylist } from 'mediaforgejs/streaming';
import { player } from 'mediaforgejs-player';
import { playStreams } from '../dist/hls-playback.js';
import { AudioRenditionFeed } from '../dist/hls-renditions.js';
import { SubtitleTracks } from '../dist/hls-subtitles.js';
import { avcc } from '../../../test/helpers/mp4-preservation-fixture.mjs';

// The alternative renditions of an HLS variant through play(), with a model of Media Source
// Extensions: the audio of a variant played from its AUDIO rendition in a SourceBuffer of its own,
// the rendition chosen by the settings or the group's flags, followed across variant switches and
// live refreshes, and the SUBTITLES renditions as text tracks of the element.

/** One CMAF track as an initialization segment and `count` one-second media segments. */
function track(type, marker, { count = 2, width = 16 } = {}) {
    const writer = new CmafWriter({
        tracks: [
            type === 'video'
                ? {
                      id: 1,
                      type,
                      codec: 'avc1.42001e',
                      timescale: 1000,
                      width,
                      height: 16,
                      codecConfig: avcc,
                  }
                : {
                      id: 1,
                      type,
                      codec: 'mp4a.40.2',
                      timescale: 48000,
                      sampleRate: 48000,
                      channelCount: 1,
                      codecConfig: Uint8Array.of(0x11, 0x88),
                  },
        ],
    });
    const init = writer.createInitSegment();
    const timescale = type === 'video' ? 1000 : 48000;
    const segments = Array.from({ length: count }, (_, index) => {
        writer.addSample({
            trackId: 1,
            data:
                type === 'video'
                    ? Uint8Array.of(0, 0, 0, 2, 0x65, 0x88)
                    : Uint8Array.of(marker, index),
            decodeTimestamp: index * timescale,
            duration: timescale,
            isKeyframe: true,
        });
        return writer.flush().data;
    });
    return { init, segments };
}

const video = track('video');
/** The picture of a variant of other codecs, wider. */
const wide = track('video', 0, { width: 32 });
const english = track('audio', 1);
const japanese = track('audio', 2);

/** A VOD media playlist of the two segments of `prefix`. */
const mediaPlaylist = prefix =>
    '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:1\n#EXT-X-PLAYLIST-TYPE:VOD\n' +
    `#EXT-X-MAP:URI="${prefix}-init.mp4"\n#EXTINF:1.0,\n${prefix}-1.m4s\n` +
    `#EXTINF:1.0,\n${prefix}-2.m4s\n#EXT-X-ENDLIST\n`;

/** A WebVTT segment of one cue, on the 90 kHz clock of `mpegts`. */
const vtt = (start, end, text, mpegts = 0) =>
    `WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:${mpegts},LOCAL:00:00:00.000\n\n` +
    `00:00:0${start}.000 --> 00:00:0${end}.000\n${text}\n`;

const audioGroup = (flags = { en: 'DEFAULT=YES,AUTOSELECT=YES', ja: 'AUTOSELECT=YES' }) =>
    `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English",LANGUAGE="en",${flags.en},` +
    'URI="en.m3u8"\n' +
    `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Japanese",LANGUAGE="ja",${flags.ja},` +
    'URI="ja.m3u8"\n';
const subtitleGroup =
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="English",LANGUAGE="en",DEFAULT=YES,' +
    'AUTOSELECT=YES,URI="subs-en.m3u8"\n' +
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="Japanese",LANGUAGE="ja",AUTOSELECT=YES,' +
    'URI="subs-ja.m3u8"\n';
const variant = 'CODECS="avc1.42001e,mp4a.40.2",AUDIO="a"';

const files = new Map([
    [
        'master.m3u8',
        `#EXTM3U\n#EXT-X-VERSION:7\n${audioGroup()}${subtitleGroup}` +
            `#EXT-X-STREAM-INF:BANDWIDTH=300000,${variant},SUBTITLES="s"\nvideo.m3u8\n`,
    ],
    [
        'autoselect.m3u8',
        `#EXTM3U\n${audioGroup({ en: 'AUTOSELECT=NO', ja: 'AUTOSELECT=YES' })}` +
            `#EXT-X-STREAM-INF:BANDWIDTH=300000,${variant}\nvideo.m3u8\n`,
    ],
    [
        'first.m3u8',
        `#EXTM3U\n${audioGroup({ en: 'AUTOSELECT=NO', ja: 'AUTOSELECT=NO' })}` +
            `#EXT-X-STREAM-INF:BANDWIDTH=300000,${variant}\nvideo.m3u8\n`,
    ],
    [
        'muxed.m3u8',
        '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Main",DEFAULT=YES\n' +
            `#EXT-X-STREAM-INF:BANDWIDTH=300000,${variant}\nmuxed-video.m3u8\n`,
    ],
    [
        'no-sound-codec.m3u8',
        `#EXTM3U\n${audioGroup()}` +
            '#EXT-X-STREAM-INF:BANDWIDTH=300000,CODECS="avc1.42001e",AUDIO="a"\nvideo.m3u8\n',
    ],
    ['video.m3u8', mediaPlaylist('v')],
    ['muxed-video.m3u8', mediaPlaylist('v')],
    ['en.m3u8', mediaPlaylist('en')],
    ['ja.m3u8', mediaPlaylist('ja')],
    ['v-init.mp4', video.init],
    ['v-1.m4s', video.segments[0]],
    ['v-2.m4s', video.segments[1]],
    ['en-init.mp4', english.init],
    ['en-1.m4s', english.segments[0]],
    ['en-2.m4s', english.segments[1]],
    ['ja-init.mp4', japanese.init],
    ['ja-1.m4s', japanese.segments[0]],
    ['ja-2.m4s', japanese.segments[1]],
    [
        'subs-en.m3u8',
        '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:1.0,\n' +
            'en-1.vtt\n#EXTINF:1.0,\nen-2.vtt\n#EXT-X-ENDLIST\n',
    ],
    [
        'subs-ja.m3u8',
        '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:2.0,\n' +
            'ja-1.vtt\n#EXT-X-ENDLIST\n',
    ],
    // The second segment repeats the first one's cue, which overlaps it.
    ['en-1.vtt', vtt(0, 1, 'Hello')],
    ['en-2.vtt', `${vtt(0, 1, 'Hello')}\n00:00:01.000 --> 00:00:02.000\nThere\n`],
    ['ja-1.vtt', vtt(0, 2, 'こんにちは', 90000)],
]);

describe('the HLS player: alternative renditions', () => {
    const forge = new MediaForge({ plugins: { add: [player] } });
    const saved = {
        MediaSource: globalThis.MediaSource,
        VTTCue: globalThis.VTTCue,
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
            this.appends.push(new Uint8Array(bytes));
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
    class TextTrack {
        mode = 'disabled';
        cues = [];
        constructor(kind, label, language) {
            Object.assign(this, { kind, label, language });
        }
        addCue(cue) {
            this.cues.push(cue);
        }
        removeCue(cue) {
            this.cues.splice(this.cues.indexOf(cue), 1);
        }
    }
    class Element extends EventTarget {
        srcObject = null;
        currentTime = 0;
        ended = false;
        paused = true;
        error = null;
        textTracks = [];
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
        addTextTrack(kind, label, language) {
            const added = new TextTrack(kind, label, language);
            this.textTracks.push(added);
            return added;
        }
    }

    const requested = [];
    const fetch = async url => {
        const path = String(url).replace('https://media.test/', '');
        requested.push(path);
        const body = files.get(path);
        return body === undefined
            ? new Response('missing', { status: 404 })
            : new Response(body, { status: 200 });
    };
    /** Plays `name` with `settings` to its end: the MediaSource of the playback and its element. */
    const played = async (name, settings = {}) => {
        const media = new Element();
        const playback = forge.play(`https://media.test/${name}`, media, { fetch, ...settings });
        for (const end = Date.now() + 10000; !sources.at(-1)?.ended && Date.now() < end;)
            await new Promise(resolve => setTimeout(resolve, 5));
        assert.equal(sources.at(-1)?.ended, true, 'the stream reached its end');
        media.ended = true;
        media.dispatchEvent(new Event('ended'));
        await playback.finished;
        return { source: sources.at(-1), media };
    };
    before(() => {
        globalThis.MediaSource = Source;
        globalThis.VTTCue = class {
            constructor(startTime, endTime, text) {
                Object.assign(this, { startTime, endTime, text });
            }
        };
        URL.createObjectURL = () => 'blob:mediaforge-play';
        URL.revokeObjectURL = () => undefined;
    });
    after(() => {
        globalThis.MediaSource = saved.MediaSource;
        if (saved.VTTCue) globalThis.VTTCue = saved.VTTCue;
        else delete globalThis.VTTCue;
        URL.createObjectURL = saved.create;
        URL.revokeObjectURL = saved.revoke;
    });

    test("a variant's AUDIO rendition plays in a SourceBuffer of its own", async () => {
        requested.length = 0;
        const { source } = await played('master.m3u8', { subtitles: false });
        const [pictures, sound] = source.buffers;
        assert.equal(pictures.type, 'video/mp4; codecs="avc1.42001e"');
        assert.equal(sound.type, 'audio/mp4; codecs="mp4a.40.2"');
        assert.deepEqual(pictures.appends, [video.init, ...video.segments]);
        assert.deepEqual(sound.appends, [english.init, ...english.segments]);
        assert.ok(!requested.includes('ja.m3u8'), 'the other rendition is not read');
    });

    test('the rendition is the chosen one, else DEFAULT, AUTOSELECT, the first', async () => {
        const soundOf = async (name, settings) =>
            (await played(name, { subtitles: false, ...settings })).source.buffers[1].appends;
        assert.deepEqual(await soundOf('master.m3u8', { audio: { language: 'ja' } }), [
            japanese.init,
            ...japanese.segments,
        ]);
        assert.deepEqual(
            (await soundOf('master.m3u8', { audio: { name: 'Japanese' } }))[0],
            japanese.init,
        );
        assert.deepEqual(
            (await soundOf('master.m3u8', { audio: { language: 'fr' } }))[0],
            english.init,
        );
        assert.deepEqual((await soundOf('autoselect.m3u8'))[0], japanese.init);
        assert.deepEqual((await soundOf('first.m3u8'))[0], english.init);
    });

    test('a variant that names no codec of its audio rendition fails with FORMAT', async () => {
        const playback = forge.play('https://media.test/no-sound-codec.m3u8', new Element(), {
            fetch,
            subtitles: false,
        });
        await assert.rejects(
            playback.finished,
            error => error.code === 'FORMAT' && /audio rendition/.test(error.message),
        );
    });

    test('a rendition without a URI is the sound of the variant: one SourceBuffer', async () => {
        const { source } = await played('muxed.m3u8');
        assert.equal(source.buffers.length, 1);
        assert.equal(source.buffers[0].type, 'video/mp4; codecs="avc1.42001e,mp4a.40.2"');
    });

    test('an AES-128 rendition is decrypted as the main playlist is', async () => {
        const key = new Uint8Array(16).fill(7);
        // Each segment encrypted with its media sequence number as the IV.
        const encrypted = (data, sequence) => {
            const iv = new Uint8Array(16);
            iv[15] = sequence;
            const cipher = createCipheriv('aes-128-cbc', key, iv);
            return Uint8Array.from([...cipher.update(data), ...cipher.final()]);
        };
        const secret = new Map([
            ...files,
            [
                'aes.m3u8',
                '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English",' +
                    'DEFAULT=YES,URI="en-aes.m3u8"\n' +
                    `#EXT-X-STREAM-INF:BANDWIDTH=300000,${variant}\nvideo.m3u8\n`,
            ],
            [
                'en-aes.m3u8',
                mediaPlaylist('en-aes')
                    .replace('en-aes-init.mp4', 'en-init.mp4')
                    .replace('#EXTINF', '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF'),
            ],
            ['key.bin', key],
            ['en-aes-1.m4s', encrypted(english.segments[0], 0)],
            ['en-aes-2.m4s', encrypted(english.segments[1], 1)],
        ]);
        const { source } = await played('aes.m3u8', {
            fetch: async url => {
                const body = secret.get(String(url).replace('https://media.test/', ''));
                return new Response(body ?? 'missing', { status: body === undefined ? 404 : 200 });
            },
        });
        assert.deepEqual(source.buffers[1].appends, [english.init, ...english.segments]);
    });

    test('SUBTITLES renditions become text tracks, the default one showing', async () => {
        const { media } = await played('master.m3u8');
        const tracks = media.textTracks.map(added => [added.kind, added.label, added.language]);
        assert.deepEqual(tracks, [
            ['subtitles', 'English', 'en'],
            ['subtitles', 'Japanese', 'ja'],
        ]);
        // Released with the playback: the tracks stay, disabled and empty.
        assert.deepEqual(
            media.textTracks.map(added => [added.mode, added.cues.length]),
            [
                ['disabled', 0],
                ['disabled', 0],
            ],
        );
    });

    test("the cues are each segment's, once, on the element's timeline", async () => {
        const media = new Element();
        const shown = [];
        const original = media.addTextTrack.bind(media);
        media.addTextTrack = (...args) => {
            const added = original(...args);
            const addCue = added.addCue.bind(added);
            added.addCue = cue => {
                shown.push([added.label, added.mode, cue.startTime, cue.endTime, cue.text]);
                addCue(cue);
            };
            return added;
        };
        const playback = forge.play('https://media.test/master.m3u8', media, {
            fetch,
            subtitles: { language: 'ja' },
        });
        for (const end = Date.now() + 10000; shown.length < 3 && Date.now() < end;)
            await new Promise(resolve => setTimeout(resolve, 5));
        playback.stop();
        await assert.rejects(playback.finished, error => error.code === 'ABORT');
        // The Japanese segment maps local zero to one second of the 90 kHz clock.
        assert.deepEqual(
            shown.sort((a, b) => a[0].localeCompare(b[0]) || a[2] - b[2]),
            [
                ['English', 'hidden', 0, 1, 'Hello'],
                ['English', 'hidden', 1, 2, 'There'],
                ['Japanese', 'showing', 1, 3, 'こんにちは'],
            ],
        );
    });

    test('a subtitles rendition that fails is reported; the playback goes on', async () => {
        const warnings = [];
        const broken = new Map([...files, ['subs-ja.m3u8', 'not a playlist']]);
        const media = new Element();
        const playback = forge.play('https://media.test/master.m3u8', media, {
            fetch: async url => {
                const body = broken.get(String(url).replace('https://media.test/', ''));
                return new Response(body ?? 'missing', { status: body === undefined ? 404 : 200 });
            },
            onWarning: warning => warnings.push(warning),
        });
        for (const end = Date.now() + 10000; !sources.at(-1)?.ended && Date.now() < end;)
            await new Promise(resolve => setTimeout(resolve, 5));
        media.ended = true;
        media.dispatchEvent(new Event('ended'));
        await playback.finished;
        assert.deepEqual(
            warnings.map(warning => warning.code),
            ['HLS_SUBTITLES_FAILED'],
        );
        assert.match(warnings[0].message, /^Subtitles Japanese stopped: /);
    });

    /** Waits until `ready()` holds, for at most ten seconds. */
    const until = async ready => {
        for (const end = Date.now() + 10000; !ready() && Date.now() < end;)
            await new Promise(resolve => setTimeout(resolve, 5));
        assert.ok(ready(), 'the state was reached');
    };

    test("with adaptive quality the renditions are the started variant's group's", async () => {
        const codecs = 'CODECS="avc1.42001e,mp4a.40.2"';
        const grouped = new Map([
            ...files,
            [
                'groups.m3u8',
                '#EXTM3U\n#EXT-X-INDEPENDENT-SEGMENTS\n' +
                    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="lo",NAME="English",LANGUAGE="en",' +
                    'DEFAULT=YES,URI="lo-en.m3u8"\n' +
                    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="hi",NAME="English",LANGUAGE="en",' +
                    'DEFAULT=YES,URI="hi-en.m3u8"\n' +
                    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="slo",NAME="English",DEFAULT=YES,' +
                    'URI="subs-en.m3u8"\n' +
                    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="shi",NAME="English",DEFAULT=YES,' +
                    'URI="subs-ja.m3u8"\n' +
                    `#EXT-X-STREAM-INF:BANDWIDTH=100000,${codecs},AUDIO="lo",SUBTITLES="slo"\n` +
                    'video.m3u8\n' +
                    `#EXT-X-STREAM-INF:BANDWIDTH=500000,${codecs},AUDIO="hi",SUBTITLES="shi"\n` +
                    'video-hi.m3u8\n',
            ],
            ['video-hi.m3u8', mediaPlaylist('v')],
            ['lo-en.m3u8', mediaPlaylist('en')],
            ['hi-en.m3u8', mediaPlaylist('ja')],
        ]);
        const asked = [];
        const { source, media } = await played('groups.m3u8', {
            adaptive: true,
            fetch: async url => {
                const path = String(url).replace('https://media.test/', '');
                asked.push(path);
                const body = grouped.get(path);
                return new Response(body ?? 'missing', { status: body === undefined ? 404 : 200 });
            },
        });
        // The client starts low before any measurement, and so do the sound and the subtitles.
        assert.deepEqual(
            asked.filter(path => /^(?:lo|hi)-en\.m3u8$|^(?:en|ja)-\d\.m4s$/.test(path)),
            ['lo-en.m3u8', 'en-1.m4s', 'en-2.m4s'],
        );
        assert.deepEqual(source.buffers[1].appends, [english.init, ...english.segments]);
        assert.deepEqual(
            asked.filter(path => path.startsWith('subs-')),
            ['subs-en.m3u8'],
        );
        assert.equal(media.textTracks.length, 1);
    });

    test('the playback tells where the picture moves to another variant', async () => {
        const low = { uri: 'https://media.test/low.m3u8', bandwidth: 1, codecs: 'avc1.42001e' };
        const high = { ...low, uri: 'https://media.test/high.m3u8' };
        const unit = (index, variant) => ({
            type: 'segment',
            segment: {
                sequence: index,
                duration: 1,
                discontinuitySequence: 0,
                map: { uri: 'v-init.mp4' },
            },
            data: video.segments[index],
            ...(index ? {} : { initData: video.init }),
            variant,
        });
        const seen = [];
        const media = new Element();
        const playing = playStreams(
            media,
            [
                {
                    units: (async function* () {
                        yield unit(0, low);
                        yield unit(1, high);
                    })(),
                },
            ],
            {},
            { variant: (variant, start) => seen.push([variant.uri, start]) },
        );
        await until(() => sources.at(-1)?.ended);
        media.ended = true;
        media.dispatchEvent(new Event('ended'));
        await playing;
        assert.deepEqual(seen, [
            [low.uri, 0],
            [high.uri, 1],
        ]);
    });

    test('a unit of other codecs changes the SourceBuffer type once, before its init', async () => {
        const low = { uri: 'https://media.test/low.m3u8', bandwidth: 1, codecs: 'avc1.42001e' };
        const high = { uri: 'https://media.test/high.m3u8', bandwidth: 2, codecs: 'avc1.64001f' };
        const units = async function* () {
            const segment = (sequence, map) => ({
                sequence,
                duration: 1,
                discontinuitySequence: 0,
                map: { uri: map },
            });
            yield {
                type: 'segment',
                segment: segment(0, 'l-init.mp4'),
                data: video.segments[0],
                initData: video.init,
                variant: low,
            };
            yield {
                type: 'segment',
                segment: segment(1, 'h-init.mp4'),
                data: wide.segments[1],
                initData: wide.init,
                variant: high,
            };
        };
        const playOnce = async () => {
            const media = new Element();
            const before = sources.length;
            let settled = false;
            const playing = playStreams(media, [{ units: units() }]);
            playing.then(
                () => (settled = true),
                () => (settled = true),
            );
            await until(() => settled || (sources.length > before && sources.at(-1).ended));
            if (!settled) {
                media.ended = true;
                media.dispatchEvent(new Event('ended'));
            }
            await playing;
            return sources.at(-1).buffers[0];
        };
        Buffer.prototype.changeType = function (type) {
            this.appends.push(['changeType', type]);
        };
        try {
            const buffer = await playOnce();
            assert.deepEqual(buffer.appends, [
                video.init,
                video.segments[0],
                ['changeType', 'video/mp4; codecs="avc1.64001f"'],
                wide.init,
                wide.segments[1],
            ]);
        } finally {
            delete Buffer.prototype.changeType;
        }
        // Without changeType the switch is refused where it comes.
        await assert.rejects(
            playOnce(),
            error => error.code === 'FORMAT' && /cannot change HLS codecs/.test(error.message),
        );
    });

    test('adaptive quality switches to other codecs only where changeType exists', async () => {
        const playlist = prefix =>
            '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:1\n#EXT-X-PLAYLIST-TYPE:VOD\n' +
            `#EXT-X-MAP:URI="${prefix}-init.mp4"\n` +
            Array.from({ length: 6 }, (_, n) => `#EXTINF:1.0,\n${prefix}-${n}.m4s\n`).join('') +
            '#EXT-X-ENDLIST\n';
        const narrow = track('video', 0, { count: 6 });
        const broad = track('video', 0, { count: 6, width: 32 });
        const served = new Map([
            [
                'codecs.m3u8',
                '#EXTM3U\n#EXT-X-INDEPENDENT-SEGMENTS\n' +
                    '#EXT-X-STREAM-INF:BANDWIDTH=100000,CODECS="avc1.42001e"\nn.m3u8\n' +
                    '#EXT-X-STREAM-INF:BANDWIDTH=500000,CODECS="avc1.64001f"\nw.m3u8\n',
            ],
            ['n.m3u8', playlist('n')],
            ['w.m3u8', playlist('w')],
            ['n-init.mp4', narrow.init],
            ['w-init.mp4', broad.init],
            ...narrow.segments.map((data, n) => [`n-${n}.m4s`, data]),
            ...broad.segments.map((data, n) => [`w-${n}.m4s`, data]),
        ]);
        // A clock on which every segment arrives in a millisecond: throughput enough to go up.
        const saved = Object.getOwnPropertyDescriptor(globalThis, 'performance');
        let time = 0;
        Object.defineProperty(globalThis, 'performance', {
            value: { now: () => time },
            configurable: true,
        });
        const run = async () => {
            const asked = [];
            const { source } = await played('codecs.m3u8', {
                adaptive: true,
                fetch: async url => {
                    const path = String(url).replace('https://media.test/', '');
                    asked.push(path);
                    if (path.endsWith('.m4s')) time += 1;
                    const body = served.get(path);
                    return new Response(body ?? 'missing', {
                        status: body === undefined ? 404 : 200,
                    });
                },
            });
            const appends = source.buffers[0].appends;
            return {
                changes: appends.filter(entry => Array.isArray(entry)),
                after: appends[appends.findIndex(entry => Array.isArray(entry)) + 1],
                wide: asked.filter(path => path.startsWith('w-')).length,
            };
        };
        try {
            globalThis.SourceBuffer = Buffer;
            Buffer.prototype.changeType = function (type) {
                this.appends.push(['changeType', type]);
            };
            const changing = await run();
            assert.deepEqual(changing.changes, [['changeType', 'video/mp4; codecs="avc1.64001f"']]);
            assert.deepEqual(changing.after, broad.init);
            assert.ok(changing.wide > 1, 'the wider variant played');
            // Without changeType, variants of other codecs are not switched to.
            delete globalThis.SourceBuffer;
            delete Buffer.prototype.changeType;
            const fixed = await run();
            assert.deepEqual([fixed.changes, fixed.wide], [[], 0]);
        } finally {
            delete globalThis.SourceBuffer;
            delete Buffer.prototype.changeType;
            Object.defineProperty(globalThis, 'performance', saved);
        }
    });

    test('a text track follows a variant of another SUBTITLES group from the switch', async () => {
        const master = parseHlsPlaylist(
            '#EXTM3U\n' +
                '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="sl",NAME="English",LANGUAGE="en",' +
                'DEFAULT=YES,URI="sl-en.m3u8"\n' +
                '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="sl",NAME="Japanese",LANGUAGE="ja",' +
                'URI="sl-ja.m3u8"\n' +
                '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="sh",NAME="English",LANGUAGE="en",' +
                'DEFAULT=YES,URI="sh-en.m3u8"\n' +
                '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="sh",NAME="Nihongo",LANGUAGE="ja",' +
                'URI="sh-ja.m3u8"\n' +
                '#EXT-X-STREAM-INF:BANDWIDTH=100000,SUBTITLES="sl"\nlow.m3u8\n' +
                '#EXT-X-STREAM-INF:BANDWIDTH=500000,SUBTITLES="sh"\nhigh.m3u8\n',
            { baseUrl: 'https://media.test/master.m3u8' },
        );
        const [low, high] = master.variants;
        // Four one-second segments, each repeating the cue of the one before.
        const cue = (prefix, n) => `00:00:0${n}.000 --> 00:00:0${n + 1}.000\n${prefix} ${n}\n`;
        const body = path => {
            const playlist = /^(s[lh]-(?:en|ja))\.m3u8$/.exec(path);
            if (playlist)
                return (
                    '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-PLAYLIST-TYPE:VOD\n' +
                    [0, 1, 2, 3].map(n => `#EXTINF:1.0,\n${playlist[1]}-${n}.vtt\n`).join('') +
                    '#EXT-X-ENDLIST\n'
                );
            const [, prefix, n] = /^(s[lh]-(?:en|ja))-(\d)\.vtt$/.exec(path);
            return (
                'WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000\n\n' +
                (+n ? `${cue(prefix, +n - 1)}\n` : '') +
                cue(prefix, +n)
            );
        };
        // The English rendition of the first group waits at its second segment until the switch.
        let release;
        const gate = new Promise(resolve => (release = resolve));
        const fetch = async url => {
            const path = String(url).replace('https://media.test/', '');
            if (path === 'sl-en-1.vtt') await gate;
            return new Response(body(path));
        };
        const signal = new AbortController().signal;
        const media = new Element();
        const tracks = new SubtitleTracks(
            media,
            master,
            low,
            undefined,
            { fetch, signal },
            { signal },
        );
        const texts = track =>
            [...track.cues].sort((a, b) => a.startTime - b.startTime).map(added => added.text);
        try {
            tracks.offset(0, 0);
            const [english, japanese] = media.textTracks;
            await until(() => texts(japanese).length === 4 && texts(english).length === 1);
            tracks.follow(high, 2);
            release();
            await until(
                () =>
                    texts(english).includes('sl-en 1') &&
                    texts(english).includes('sh-en 3') &&
                    texts(japanese).includes('sh-ja 3'),
            );
            // The same tracks, of their own names and modes, each cue once: the first group's
            // before the switch, the other group's (by name, else by language) after it.
            assert.deepEqual(media.textTracks, [english, japanese]);
            assert.deepEqual(
                [english.label, english.mode, japanese.label, japanese.mode],
                ['English', 'showing', 'Japanese', 'hidden'],
            );
            assert.deepEqual(texts(english), ['sl-en 0', 'sl-en 1', 'sh-en 2', 'sh-en 3']);
            assert.deepEqual(texts(japanese), ['sl-ja 0', 'sl-ja 1', 'sh-ja 2', 'sh-ja 3']);
        } finally {
            tracks.stop();
        }
    });

    test('subtitles: false adds no text track', async () => {
        const { media } = await played('master.m3u8', { subtitles: false });
        assert.deepEqual(media.textTracks, []);
    });
});

describe('the HLS player: an audio rendition across variants and refreshes', () => {
    const playlists = {
        master:
            '#EXTM3U\n' +
            '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="low",NAME="English",LANGUAGE="en",DEFAULT=YES,' +
            'URI="low-en.m3u8"\n' +
            '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="high",NAME="Main",LANGUAGE="en",DEFAULT=YES,' +
            'URI="high-en.m3u8"\n' +
            '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="high",NAME="Japanese",LANGUAGE="ja",' +
            'URI="high-ja.m3u8"\n' +
            '#EXT-X-STREAM-INF:BANDWIDTH=100000,AUDIO="low"\nlow.m3u8\n' +
            '#EXT-X-STREAM-INF:BANDWIDTH=500000,AUDIO="high"\nhigh.m3u8\n',
    };
    /** A media playlist of segments `from`..`to` of `prefix`, ended unless `live`. */
    const segments = (prefix, from, to, live = false) =>
        '#EXTM3U\n#EXT-X-TARGETDURATION:1\n' +
        `#EXT-X-MEDIA-SEQUENCE:${from}\n` +
        Array.from(
            { length: to - from + 1 },
            (_, index) => `#EXTINF:1.0,\n${prefix}-${from + index}.aac\n`,
        ).join('') +
        (live ? '' : '#EXT-X-ENDLIST\n');
    const master = parseHlsPlaylist(playlists.master, {
        baseUrl: 'https://media.test/master.m3u8',
    });
    const [low, high] = master.variants;

    test('a variant of another group plays its rendition of the same language', async () => {
        const seen = [];
        const fetch = async url => {
            const path = String(url).replace('https://media.test/', '');
            seen.push(path);
            if (path.endsWith('.m3u8'))
                return new Response(segments(path.replace('.m3u8', ''), 0, 3));
            return new Response(new TextEncoder().encode(path));
        };
        const signal = new AbortController().signal;
        const rendition = master.renditions[0];
        const feed = new AudioRenditionFeed(
            master,
            low,
            rendition,
            undefined,
            { fetch, signal },
            { signal },
        );
        const units = [];
        for await (const unit of feed.units()) {
            units.push([new TextDecoder().decode(unit.data), unit.variant.uri]);
            if (units.length === 2) feed.follow(high);
        }
        // The new group has no rendition of the name English: the one of its language plays,
        // from the media sequence after the last one played.
        assert.deepEqual(units, [
            ['low-en-0.aac', low.uri],
            ['low-en-1.aac', low.uri],
            ['high-en-2.aac', high.uri],
            ['high-en-3.aac', high.uri],
        ]);
        assert.ok(!seen.includes('high-ja.m3u8'));
    });

    test('a switch inside a segment of parts ends it in the rendition before', async () => {
        // Three segments of two parts each.
        const parted = prefix =>
            '#EXTM3U\n#EXT-X-VERSION:9\n#EXT-X-TARGETDURATION:1\n' +
            '#EXT-X-PART-INF:PART-TARGET=0.5\n' +
            [0, 1, 2]
                .map(
                    n =>
                        `#EXT-X-PART:DURATION=0.5,URI="${prefix}-${n}.0.aac"\n` +
                        `#EXT-X-PART:DURATION=0.5,URI="${prefix}-${n}.1.aac"\n` +
                        `#EXTINF:1.0,\n${prefix}-${n}.aac\n`,
                )
                .join('') +
            '#EXT-X-ENDLIST\n';
        const fetch = async url => {
            const path = String(url).replace('https://media.test/', '');
            if (path.endsWith('.m3u8')) return new Response(parted(path.replace('.m3u8', '')));
            return new Response(new TextEncoder().encode(path));
        };
        const signal = new AbortController().signal;
        const feed = new AudioRenditionFeed(
            master,
            low,
            master.renditions[0],
            undefined,
            { fetch, signal },
            { signal },
        );
        const names = [];
        for await (const unit of feed.units()) {
            names.push(new TextDecoder().decode(unit.data));
            if (names.length === 1) feed.follow(high);
        }
        assert.deepEqual(names, [
            'low-en-0.0.aac',
            'low-en-0.1.aac',
            'high-en-1.0.aac',
            'high-en-1.1.aac',
            'high-en-2.0.aac',
            'high-en-2.1.aac',
        ]);
    });

    test('a live rendition is refreshed as its playlist grows', async () => {
        let loads = 0;
        const fetch = async url => {
            const path = String(url).replace('https://media.test/', '');
            if (path === 'low-en.m3u8')
                return new Response(
                    ++loads === 1 ? segments('low-en', 0, 1, true) : segments('low-en', 0, 2),
                );
            return new Response(new TextEncoder().encode(path));
        };
        const signal = new AbortController().signal;
        const feed = new AudioRenditionFeed(
            master,
            low,
            master.renditions[0],
            undefined,
            { fetch, signal, refreshIntervalMs: 1 },
            { signal, live: true },
        );
        const names = [];
        for await (const unit of feed.units()) names.push(new TextDecoder().decode(unit.data));
        assert.deepEqual(names, ['low-en-0.aac', 'low-en-1.aac', 'low-en-2.aac']);
        assert.ok(loads >= 2, `${loads} loads`);
    });
});
