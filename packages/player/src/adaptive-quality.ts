import { MediaForgeError } from 'mediaforgejs/plugins';

export interface AdaptiveQualityOptions {
    /** Initial throughput estimate in bits per second; omitted starts at the lowest bandwidth. */
    initialBandwidth?: number;
    /** Fraction of measured throughput available to media. Default 0.75; range (0, 1]. */
    bandwidthSafetyFactor?: number;
    /** Consecutive successful media-unit samples required to increase bandwidth. Default 3. */
    upSwitchSegments?: number;
}

function positive(value: number, label: string): number {
    if (!Number.isFinite(value) || value <= 0 || value > Number.MAX_SAFE_INTEGER) {
        throw new MediaForgeError(`Adaptive quality: invalid ${label}`, 'INPUT');
    }
    return value;
}

/** Throughput policy only; callers own fetching, alignment, initialization, and decoding. */
export class AdaptiveQualityController {
    private readonly initialBandwidth: number | undefined;
    private readonly safetyFactor: number;
    private readonly upSwitchSegments: number;
    private fast: number | undefined;
    private slow: number | undefined;
    private latest: number | undefined;
    private samples = 0;
    private selectedSample = 0;
    private upgradeBandwidth: number | undefined;
    private upgradeSamples = 0;

    constructor(options: AdaptiveQualityOptions = {}) {
        if (!options || typeof options !== 'object' || Array.isArray(options)) {
            throw new MediaForgeError('Adaptive quality: options must be an object', 'INPUT');
        }

        const initial = options.initialBandwidth;
        const safety = options.bandwidthSafetyFactor;
        const segments = options.upSwitchSegments;
        this.initialBandwidth =
            initial === undefined ? undefined : positive(initial, 'initialBandwidth');
        this.safetyFactor = positive(safety === undefined ? 0.75 : safety, 'bandwidthSafetyFactor');
        if (this.safetyFactor > 1)
            throw new MediaForgeError(
                'Adaptive quality: bandwidthSafetyFactor must not exceed 1',
                'INPUT',
            );
        this.upSwitchSegments = positive(segments === undefined ? 3 : segments, 'upSwitchSegments');
        if (!Number.isSafeInteger(this.upSwitchSegments))
            throw new MediaForgeError(
                'Adaptive quality: upSwitchSegments must be an integer',
                'INPUT',
            );
    }

    /** Minimum of 2-second and 5-second throughput EWMAs, in bits per second. */
    get bandwidthEstimate(): number | undefined {
        return this.fast === undefined || this.slow === undefined
            ? this.initialBandwidth
            : Math.min(this.fast, this.slow);
    }

    /**
     * Samples include request and body time, excluding caller backpressure. Zero-length/zero-time
     * samples are ignored.
     */
    addSample(byteLength: number, elapsedMs: number): void {
        if (
            !Number.isSafeInteger(byteLength) ||
            byteLength < 0 ||
            !Number.isFinite(elapsedMs) ||
            elapsedMs < 0
        ) {
            throw new MediaForgeError('Adaptive quality: invalid throughput sample', 'INPUT');
        }

        if (!byteLength || !elapsedMs) return;
        const throughput = (byteLength * 8000) / elapsedMs;
        if (!Number.isFinite(throughput))
            throw new MediaForgeError('Adaptive quality: throughput sample overflow', 'INPUT');
        const update = (previous: number | undefined, halfLifeMs: number): number => {
            if (previous === undefined) return throughput;
            const exponent = (-Math.LN2 * elapsedMs) / halfLifeMs;
            const weight = Math.exp(exponent);
            return (
                previous * weight + throughput * (weight === 1 ? -Math.expm1(exponent) : 1 - weight)
            );
        };

        this.fast = update(this.fast, 2000);
        this.slow = update(this.slow, 5000);
        this.latest = throughput;
        this.samples++;
    }

    /**
     * Returns a supplied bandwidth; a poor latest sample lowers quality immediately, upgrades
     * require sustained samples.
     */
    selectBandwidth(bandwidths: readonly number[], currentBandwidth?: number): number {
        if (!Array.isArray(bandwidths) || !bandwidths.length)
            throw new MediaForgeError(
                'Adaptive quality: bandwidths must be a nonempty array',
                'INPUT',
            );
        const available = Array.from(bandwidths, value => positive(value, 'bandwidth'));
        if (
            currentBandwidth !== undefined &&
            !available.includes(positive(currentBandwidth, 'currentBandwidth'))
        ) {
            throw new MediaForgeError(
                'Adaptive quality: currentBandwidth must be an available choice',
                'INPUT',
            );
        }

        const estimate = this.bandwidthEstimate;
        const budget =
            estimate === undefined
                ? 0
                : Math.min(estimate, this.latest ?? estimate) * this.safetyFactor;

        let minimum = available[0];
        let selected = 0;
        for (const bandwidth of available) {
            if (bandwidth < minimum) minimum = bandwidth;
            if (bandwidth <= budget && bandwidth > selected) selected = bandwidth;
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

        if (this.upgradeSamples < this.upSwitchSegments) return currentBandwidth;
        return selected;
    }
}
