import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { open } from 'mediaforgejs';
import {
    createId3Tag,
    deserializeTracks,
    parseId3Tag,
    serializeTracks,
    writeId3Tag,
} from 'mediaforgejs/formats';
import { readerPart } from '../helpers/parts.mjs';
import { distUrl } from '../helpers/dist-paths.mjs';

// Metadata the formats share: tracks as JSON, and Vorbis comments.

const { vorbisCommentTags } = await import(distUrl('esm/formats/metadata/vorbis-comment.js'));

const UID = 18446744073709551615n;
const CONFIG = Uint8Array.of(0, 1, 127, 255);

/** The tracks open() describes of one Opus track with the largest Matroska UID. */
async function describedTracks() {
    const reader = readerPart({
        formats: ['json-fixture'],
        async read() {
            return {
                videoTracks: [],
                audioTracks: [
                    {
                        id: 7,
                        codec: 'opus',
                        matroskaTrackUid: UID,
                        codecConfig: CONFIG,
                        duration: 0.02,
                        sampleRate: 48000,
                        channelCount: 1,
                        width: 0,
                        height: 0,
                        samples: [
                            {
                                offset: 0,
                                size: 1,
                                data: Uint8Array.of(1),
                                timestamp: 0,
                                duration: 0.02,
                                isKeyframe: true,
                            },
                        ],
                    },
                ],
            };
        },
    });
    const media = await open(Uint8Array.of(1), {
        format: 'json-fixture',
        plugins: { add: [{ name: 'json-fixture', readers: [reader] }] },
    });
    return { media, tracks: media.tracks };
}

/** A Vorbis comment payload of `vendor` and `fields`. */
function vorbisComment(vendor, fields) {
    const encoded = [vendor, ...fields].map(text => new TextEncoder().encode(text));
    const size = 8 + encoded.reduce((sum, field) => sum + 4 + field.length, 0) - 4;
    const payload = new Uint8Array(size);
    const view = new DataView(payload.buffer);
    let at = 0;
    view.setUint32(at, encoded[0].length, true);
    payload.set(encoded[0], (at += 4));
    at += encoded[0].length;
    view.setUint32(at, fields.length, true);
    at += 4;
    for (const field of encoded.slice(1)) {
        view.setUint32(at, field.length, true);
        payload.set(field, at + 4);
        at += 4 + field.length;
    }
    return payload;
}

describe('metadata', () => {
    describe('tracks as JSON', () => {
        test('JSON.stringify writes a 64-bit UID as a string and bytes as numbers', async () => {
            const { media, tracks } = await describedTracks();
            try {
                const [track] = JSON.parse(JSON.stringify(tracks));
                assert.equal(track.matroskaTrackUid, '18446744073709551615');
                assert.deepEqual(track.codecConfig, [0, 1, 127, 255]);
            } finally {
                media.close();
            }
        });

        test('deserializeTracks() restores the exact UID and bytes the caller owns', async () => {
            const { media, tracks } = await describedTracks();
            try {
                const [restored] = deserializeTracks(JSON.stringify(tracks));
                assert.equal(restored.matroskaTrackUid, UID);
                assert.ok(restored.codecConfig instanceof Uint8Array);
                assert.deepEqual(restored.codecConfig, CONFIG);
                restored.codecConfig[0] = 255;
                assert.equal(media.tracks[0].codecConfig[0], 0);
                assert.equal(typeof media.tracks[0].matroskaTrackUid, 'bigint');
            } finally {
                media.close();
            }
        });

        test('tracks are frozen, and no toJSON is added to them or to BigInt', async () => {
            const { media, tracks } = await describedTracks();
            try {
                assert.ok(Object.isFrozen(tracks[0]));
                assert.equal(Object.hasOwn({ ...tracks[0] }, 'toJSON'), false);
                assert.equal(Object.hasOwn(BigInt.prototype, 'toJSON'), false);
            } finally {
                media.close();
            }
        });

        test('fields beyond the schema round trip as ordinary data', async () => {
            const { media, tracks } = await describedTracks();
            try {
                const extras = {
                    note: '123n',
                    nested: { matroskaTrackUid: '9', codecConfig: [1] },
                    toJSON: 'ordinary data',
                };
                const [decoded] = deserializeTracks(serializeTracks([{ ...tracks[0], ...extras }]));
                for (const [key, value] of Object.entries(extras))
                    assert.deepEqual(decoded[key], value);
                assert.equal(decoded.matroskaTrackUid, UID);
                assert.equal(
                    deserializeTracks(serializeTracks([decoded]))[0].matroskaTrackUid,
                    UID,
                );
            } finally {
                media.close();
            }
        });

        test('serializeTracks() reads an inherited getter and the length once', async () => {
            const { media, tracks } = await describedTracks();
            try {
                let fieldReads = 0;
                const inherited = Object.create({
                    get matroskaTrackUid() {
                        assert.equal(this, inherited);
                        fieldReads++;
                        return UID;
                    },
                });
                Object.assign(inherited, { id: 1, type: 'audio', codec: 'opus' });
                const [decoded] = deserializeTracks(serializeTracks([inherited]));
                assert.deepEqual([decoded.matroskaTrackUid, fieldReads], [UID, 1]);
                let lengthReads = 0;
                const array = new Proxy([tracks[0]], {
                    get(target, key, receiver) {
                        if (key === 'length') return lengthReads++ === 0 ? 1 : 4097;
                        return Reflect.get(target, key, receiver);
                    },
                });
                assert.equal(JSON.parse(serializeTracks(array)).length, 1);
                assert.equal(lengthReads, 1);
            } finally {
                media.close();
            }
        });

        test("serializeTracks() passes on the caller's own failures", async () => {
            const { media, tracks } = await describedTracks();
            try {
                for (const reason of [{ failure: 'caller' }, new TypeError('caller failure')]) {
                    const throwing = {
                        get name() {
                            throw reason;
                        },
                    };
                    const toJson = {
                        extension: {
                            toJSON() {
                                throw reason;
                            },
                        },
                    };
                    for (const extra of [throwing, toJson])
                        assert.throws(
                            () => serializeTracks([Object.assign({ ...tracks[0] }, extra)]),
                            error => error === reason,
                        );
                }
            } finally {
                media.close();
            }
        });

        test('cyclic and BigInt extensions fail as JSON.stringify fails', async () => {
            const { media, tracks } = await describedTracks();
            try {
                const cyclic = {};
                cyclic.self = cyclic;
                assert.throws(
                    () => serializeTracks([{ ...tracks[0], extension: cyclic }]),
                    TypeError,
                );
                assert.throws(() => serializeTracks([{ ...tracks[0], extension: 1n }]), TypeError);
            } finally {
                media.close();
            }
        });

        test('UIDs outside 64 bits or unsafe as numbers fail with FORMAT', async () => {
            const { media, tracks } = await describedTracks();
            try {
                for (const matroskaTrackUid of [0n, 18446744073709551616n, 9007199254740992])
                    assert.throws(() => serializeTracks([{ ...tracks[0], matroskaTrackUid }]), {
                        code: 'FORMAT',
                    });
                assert.throws(
                    () =>
                        deserializeTracks(
                            '[{"id":1,"type":"audio","codec":"opus","matroskaTrackUid":' +
                                '9007199254740992}]',
                        ),
                    { code: 'FORMAT' },
                );
            } finally {
                media.close();
            }
        });

        test('more than 4096 tracks or a configuration over 1 MiB fail with FORMAT', async () => {
            const { media, tracks } = await describedTracks();
            try {
                assert.throws(() => serializeTracks(Array(4097).fill(tracks[0])), {
                    code: 'FORMAT',
                });
                const large = { ...tracks[0], codecConfig: new Uint8Array(1024 * 1024 + 1) };
                assert.throws(() => serializeTracks([large]), { code: 'FORMAT' });
            } finally {
                media.close();
            }
        });
    });

    test('an ID3 tag written from a title reads back with it, in Japanese too', () => {
        const tag = createId3Tag({
            entries: [{ key: 'title', value: { type: 'text', value: '日本語' } }],
        });
        assert.deepEqual(parseId3Tag(writeId3Tag(tag)).metadata.entries[0].value, {
            type: 'text',
            value: '日本語',
        });
    });

    describe('Vorbis comments', () => {
        test('YEAR is the date and a lone DESCRIPTION the comment', () => {
            const payload = vorbisComment('vendor', [
                'YEAR=1948',
                'DESCRIPTION=Radio play',
                'ARTIST=Cast',
            ]);
            assert.deepEqual(
                vorbisCommentTags(payload).entries.sort((a, b) => a.key.localeCompare(b.key)),
                [
                    { key: 'artist', value: 'Cast' },
                    { key: 'comment', value: 'Radio play' },
                    { key: 'date', value: '1948' },
                ],
            );
        });
    });
});
