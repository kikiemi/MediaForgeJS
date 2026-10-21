import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { CmafWriter } from 'mediaforgejs/streaming';
import { playHls } from 'mediaforgejs-player';

// playHls() through an EventTarget model of Media Source Extensions: serial fMP4 appends, the
// end of a stream, cancellation, one stream per element, buffer eviction and gaps.

describe('HLS playback through Media Source Extensions', () => {
    const saved = {
        MediaSource: globalThis.MediaSource,
        create: URL.createObjectURL,
        revoke: URL.revokeObjectURL,
    };
    let mse;
    let revoked = 0;
    let automaticEviction = false;
    const frameTimes = new Map();
    class Buffer extends EventTarget {
        updating = false;
        mode = 'segments';
        timestampOffset = 0;
        appends = [];
        ranges = [];
        get buffered() {
            const ranges = this.ranges;
            return { length: ranges.length, start: n => ranges[n][0], end: n => ranges[n][1] };
        }
        appendBuffer(bytes) {
            assert.equal(this.updating, false);
            this.updating = true;
            this.appends.push({ bytes: new Uint8Array(bytes), offset: this.timestampOffset });
            queueMicrotask(() => {
                const timing = frameTimes.get(bytes.buffer);
                if (timing) {
                    if (automaticEviction) this.ranges = [];
                    this.ranges.push(timing.map(time => time + this.timestampOffset));
                }
                this.updating = false;
                this.dispatchEvent(new Event('updateend'));
            });
        }
        abort() {
            this.updating = false;
        }
    }
    class Source extends EventTarget {
        static isTypeSupported(value) {
            return value === 'audio/mp4; codecs="mp4a.40.2"';
        }
        readyState = 'closed';
        ended = false;
        removed = false;
        constructor() {
            super();
            mse = this;
        }
        addSourceBuffer() {
            this.buffer = new Buffer();
            return this.buffer;
        }
        removeSourceBuffer(buffer) {
            assert.equal(buffer, this.buffer);
            this.removed = true;
        }
        endOfStream() {
            assert.equal(this.buffer.updating, false);
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
        playCalls = 0;
        set src(value) {
            this.url = value;
            queueMicrotask(() => {
                mse.readyState = 'open';
                mse.dispatchEvent(new Event('sourceopen'));
            });
        }
        get buffered() {
            return mse?.buffer?.buffered ?? { length: 0 };
        }
        getAttribute() {
            return this.url;
        }
        removeAttribute() {
            this.url = undefined;
        }
        load() {}
        play() {
            this.playCalls++;
            this.paused = false;
            return Promise.resolve();
        }
    }
    const writer = new CmafWriter({
        tracks: [
            {
                id: 1,
                type: 'audio',
                codec: 'mp4a.40.2',
                timescale: 48000,
                sampleRate: 48000,
                channelCount: 1,
                codecConfig: Uint8Array.of(0x11, 0x88),
            },
        ],
    });
    const initData = writer.createInitSegment();
    writer.addSample({
        trackId: 1,
        data: Uint8Array.of(1),
        decodeTimestamp: 48000,
        duration: 1024,
        isKeyframe: true,
    });
    const data = writer.flush().data;
    const unit = {
        type: 'part',
        part: { uri: 'sample.m4s', duration: 1024 / 48000, map: { uri: 'init.mp4' } },
        sequence: 1,
        partIndex: 0,
        discontinuitySequence: 0,
        variant: { uri: 'audio', bandwidth: 64000, codecs: 'mp4a.40.2' },
        initData,
        data,
    };
    const timedUnit = (start, first) => {
        writer.addSample({
            trackId: 1,
            data: Uint8Array.of(1),
            decodeTimestamp: start * 48000,
            duration: 48000,
            isKeyframe: true,
        });
        const data = writer.flush().data;
        frameTimes.set(data.buffer, [start, start + 1]);
        return {
            ...unit,
            sequence: start,
            part: { ...unit.part, duration: 1 },
            data,
            initData: first ? initData : undefined,
        };
    };
    const awaitEndOfStream = async () => {
        for (let attempts = 0; !mse?.ended && attempts < 30; attempts++)
            await new Promise(resolve => setImmediate(resolve));
        assert.equal(mse?.ended, true);
    };
    before(() => {
        globalThis.MediaSource = Source;
        URL.createObjectURL = () => 'blob:mediaforge-hls-smoke';
        URL.revokeObjectURL = () => {
            revoked++;
        };
    });
    beforeEach(() => {
        mse = undefined;
        revoked = 0;
        automaticEviction = false;
    });
    after(() => {
        globalThis.MediaSource = saved.MediaSource;
        URL.createObjectURL = saved.create;
        URL.revokeObjectURL = saved.revoke;
    });

    test('plays fMP4 units in order, calls play() once, releases the element', async () => {
        const media = new Element();
        let settled = false;
        const playing = playHls(
            media,
            (async function* () {
                yield unit;
            })(),
        ).then(() => {
            settled = true;
        });
        for (let attempts = 0; !mse?.ended && attempts < 30; attempts++)
            await new Promise(resolve => setImmediate(resolve));
        assert.equal(mse.ended, true);
        assert.equal(settled, false);
        assert.equal(media.playCalls, 1);
        assert.deepEqual(
            mse.buffer.appends.map(append => append.offset),
            [-1, -1],
        );
        assert.deepEqual(
            mse.buffer.appends.map(append => append.bytes),
            [initData, data],
        );
        media.ended = true;
        media.dispatchEvent(new Event('ended'));
        await playing;
        assert.equal(media.url, undefined);
        assert.equal(mse.removed, true);
        assert.equal(revoked, 1);
    });

    test('an element plays one stream; abort ends a stalled one and its units', async () => {
        const media = new Element();
        const controller = new AbortController();
        let returns = 0;
        const stalled = {
            [Symbol.asyncIterator]() {
                return this;
            },
            next: () => new Promise(() => {}),
            return() {
                returns++;
                return Promise.reject(new Error('cleanup'));
            },
        };
        const first = playHls(media, stalled, { signal: controller.signal });
        await assert.rejects(playHls(media, stalled), error => error.code === 'INPUT');
        controller.abort();
        await assert.rejects(first, error => error.code === 'ABORT');
        assert.equal(returns, 1);
    });

    test('a long live stream keeps only the media near the playhead', async () => {
        automaticEviction = true;
        const liveMedia = new Element();
        let position = 0;
        let timeReads = 0;
        Object.defineProperty(liveMedia, 'currentTime', {
            get() {
                timeReads++;
                return position;
            },
            set() {},
        });
        const livePlaying = playHls(
            liveMedia,
            (async function* () {
                for (let index = 0; index < 1000; index++) {
                    position = index;
                    yield timedUnit(index + 2, index === 0);
                }
            })(),
        );
        await awaitEndOfStream();
        const observedReads = timeReads;
        assert.deepEqual(mse.buffer.ranges, [[999, 1000]]);
        liveMedia.ended = true;
        liveMedia.dispatchEvent(new Event('ended'));
        await livePlaying;
        assert.ok(
            observedReads < 15000,
            `automatic eviction retained historical work: ${observedReads} time reads`,
        );
    });

    test('waiting at a gap skips it; playable media before the gap is not skipped', async () => {
        const gapMedia = new Element();
        const gapPlaying = playHls(
            gapMedia,
            (async function* () {
                yield timedUnit(2000, true);
                yield timedUnit(2004, false);
            })(),
        );
        await awaitEndOfStream();
        gapMedia.currentTime = 0.97;
        gapMedia.dispatchEvent(new Event('timeupdate'));
        assert.equal(gapMedia.currentTime, 0.97, 'playable media before a gap must not be skipped');
        gapMedia.dispatchEvent(new Event('waiting'));
        assert.equal(gapMedia.currentTime, 4);
        gapMedia.ended = true;
        gapMedia.dispatchEvent(new Event('ended'));
        await gapPlaying;
    });
});
