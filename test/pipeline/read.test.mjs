import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MediaForgeError, convert, open } from 'mediaforgejs';
import { annexB, avcc, idr, readNals } from '../helpers/avi-h264-fixtures.mjs';
import { readerPart } from '../helpers/parts.mjs';
import { engineOf, openIn } from '../helpers/engine.mjs';
import { waveFixture } from '../helpers/original-fixtures.mjs';
import { distUrl } from '../helpers/dist-paths.mjs';
import { encodeAacLc } from 'mediaforgejs/codecs';
import { WebMMuxer } from 'mediaforgejs/formats';
import { MemorySink } from 'mediaforgejs/io';
import { bindCompactSampleIndex } from 'mediaforgejs/plugins';

/** One frame of AAC silence. */
const FRAME = (await encodeAacLc([new Float32Array(1024)], { sampleRate: 48000, bitrate: 64 }))
    .frames[0];

/** Opens a one-sample H.264 track `sample` through a plugin reader of 'sample-fixture'. */
const openSample = sample =>
    open(new Uint8Array(0), {
        format: 'sample-fixture',
        plugins: {
            add: [
                {
                    name: 'sample-fixture',
                    readers: [
                        readerPart({
                            formats: ['sample-fixture'],
                            async read() {
                                return {
                                    audioTracks: [],
                                    videoTracks: [
                                        {
                                            codec: 'avc1.42000a',
                                            codecConfig: avcc(),
                                            width: 32,
                                            height: 16,
                                            sampleRate: 0,
                                            channelCount: 0,
                                            duration: 0.04,
                                            samples: [sample],
                                        },
                                    ],
                                };
                            },
                        }),
                    ],
                },
            ],
        },
    });

describe('read', () => {
    test("a reader's sample framing is taken once, before the packets are read", async () => {
        const data = annexB(idr);
        let framing = 'annexb';
        const media = await openSample({
            offset: 0,
            size: data.length,
            timestamp: 0,
            duration: 0.04,
            isKeyframe: true,
            data,
            get nalUnitFormat() {
                return framing;
            },
        });
        try {
            framing = 'avcc';
            const [packet] = await Array.fromAsync(media.packets());
            assert.deepEqual(readNals(packet.data, 4), [idr]);
        } finally {
            media.close();
        }
    });

    test('a sample framing other than annexb or avcc fails the open with DEMUX', async () => {
        const data = annexB(idr);
        await assert.rejects(
            openSample({
                offset: 0,
                size: data.length,
                timestamp: 0,
                duration: 0.04,
                isKeyframe: true,
                data,
                nalUnitFormat: 'guess',
            }),
            { code: 'DEMUX' },
        );
    });

    test('an open whose signal is aborted fails with ABORT before it reads', async () => {
        let reads = 0;
        const source = {
            size: 1024,
            async read() {
                reads++;
                throw new Error('an aborted open reads nothing');
            },
        };
        await assert.rejects(open(source, { signal: AbortSignal.abort() }), { code: 'ABORT' });
        assert.equal(reads, 0);
    });

    describe('the first reader of a format wins', () => {
        const marker = new MediaForgeError('custom reader', 'DEMUX');
        const custom = { formats: ['wav'], read: async () => Promise.reject(marker) };

        test("an application reader comes ahead of the library's", async () => {
            const options = {
                plugins: { add: [{ name: 'custom', readers: [readerPart(custom)] }] },
            };
            await assert.rejects(
                open(new Blob([waveFixture()]), options),
                error => error === marker,
            );
        });

        test("a reader behind the library's is not asked", async () => {
            const { CORE_FORMATS } = await import(distUrl('esm/formats/core-formats.js'));
            const behind = await engineOf({
                ...CORE_FORMATS,
                readers: [...CORE_FORMATS.readers, readerPart(custom)],
            });
            const file = await openIn(behind, new Blob([waveFixture()]));
            assert.equal(file.format, 'wav');
            file.close();
        });
    });

    describe('one read of the input', () => {
        const AAC = {
            id: 1,
            codec: 'mp4a.40.2',
            sampleRate: 48000,
            channelCount: 1,
            codecConfig: Uint8Array.of(0x11, 0x88),
        };
        /** One AAC frame in Matroska. */
        async function matroskaAac() {
            const sink = new MemorySink();
            const muxer = new WebMMuxer(
                { format: 'mkv', mode: 'standard', audio: { ...AAC, type: 'audio' } },
                sink,
            );
            muxer.addAudioChunk({
                data: FRAME,
                timestamp: 0,
                duration: 1024 / 48000,
                isKeyframe: true,
                trackType: 'audio',
            });
            await muxer.finalize();
            return sink.toUint8Array();
        }

        test('a conversion of audio asks the reader once, with the open policy', async () => {
            let reads = 0;
            const reader = readerPart({
                formats: ['mkv'],
                async read(_source, options) {
                    reads++;
                    assert.equal(options.metadataPolicy, 'warn');
                    const sample = { offset: 0, size: FRAME.length, data: FRAME, timestamp: 0 };
                    return {
                        duration: 1024 / 48000,
                        videoTracks: [],
                        audioTracks: [
                            {
                                ...AAC,
                                width: 0,
                                height: 0,
                                duration: 1024 / 48000,
                                samples: [{ ...sample, duration: 1024 / 48000, isKeyframe: true }],
                            },
                        ],
                    };
                },
            });
            const { blob } = await convert(await matroskaAac(), 'wav', {
                plugins: { add: [{ name: 'counted', readers: [reader] }] },
            });
            assert.ok(blob.size > 44);
            assert.equal(reads, 1);
        });

        test('detection and the index scan share one read of a Blob from its start', async () => {
            class CountingBlob extends Blob {
                fullReads = 0;
                slice(start, end, type) {
                    if ((start ?? 0) === 0) this.fullReads++;
                    return super.slice(start, end, type);
                }
            }
            const source = new CountingBlob([await matroskaAac()]);
            const { blob } = await convert(source, 'wav');
            assert.ok(blob.size > 44);
            assert.equal(source.fullReads, 1);
        });
    });

    describe("a plugin reader's results", () => {
        /** Opens `input` as `format` with the plugin reader `reader`. */
        const openWith = (reader, input, options = {}) =>
            open(input, {
                format: reader.formats[0],
                plugins: { add: [{ name: reader.formats[0], readers: [readerPart(reader)] }] },
                ...options,
            });

        test('are copied at open: changing them later changes nothing', async () => {
            const original = {
                id: 1,
                codec: 'mp4a.40.2',
                width: 0,
                height: 0,
                sampleRate: 48000,
                channelCount: 1,
                duration: 1,
                codecConfigurations: [{ codec: 'mp4a.40.2', codecConfig: Uint8Array.of(17, 136) }],
                samples: [
                    {
                        offset: 0,
                        size: 1,
                        data: Uint8Array.of(1),
                        timestamp: 0,
                        duration: 1,
                        isKeyframe: true,
                        codecConfigIndex: 0,
                    },
                ],
            };
            const reader = {
                formats: ['owned-fixture'],
                read: async () => ({ videoTracks: [], audioTracks: [original] }),
            };
            const media = await openWith(reader, new Uint8Array(1));
            original.samples[0].timestamp = 99;
            original.samples[0].data[0] = 99;
            original.codecConfigurations[0].codecConfig.fill(99);
            const packet = await media.packetAt(1, 0);
            assert.deepEqual([packet.timestamp, packet.data], [0, Uint8Array.of(1)]);
            assert.deepEqual(media.tracks[0].codecConfig, Uint8Array.of(17, 136));
            assert.equal((await media.check('mp4', { copy: true })).supported, true);
            media.close();
            assert.equal((await media.check('mp4', { copy: true })).supported, false);
            // A flag that is not a boolean is refused.
            original.forced = 'yes';
            await assert.rejects(openWith(reader, new Uint8Array(1)), { code: 'DEMUX' });
        });

        describe('declared capabilities', () => {
            // A reader states what the opened file may rely on, as the library's readers do: one
            // that hands its results over and reads compact indexes is asked for them and has
            // its index kept; one that only hands them over is not asked.
            const index = {
                length: 3,
                byteLength: 96,
                maxSampleSize: 1,
                allKeyframes: true,
                presentationSorted: true,
                decodeSorted: true,
                firstPresentation: 0,
                lastPresentationEnd: 3,
                get: position => ({
                    offset: position,
                    size: 1,
                    timestamp: position,
                    duration: 1,
                    isKeyframe: true,
                }),
                timestampAt: position => position,
                decodeTimeAt: position => position,
                isKeyframeAt: () => true,
            };
            const reader = (format, capabilities, asked) => ({
                formats: [format],
                capabilities,
                async read(_source, options) {
                    asked.push(options.compactIndex);
                    const track = {
                        id: 1,
                        codec: 'mp4a.40.2',
                        width: 0,
                        height: 0,
                        sampleRate: 48000,
                        channelCount: 1,
                        duration: 3,
                        codecConfig: Uint8Array.of(17, 136),
                        samples: [0, 1, 2].map(index.get),
                    };
                    if (options.compactIndex) bindCompactSampleIndex(track, index);
                    return { videoTracks: [], audioTracks: [track] };
                },
            });
            const INPUT = Uint8Array.of(10, 11, 12);

            for (const [label, capabilities, compactIndex] of [
                [
                    'hands over and reads compact indexes',
                    { handsOver: true, compactIndex: true },
                    true,
                ],
                ['hands over only', { handsOver: true }, undefined],
                ['declares nothing', undefined, undefined],
            ])
                test(`a reader that ${label} is asked accordingly and read`, async () => {
                    const asked = [];
                    const media = await openWith(
                        reader(label.replace(/\W/g, ''), capabilities, asked),
                        INPUT,
                    );
                    try {
                        assert.deepEqual(asked, [compactIndex]);
                        assert.deepEqual((await media.packetAt(1, 2)).data, Uint8Array.of(12));
                        assert.equal((await media.packetAt(1, 1)).timestamp, 1);
                    } finally {
                        media.close();
                    }
                });

            test('capabilities other than true or false are refused with INPUT', async () => {
                await assert.rejects(openWith(reader('odd', { handsOver: 'yes' }, []), INPUT), {
                    code: 'INPUT',
                });
            });
        });
    });
});
