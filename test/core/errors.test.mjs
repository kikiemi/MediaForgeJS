import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ERROR_CODES, MediaForgeError, isMediaForgeError } from 'mediaforgejs';
import { distUrl } from '../helpers/dist-paths.mjs';

const errors = await import(distUrl('esm/core/errors/errors.js'));
const guard = await import(distUrl('esm/core/errors/demux-guard.js'));
const { DiagnosticContext } = await import(distUrl('esm/core/errors/diagnostics.js'));
const { positiveLimit } = await import(distUrl('esm/core/errors/limits.js'));
const { OptionNormalizer, closestName, resolveOptionPolicy } = await import(
    distUrl('esm/core/errors/option-policy.js')
);

describe('errors', () => {
    describe('library errors', () => {
        test('carry a code, a hint, the plugin and the cause', () => {
            const cause = new Error('first');
            const error = new MediaForgeError('needs h264', 'PLUGIN', {
                hint: 'Include it.',
                plugin: 'h264',
                cause,
            });
            assert.deepEqual(
                [error.name, error.code, error.message, error.hint, error.plugin, error.cause],
                ['MediaForgeError', 'PLUGIN', 'needs h264', 'Include it.', 'h264', cause],
            );
            assert(error instanceof Error);
            const plain = new MediaForgeError('x', 'IO');
            assert.deepEqual(
                [plain.hint, plain.plugin, 'cause' in plain],
                [undefined, undefined, false],
            );
        });

        test('isMediaForgeError tells library errors, of given codes or any', () => {
            const error = new MediaForgeError('x', 'ABORT');
            assert.equal(isMediaForgeError(error), true);
            assert.equal(isMediaForgeError(error, 'ABORT', 'IO'), true);
            assert.equal(isMediaForgeError(error, 'IO'), false);
            assert.equal(isMediaForgeError(new Error('x')), false);
            assert.equal(isMediaForgeError({ code: 'ABORT' }), false);
        });

        test('the code list is frozen and names every category', () => {
            assert(Object.isFrozen(ERROR_CODES));
            assert.deepEqual([...ERROR_CODES].sort(), [
                'ABORT',
                'DECODE',
                'DEMUX',
                'ENCODE',
                'FORMAT',
                'INPUT',
                'IO',
                'MUX',
                'OOM',
                'OUTPUT',
                'PLUGIN',
            ]);
        });

        test('each error class has its code and name', () => {
            for (const [Class, code] of [
                [errors.DemuxError, 'DEMUX'],
                [errors.DecodeError, 'DECODE'],
                [errors.EncodeError, 'ENCODE'],
                [errors.MuxError, 'MUX'],
                [errors.IOError, 'IO'],
            ]) {
                const error = new Class('x');
                assert.deepEqual(
                    [error.code, error.name, error instanceof MediaForgeError],
                    [code, Class.name, true],
                );
            }
        });

        test('errorMessage reads errors and anything else', () => {
            assert.equal(errors.errorMessage(new TypeError('bad')), 'bad');
            assert.equal(errors.errorMessage('text'), 'text');
            assert.equal(errors.errorMessage(undefined), 'unknown');
        });

        test('aborts surface as ABORT; rethrowIfAbort lets other errors pass', () => {
            errors.throwIfAborted(undefined);
            const signal = AbortSignal.abort();
            assert.throws(() => errors.throwIfAborted(signal), {
                code: 'ABORT',
                cause: signal.reason,
            });
            errors.rethrowIfAbort(new Error('other'));
            const abort = new MediaForgeError('x', 'ABORT');
            assert.throws(
                () => errors.rethrowIfAbort(abort),
                error => error === abort,
            );
            const host = new DOMException('x', 'AbortError');
            assert.throws(() => errors.rethrowIfAbort(host), { code: 'ABORT', cause: host });
            assert.throws(() => errors.rethrowIfAbort(new Error('other'), AbortSignal.abort()), {
                code: 'ABORT',
            });
        });

        test('an abort whose reason is a library error stops with that error', () => {
            const timeout = new MediaForgeError('timed out', 'IO');
            const controller = new AbortController();
            controller.abort(timeout);
            assert.throws(
                () => errors.throwIfAborted(controller.signal),
                error => error === timeout,
            );
            assert.equal(errors.abortError(controller.signal), timeout);
        });

        test('limits are positive safe integers or fail with the code given', () => {
            assert.equal(positiveLimit(undefined, 5, 'maxThings'), 5);
            assert.equal(positiveLimit(7, 5, 'maxThings'), 7);
            assert.throws(() => positiveLimit(0, 5, 'maxThings'), {
                code: 'INPUT',
                message: 'maxThings must be a positive safe integer',
            });
            assert.throws(() => positiveLimit(1.5, 5, 'maxThings', 'OOM'), { code: 'OOM' });
        });
    });

    describe('demux guards', () => {
        test('malformed input fails with DEMUX; reads past a view become it too', () => {
            guard.demuxAssert(true, 'never');
            assert.throws(() => guard.demuxAssert(0, 'box size'), {
                code: 'DEMUX',
                message: 'Malformed input: box size',
            });
            const failure = guard.demuxFailure(new RangeError('Offset is outside the bounds'));
            assert.deepEqual([failure.code, failure.cause instanceof RangeError], ['DEMUX', true]);
            const other = new Error('x');
            assert.equal(guard.demuxFailure(other), other);
        });
    });

    describe('diagnostics', () => {
        test('warnings are frozen, delivered and kept up to the limit', () => {
            const delivered = [];
            const context = new DiagnosticContext({
                onWarning: warning => delivered.push(warning),
                maxWarnings: 2,
            });
            for (const code of ['A', 'B', 'C']) context.warn({ code, message: code });
            assert.deepEqual(
                context.warnings.map(warning => warning.code),
                ['A', 'B'],
            );
            assert.equal(delivered.length, 2);
            assert.equal(context.suppressedWarnings, 1);
            assert(Object.isFrozen(delivered[0]));
            assert.equal(delivered[0].severity, 'warning');
        });

        test('recovered damage fails strict validation with DEMUX and counts otherwise', () => {
            assert.throws(() => new DiagnosticContext({}).recover({ code: 'X', message: 'bad' }), {
                code: 'DEMUX',
            });
            const lenient = new DiagnosticContext({ validation: 'compatible' });
            lenient.note('recover', 'mp4', 'X', 'bad', { offset: 8 });
            assert.equal(lenient.recoveries, 1);
            assert.deepEqual(lenient.warnings[0], {
                code: 'X',
                format: 'mp4',
                offset: 8,
                message: 'bad',
                severity: 'warning',
            });
        });

        test('losses fail strict validation with FORMAT; metadata obeys its own policy', () => {
            assert.throws(() => new DiagnosticContext({}).lose({ code: 'L', message: 'alpha' }), {
                code: 'FORMAT',
            });
            const compatible = new DiagnosticContext({
                validation: 'compatible',
                metadataPolicy: 'error',
            });
            assert.throws(() => compatible.metadata({ code: 'M', message: 'tag' }), {
                code: 'FORMAT',
            });
            assert.equal(compatible.warnings.length, 1, 'reported before failing');
        });

        test('metadata warns, or fails with FORMAT under the error policy', () => {
            const diagnostic = { code: 'TEST_METADATA_LOSS', message: 'Metadata unavailable' };
            for (const validation of ['strict', 'compatible']) {
                const optional = new DiagnosticContext({ validation });
                optional.metadata(diagnostic);
                assert.equal(optional.warnings.length, 1);
                const required = new DiagnosticContext({ validation, metadataPolicy: 'error' });
                assert.throws(() => required.metadata(diagnostic), { code: 'FORMAT' });
                assert.equal(required.warnings.length, 1);
            }
        });

        test('a metadata failure past the warning limit reaches no listener', () => {
            const delivered = [];
            const required = new DiagnosticContext({
                metadataPolicy: 'error',
                onWarning: warning => delivered.push(warning),
                maxWarnings: 0,
            });
            assert.throws(() => required.metadata({ code: 'M', message: 'tag' }), {
                code: 'FORMAT',
            });
            assert.deepEqual([delivered.length, required.suppressedWarnings], [0, 1]);
        });

        test('a listener that throws under the error policy fails with its own error', () => {
            const reason = { name: 'listener failure' };
            const context = new DiagnosticContext({
                metadataPolicy: 'error',
                onWarning() {
                    throw reason;
                },
            });
            assert.throws(
                () => context.metadata({ code: 'M', message: 'tag' }),
                error => error === reason,
            );
        });

        test('recoveries are counted beyond the warnings kept', () => {
            const damage = { code: 'TEST_DAMAGE', message: 'Damage read past' };
            const compatible = new DiagnosticContext({ validation: 'compatible', maxWarnings: 1 });
            compatible.recover(damage);
            compatible.recover(damage);
            compatible.metadata({ code: 'M', message: 'tag' });
            assert.deepEqual([compatible.recoveries, compatible.warnings.length], [2, 1]);
            const strict = new DiagnosticContext();
            assert.throws(() => strict.recover(damage), { code: 'DEMUX' });
            assert.equal(strict.recoveries, 0);
        });

        test('a fresh context keeps the policies but not the warnings', () => {
            const context = new DiagnosticContext({
                validation: 'compatible',
                metadataPolicy: 'error',
            });
            context.warn({ code: 'A', message: 'a' });
            const fresh = context.fresh();
            assert.deepEqual(
                [fresh.validation, fresh.metadataPolicy, fresh.warnings.length],
                ['compatible', 'error', 0],
            );
        });

        test('refuses unknown policies and limits with INPUT', () => {
            for (const options of [
                { validation: 'loose' },
                { metadataPolicy: 'ignore' },
                { metadataPolicy: null },
                { metadataPolicy: false },
                { metadataPolicy: 0 },
                { onWarning: 1 },
                { maxWarnings: -1 },
                null,
            ])
                assert.throws(() => new DiagnosticContext(options), { code: 'INPUT' });
        });

        test('metadata follows its own policy in either validation, past the warning limit', () => {
            const loss = { code: 'M', message: 'tag' };
            for (const validation of ['strict', 'compatible']) {
                const kept = new DiagnosticContext({ validation });
                kept.metadata(loss);
                assert.equal(kept.warnings.length, 1, `${validation} reports it`);
            }
            const delivered = [];
            const silent = new DiagnosticContext({
                metadataPolicy: 'error',
                onWarning: warning => delivered.push(warning),
                maxWarnings: 0,
            });
            assert.throws(() => silent.metadata(loss), { code: 'FORMAT' });
            assert.deepEqual([delivered.length, silent.suppressedWarnings], [0, 1]);
            for (const metadataPolicy of [null, false, 0])
                assert.throws(() => new DiagnosticContext({ metadataPolicy }), { code: 'INPUT' });
        });

        test('recovered damage is counted beyond the warnings kept', () => {
            const context = new DiagnosticContext({ validation: 'compatible', maxWarnings: 1 });
            context.recover({ code: 'X', message: 'bad' });
            context.recover({ code: 'X', message: 'bad' });
            context.metadata({ code: 'M', message: 'tag' });
            assert.deepEqual([context.recoveries, context.warnings.length], [2, 1]);
        });

        test("a listener's failure ends the report with that failure", () => {
            const reason = { name: 'listener failure' };
            const context = new DiagnosticContext({
                metadataPolicy: 'error',
                onWarning() {
                    throw reason;
                },
            });
            assert.throws(
                () => context.metadata({ code: 'M', message: 'tag' }),
                error => error === reason,
            );
        });
    });

    describe('option policy', () => {
        test('only strict is strict', () => {
            assert.deepEqual(['strict', 'lenient', 'STRICT', undefined].map(resolveOptionPolicy), [
                'strict',
                'lenient',
                'lenient',
                'lenient',
            ]);
        });

        test('suggests the name within two edits', () => {
            assert.equal(closestName('bitrat', ['bitrate', 'codec']), 'bitrate');
            assert.equal(closestName('Codex', ['bitrate', 'codec']), 'codec');
            assert.equal(closestName('zzzzzz', ['bitrate', 'codec']), undefined);
        });

        test('numbers are read, rounded and clamped with a finding each', () => {
            const options = new OptionNormalizer('lenient', 'video');
            assert.equal(options.number('fps', '30'), 30);
            assert.equal(options.number('width', 10.4, { integer: true }), 10);
            assert.equal(options.number('quality', 3, { max: 1 }), 1);
            assert.equal(options.number('quality', 'high', { fallback: 0.8 }), 0.8);
            assert.equal(options.number('quality', {}), undefined);
            assert.deepEqual(
                options.findings.map(finding => finding.code),
                [
                    'OPTION_NORMALIZED',
                    'OPTION_NORMALIZED',
                    'OPTION_NORMALIZED',
                    'OPTION_NORMALIZED',
                    'OPTION_IGNORED',
                ],
            );
            assert.match(options.findings[0].message, /^video: fps read the string "30" as 30$/);
        });

        test('strict policy turns every finding into INPUT', () => {
            assert.throws(() => new OptionNormalizer('strict').number('fps', '30'), {
                code: 'INPUT',
            });
            assert.throws(
                () =>
                    new OptionNormalizer('strict').adopt([
                        { code: 'OPTION_IGNORED', option: 'x', message: 'x' },
                    ]),
                {
                    code: 'INPUT',
                },
            );
        });

        test('bitrates read units; small bare numbers read as kilobits', () => {
            const options = new OptionNormalizer();
            assert.equal(options.bitrate('bitrate', '192k', 'audio'), 192000);
            assert.equal(options.bitrate('bitrate', '2.5M', 'video'), 2500000);
            assert.equal(options.bitrate('bitrate', 128, 'audio'), 128000);
            assert.equal(options.bitrate('bitrate', 96000, 'audio'), 96000);
            assert.equal(options.bitrate('bitrate', 5e9, 'video'), 800_000_000);
            assert.equal(options.bitrate('bitrate', 'fast', 'audio'), undefined);
        });

        test('booleans, strings, callbacks and signals take loose forms or are ignored', () => {
            const options = new OptionNormalizer();
            assert.deepEqual(
                ['yes', 'off', 1, 'maybe'].map(value => options.boolean('loop', value)),
                [true, false, true, undefined],
            );
            assert.equal(options.string('title', '  Hi  '), 'Hi');
            assert.equal(options.string('title', ''), undefined);
            assert.equal(options.string('title', 'x'.repeat(300)), undefined);
            assert.equal(options.callback('onProgress', 1), undefined);
            assert.equal(options.signal('signal', {}), undefined);
            const controller = new AbortController();
            assert.equal(options.signal('signal', controller.signal), controller.signal);
        });

        test('choices fold case and aliases; an unknown one is refused unless optional', () => {
            const options = new OptionNormalizer();
            assert.equal(options.choice('fit', 'Cover', ['cover', 'contain']), 'cover');
            assert.equal(
                options.choice('fit', 'fill', ['cover', 'contain'], { aliases: { fill: 'cover' } }),
                'cover',
            );
            assert.equal(
                options.choice('fit', 'odd', ['cover', 'contain'], { fallback: 'contain' }),
                'contain',
            );
            assert.equal(
                options.choice('fit', 'odd', ['cover', 'contain'], { optional: true }),
                undefined,
            );
            assert.throws(() => options.choice('fit', 'odd', ['cover', 'contain']), {
                code: 'INPUT',
                message: /not one of cover, contain/,
            });
        });

        test('track ids drop duplicates and unusable entries', () => {
            const options = new OptionNormalizer();
            assert.deepEqual(options.ids('trackIds', [2, 2, -1, '3']), [2, 3]);
            assert.equal(options.ids('trackIds', []), undefined);
            assert.deepEqual(options.ids('trackIds', 4), [4]);
        });

        test('keys map case and aliases, and name unknown ones with a suggestion', () => {
            const options = new OptionNormalizer();
            const result = options.keys(
                { Bitrate: 1, sampleRate: 2, codex: 3 },
                ['bitrate', 'codec', 'rate'],
                { sampleRate: 'rate' },
            );
            assert.deepEqual(result, { bitrate: 1, rate: 2 });
            assert.match(
                options.findings.at(-1).message,
                /codex is not a known option and was ignored; did you mean codec\?/,
            );
        });
    });
});
