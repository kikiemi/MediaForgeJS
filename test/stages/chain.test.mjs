import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { convert, edit, inspect, open } from 'mediaforgejs';
import { createPicture, createVideoStages, stageAudio } from 'mediaforgejs/parts';
import { tone as toneSamples, toInt16, waveFile } from '../helpers/pcm.mjs';
import { distUrl } from '../helpers/dist-paths.mjs';

const { AudioStageChain, createStages, stagedPcmSource } = await import(
    distUrl('esm/stages/chain.js')
);

const INFO = { width: 4, height: 2 };

const picture = (timestamp = 0, { width = 4, height = 2 } = {}) =>
    createPicture({
        data: new Uint8Array(width * height * 4),
        width,
        height,
        timestamp,
        duration: 0.04,
    });

/** Whether a picture is closed: its pixels can no longer be read. */
const isClosed = picture =>
    picture.rgba().then(
        () => false,
        error => error.code === 'INPUT',
    );

/** A video stage that passes pictures on and records its calls into `log`. */
const passing = (name, log = [], extra = {}) => ({
    type: 'video',
    name,
    process(input, emit) {
        log.push(`${name} ${Math.round(input.timestamp * 100)}`);
        emit(input);
    },
    close() {
        log.push(`${name} close`);
    },
    ...extra,
});

/** Mono sound of `blocks` blocks of `length` samples, read as often as asked. */
const tone = (blocks = 3, length = 4, extra = {}) => ({
    sampleRate: 8000,
    channels: 1,
    estimatedFrames: blocks * length,
    async *chunks() {
        for (let block = 0; block < blocks; block++)
            yield [Float32Array.from({ length }, (_, at) => block * length + at)];
    },
    ...extra,
});

const collect = async source => {
    const blocks = [];
    for await (const planes of source.chunks()) blocks.push(planes);
    return blocks;
};

describe('stages', () => {
    describe('video stage chain', () => {
        test('each stage is configured once, in order, with the stream before it', () => {
            const seen = [];
            const sized = (name, width) =>
                passing(name, [], {
                    configure(input) {
                        seen.push([name, input.width, input.fps]);
                        return { ...input, width };
                    },
                });
            const chain = createVideoStages([sized('a', 8), sized('b', 6)], {
                ...INFO,
                fps: 25,
            });
            assert.deepEqual(seen, [
                ['a', 4, 25],
                ['b', 8, 25],
            ]);
            assert.deepEqual(chain.output, { width: 6, height: 2, fps: 25 });
            chain.close();
        });

        test('a stage that configures an invalid stream fails with INPUT', () => {
            const broken = passing('broken', [], { configure: () => ({ width: 0, height: 2 }) });
            assert.throws(() => createVideoStages([broken], INFO), {
                code: 'INPUT',
                message: "Stage 'broken' configured an invalid video stream",
            });
            assert.throws(() => createVideoStages([], { width: 4, height: 2, fps: -1 }), {
                code: 'INPUT',
            });
        });

        test('what a stage emits runs through the stages after it, in order', async () => {
            const log = [];
            const twice = {
                type: 'video',
                name: 'twice',
                process(input, emit) {
                    emit(input.retime(input.timestamp, 0.02));
                    emit(input.retime(input.timestamp + 0.02, 0.02));
                    input.close();
                },
            };
            const chain = createVideoStages([twice, passing('after', log)], INFO);
            const output = await chain.push(picture());
            assert.deepEqual(log, ['after 0', 'after 2']);
            assert.deepEqual(
                output.map(item => item.timestamp),
                [0, 0.02],
            );
            chain.close();
        });

        test('flushing passes what a stage held through the stages after it', async () => {
            const log = [];
            let held;
            const holding = {
                type: 'video',
                name: 'holding',
                process(input) {
                    held = input;
                },
                flush(emit) {
                    emit(held);
                },
            };
            const chain = createVideoStages([holding, passing('after', log)], INFO);
            assert.deepEqual(await chain.push(picture(0.5)), []);
            assert.equal((await chain.flush()).length, 1);
            assert.deepEqual(log, ['after 50']);
            chain.close();
        });

        test('a picture of another size than configured fails with INPUT and a hint', async () => {
            const growing = {
                type: 'video',
                name: 'growing',
                process(input, emit) {
                    input.close();
                    emit(picture(0, { width: 8, height: 2 }));
                },
            };
            const chain = createVideoStages([growing], INFO);
            await assert.rejects(chain.push(picture()), error => {
                assert.equal(error.code, 'INPUT');
                assert.match(error.message, /'growing' emitted a picture of another size/);
                assert.match(error.hint, /configure\(\)/);
                return true;
            });
            chain.close();
        });

        test('only pictures may be emitted, with finite timing', async () => {
            const emitting = value => ({
                type: 'video',
                name: 'odd',
                process(input, emit) {
                    input.close();
                    emit(value(input));
                },
            });
            for (const value of [
                () => ({ width: 4, height: 2, timestamp: 0, duration: 0 }),
                input => input.retime(Number.NaN, 0.04),
                input => input.retime(0, -1),
            ]) {
                const chain = createVideoStages([emitting(value)], INFO);
                await assert.rejects(chain.push(picture()), { code: 'INPUT' });
                chain.close();
            }
        });

        test('emitting after the call returned fails with INPUT', async () => {
            let saved;
            const late = {
                type: 'video',
                name: 'late',
                process(input, emit) {
                    if (saved) saved(input);
                    else input.close();
                    saved = emit;
                },
            };
            const chain = createVideoStages([late], INFO);
            await chain.push(picture());
            await assert.rejects(chain.push(picture()), {
                code: 'INPUT',
                message: "Stage 'late' emitted after its call returned",
            });
            chain.close();
        });

        test("a stage's own failure is ENCODE naming it; library errors keep theirs", async () => {
            const failing = error => ({
                type: 'video',
                name: 'failing',
                process() {
                    throw error;
                },
            });
            const outcome = async error => {
                const chain = createVideoStages([failing(error)], INFO);
                const input = picture();
                try {
                    await chain.push(input);
                } catch (caught) {
                    assert(await isClosed(input), 'the pushed picture is released');
                    return caught;
                } finally {
                    chain.close();
                }
            };
            const own = await outcome(new TypeError('bad pixel'));
            assert.deepEqual(
                [own.code, own.message],
                ['ENCODE', "Stage 'failing' failed: bad pixel"],
            );
            assert.equal(
                (await outcome(Object.assign(new Error('x'), { code: 'X' }))).code,
                'ENCODE',
            );
            const abort = new DOMException('stopped', 'AbortError');
            assert.equal(await outcome(abort), abort);
        });

        test('closing closes every stage once and reports a failing close', async () => {
            const log = [];
            const warnings = [];
            const failing = passing('failing', log, {
                close() {
                    throw new Error('busy');
                },
            });
            const chain = createVideoStages([passing('a', log), failing, passing('b', log)], INFO, {
                onWarning: warning => warnings.push(warning),
            });
            chain.close();
            chain.close();
            assert.deepEqual(log, ['a close', 'b close']);
            assert.deepEqual(warnings, [
                {
                    code: 'STAGE_CLOSE_FAILED',
                    message: "Stage 'failing' cleanup failed: busy",
                    severity: 'warning',
                },
            ]);
        });

        test('a closed chain refuses pictures with ABORT and releases them', async () => {
            const chain = createVideoStages([passing('a')], INFO);
            chain.close();
            const input = picture();
            await assert.rejects(chain.push(input), { code: 'ABORT' });
            assert(await isClosed(input));
        });

        test('stage factories must make stages of their type', () => {
            const make = stage => [{ name: 'made', create: () => stage }];
            assert.equal(createStages('video', make(passing('a')))[0].name, 'a');
            for (const stage of [
                undefined,
                { ...passing('a'), type: 'audio' },
                { ...passing(''), name: '' },
                { type: 'video', name: 'x' },
            ])
                assert.throws(() => createStages('video', make(stage)), {
                    code: 'INPUT',
                    message: "A video stage needs type 'video', a name and process()",
                });
            assert.deepEqual(createStages('audio'), []);
        });
    });

    describe('audio stage chain', () => {
        const gain = (factor, extra = {}) => ({
            type: 'audio',
            name: 'gain',
            process(planes, emit) {
                emit(planes.map(plane => plane.map(value => value * factor)));
            },
            ...extra,
        });

        test('sound runs through the stages in order', async () => {
            const staged = stageAudio(tone(), [gain(2), gain(0.25)]);
            const blocks = await collect(staged);
            assert.deepEqual(
                blocks.map(([plane]) => [...plane]),
                [
                    [0, 0.5, 1, 1.5],
                    [2, 2.5, 3, 3.5],
                    [4, 4.5, 5, 5.5],
                ],
            );
        });

        test('staged sound is read once', async () => {
            const staged = stageAudio(tone(), [gain(1)]);
            await collect(staged);
            await assert.rejects(collect(staged), { code: 'INPUT', message: /read once/ });
        });

        test('planes of the wrong count, length or type fail with INPUT', async () => {
            for (const emitted of [
                () => [],
                () => [new Float32Array(2), new Float32Array(2)],
                () => [new Float64Array(2)],
                () => 'planes',
            ]) {
                const odd = {
                    type: 'audio',
                    name: 'odd',
                    process: (_planes, emit) => emit(emitted()),
                };
                await assert.rejects(collect(stageAudio(tone(), [odd])), {
                    code: 'INPUT',
                    message: "Stage 'odd' emitted planes of the wrong count or length",
                });
            }
        });

        test('empty blocks do not reach the output', async () => {
            const sink = [];
            const chain = new AudioStageChain(
                [gain(1)],
                { sampleRate: 8000, channels: 1 },
                planes => sink.push(planes),
            );
            await chain.push([new Float32Array(0)]);
            await chain.push([new Float32Array(1)]);
            assert.equal(sink.length, 1);
            chain.close();
        });

        test('a stream of more than eight channels or no rate fails with INPUT', () => {
            const configured = info => gain(1, { configure: () => info });
            for (const info of [
                { sampleRate: 8000, channels: 9 },
                { sampleRate: 0, channels: 1 },
                { sampleRate: 44100.5, channels: 2 },
            ])
                assert.throws(() => stageAudio(tone(), [configured(info)]), {
                    code: 'INPUT',
                    message: "Stage 'gain' configured an invalid audio stream",
                });
        });

        test('a closed chain refuses sound with ABORT', async () => {
            const chain = new AudioStageChain(
                [gain(1)],
                { sampleRate: 8000, channels: 1 },
                () => {},
            );
            chain.close();
            await assert.rejects(chain.push([new Float32Array(1)]), { code: 'ABORT' });
        });
    });

    describe('replayable staged sound', () => {
        const halving = created => ({
            name: 'halve',
            create() {
                created.push(1);
                let pending = [];
                return {
                    type: 'audio',
                    name: 'halve',
                    configure: input => ({ ...input, sampleRate: input.sampleRate / 2 }),
                    process(planes, emit) {
                        pending.push(...planes[0]);
                        const even = pending.filter((_, at) => at % 2 === 0);
                        pending = [];
                        emit([Float32Array.from(even)]);
                    },
                };
            },
        });

        test('without stages the source is its own staged sound', () => {
            const source = tone();
            assert.equal(stagedPcmSource(source, []), source);
        });

        test('every replay runs fresh stages from the start', async () => {
            const created = [];
            const staged = stagedPcmSource(tone(), [halving(created)]);
            assert.deepEqual([staged.sampleRate, staged.estimatedFrames], [4000, 6]);
            const first = await collect(staged);
            const second = await collect(staged);
            assert.deepEqual(first, second);
            assert.deepEqual(
                first.map(([plane]) => [...plane]),
                [
                    [0, 2],
                    [4, 6],
                    [8, 10],
                ],
            );
            assert.equal(created.length, 3, 'one probe and one set per replay');
        });

        test('the channel mask is kept only while the channels are', () => {
            const masked = tone(1, 4, { channels: 2, channelMask: 0x3 });
            const same = {
                name: 'same',
                create: () => ({ type: 'audio', name: 'same', process() {} }),
            };
            const mono = {
                name: 'mono',
                create: () => ({
                    type: 'audio',
                    name: 'mono',
                    configure: input => ({ ...input, channels: 1 }),
                    process() {},
                }),
            };
            assert.equal(stagedPcmSource(masked, [same]).channelMask, 0x3);
            assert.equal('channelMask' in stagedPcmSource(masked, [mono]), false);
        });
    });

    describe('audio stages in conversions', () => {
        const definition = (name, stage) => ({
            type: 'audio',
            name,
            create: () => ({ type: 'audio', name, ...stage }),
        });
        const gain = definition('gain', {
            process: (planes, emit) => emit(planes.map(plane => plane.map(value => value / 2))),
        });
        const mono = definition('mono', {
            configure: info => ({ ...info, channels: 1 }),
            process: (planes, emit) =>
                emit([planes[0].map((value, at) => (value + planes[1][at]) / 2)]),
        });
        const input = () => new Blob([waveFile(toInt16(toneSamples(8000, 2, 4000)), 8000, 2)]);
        const samples = async blob => {
            const media = await open(blob);
            const values = [];
            for await (const packet of media.packets())
                values.push(...new Int16Array(packet.data.slice().buffer));
            media.close();
            return values;
        };

        test('a target runs its sound through the stages, which the plan names', async () => {
            const original = await samples(input());
            const halved = await convert(input(), { to: 'wav', audio: { stages: [gain] } });
            assert.deepEqual(
                halved.plan.tracks.map(track => track.stages),
                [['gain']],
            );
            const quiet = await samples(halved.blob);
            assert.equal(quiet.length, original.length);
            assert(quiet.every((value, at) => Math.abs(value - original[at] / 2) <= 1));
            const encoded = await convert(input(), { to: 'm4a', audio: { stages: [gain] } });
            assert.deepEqual(
                encoded.plan.tracks.map(track => [track.action, track.stages]),
                [['encode', ['gain']]],
            );
            const edited = await edit(
                { clips: [{ input: input() }] },
                {
                    to: 'wav',
                    audio: { stages: [gain] },
                },
            );
            assert.deepEqual(await samples(edited.blob), quiet, 'an edit runs the same stage');
        });

        test('the channel count a stage declares is written', async () => {
            const folded = await convert(input(), { to: 'wav', audio: { stages: [mono] } });
            assert.equal((await inspect(folded.blob)).tracks[0].channelCount, 1);
            const undeclared = definition('mono', { ...mono.create(), configure: undefined });
            await assert.rejects(convert(input(), { to: 'wav', audio: { stages: [undeclared] } }), {
                code: 'INPUT',
                message: /planes of the wrong count/,
            });
        });

        test('a failing cleanup leaves the output standing and is reported', async () => {
            const failing = definition('gain', {
                ...gain.create(),
                close: () => {
                    throw new Error('boom');
                },
            });
            const kept = await convert(input(), { to: 'wav', audio: { stages: [failing] } });
            const halved = await convert(input(), { to: 'wav', audio: { stages: [gain] } });
            assert.deepEqual(await samples(kept.blob), await samples(halved.blob));
            assert(
                kept.warnings.some(
                    warning =>
                        warning.code === 'STAGE_CLOSE_FAILED' && /boom/.test(warning.message),
                ),
            );
        });
    });
});
