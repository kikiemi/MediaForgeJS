import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { webcrypto } from 'node:crypto';
import { open } from 'mediaforgejs';
import {
    HlsLivePlaylist,
    packageHlsLive,
    parseHlsPlaylist,
    sequenceIv,
} from 'mediaforgejs/streaming';
import { packageMovie } from '../helpers/package-movie.mjs';

// Live HLS: a playlist that slides over the newest segments, and packageHlsLive(), which turns a
// file's segments into playlist updates, encrypted with AES-128 when asked.

const KEY = Uint8Array.from({ length: 16 }, (_, index) => index * 17 + 3);

async function decrypt(data, sequence, iv = sequenceIv(sequence)) {
    const handle = await webcrypto.subtle.importKey('raw', KEY, { name: 'AES-CBC' }, false, [
        'decrypt',
    ]);
    return new Uint8Array(await webcrypto.subtle.decrypt({ name: 'AES-CBC', iv }, handle, data));
}

/** The updates packageHlsLive() gives for the segments of the package movie, and its summary. */
async function liveRun(options) {
    const media = await open(packageMovie());
    try {
        const updates = [];
        const generator = packageHlsLive(media.segments({ targetDuration: 0.16 }), options);
        let result = await generator.next();
        while (!result.done) {
            updates.push(result.value);
            result = await generator.next();
        }
        return { updates, summary: result.value };
    } finally {
        media.close();
    }
}

/** A live playlist of two segments at most, from 2026-01-01T00:00:00Z. */
const window2 = () =>
    new HlsLivePlaylist({ targetDuration: 2, window: 2, programDateTime: '2026-01-01T00:00:00Z' });

describe('package: live HLS', () => {
    describe('HlsLivePlaylist', () => {
        test('slides over the newest segments and returns those it drops', () => {
            const playlist = window2();
            assert.deepEqual(playlist.add('a.m4s', 1.5), []);
            assert.deepEqual(playlist.add('b.m4s', 1.5), []);
            assert.deepEqual(playlist.add('c.m4s', 1.5), ['a.m4s']);
            assert.equal(playlist.sequence, 1);
        });

        test('states the media sequence and each segment date, without an end', () => {
            const playlist = window2();
            for (const name of ['a.m4s', 'b.m4s', 'c.m4s']) playlist.add(name, 1.5);
            const live = playlist.text();
            assert.match(live, /#EXT-X-MEDIA-SEQUENCE:1\n/);
            assert.match(
                live,
                /#EXT-X-PROGRAM-DATE-TIME:2026-01-01T00:00:01\.500Z\n#EXTINF:1\.500000,\nb\.m4s/,
            );
            assert.doesNotMatch(live, /ENDLIST|a\.m4s/);
        });

        test('raises its target duration for a longer segment, with a warning', () => {
            const warnings = [];
            const raised = new HlsLivePlaylist({
                targetDuration: 1,
                onWarning: warning => warnings.push(warning.code),
            });
            raised.add('long.m4s', 2.4);
            assert.equal(raised.targetDuration, 3);
            assert.deepEqual(warnings, ['HLS_TARGET_DURATION_RAISED']);
        });

        test('ends as a VOD playlist and then takes no segment', () => {
            const playlist = window2();
            playlist.add('a.m4s', 1.5);
            assert.match(playlist.end(), /#EXT-X-PLAYLIST-TYPE:VOD[\s\S]*#EXT-X-ENDLIST\n$/);
            assert.throws(() => playlist.add('d.m4s', 1), { code: 'INPUT' });
        });

        test('refuses a VOD type, a negative window and an unreadable date', () => {
            for (const options of [
                { playlistType: 'vod' },
                { window: -1 },
                { programDateTime: 'never' },
            ])
                assert.throws(
                    () => new HlsLivePlaylist(options),
                    { code: 'INPUT' },
                    JSON.stringify(options),
                );
        });
    });

    describe('packageHlsLive()', () => {
        const plain = () => liveRun({ targetDuration: 1, window: 2 });

        test('gives the init segment first, then a keyframe-aligned segment a time', async () => {
            const { updates } = await plain();
            assert.deepEqual([updates[0].files[0].kind, updates[0].segments], ['init', 0]);
            assert.deepEqual(
                updates.slice(1).map(update => update.files.map(file => file.name)),
                [
                    ['segment-00000.m4s', 'index.m3u8'],
                    ['segment-00001.m4s', 'index.m3u8'],
                    ['segment-00002.m4s', 'index.m3u8'],
                ],
            );
        });

        test('slides its window, naming the segments it drops', async () => {
            const media = (await plain()).updates.slice(1);
            assert.deepEqual(
                media.map(update => [update.mediaSequence, update.removed]),
                [
                    [0, []],
                    [0, []],
                    [1, ['segment-00000.m4s']],
                ],
            );
            for (const update of media) {
                const parsed = parseHlsPlaylist(update.playlist, { validation: 'strict' });
                assert.equal(parsed.type, 'media');
                assert.equal(parsed.segments.length, Math.min(2, update.segments));
                assert.doesNotMatch(update.playlist, /ENDLIST/);
            }
        });

        test('ends with a playlist of every segment, its duration and bytes', async () => {
            const { updates, summary } = await plain();
            assert.equal(summary.segments, 3);
            assert.match(summary.playlist, /#EXT-X-ENDLIST\n$/);
            const written = [
                updates[0].files[0],
                ...updates.slice(1).map(update => update.files[0]),
            ];
            assert.equal(
                summary.bytes,
                written.reduce((sum, file) => sum + file.data.length, 0),
            );
            const listed = parseHlsPlaylist(summary.playlist, { validation: 'strict' }).segments;
            assert.equal(listed.length, 3);
            const total = listed.reduce((sum, segment) => sum + segment.duration, 0);
            assert.ok(Math.abs(summary.duration - total) < 1e-5);
        });

        test('an event playlist keeps every segment', async () => {
            const { updates } = await liveRun({
                targetDuration: 1,
                playlistType: 'event',
                window: 1,
            });
            const last = updates.at(-1);
            assert.equal(last.mediaSequence, 0);
            assert.match(last.playlist, /#EXT-X-PLAYLIST-TYPE:EVENT/);
            assert.equal(
                parseHlsPlaylist(last.playlist, { validation: 'strict' }).segments.length,
                3,
            );
        });

        describe('with AES-128', () => {
            const secured = () =>
                liveRun({
                    targetDuration: 1,
                    encryption: {
                        method: 'AES-128',
                        key: KEY,
                        keyUri: 'https://keys.example/live.bin',
                        keyFile: 'live.bin',
                    },
                    programDateTime: new Date('2026-05-05T05:05:05Z'),
                });

            test('gives the key file after the init segment', async () => {
                const { updates } = await secured();
                assert.deepEqual(
                    updates[0].files.map(file => [file.kind, file.name]),
                    [
                        ['init', 'init.mp4'],
                        ['key', 'live.bin'],
                    ],
                );
                assert.deepEqual(updates[0].files[1].data, KEY);
            });

            test('states the key and the date in every update', async () => {
                for (const update of (await secured()).updates.slice(1)) {
                    assert.match(
                        update.playlist,
                        /#EXT-X-KEY:METHOD=AES-128,URI="https:\/\/keys\.example\/live\.bin"\n/,
                    );
                    assert.match(
                        update.playlist,
                        /#EXT-X-PROGRAM-DATE-TIME:2026-05-05T05:05:05\.000Z/,
                    );
                }
            });

            test('encrypts each segment, padded, with the IV of its sequence', async () => {
                const clear = (await plain()).updates.slice(1);
                for (const [index, update] of (await secured()).updates.slice(1).entries()) {
                    const segment = update.files.find(file => file.kind === 'segment');
                    assert.equal(segment.data.length % 16, 0, 'PKCS#7 padded');
                    assert.deepEqual(
                        await decrypt(segment.data, index),
                        clear[index].files[0].data,
                    );
                }
            });

            test('a stated IV is written and used for every segment', async () => {
                const iv = Uint8Array.from({ length: 16 }, (_, index) => 255 - index);
                const fixed = await liveRun({
                    targetDuration: 1,
                    encryption: { method: 'AES-128', key: KEY, keyUri: 'k', iv },
                });
                assert.match(fixed.updates[1].playlist, /IV=0xfffefdfcfbfaf9f8f7f6f5f4f3f2f1f0/);
                assert.deepEqual(
                    await decrypt(fixed.updates[1].files[0].data, 0, iv),
                    (await plain()).updates[1].files[0].data,
                );
            });
        });

        test('a short key or a segment name of the playlist fails with INPUT', async () => {
            const encryption = { method: 'AES-128', key: KEY.subarray(0, 8), keyUri: 'k' };
            await assert.rejects(liveRun({ encryption }), { code: 'INPUT' });
            await assert.rejects(liveRun({ segmentNamePattern: 'index.m3u8' }), { code: 'INPUT' });
        });
    });
});
