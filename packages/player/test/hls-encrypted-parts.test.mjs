import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { HlsClient } from 'mediaforgejs-player';

// AES-128 partial segments of two variants, one of them packed into byte ranges, decrypted
// while the client switches between them.

describe('the HLS client: encrypted partial segments', () => {
    const encrypt = (bytes, key, iv) => {
        const cipher = createCipheriv('aes-128-cbc', key, iv);
        return Buffer.concat([cipher.update(bytes), cipher.final()]);
    };
    const resources = new Map();
    const plaintext = new Map();
    const playlists = new Map();
    const master =
        '#EXTM3U\n' +
        '#EXT-X-STREAM-INF:BANDWIDTH=100000,CODECS="avc1.42e01e"\n' +
        'low.m3u8\n' +
        '#EXT-X-STREAM-INF:BANDWIDTH=400000,CODECS="avc1.42e01e"\n' +
        'high.m3u8\n';
    playlists.set('master.m3u8', master);
    for (const [name, sequence, marker] of [
        ['low', 0, 1],
        ['high', 100, 2],
    ]) {
        const mapKey = Buffer.alloc(16, 120 + marker);
        const mapIv = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
        resources.set(`${name}-map.key`, mapKey);
        const init = Buffer.from(`${name} init`);
        plaintext.set(`${name}-init`, init);
        resources.set(`${name}-init.mp4`, encrypt(init, mapKey, mapIv));
        let text =
            '#EXTM3U\n' +
            '#EXT-X-TARGETDURATION:2\n' +
            '#EXT-X-PART-INF:PART-TARGET=0.5\n' +
            `#EXT-X-MEDIA-SEQUENCE:${sequence}\n` +
            '#EXT-X-PROGRAM-DATE-TIME:2026-01-01T00:00:00Z\n';
        for (let group = 0; group < 2; group++) {
            if (group) text += '#EXT-X-DISCONTINUITY\n';
            text +=
                `#EXT-X-KEY:METHOD=AES-128,URI="${name}-map.key",` +
                'IV=0x00112233445566778899aabbccddeeff\n' +
                `#EXT-X-MAP:URI="${name}-init.mp4"\n`;
            const key = Buffer.alloc(16, marker * 10 + group);
            resources.set(`${name}-${group}.key`, key);
            text += `#EXT-X-KEY:METHOD=AES-128,URI="${name}-${group}.key"\n`;
            const iv = Buffer.alloc(16);
            iv.writeBigUInt64BE(BigInt(sequence + group), 8);
            let offset = 7;
            const encryptedParts = [Buffer.alloc(7, 0xee)];
            for (let part = 0; part < 4; part++) {
                const ordinal = group * 4 + part;
                const bytes = Buffer.alloc(12501, ordinal + 33);
                bytes[0] = ordinal;
                bytes[1] = marker;
                plaintext.set(`${name}-${ordinal}`, bytes);
                const encrypted = encrypt(bytes, key, iv);
                encryptedParts.push(encrypted);
                const uri = name === 'high' ? `high-packed-${group}.bin` : `low-${ordinal}.m4s`;
                if (name === 'low') resources.set(uri, encrypted);
                const start = part ? '' : `@${offset}`;
                const byteRange = name === 'high' ? `,BYTERANGE="${encrypted.length}${start}"` : '';
                text += `#EXT-X-PART:DURATION=0.5,URI="${uri}",INDEPENDENT=YES${byteRange}\n`;
                offset += encrypted.length;
            }
            resources.set(`${name}-packed-${group}.bin`, Buffer.concat(encryptedParts));
            text += `#EXTINF:2,\n${name}-full-${group}.m4s\n`;
        }
        playlists.set(`${name}.m3u8`, text + '#EXT-X-ENDLIST\n');
    }
    const previousPerformance = globalThis.performance;
    let now = 0;
    before(() =>
        Object.defineProperty(globalThis, 'performance', {
            configurable: true,
            value: { now: () => now },
        }),
    );
    after(() =>
        Object.defineProperty(globalThis, 'performance', {
            configurable: true,
            value: previousPerformance,
        }),
    );
    const NAMES = {
        success: 'encrypted PARTs decrypt across an up-switch to a variant of packed ranges',
        candidate: 'a variant whose PARTs do not decrypt is not switched to, with a warning',
        active: 'a PART of the active variant that does not decrypt stops with DECODE',
        callback: 'a failing onVariantChange stops the iteration with its error',
    };
    for (const scenario of ['success', 'candidate', 'active', 'callback'])
        test(NAMES[scenario], async () => {
            const requests = [],
                changes = [],
                units = [];
            const failure = new Error('encrypted PART listener failed');
            const client = new HlsClient({
                adaptive:
                    scenario === 'active'
                        ? false
                        : {
                              upSwitchSegments: 1,
                              onVariantChange(event) {
                                  changes.push(event);
                                  if (event.reason === 'up') {
                                      assert(requests.includes('high-init.mp4'));
                                      assert(requests.includes('high-packed-0.bin'));
                                      if (scenario === 'callback') throw failure;
                                  }
                              },
                          },
                fetch: async (url, options) => {
                    const name = new URL(url).pathname.slice(1);
                    requests.push(name);
                    if (playlists.has(name)) return new Response(playlists.get(name));
                    now += 25;
                    if (scenario === 'active' && name === 'low-1.m4s')
                        return new Response(Uint8Array.of(1));
                    const bytes = resources.get(name);
                    assert(bytes, name);
                    const range = options.headers?.Range;
                    if (range) {
                        const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(range);
                        const payload =
                            scenario === 'candidate'
                                ? Buffer.alloc(+end - +start + 1)
                                : bytes.subarray(+start, +end + 1);
                        return new Response(payload, {
                            status: 206,
                            headers: { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` },
                        });
                    }
                    return new Response(bytes);
                },
            });
            try {
                await client.load(
                    `https://encrypted-parts.test/${scenario === 'active' ? 'low' : 'master'}.m3u8`,
                );
                const iterator = client.parts();
                units.push((await iterator.next()).value);
                if (scenario === 'active' || scenario === 'callback') {
                    await assert.rejects(iterator.next(), error =>
                        scenario === 'active' ? error.code === 'DECODE' : error === failure,
                    );
                    assert(!requests.includes('low-full-0.m4s'));
                    return;
                }
                for await (const unit of iterator) units.push(unit);
                assert.equal(units.length, 8);
                for (let index = 0; index < units.length; index++) {
                    const name = scenario === 'success' && index ? 'high' : 'low';
                    assert.deepEqual(
                        Buffer.from(units[index].data),
                        plaintext.get(`${name}-${index}`),
                    );
                    assert.equal(units[index].partIndex, index % 4);
                    assert.equal(units[index].discontinuitySequence, index < 4 ? 0 : 1);
                    if (units[index].initData)
                        assert.deepEqual(
                            Buffer.from(units[index].initData),
                            plaintext.get(`${name}-init`),
                        );
                }
                assert.deepEqual(
                    changes.map(event => event.reason),
                    scenario === 'success' ? ['initial', 'up'] : ['initial'],
                );
                assert(units[0].initData);
                assert(units[4].initData);
                assert(!requests.some(name => name.includes('-full-')));
                if (scenario === 'candidate')
                    assert(
                        client.diagnostics.some(
                            warning => warning.code === 'HLS_ADAPTIVE_UNAVAILABLE',
                        ),
                    );
                else assert.equal(units[1].sequence, 100);
            } finally {
                client.close();
            }
        });
});
