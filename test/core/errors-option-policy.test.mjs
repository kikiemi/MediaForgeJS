import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
// The normalizer every option reader shares; it has no public face of its own.
import { OptionNormalizer } from '../../dist/esm/core/errors/option-policy.js';

// The option policy: a lenient normalizer repairs or drops what it can and reports each finding
// (OPTION_NORMALIZED, OPTION_IGNORED, OPTION_UNKNOWN); a strict one refuses with INPUT instead.

const codesOf = findings => findings.map(finding => finding.code);
const inputError = error => error.code === 'INPUT';

/** A lenient normalizer and the codes of the findings since the last call of `since`. */
function lenient() {
    const normalizer = new OptionNormalizer();
    let seen = 0;
    const since = () => {
        const fresh = codesOf(normalizer.findings.slice(seen));
        seen = normalizer.findings.length;
        return fresh;
    };
    return { normalizer, since };
}

describe('core/errors option policy', () => {
    test('numbers are parsed, rounded and clamped, or dropped, with a finding each', () => {
        const { normalizer, since } = lenient();
        const cases = [
            [['rate', '48000', { integer: true }], 48000, ['OPTION_NORMALIZED']],
            [['rate', 1.5, { integer: true }], 2, ['OPTION_NORMALIZED']],
            [['rate', 5n, { integer: true }], 5, []],
            [['rate', 7, { max: 4 }], 4, ['OPTION_NORMALIZED']],
            [['rate', -7, { min: 0 }], 0, ['OPTION_NORMALIZED']],
            [['rate', NaN], undefined, ['OPTION_IGNORED']],
            [['rate', 'many', { fallback: 3 }], 3, ['OPTION_NORMALIZED']],
            [['rate', 0, { positive: true }], undefined, ['OPTION_IGNORED']],
            [['rate', 2 ** 53, { integer: true }], undefined, ['OPTION_IGNORED']],
            [['rate', undefined, { fallback: 9 }], 9, []],
        ];
        for (const [args, value, codes] of cases) {
            assert.equal(normalizer.number(...args), value, String(args[1]));
            assert.deepEqual(since(), codes, String(args[1]));
        }
    });

    test('booleans and choices read common spellings and aliases', () => {
        const { normalizer, since } = lenient();
        assert.equal(normalizer.boolean('flag', 'yes'), true);
        assert.equal(normalizer.boolean('flag', 'OFF'), false);
        assert.deepEqual(since(), ['OPTION_NORMALIZED', 'OPTION_NORMALIZED']);
        assert.equal(normalizer.boolean('flag', 'maybe', true), true);
        assert.deepEqual(since(), ['OPTION_IGNORED']);
        const modes = ['strict', 'compatible'];
        assert.equal(normalizer.choice('mode', 'STRICT', modes), 'strict');
        const aliases = { aliases: { loose: 'compatible' } };
        assert.equal(normalizer.choice('mode', 'loose', modes, aliases), 'compatible');
        assert.deepEqual(since(), ['OPTION_NORMALIZED', 'OPTION_NORMALIZED']);
        assert.equal(normalizer.choice('mode', 'odd', modes, { optional: true }), undefined);
        assert.deepEqual(since(), ['OPTION_IGNORED']);
        assert.equal(
            normalizer.choice('mode', 'odd', modes, { fallback: 'compatible' }),
            'compatible',
        );
        assert.deepEqual(since(), ['OPTION_NORMALIZED']);
    });

    test('a required choice without a usable value fails with INPUT, lenient or not', () => {
        const { normalizer, since } = lenient();
        assert.throws(() => normalizer.choice('mode', 'odd', ['strict', 'compatible']), inputError);
        assert.deepEqual(since(), []);
    });

    test('track ids drop duplicates and values that are no ids', () => {
        const { normalizer, since } = lenient();
        assert.deepEqual(normalizer.ids('trackIds', [1, 1, '2', 0, -3, 'x']), [1, 2]);
        assert.deepEqual(since(), [
            'OPTION_NORMALIZED',
            'OPTION_NORMALIZED',
            'OPTION_IGNORED',
            'OPTION_IGNORED',
            'OPTION_IGNORED',
        ]);
        assert.deepEqual(normalizer.ids('trackIds', 7), [7]);
        assert.deepEqual(since(), []);
        assert.equal(normalizer.ids('trackIds', []), undefined);
        assert.deepEqual(since(), ['OPTION_IGNORED']);
        assert.equal(normalizer.ids('trackIds', ['x']), undefined);
        assert.deepEqual(since(), ['OPTION_IGNORED', 'OPTION_IGNORED']);
    });

    test('strings are trimmed; empty or other values are dropped', () => {
        const { normalizer, since } = lenient();
        assert.equal(normalizer.string('name', '  spaced  '), 'spaced');
        assert.equal(normalizer.string('name', ''), undefined);
        assert.equal(normalizer.string('name', 42), undefined);
        assert.deepEqual(since(), ['OPTION_NORMALIZED', 'OPTION_IGNORED', 'OPTION_IGNORED']);
    });

    test('keys match case-insensitively and by alias; others are unknown', () => {
        const { normalizer, since } = lenient();
        assert.deepEqual(
            normalizer.keys({ Format: 'wav', to: 'mp4', other: 1 }, ['format'], { to: 'format' }),
            { format: 'wav' },
        );
        assert.deepEqual(since(), ['OPTION_NORMALIZED', 'OPTION_NORMALIZED', 'OPTION_UNKNOWN']);
    });

    test('findings are frozen and their messages name the scope', () => {
        const { normalizer } = lenient();
        normalizer.number('rate', '1');
        normalizer.keys({ other: 1 }, ['format']);
        assert.ok(
            normalizer.findings.every(
                finding => Object.isFrozen(finding) && finding.message.startsWith('options: '),
            ),
        );
    });

    test('a strict normalizer refuses every repair with INPUT and accepts clean values', () => {
        const rejecting = new OptionNormalizer('strict');
        assert.throws(() => rejecting.number('rate', '48000'), inputError);
        assert.throws(() => rejecting.number('rate', 1.5, { integer: true }), inputError);
        assert.throws(() => rejecting.boolean('flag', 'yes'), inputError);
        assert.throws(() => rejecting.choice('mode', 'STRICT', ['strict']), inputError);
        assert.throws(() => rejecting.ids('trackIds', [1, 1]), inputError);
        assert.throws(() => rejecting.ids('trackIds', []), inputError);
        assert.throws(() => rejecting.keys({ other: 1 }, ['format']), inputError);
        assert.equal(rejecting.number('rate', 48000), 48000);
        assert.equal(rejecting.findings.length, 0);
    });

    test('bitrates are bits per second; small numbers are read as kbit/s and reported', () => {
        const { normalizer, since } = lenient();
        const cases = [
            [128_000, 'audio', 128_000, []],
            [128, 'audio', 128_000, ['OPTION_NORMALIZED']],
            [1920, 'audio', 1920, ['OPTION_NORMALIZED']],
            [8000, 'audio', 8000, []],
            ['192k', 'audio', 192_000, []],
            ['192 kbps', 'audio', 192_000, []],
            ['2.5M', 'video', 2_500_000, []],
            ['2.5 Mbps', 'video', 2_500_000, []],
            ['640kbit/s', 'video', 640_000, []],
            ['96000', 'audio', 96_000, []],
            ['96', 'audio', 96_000, ['OPTION_NORMALIZED']],
            [2500, 'video', 2_500_000, ['OPTION_NORMALIZED']],
            [50_000, 'video', 50_000, ['OPTION_NORMALIZED']],
            [2_000_000, 'video', 2_000_000, []],
            ['fast', 'video', undefined, ['OPTION_IGNORED']],
            [-5, 'audio', undefined, ['OPTION_IGNORED']],
            [undefined, 'audio', undefined, []],
        ];
        for (const [value, kind, bits, codes] of cases) {
            const label = `${kind} ${JSON.stringify(value)}`;
            assert.equal(normalizer.bitrate('bitrate', value, kind), bits, label);
            assert.deepEqual(since(), codes, label);
        }
    });

    test('strictly, a kbit/s number is refused and text with a unit accepted', () => {
        const strict = new OptionNormalizer('strict');
        assert.throws(() => strict.bitrate('bitrate', 128, 'audio'), inputError);
        assert.equal(strict.bitrate('bitrate', '128k', 'audio'), 128_000);
    });
});
