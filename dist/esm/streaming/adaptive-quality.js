import { MediaForgeError } from '../core/errors.js';
function positive(value, label) {
    if (!Number.isFinite(value) || value <= 0 || value > Number.MAX_SAFE_INTEGER) {
        throw new MediaForgeError(`Adaptive quality: invalid ${label}`, 'FORMAT');
    }
    return value;
}
export class AdaptiveQualityController {
    initialBandwidth;
    safetyFactor;
    upSwitchSegments;
    fast;
    slow;
    latest;
    samples = 0;
    selectedSample = 0;
    upgradeBandwidth;
    upgradeSamples = 0;
    constructor(options = {}) {
        if (!options || typeof options !== 'object' || Array.isArray(options)) {
            throw new MediaForgeError('Adaptive quality: options must be an object', 'FORMAT');
        }
        const initial = options.initialBandwidth;
        const safety = options.bandwidthSafetyFactor;
        const segments = options.upSwitchSegments;
        this.initialBandwidth = initial === undefined ? undefined : positive(initial, 'initialBandwidth');
        this.safetyFactor = positive(safety === undefined ? 0.75 : safety, 'bandwidthSafetyFactor');
        if (this.safetyFactor > 1)
            throw new MediaForgeError('Adaptive quality: bandwidthSafetyFactor must not exceed 1', 'FORMAT');
        this.upSwitchSegments = positive(segments === undefined ? 3 : segments, 'upSwitchSegments');
        if (!Number.isSafeInteger(this.upSwitchSegments))
            throw new MediaForgeError('Adaptive quality: upSwitchSegments must be an integer', 'FORMAT');
    }
    get bandwidthEstimate() {
        return this.fast === undefined || this.slow === undefined
            ? this.initialBandwidth
            : Math.min(this.fast, this.slow);
    }
    addSample(byteLength, elapsedMs) {
        if (!Number.isSafeInteger(byteLength) || byteLength < 0 || !Number.isFinite(elapsedMs) || elapsedMs < 0) {
            throw new MediaForgeError('Adaptive quality: invalid throughput sample', 'FORMAT');
        }
        if (!byteLength || !elapsedMs)
            return;
        const throughput = (byteLength * 8000) / elapsedMs;
        if (!Number.isFinite(throughput))
            throw new MediaForgeError('Adaptive quality: throughput sample overflow', 'FORMAT');
        const update = (previous, halfLifeMs) => {
            if (previous === undefined)
                return throughput;
            const exponent = (-Math.LN2 * elapsedMs) / halfLifeMs;
            const weight = Math.exp(exponent);
            return previous * weight + throughput * (weight === 1 ? -Math.expm1(exponent) : 1 - weight);
        };
        this.fast = update(this.fast, 2000);
        this.slow = update(this.slow, 5000);
        this.latest = throughput;
        this.samples++;
    }
    selectBandwidth(bandwidths, currentBandwidth) {
        if (!Array.isArray(bandwidths) || !bandwidths.length)
            throw new MediaForgeError('Adaptive quality: bandwidths must be a nonempty array', 'FORMAT');
        const available = Array.from(bandwidths, value => positive(value, 'bandwidth'));
        if (currentBandwidth !== undefined && !available.includes(positive(currentBandwidth, 'currentBandwidth'))) {
            throw new MediaForgeError('Adaptive quality: currentBandwidth must be an available choice', 'FORMAT');
        }
        const estimate = this.bandwidthEstimate;
        const budget = estimate === undefined ? 0 : Math.min(estimate, this.latest ?? estimate) * this.safetyFactor;
        let minimum = available[0];
        let selected = 0;
        for (const bandwidth of available) {
            if (bandwidth < minimum)
                minimum = bandwidth;
            if (bandwidth <= budget && bandwidth > selected)
                selected = bandwidth;
        }
        selected ||= minimum;
        if (currentBandwidth === undefined || selected <= currentBandwidth) {
            this.upgradeSamples = 0;
            this.upgradeBandwidth = undefined;
            this.selectedSample = this.samples;
            return selected;
        }
        if (this.selectedSample !== this.samples) {
            this.upgradeSamples = selected === this.upgradeBandwidth ? this.upgradeSamples + 1 : 1;
            this.upgradeBandwidth = selected;
            this.selectedSample = this.samples;
        }
        if (this.upgradeSamples < this.upSwitchSegments)
            return currentBandwidth;
        return selected;
    }
}
