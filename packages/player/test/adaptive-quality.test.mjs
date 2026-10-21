import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { AdaptiveQualityController } from 'mediaforgejs-player';

// The bandwidth policy of adaptive playback: which choice a measured bandwidth selects.

describe('the adaptive quality controller', () => {
    test('selects among unsorted choices without reordering them', () => {
        const choices = Object.freeze([3000000, 500000, 1500000, 1500000, 1000000]);
        const quality = new AdaptiveQualityController({ initialBandwidth: 2000000 });
        assert.equal(quality.selectBandwidth(choices), 1500000);
        assert.equal(new AdaptiveQualityController().selectBandwidth(choices), 500000);
        assert.deepEqual(choices, [3000000, 500000, 1500000, 1500000, 1000000]);
    });

    test('reads each choice once, after the samples a getter adds', () => {
        const sampled = new AdaptiveQualityController({
            initialBandwidth: 100,
            bandwidthSafetyFactor: 1,
        });
        const sampledChoices = [100, 300, 500];
        let reads = 0;
        Object.defineProperty(sampledChoices, 1, {
            get() {
                reads++;
                sampled.addSample(125, 1000);
                return 300;
            },
        });
        assert.equal(sampled.selectBandwidth(sampledChoices), 500);
        assert.equal(reads, 1);
    });

    test('checks the choices before it reads the estimate', () => {
        let estimateReads = 0;
        class WithEstimate extends AdaptiveQualityController {
            get bandwidthEstimate() {
                estimateReads++;
                return 1000;
            }
        }
        const ordered = new WithEstimate();
        assert.throws(
            () => ordered.selectBandwidth([0], NaN),
            error => error.code === 'INPUT',
        );
        assert.throws(
            () => ordered.selectBandwidth([100], 200),
            error => error.code === 'INPUT',
        );
        assert.equal(estimateReads, 0);
        assert.equal(ordered.selectBandwidth([300, 100, 200]), 300);
        assert.equal(estimateReads, 1);
    });

    test('a sample of a vanishing duration keeps the estimate finite', () => {
        for (const duration of [1e-15, 1e-100, 1e-200, 1e-290]) {
            const tiny = new AdaptiveQualityController({
                bandwidthSafetyFactor: 1,
                upSwitchSegments: 1,
            });
            tiny.addSample(1, 1000);
            tiny.addSample(1000000, duration);
            assert(tiny.bandwidthEstimate > 1109043.48 && tiny.bandwidthEstimate < 1109043.5);
            assert.equal(tiny.selectBandwidth([1, 1000000]), 1000000);
        }
    });
});
