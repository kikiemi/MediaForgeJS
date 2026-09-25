export interface AdaptiveQualityOptions {
    /** Initial throughput estimate in bits per second; omitted starts at the lowest bandwidth. */
    initialBandwidth?: number;
    /** Fraction of measured throughput available to media. Default 0.75; range (0, 1]. */
    bandwidthSafetyFactor?: number;
    /** Consecutive successful media-unit samples required to increase bandwidth. Default 3. */
    upSwitchSegments?: number;
}
/** Throughput policy only; callers own fetching, alignment, initialization, and decoding. */
export declare class AdaptiveQualityController {
    private readonly initialBandwidth;
    private readonly safetyFactor;
    private readonly upSwitchSegments;
    private fast;
    private slow;
    private latest;
    private samples;
    private selectedSample;
    private upgradeBandwidth;
    private upgradeSamples;
    constructor(options?: AdaptiveQualityOptions);
    /** Minimum of 2-second and 5-second throughput EWMAs, in bits per second. */
    get bandwidthEstimate(): number | undefined;
    /** Samples include request and body time, excluding caller backpressure. Zero-length/zero-time samples are ignored. */
    addSample(byteLength: number, elapsedMs: number): void;
    /** Returns a supplied bandwidth; a poor latest sample lowers quality immediately, upgrades require sustained samples. */
    selectBandwidth(bandwidths: readonly number[], currentBandwidth?: number): number;
}
