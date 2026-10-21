import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { open } from 'mediaforgejs';
import { IvfDemuxer } from 'mediaforgejs/formats';
import { distUrl } from '../helpers/dist-paths.mjs';
import { FIXTURES } from '../helpers/recorded-fixtures.mjs';

// What a reader may index and hold: the budget of an open input's sample index and the largest
// packet, which the demuxers built on PacketDemuxer (IVF here) read within.

const { DEMUX_LIMITS, DemuxIndexBudget, resolveDemuxBudget } = await import(
    distUrl('esm/formats/shared/demux-budget.js')
);

describe('formats/shared: demux budget', () => {
    test('the budget defaults to the sample limit and 128 MiB of index', () => {
        assert.deepEqual(resolveDemuxBudget(), {
            maxSamples: DEMUX_LIMITS.maxSamplesTotal,
            maxIndexBytes: 128 * 1024 * 1024,
        });
        assert.deepEqual(resolveDemuxBudget({ maxSamples: 5 }, 9).maxSamples, 5);
        assert.equal(resolveDemuxBudget({}, 9).maxSamples, 9);
    });

    test('budget options that are not positive integers fail with INPUT', () => {
        assert.throws(() => resolveDemuxBudget({ maxIndexBytes: 0 }), { code: 'INPUT' });
        assert.throws(() => resolveDemuxBudget({ maxSamples: 1.5 }), { code: 'INPUT' });
        assert.throws(() => resolveDemuxBudget(null), { code: 'INPUT' });
    });

    test('reservations beyond the budget fail with OOM, a negative count with DEMUX', () => {
        const budget = new DemuxIndexBudget({ maxSamples: 10, maxIndexBytes: 1000 });
        budget.reserveSamples(4, 100);
        assert.throws(() => budget.reserveSamples(7, 1), { code: 'OOM', message: /maxSamples/ });
        assert.throws(() => budget.reserveBytes(601), { code: 'OOM', message: /maxIndexBytes/ });
        budget.reserveBytes(600);
        assert.throws(() => budget.checkSamples(-1), { code: 'DEMUX' });
    });

    describe('a demuxer built on PacketDemuxer', () => {
        const ivf = () => FIXTURES['av1.ivf'].bytes();

        test('reads frames up to maxPacketBytes and refuses a larger one with OOM', async () => {
            const media = await open(ivf());
            let largest = 0;
            try {
                for await (const packet of media.packets())
                    largest = Math.max(largest, packet.data.length);
            } finally {
                media.close();
            }
            (await open(ivf(), { maxPacketBytes: largest })).close();
            await assert.rejects(open(ivf(), { maxPacketBytes: largest - 1 }), {
                code: 'OOM',
                message: /maxPacketBytes/,
            });
        });

        test('refuses more frames than maxSamples with OOM', async () => {
            await assert.rejects(open(ivf(), { maxSamples: 1 }), {
                code: 'OOM',
                message: /maxSamples/,
            });
        });

        test('is refused with INPUT when made with a limit that is not a positive integer', () => {
            for (const options of [{ maxIndexBytes: 0 }, { maxSamples: -1 }])
                assert.throws(() => new IvfDemuxer(options), { code: 'INPUT' });
        });
    });
});
