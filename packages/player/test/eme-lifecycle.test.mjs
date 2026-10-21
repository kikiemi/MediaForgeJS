import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MediaForgeError } from 'mediaforgejs';
import { EmeController } from 'mediaforgejs-player';

describe('the EME controller', () => {
    function deferred() {
        let resolve, reject;
        const promise = new Promise((yes, no) => {
            resolve = yes;
            reject = no;
        });
        return { promise, resolve, reject };
    }
    const tick = () => new Promise(resolve => setTimeout(resolve, 0));
    // Deadlines a test means to pass are a few hundred milliseconds: every step before the one
    // that times out must finish within it, which a few milliseconds cannot promise on a loaded
    // machine. Deadlines a test does not mean to reach are far away.
    const DEADLINE_MS = 200;
    const NEVER_MS = 60000;
    /** Settles with the promise, or with `{ pending: true }` when it hangs. */
    async function bounded(promise, timeout = 5000) {
        let timer;
        try {
            return await Promise.race([
                promise,
                new Promise(resolve => {
                    timer = setTimeout(() => resolve({ pending: true }), timeout);
                }),
            ]);
        } finally {
            clearTimeout(timer);
        }
    }
    class Session extends EventTarget {
        sessionId = 'session-1';
        keyStatuses = new Map();
        expiration = NaN;
        closure = deferred();
        closed = this.closure.promise;
        updates = [];
        closeCount = 0;
        generateRequest(type, data) {
            this.generated = [type, new Uint8Array(data)];
            return Promise.resolve();
        }
        update(data) {
            this.updates.push(new Uint8Array(data));
            return Promise.resolve();
        }
        close() {
            this.closeCount++;
            this.closure.resolve();
            return Promise.resolve();
        }
        message(type = 'license-request', bytes = Uint8Array.of(1)) {
            const event = new Event('message');
            event.messageType = type;
            event.message = bytes.buffer.slice(
                bytes.byteOffset,
                bytes.byteOffset + bytes.byteLength,
            );
            this.dispatchEvent(event);
        }
    }
    function model(overrides = {}) {
        const calls = [];
        const selected = {
            initDataTypes: ['cenc'],
            sessionTypes: ['temporary'],
            videoCapabilities: [{ contentType: 'video/mp4;codecs="avc1.64001f"', robustness: '' }],
        };
        const sessions = [];
        const keys = {
            createSession(type) {
                assert.equal(type, 'temporary');
                calls.push('session');
                const session = new Session();
                sessions.push(session);
                return session;
            },
            setServerCertificate(bytes) {
                calls.push(['certificate', new Uint8Array(bytes)]);
                return Promise.resolve(true);
            },
        };
        const access = {
            keySystem: 'org.example.test',
            getConfiguration() {
                return selected;
            },
            createMediaKeys() {
                return Promise.resolve(keys);
            },
        };
        class Element extends EventTarget {
            mediaKeys = null;
            setMediaKeys(next) {
                calls.push(next ? 'attach' : 'detach');
                this.mediaKeys = next;
                return Promise.resolve();
            }
        }
        const element = new Element();
        const request = {
            requestMediaKeySystemAccess(keySystem) {
                assert.equal(keySystem, access.keySystem);
                return Promise.resolve(access);
            },
        };
        const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
        Object.defineProperty(globalThis, 'navigator', { configurable: true, value: request });
        const options = {
            keySystem: access.keySystem,
            configurations: [{ initDataTypes: ['cenc'] }],
            license: () => Uint8Array.of(7),
            ...overrides,
        };
        return {
            calls,
            selected,
            sessions,
            keys,
            access,
            element,
            request,
            options,
            restore() {
                if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor);
                else delete globalThis.navigator;
            },
        };
    }
    async function run(overrides, callback) {
        const m = model(overrides);
        let controller;
        try {
            controller = await EmeController.attach(m.element, m.options);
            await callback(m, controller);
        } finally {
            if (controller) await controller.close().catch(() => {});
            m.restore();
        }
    }

    test('selected configuration is copied at acquisition and on every getter', async () => {
        await run({}, async (m, controller) => {
            const first = controller.configuration;
            first.initDataTypes[0] = 'mutated';
            first.videoCapabilities[0].contentType = 'mutated';
            m.selected.videoCapabilities[0].robustness = 'mutated';
            assert.deepEqual(controller.configuration.initDataTypes, ['cenc']);
            assert.equal(
                controller.configuration.videoCapabilities[0].contentType,
                'video/mp4;codecs="avc1.64001f"',
            );
            assert.equal(controller.configuration.videoCapabilities[0].robustness, '');
        });
    });

    for (const stage of ['access', 'keys', 'certificate', 'attachment']) {
        test(`attach deadline bounds a never-settling ${stage} promise`, async () => {
            const abort = new AbortController();
            const m = model({
                attachTimeoutMs: DEADLINE_MS,
                signal: abort.signal,
                ...(stage === 'certificate' ? { serverCertificate: Uint8Array.of(3) } : {}),
            });
            const pending = new Promise(() => {});
            if (stage === 'access') m.request.requestMediaKeySystemAccess = () => pending;
            if (stage === 'keys') m.access.createMediaKeys = () => pending;
            if (stage === 'certificate') m.keys.setServerCertificate = () => pending;
            if (stage === 'attachment') m.element.setMediaKeys = () => pending;
            const attaching = EmeController.attach(m.element, m.options).then(
                value => ({ value }),
                error => ({ error }),
            );
            try {
                const result = await bounded(attaching);
                assert.equal(result.error?.code, 'IO');
                assert.match(result.error.message, /timed out/i);
            } finally {
                abort.abort();
                await attaching;
                m.restore();
            }
        });
    }

    test(
        'server certificate is copied before asynchronous setup and precedes every ' + 'session',
        async () => {
            const certificate = Uint8Array.of(8, 9);
            const m = model({ serverCertificate: certificate });
            let controller;
            try {
                const attaching = EmeController.attach(m.element, m.options);
                certificate.fill(0);
                controller = await attaching;
                await controller.addSession('cenc', Uint8Array.of(2));
                assert.deepEqual(m.calls, [
                    ['certificate', Uint8Array.of(8, 9)],
                    'attach',
                    'session',
                ]);
            } finally {
                await controller?.close();
                m.restore();
            }
        },
    );

    test('unsupported or rejected supplied certificate fails before attachment', async () => {
        for (const result of [false, new Error('certificate rejected')]) {
            const m = model({ serverCertificate: Uint8Array.of(8) });
            m.keys.setServerCertificate = () =>
                result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
            try {
                await assert.rejects(
                    EmeController.attach(m.element, m.options),
                    error => error.code === 'IO',
                );
                assert.equal(m.element.mediaKeys, null);
            } finally {
                m.restore();
            }
        }
    });

    test(
        'temporary sessions exchange renewal messages in order with original options ' + 'receiver',
        async () => {
            const seen = [];
            const options = {
                license(request) {
                    assert.equal(this, options);
                    seen.push(request.messageType);
                    return Uint8Array.of(request.message[0] + 1);
                },
            };
            const m = model(options);
            Object.assign(options, m.options);
            let controller;
            try {
                controller = await EmeController.attach(m.element, options);
                const session = await controller.addSession('cenc', Uint8Array.of(2));
                session.message('license-request', Uint8Array.of(4));
                session.message('license-renewal', Uint8Array.of(5));
                await tick();
                assert.deepEqual(seen, ['license-request', 'license-renewal']);
                assert.deepEqual(session.updates, [Uint8Array.of(5), Uint8Array.of(6)]);
            } finally {
                await controller?.close();
                m.restore();
            }
        },
    );

    test(
        'status callback receives fresh byte snapshots and retains original ' + 'receiver',
        async () => {
            const changes = [];
            const options = {
                onKeyStatusesChange(change) {
                    assert.equal(this, options);
                    changes.push(change);
                },
            };
            const m = model(options);
            Object.assign(options, m.options);
            let controller;
            try {
                controller = await EmeController.attach(m.element, options);
                const session = await controller.addSession('cenc', Uint8Array.of(2));
                const keyId = Uint8Array.of(1, 2);
                session.keyStatuses.set(keyId.buffer, 'usable');
                session.dispatchEvent(new Event('keystatuseschange'));
                assert.equal(changes.length, 1);
                assert.equal(changes[0].keySystem, m.options.keySystem);
                assert.equal(changes[0].sessionId, session.sessionId);
                assert.deepEqual(changes[0].statuses, [
                    { keyId: Uint8Array.of(1, 2), status: 'usable' },
                ]);
                changes[0].statuses[0].keyId[0] = 77;
                assert.deepEqual(keyId, Uint8Array.of(1, 2));
                session.dispatchEvent(new Event('keystatuseschange'));
                assert.deepEqual(changes[1].statuses[0].keyId, Uint8Array.of(1, 2));
                await controller.close();
                session.dispatchEvent(new Event('keystatuseschange'));
                assert.equal(changes.length, 2);
            } finally {
                await controller?.close();
                m.restore();
            }
        },
    );

    test(
        'status failure retains first error despite throwing notification and ' + 'cleanup',
        async () => {
            const primary = new Error('primary status failure');
            let notified;
            await run(
                {
                    onKeyStatusesChange() {
                        throw primary;
                    },
                    onError(error) {
                        notified = error;
                        throw new Error('notification failed');
                    },
                },
                async (m, controller) => {
                    const first = await controller.addSession('cenc', Uint8Array.of(1));
                    const second = await controller.addSession('cenc', Uint8Array.of(2));
                    first.removeEventListener = () => {
                        throw new Error('listener cleanup failed');
                    };
                    first.close = () => {
                        first.closeCount++;
                        throw new Error('close failed');
                    };
                    first.dispatchEvent(new Event('keystatuseschange'));
                    const result = await bounded(
                        controller.done.then(
                            () => ({}),
                            error => ({ error }),
                        ),
                    );
                    assert.equal(result.error?.message, 'EME failed: primary status failure');
                    assert.equal(controller.failure, notified);
                    assert.equal(first.closeCount, 1);
                    assert.equal(second.closeCount, 1);
                    await controller.close();
                    assert.equal(m.element.mediaKeys, null);
                },
            );
        },
    );

    test('license callbacks may close reentrantly without applying their response', async () => {
        let controller;
        await run(
            {
                license() {
                    void controller.close();
                    return Uint8Array.of(9);
                },
            },
            async (_m, current) => {
                controller = current;
                const session = await controller.addSession('cenc', Uint8Array.of(2));
                session.message();
                await tick();
                assert.deepEqual(session.updates, []);
                assert.equal(session.closeCount, 1);
                assert.equal(controller.failure, null);
            },
        );
    });

    test('license timeout rejects done despite an uncooperative callback', async () => {
        await run(
            { licenseTimeoutMs: DEADLINE_MS, license: () => new Promise(() => {}) },
            async (_m, controller) => {
                const session = await controller.addSession('cenc', Uint8Array.of(2));
                session.message();
                const result = await bounded(
                    controller.done.then(
                        () => ({}),
                        error => ({ error }),
                    ),
                );
                assert.equal(result.error?.code, 'IO');
                assert.equal(session.closeCount, 1);
            },
        );
    });

    test('aborted late attachment detaches only its owned keys', async () => {
        for (const replace of [false, true]) {
            const abort = new AbortController();
            const m = model({ signal: abort.signal });
            const attached = deferred();
            const started = deferred();
            let detachCount = 0;
            const foreign = {};
            m.element.setMediaKeys = async next => {
                if (next) {
                    started.resolve();
                    await attached.promise;
                    m.element.mediaKeys = replace ? foreign : next;
                } else {
                    detachCount++;
                    m.element.mediaKeys = null;
                }
            };
            try {
                const attaching = EmeController.attach(m.element, m.options);
                await started.promise;
                abort.abort();
                await assert.rejects(attaching, error => error.code === 'ABORT');
                attached.resolve();
                await tick();
                assert.equal(m.element.mediaKeys, replace ? foreign : null);
                assert.equal(detachCount, replace ? 0 : 1);
            } finally {
                attached.resolve();
                m.restore();
            }
        }
    });

    test('preselected access is used once with its own method receivers', async () => {
        const m = model();
        let reads = 0;
        const raw = m.access.createMediaKeys;
        Object.defineProperty(m.access, 'createMediaKeys', {
            get() {
                reads++;
                assert.equal(this, m.access);
                return function () {
                    assert.equal(this, m.access);
                    return raw.call(this);
                };
            },
        });
        m.request.requestMediaKeySystemAccess = () => {
            throw new Error('duplicate capability request');
        };
        m.options.keySystemAccess = m.access;
        let controller;
        try {
            controller = await EmeController.attach(m.element, m.options);
            assert.equal(reads, 1);
        } finally {
            await controller?.close();
            m.restore();
        }
    });

    test(
        'close deadline stops waiting for detach while late cleanup preserves ' + 'ownership',
        async () => {
            await run({ attachTimeoutMs: DEADLINE_MS }, async (m, controller) => {
                const detached = deferred();
                m.element.setMediaKeys = async next => {
                    assert.equal(next, null);
                    await detached.promise;
                    m.element.mediaKeys = null;
                };
                try {
                    const closing = controller.close();
                    const result = await bounded(
                        closing.then(
                            () => ({}),
                            error => ({ error }),
                        ),
                    );
                    assert.equal(result.error?.code, 'IO');
                    assert.match(result.error.message, /timed out/i);
                    await assert.rejects(
                        EmeController.attach(m.element, m.options),
                        error => error.code === 'IO',
                    );
                } finally {
                    detached.resolve();
                }
                await tick();
                assert.equal(m.element.mediaKeys, null);
            });
        },
    );

    test('configuration getters use their original receivers exactly once', async () => {
        const m = model();
        const counts = new Map();
        const configuration = {};
        const capability = {};
        const options = Object.create(null);
        const define = (target, key, value) =>
            Object.defineProperty(target, key, {
                get() {
                    assert.equal(this, target);
                    counts.set(key, (counts.get(key) ?? 0) + 1);
                    return value;
                },
            });
        define(capability, 'contentType', 'video/mp4');
        define(capability, 'robustness', 'software');
        define(configuration, 'videoCapabilities', [capability]);
        for (const [key, value] of Object.entries({
            ...m.options,
            configurations: [configuration],
            attachTimeoutMs: NEVER_MS,
            serverCertificate: Uint8Array.of(1),
            onKeyStatusesChange() {},
        }))
            define(options, key, value);
        m.request.requestMediaKeySystemAccess = async (_keySystem, configurations) => {
            assert.equal(configurations[0].videoCapabilities[0].contentType, 'video/mp4');
            return m.access;
        };
        let controller;
        try {
            controller = await EmeController.attach(m.element, options);
            assert([...counts.values()].every(value => value === 1));
            assert.equal(counts.size, 9);
        } finally {
            await controller?.close();
            m.restore();
        }
    });

    test('new EME options reject invalid values before native acquisition', async () => {
        for (const invalid of [
            { attachTimeoutMs: 0 },
            { attachTimeoutMs: 0x80000000 },
            { serverCertificate: new Uint8Array() },
            { serverCertificate: new Uint16Array([1]) },
            { onKeyStatusesChange: 1 },
            {
                keySystemAccess: {
                    keySystem: 'wrong',
                    getConfiguration() {},
                    createMediaKeys() {},
                },
            },
        ]) {
            const m = model(invalid);
            let requested = 0;
            m.request.requestMediaKeySystemAccess = () => {
                requested++;
                throw new Error('must validate first');
            };
            try {
                await assert.rejects(
                    EmeController.attach(m.element, m.options),
                    error => error.code === 'INPUT',
                );
                assert.equal(requested, 0);
            } finally {
                m.restore();
            }
        }
    });

    test(
        'license deadline includes a stalled session update and keeps its first ' + 'failure',
        async () => {
            await run(
                {
                    licenseTimeoutMs: DEADLINE_MS,
                    attachTimeoutMs: DEADLINE_MS,
                    onError() {
                        throw new Error('secondary callback failure');
                    },
                },
                async (m, controller) => {
                    const session = await controller.addSession('cenc', Uint8Array.of(1));
                    session.update = () => new Promise(() => {});
                    m.element.setMediaKeys = () =>
                        Promise.reject(new Error('secondary detach failure'));
                    session.message();
                    const result = await bounded(
                        controller.done.then(
                            () => ({}),
                            error => ({ error }),
                        ),
                    );
                    assert.equal(result.error?.code, 'IO');
                    assert.match(result.error.message, /license exchange timed out/);
                    await assert.rejects(controller.close(), error => error === result.error);
                },
            );
        },
    );

    test('a session that finishes generation after abort is closed once', async () => {
        const abort = new AbortController();
        await run({ signal: abort.signal }, async (m, controller) => {
            const generation = deferred();
            const started = deferred();
            const session = new Session();
            session.generateRequest = () => {
                started.resolve();
                return generation.promise;
            };
            m.keys.createSession = () => session;
            const ready = controller.addSession('cenc', Uint8Array.of(1));
            await started.promise;
            abort.abort();
            await assert.rejects(ready, error => error.code === 'ABORT');
            await assert.rejects(controller.done, error => error.code === 'ABORT');
            assert.equal(session.closeCount, 0);
            generation.resolve();
            await tick();
            assert.equal(session.closeCount, 1);
        });
    });

    test(
        'status callback may close and reenter a released session without more ' + 'callbacks',
        async () => {
            let controller;
            let session;
            let count = 0;
            await run(
                {
                    onKeyStatusesChange() {
                        count++;
                        void controller.close();
                        session.dispatchEvent(new Event('keystatuseschange'));
                    },
                },
                async (_m, current) => {
                    controller = current;
                    session = await controller.addSession('cenc', Uint8Array.of(1));
                    session.dispatchEvent(new Event('keystatuseschange'));
                    await controller.done;
                    assert.equal(count, 1);
                    assert.equal(controller.failure, null);
                    assert.equal(session.closeCount, 1);
                },
            );
        },
    );

    test(
        'configuration array accessors are validated from the same single snapshot that is ' +
            'used',
        async () => {
            const m = model();
            let reads = 0;
            const types = [];
            Object.defineProperty(types, 0, {
                get() {
                    reads++;
                    return reads === 1 ? 'cenc' : 42;
                },
            });
            m.options.configurations = [{ initDataTypes: types }];
            m.request.requestMediaKeySystemAccess = async (_system, configurations) => {
                assert.deepEqual(configurations[0].initDataTypes, ['cenc']);
                return m.access;
            };
            let controller;
            try {
                controller = await EmeController.attach(m.element, m.options);
                assert.equal(reads, 1);
            } finally {
                await controller?.close();
                m.restore();
            }
        },
    );

    test('status key ID snapshots use native view ranges despite shadowed properties', async () => {
        let change;
        await run(
            {
                onKeyStatusesChange(value) {
                    change = value;
                },
            },
            async (_m, controller) => {
                const session = await controller.addSession('cenc', Uint8Array.of(1));
                const storage = Uint8Array.of(0, 4, 5, 0);
                for (const view of [storage.subarray(1, 3), new DataView(storage.buffer, 1, 2)]) {
                    Object.defineProperties(view, {
                        buffer: { value: new ArrayBuffer(0) },
                        byteOffset: { value: 0 },
                        byteLength: { value: 0 },
                    });
                    session.keyStatuses.clear();
                    session.keyStatuses.set(view, 'usable');
                    session.dispatchEvent(new Event('keystatuseschange'));
                    assert.deepEqual(change.statuses[0].keyId, Uint8Array.of(4, 5));
                }
            },
        );
    });

    test('encrypted event getters are captured once before session creation', async () => {
        await run({}, async (m, controller) => {
            let dataReads = 0;
            let typeReads = 0;
            const event = new Event('encrypted');
            Object.defineProperties(event, {
                initData: {
                    get() {
                        assert.equal(++dataReads, 1);
                        return Uint8Array.of(3).buffer;
                    },
                },
                initDataType: {
                    get() {
                        assert.equal(++typeReads, 1);
                        return 'cenc';
                    },
                },
            });
            m.element.dispatchEvent(event);
            await tick();
            assert.equal(controller.failure, null);
            assert.equal(controller.sessionCount, 1);
            assert.deepEqual(m.sessions[0].generated, ['cenc', Uint8Array.of(3)]);
        });
    });

    test('detached encrypted init data fails the controller and releases its keys', async () => {
        let notified;
        const m = model({
            onError(error) {
                notified = error;
            },
        });
        m.element.addEventListener('encrypted', event =>
            structuredClone(event.initData, { transfer: [event.initData] }),
        );
        let controller;
        try {
            controller = await EmeController.attach(m.element, m.options);
            const event = new Event('encrypted');
            event.initData = Uint8Array.of(1, 2).buffer;
            event.initDataType = 'cenc';
            m.element.dispatchEvent(event);
            const result = await bounded(
                controller.done.then(
                    () => ({}),
                    error => ({ error }),
                ),
            );
            assert.equal(result.error?.code, 'IO');
            assert.equal(controller.failure, notified);
            await controller.close();
            assert.equal(m.element.mediaKeys, null);
            assert.equal(m.sessions.length, 0);
        } finally {
            await controller?.close().catch(() => {});
            m.restore();
        }
    });

    const blockPastDeadline = () => {
        const end = performance.now() + 2 * DEADLINE_MS;
        while (performance.now() < end) {}
    };
    for (const stage of ['access', 'keys', 'certificate', 'attachment']) {
        test(
            `attach deadline rejects synchronous ${stage} work that starves its ` + `timer`,
            async () => {
                const m = model({
                    attachTimeoutMs: DEADLINE_MS,
                    ...(stage === 'certificate' ? { serverCertificate: Uint8Array.of(3) } : {}),
                });
                if (stage === 'access')
                    m.request.requestMediaKeySystemAccess = () => {
                        blockPastDeadline();
                        return Promise.resolve(m.access);
                    };
                if (stage === 'keys')
                    m.access.createMediaKeys = () => {
                        blockPastDeadline();
                        return Promise.resolve(m.keys);
                    };
                if (stage === 'certificate')
                    m.keys.setServerCertificate = () => {
                        blockPastDeadline();
                        return Promise.resolve(true);
                    };
                if (stage === 'attachment')
                    m.element.setMediaKeys = next => {
                        if (next) blockPastDeadline();
                        m.element.mediaKeys = next;
                        return Promise.resolve();
                    };
                let controller;
                try {
                    const result = await EmeController.attach(m.element, m.options).then(
                        value => ({ value }),
                        error => ({ error }),
                    );
                    controller = result.value;
                    assert.equal(result.error?.code, 'IO');
                    assert.match(result.error.message, /timed out/);
                    await tick();
                    assert.equal(m.element.mediaKeys, null);
                } finally {
                    await controller?.close().catch(() => {});
                    m.restore();
                }
            },
        );
    }

    for (const stage of ['license', 'update']) {
        test(
            `license deadline rejects synchronous ${stage} work that starves its ` + `timer`,
            async () => {
                await run(
                    {
                        licenseTimeoutMs: DEADLINE_MS,
                        license() {
                            if (stage === 'license') blockPastDeadline();
                            return Uint8Array.of(7);
                        },
                    },
                    async (_m, controller) => {
                        const session = await controller.addSession('cenc', Uint8Array.of(1));
                        if (stage === 'update')
                            session.update = data => {
                                blockPastDeadline();
                                session.updates.push(data);
                                return Promise.resolve();
                            };
                        session.message();
                        const result = await bounded(
                            controller.done.then(
                                () => ({}),
                                error => ({ error }),
                            ),
                        );
                        assert.equal(result.error?.code, 'IO');
                        assert.match(result.error.message, /timed out/);
                        assert.equal(session.updates.length, stage === 'license' ? 0 : 1);
                    },
                );
            },
        );
    }

    test('license timeout is recorded before application abort listeners run', async () => {
        const abort = new AbortController();
        let reason;
        await run(
            {
                signal: abort.signal,
                licenseTimeoutMs: DEADLINE_MS,
                license(request) {
                    request.signal.addEventListener('abort', () => {
                        reason = request.signal.reason;
                        abort.abort();
                    });
                    return new Promise(() => {});
                },
            },
            async (_m, controller) => {
                const session = await controller.addSession('cenc', Uint8Array.of(1));
                session.message();
                await assert.rejects(
                    controller.done,
                    error =>
                        error.code === 'IO' && /license exchange timed out/.test(error.message),
                );
                assert.equal(reason, controller.failure);
                assert.equal(session.closeCount, 1);
            },
        );
    });

    test('close rejects synchronous detach work that starves its timer', async () => {
        await run({ attachTimeoutMs: DEADLINE_MS }, async (m, controller) => {
            m.element.setMediaKeys = next => {
                blockPastDeadline();
                m.element.mediaKeys = next;
                return Promise.resolve();
            };
            await assert.rejects(
                controller.close(),
                error => error.code === 'IO' && /timed out/.test(error.message),
            );
            assert.equal(m.element.mediaKeys, null);
        });
    });

    for (const stage of ['license', 'update']) {
        test(`EME ${stage} preserves a synchronous failure before queued abort`, async () => {
            const primary = new MediaForgeError('earlier CDM failure', 'IO');
            const abort = new AbortController();
            const trigger = () => {
                queueMicrotask(() => abort.abort());
                throw primary;
            };
            await run(
                {
                    signal: abort.signal,
                    license() {
                        return stage === 'license' ? trigger() : Uint8Array.of(7);
                    },
                },
                async (_m, controller) => {
                    const session = await controller.addSession('cenc', Uint8Array.of(1));
                    if (stage === 'update') session.update = trigger;
                    session.message();
                    await assert.rejects(controller.done, error => error === primary);
                },
            );
        });
        test(`EME ${stage} preserves a rejection observed before queued abort`, async () => {
            const primary = new MediaForgeError('earlier asynchronous CDM failure', 'IO');
            const abort = new AbortController();
            const started = deferred();
            const rejected = deferred();
            const trigger = () => {
                started.resolve();
                return rejected.promise;
            };
            await run(
                {
                    signal: abort.signal,
                    license() {
                        return stage === 'license' ? trigger() : Uint8Array.of(7);
                    },
                },
                async (_m, controller) => {
                    const session = await controller.addSession('cenc', Uint8Array.of(1));
                    if (stage === 'update') session.update = trigger;
                    session.message();
                    await started.promise;
                    rejected.reject(primary);
                    queueMicrotask(() => abort.abort());
                    await assert.rejects(controller.done, error => error === primary);
                },
            );
        });
    }
});
