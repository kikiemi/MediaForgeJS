import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { CmafWriter } from 'mediaforgejs/streaming';
import { createHlsDrmHandler, HlsClient, playHlsWithDrm } from 'mediaforgejs-player';

// HLS DRM through a model of Media Source Extensions and EME: the handler, key systems,
// initialization data, licenses, deadlines and the release of the element.

describe('HLS DRM playback', () => {
    const tick = () => new Promise(resolve => setImmediate(resolve));
    const until = async predicate => {
        for (let i = 0; i < 100; i++) {
            if (predicate()) return;
            await tick();
        }
        assert.fail('model did not reach expected state');
    };
    const format = 'urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed';
    const makePssh = id => {
        const bytes = new Uint8Array(33);
        const view = new DataView(bytes.buffer);
        view.setUint32(0, 33);
        bytes.set([112, 115, 115, 104], 4);
        bytes.set(Buffer.from('edef8ba979d64acea3c827dcd51d21ed', 'hex'), 12);
        view.setUint32(28, 1);
        bytes[32] = id;
        return bytes;
    };
    const key = id => ({
        method: 'SAMPLE-AES',
        keyFormat: format,
        uri: 'data:text/plain;base64,' + Buffer.from(makePssh(id)).toString('base64'),
    });
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
    let decodeIndex = 0;
    const unit = (id, encryption = key(1)) => {
        writer.addSample({
            trackId: 1,
            data: Uint8Array.of(1),
            decodeTimestamp: decodeIndex++ * 1024,
            duration: 1024,
            isKeyframe: true,
        });
        return {
            type: 'part',
            part: {
                uri: `${id}.m4s`,
                duration: 1024 / 48000,
                map: { uri: 'init.mp4' },
                key: encryption,
                keys: encryption ? [encryption] : [],
            },
            sequence: 1,
            partIndex: id,
            discontinuitySequence: 0,
            data: writer.flush().data,
            initData: id === 0 ? initData : undefined,
            encryption,
            variant: { uri: 'a.m3u8', bandwidth: 64000, codecs: 'mp4a.40.2' },
        };
    };
    const saved = {
        navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
        MediaSource: globalThis.MediaSource,
        create: URL.createObjectURL,
        revoke: URL.revokeObjectURL,
    };
    let source, sessions, requests, ordered, rejectSystem, denyLicense, currentMedia;
    class Session extends EventTarget {
        sessionId = '';
        keyStatuses = new Map();
        constructor() {
            super();
            this.closed = new Promise(resolve => (this.finish = resolve));
            sessions.push(this);
        }
        async generateRequest(type, bytes) {
            this.type = type;
            this.init = new Uint8Array(bytes);
            this.sessionId = String(sessions.length);
            ordered.push('generate');
            queueMicrotask(() => this.message());
        }
        message() {
            const event = new Event('message');
            Object.assign(event, {
                messageType: 'license-request',
                message: Uint8Array.of(8).buffer,
            });
            this.dispatchEvent(event);
        }
        async update(bytes) {
            this.license = new Uint8Array(bytes);
            ordered.push('license');
        }
        async close() {
            this.finish();
        }
    }
    class SourceBuffer extends EventTarget {
        updating = false;
        mode = 'segments';
        timestampOffset = 0;
        appends = [];
        buffered = { length: 0 };
        appendBuffer(data) {
            ordered.push('append');
            this.appends.push(new Uint8Array(data));
            this.updating = true;
            queueMicrotask(() => {
                this.updating = false;
                this.dispatchEvent(new Event('updateend'));
            });
        }
        abort() {
            this.updating = false;
        }
    }
    class Source extends EventTarget {
        static isTypeSupported() {
            return true;
        }
        readyState = 'closed';
        constructor() {
            super();
            source = this;
        }
        addSourceBuffer() {
            return (this.buffer = new SourceBuffer());
        }
        removeSourceBuffer() {
            this.removed = true;
        }
        endOfStream() {
            this.ended = true;
            this.readyState = 'ended';
        }
    }
    class Media extends EventTarget {
        srcObject = null;
        currentTime = 0;
        ended = false;
        paused = true;
        mediaKeys = null;
        constructor() {
            super();
            currentMedia = this;
        }
        async setMediaKeys(keys) {
            ordered.push(keys ? 'attach' : 'detach');
            this.mediaKeys = keys;
        }
        set src(value) {
            this.url = value;
            queueMicrotask(() => {
                source.readyState = 'open';
                source.dispatchEvent(new Event('sourceopen'));
            });
        }
        get buffered() {
            return source?.buffer?.buffered ?? { length: 0 };
        }
        getAttribute() {
            return this.url;
        }
        removeAttribute() {
            this.url = undefined;
        }
        load() {}
        async play() {
            this.paused = false;
        }
    }
    const license = request => {
        if (denyLicense) throw denyLicense;
        return Uint8Array.of(4);
    };
    const options = {
        keySystems: [{ keySystem: 'com.widevine.alpha', license }],
        // Deadlines the tests do not mean to reach: far enough that no load reaches them.
        eme: { attachTimeoutMs: 10000, licenseTimeoutMs: 10000 },
    };
    const reset = () => {
        source = undefined;
        sessions = [];
        requests = [];
        ordered = [];
        rejectSystem = undefined;
        denyLicense = undefined;
    };
    const complete = async (media, pending) => {
        await until(() => source?.ended);
        media.ended = true;
        media.dispatchEvent(new Event('ended'));
        await pending;
    };
    beforeEach(() => reset());
    before(() => {
        globalThis.MediaSource = Source;
        URL.createObjectURL = () => 'blob:test-protected-hls';
        URL.revokeObjectURL = () => {};
        Object.defineProperty(globalThis, 'navigator', {
            configurable: true,
            value: {
                async requestMediaKeySystemAccess(system, configurations) {
                    requests.push({ system, configurations });
                    if (system === rejectSystem)
                        throw new DOMException('unsupported', 'NotSupportedError');
                    return {
                        keySystem: system,
                        getConfiguration: () => configurations[0],
                        async createMediaKeys() {
                            return {
                                createSession() {
                                    return new Session();
                                },
                                async setServerCertificate() {
                                    ordered.push('certificate');
                                    return true;
                                },
                            };
                        },
                    };
                },
            },
        });
    });
    test('DRM handler only allows configured fMP4 sample encryption', async () => {
        const handler = createHlsDrmHandler(options);
        const context = {
            key: key(1),
            kind: 'part',
            uri: 'part.m4s',
            sequence: 1,
            map: { uri: 'init.mp4' },
            signal: new AbortController().signal,
        };
        assert.equal(handler.supports(context), true);
        assert.equal(handler.supports({ ...context, map: undefined }), false);
        assert.equal(
            handler.supports({ ...context, key: { ...context.key, method: 'AES-128' } }),
            false,
        );
        assert.equal(handler.retainsEncryption, true);
        const bytes = Uint8Array.of(1, 2);
        assert.equal(await handler.decrypt({ ...context, data: bytes }), bytes);
    });
    test('CDM attach precedes first append and licenses deduplicate/rotate', async () => {
        const media = new Media();
        const pending = playHlsWithDrm(
            media,
            (async function* () {
                yield unit(0);
                yield unit(1);
                yield unit(2, key(2));
            })(),
            options,
        );
        await complete(media, pending);
        assert.equal(requests.length, 1);
        assert.equal(sessions.length, 2);
        assert.equal(requests[0].configurations[0].audioCapabilities[0].encryptionScheme, 'cbcs');
        assert(ordered.indexOf('attach') < ordered.indexOf('append'));
        assert.equal(media.mediaKeys, null);
        assert(sessions.every(session => session.type === 'cenc' && session.license[0] === 4));
    });
    test('key-system fallback is selected before attachment', async () => {
        rejectSystem = 'test.unavailable';
        const media = new Media();
        const configured = {
            keySystems: [
                { keySystem: rejectSystem, keyFormats: [format], license },
                ...options.keySystems,
            ],
        };
        await complete(
            media,
            playHlsWithDrm(
                media,
                (async function* () {
                    yield unit(0);
                })(),
                configured,
            ),
        );
        assert.deepEqual(
            requests.map(x => x.system),
            ['test.unavailable', 'com.widevine.alpha'],
        );
        assert.equal(ordered.filter(x => x === 'attach').length, 1);
    });
    test('clear to encrypted transition initializes EME', async () => {
        const media = new Media();
        const plain = unit(0);
        delete plain.encryption;
        await complete(
            media,
            playHlsWithDrm(
                media,
                (async function* () {
                    yield plain;
                    yield unit(1);
                })(),
                options,
            ),
        );
        assert.equal(sessions.length, 1);
        assert.equal(requests.length, 1);
    });
    test('license rejection propagates and releases playback', async () => {
        denyLicense = new Error('license forbidden');
        const media = new Media();
        const pending = playHlsWithDrm(
            media,
            (async function* () {
                yield unit(0);
            })(),
            options,
        );
        await assert.rejects(pending, /license forbidden/);
        await tick();
        assert.equal(media.mediaKeys, null);
        assert.equal(media.url, undefined);
    });
    test('abort releases an uncooperative iterator exactly once', async () => {
        const signal = new AbortController();
        let returns = 0;
        const iterable = {
            [Symbol.asyncIterator]() {
                return this;
            },
            next() {
                return new Promise(() => {});
            },
            return() {
                returns++;
                return new Promise(() => {});
            },
        };
        const pending = playHlsWithDrm(new Media(), iterable, {
            ...options,
            signal: signal.signal,
        });
        signal.abort();
        await assert.rejects(pending, e => e.code === 'ABORT');
        await tick();
        assert.equal(returns, 1);
    });
    test('SAMPLE-AES-CTR requests cenc capabilities', async () => {
        const media = new Media();
        await complete(
            media,
            playHlsWithDrm(
                media,
                (async function* () {
                    yield unit(0, { ...key(1), method: 'SAMPLE-AES-CTR' });
                })(),
                options,
            ),
        );
        assert.equal(requests[0].configurations[0].audioCapabilities[0].encryptionScheme, 'cenc');
    });
    test('FairPlay certificate precedes skd session generation', async () => {
        const media = new Media();
        const configured = {
            keySystems: [
                { keySystem: 'com.apple.fps', license, serverCertificate: Uint8Array.of(1, 2) },
            ],
        };
        await complete(
            media,
            playHlsWithDrm(
                media,
                (async function* () {
                    yield unit(0, {
                        method: 'SAMPLE-AES',
                        keyFormat: 'com.apple.streamingkeydelivery',
                        uri: 'skd:asset',
                    });
                })(),
                configured,
            ),
        );
        assert.equal(sessions[0].type, 'skd');
        assert.deepEqual(sessions[0].init, new TextEncoder().encode('skd:asset'));
        assert(ordered.indexOf('certificate') < ordered.indexOf('generate'));
    });
    test('PlayReady object becomes cenc initialization data', async () => {
        const media = new Media();
        const object = Uint8Array.of(12, 0, 0, 0, 1, 0, 1, 0, 2, 0, 60, 0);
        const configured = { keySystems: [{ keySystem: 'com.microsoft.playready', license }] };
        await complete(
            media,
            playHlsWithDrm(
                media,
                (async function* () {
                    yield unit(0, {
                        method: 'SAMPLE-AES-CTR',
                        keyFormat: 'com.microsoft.playready',
                        uri:
                            'data:text/plain;charset=UTF-16;base64,' +
                            Buffer.from(object).toString('base64'),
                    });
                })(),
                configured,
            ),
        );
        assert.equal(sessions[0].type, 'cenc');
        assert.equal(sessions[0].init.length, 44);
        assert.deepEqual(
            sessions[0].init.slice(12, 28),
            new Uint8Array(Buffer.from('9a04f07998404286ab92e65be0885f95', 'hex')),
        );
        assert.deepEqual(sessions[0].init.slice(32), object);
    });
    test('malformed or foreign PSSH is rejected before appending', async () => {
        const bytes = makePssh(1);
        bytes[12] = 0;
        await assert.rejects(
            playHlsWithDrm(
                new Media(),
                (async function* () {
                    yield unit(0, {
                        ...key(1),
                        uri: 'data:text/plain;base64,' + Buffer.from(bytes).toString('base64'),
                    });
                })(),
                options,
            ),
            e => e.code === 'DEMUX',
        );
        assert.equal(source, undefined);
        assert.equal(currentMedia.mediaKeys, null);
    });
    test('active waitingforkey has a deadline', async () => {
        const media = new Media();
        const pending = playHlsWithDrm(
            media,
            (async function* () {
                yield unit(0);
            })(),
            { ...options, keyTimeoutMs: 5 },
        );
        await until(() => source?.ended);
        media.dispatchEvent(new Event('waitingforkey'));
        await assert.rejects(pending, e => e.code === 'IO' && /usable key/.test(e.message));
        assert.equal(media.mediaKeys, null);
    });
    test('invalid null timeout is rejected before any capability request', async () => {
        await assert.rejects(
            playHlsWithDrm(
                new Media(),
                (async function* () {
                    yield unit(0);
                })(),
                { ...options, keyTimeoutMs: null },
            ),
            e => e.code === 'INPUT',
        );
        assert.equal(requests.length, 0);
    });
    test('abort returns promptly during a stalled native detach', async () => {
        const original = Media.prototype.setMediaKeys;
        let release;
        const stop = new AbortController();
        const media = new Media();
        let timer;
        Media.prototype.setMediaKeys = function (keys) {
            if (keys) return original.call(this, keys);
            return new Promise(resolve => {
                release = () => {
                    this.mediaKeys = null;
                    resolve();
                };
            });
        };
        const pending = playHlsWithDrm(
            media,
            (async function* () {
                yield unit(0);
            })(),
            { ...options, signal: stop.signal },
        );
        const outcome = pending.then(
            () => 'success',
            error => {
                assert.equal(error.code, 'ABORT');
                return 'aborted';
            },
        );
        try {
            await until(() => source?.ended);
            stop.abort();
            assert.equal(
                await Promise.race([
                    outcome,
                    new Promise(resolve => {
                        timer = setTimeout(() => resolve('waiting for detach'), 30);
                    }),
                ]),
                'aborted',
            );
        } finally {
            clearTimeout(timer);
            release?.();
            await outcome;
            await tick();
            Media.prototype.setMediaKeys = original;
        }
    });
    test('compatible scheme configuration alternative is used', async () => {
        const media = new Media();
        const configured = {
            keySystems: [
                {
                    ...options.keySystems[0],
                    configurations: [
                        {
                            audioCapabilities: [
                                {
                                    contentType: 'audio/mp4; codecs="mp4a.40.2"',
                                    encryptionScheme: 'cenc',
                                },
                            ],
                        },
                        {
                            audioCapabilities: [
                                {
                                    contentType: 'audio/mp4; codecs="mp4a.40.2"',
                                    encryptionScheme: 'cbcs',
                                },
                            ],
                        },
                    ],
                },
            ],
        };
        const pending = playHlsWithDrm(
            media,
            (async function* () {
                yield unit(0);
            })(),
            configured,
        );
        pending.catch(() => {});
        await Promise.race([complete(media, pending), pending]);
        assert.equal(requests.length, 1);
    });
    test('encrypted event during clear lead survives until EME selection', async () => {
        const append = SourceBuffer.prototype.appendBuffer;
        SourceBuffer.prototype.appendBuffer = function (data) {
            append.call(this, data);
            if (this.appends.length === 1) {
                const event = new Event('encrypted');
                Object.assign(event, { initDataType: 'cenc', initData: makePssh(1).buffer });
                currentMedia.dispatchEvent(event);
            }
            if (this.appends.length === 3)
                queueMicrotask(() => currentMedia.dispatchEvent(new Event('waitingforkey')));
        };
        try {
            const media = new Media();
            const plain = unit(0);
            delete plain.encryption;
            delete plain.part.key;
            plain.part.keys = [];
            plain.initData = new Uint8Array([...initData, ...makePssh(1)]);
            const protectedKey = { ...key(1), uri: 'https://example.test/widevine' };
            const encrypted = unit(1, protectedKey);
            const pending = playHlsWithDrm(
                media,
                (async function* () {
                    yield plain;
                    yield encrypted;
                })(),
                { ...options, keyTimeoutMs: 10000, operationTimeoutMs: 10000 },
            );
            pending.catch(() => {});
            await until(() => source?.ended);
            assert.equal(
                sessions.length,
                1,
                'no session was created from the sole browser initialization event',
            );
            await complete(media, pending);
        } finally {
            SourceBuffer.prototype.appendBuffer = append;
        }
    });

    test('paused playback survives a resolved waitingforkey interval', async () => {
        await new Promise(resolve => setTimeout(resolve, 25));
        let resolveLicense;
        const configured = {
            ...options,
            keyTimeoutMs: 15,
            keySystems: [
                {
                    ...options.keySystems[0],
                    license: () =>
                        new Promise(resolve => {
                            resolveLicense = resolve;
                        }),
                },
            ],
        };
        const media = new Media();
        let failure;
        const pending = playHlsWithDrm(
            media,
            (async function* () {
                yield unit(0);
            })(),
            configured,
        );
        pending.catch(error => {
            failure = error;
        });
        await until(() => source?.ended && resolveLicense);
        media.readyState = 2;
        media.dispatchEvent(new Event('waitingforkey'));
        media.paused = true;
        media.dispatchEvent(new Event('pause'));
        resolveLicense(Uint8Array.of(4));
        await until(() => sessions[0]?.license);
        sessions[0].keyStatuses.set(Uint8Array.of(1).buffer, 'usable');
        sessions[0].dispatchEvent(new Event('keystatuseschange'));
        media.readyState = 4;
        media.dispatchEvent(new Event('canplay'));
        await new Promise(resolve => setTimeout(resolve, 25));
        if (failure) throw failure;
        await complete(media, pending);
    });
    test('callback getters and original receivers survive setup', async () => {
        let licenseReads = 0,
            initReads = 0,
            calls = 0;
        const system = {
            keySystem: 'com.widevine.alpha',
            get license() {
                licenseReads++;
                return function () {
                    assert.equal(this, system);
                    calls++;
                    return Uint8Array.of(4);
                };
            },
            get getInitData() {
                initReads++;
                return function () {
                    assert.equal(this, system);
                    return { type: 'cenc', data: makePssh(2) };
                };
            },
        };
        const media = new Media();
        await complete(
            media,
            playHlsWithDrm(
                media,
                (async function* () {
                    yield unit(0);
                })(),
                { keySystems: [system] },
            ),
        );
        assert.equal(licenseReads, 1);
        assert.equal(initReads, 1);
        assert.equal(calls, 1);
    });
    test('uncooperative init data callback is cancelled and media keys detach', async () => {
        let callbackSignal;
        const stop = new AbortController();
        const media = new Media();
        const configured = {
            ...options,
            signal: stop.signal,
            keySystems: [
                {
                    ...options.keySystems[0],
                    getInitData(request) {
                        callbackSignal = request.signal;
                        return new Promise(() => {});
                    },
                },
            ],
        };
        const pending = playHlsWithDrm(
            media,
            (async function* () {
                yield unit(0);
            })(),
            configured,
        );
        await until(() => callbackSignal);
        stop.abort();
        await assert.rejects(pending, error => error.code === 'ABORT');
        assert.equal(callbackSignal.aborted, true);
        assert.equal(media.mediaKeys, null);
    });
    test('uncooperative init data callback has an attach deadline', async () => {
        const media = new Media();
        const configured = {
            ...options,
            eme: { attachTimeoutMs: 10 },
            keySystems: [
                {
                    ...options.keySystems[0],
                    getInitData() {
                        return new Promise(() => {});
                    },
                },
            ],
        };
        await assert.rejects(
            playHlsWithDrm(
                media,
                (async function* () {
                    yield unit(0);
                })(),
                configured,
            ),
            error => error.code === 'IO' && /timed out/.test(error.message),
        );
        assert.equal(media.mediaKeys, null);
    });

    test('MAP KEYFORMAT alternatives survive METHOD=NONE before media', async () => {
        const configured = {
            keySystems: [...options.keySystems, { keySystem: 'com.apple.fps', license }],
            mimeType: 'audio/mp4; codecs="mp4a.40.2"',
        };
        const sourceUnit = unit(0);
        const playlist =
            '#EXTM3U\n#EXT-X-TARGETDURATION:1\n' +
            `#EXT-X-KEY:METHOD=SAMPLE-AES,KEYFORMAT="${format}",URI="${key(1).uri}"\n` +
            '#EXT-X-KEY:METHOD=SAMPLE-AES,KEYFORMAT="com.apple.streamingkeydelivery",' +
            'URI="skd:asset"\n' +
            '#EXT-X-MAP:URI="init.mp4"\n' +
            '#EXT-X-KEY:METHOD=NONE\n' +
            '#EXTINF:1,\n' +
            'media.m4s\n' +
            '#EXT-X-ENDLIST\n';
        const client = new HlsClient({
            encryptionHandlers: [createHlsDrmHandler(configured)],
            fetch: async uri => {
                const path = new URL(uri).pathname;
                return new Response(
                    path.endsWith('index.m3u8')
                        ? playlist
                        : path.endsWith('init.mp4')
                          ? initData
                          : sourceUnit.data,
                );
            },
        });
        try {
            await client.load('https://fixture.test/index.m3u8');
            const units = [];
            for await (const item of client.parts()) units.push(item);
            assert.equal(units[0].encryption.keyFormat, format);
            assert.equal(units[0].segment.map.keys.length, 2);
            assert.equal(units[0].segment.keys, undefined);
            rejectSystem = 'com.widevine.alpha';
            const media = new Media();
            const pending = playHlsWithDrm(
                media,
                (async function* () {
                    yield* units;
                })(),
                configured,
            );
            pending.catch(() => {});
            await Promise.race([complete(media, pending), pending]);
            assert.deepEqual(
                requests.map(item => item.system),
                ['com.widevine.alpha', 'com.apple.fps'],
            );
        } finally {
            client.close();
        }
    });

    test('abort before late MediaKeys completion releases its attachment', async () => {
        const original = Media.prototype.setMediaKeys;
        let release;
        const stop = new AbortController();
        const media = new Media();
        Media.prototype.setMediaKeys = function (keys) {
            if (keys)
                return new Promise(resolve => {
                    release = () => {
                        this.mediaKeys = keys;
                        resolve();
                    };
                });
            this.mediaKeys = null;
            return Promise.resolve();
        };
        try {
            const pending = playHlsWithDrm(
                media,
                (async function* () {
                    yield unit(0);
                })(),
                { ...options, signal: stop.signal },
            );
            await until(() => release);
            stop.abort();
            await assert.rejects(pending, error => error.code === 'ABORT');
            release();
            await until(() => media.mediaKeys === null);
        } finally {
            Media.prototype.setMediaKeys = original;
        }
    });
    test('filtered scheme cannot silently discard a required track', async () => {
        const configured = {
            keySystems: [
                {
                    keySystem: 'test.incompatible',
                    keyFormats: [format],
                    license,
                    configurations: [
                        {
                            audioCapabilities: [
                                {
                                    contentType: 'audio/mp4; codecs="mp4a.40.2"',
                                    encryptionScheme: 'cbcs',
                                },
                            ],
                            videoCapabilities: [
                                {
                                    contentType: 'video/mp4; codecs="avc1.42e01e"',
                                    encryptionScheme: 'cenc',
                                },
                            ],
                        },
                    ],
                },
                ...options.keySystems,
            ],
        };
        const media = new Media();
        await complete(
            media,
            playHlsWithDrm(
                media,
                (async function* () {
                    yield unit(0);
                })(),
                configured,
            ),
        );
        assert.deepEqual(
            requests.map(item => item.system),
            ['com.widevine.alpha'],
        );
    });
    test('early initialization is copied and duplicate events are deduplicated', async () => {
        const append = SourceBuffer.prototype.appendBuffer;
        SourceBuffer.prototype.appendBuffer = function (data) {
            append.call(this, data);
            if (this.appends.length !== 1) return;
            const bytes = makePssh(77);
            const event = new Event('encrypted');
            Object.assign(event, { initDataType: 'cenc', initData: bytes.buffer });
            currentMedia.dispatchEvent(event);
            currentMedia.dispatchEvent(event);
            bytes.fill(0);
        };
        try {
            const media = new Media();
            const plain = unit(0);
            delete plain.encryption;
            delete plain.part.key;
            plain.part.keys = [];
            const pending = playHlsWithDrm(
                media,
                (async function* () {
                    yield plain;
                    yield unit(1, { ...key(1), uri: 'https://example.test/key' });
                })(),
                options,
            );
            await complete(media, pending);
            assert.equal(sessions.length, 1);
            assert.deepEqual(sessions[0].init, makePssh(77));
        } finally {
            SourceBuffer.prototype.appendBuffer = append;
        }
    });
    after(() => {
        if (saved.navigator) Object.defineProperty(globalThis, 'navigator', saved.navigator);
        else delete globalThis.navigator;
        globalThis.MediaSource = saved.MediaSource;
        URL.createObjectURL = saved.create;
        URL.revokeObjectURL = saved.revoke;
    });
});
