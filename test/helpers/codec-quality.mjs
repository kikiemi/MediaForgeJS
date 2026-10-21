// Measures for lossy codecs: test signals with one unambiguous alignment, signal-to-noise ratios
// and the delay, level and peak of a decode against its source.

/** A linear chirp: aperiodic, so a cross-correlation finds one delay. */
export function chirp(frames, rate, reverse = false, amplitude = 0.3) {
    const out = new Float32Array(frames);
    let phase = 0;
    for (let index = 0; index < frames; index++) {
        const position = (reverse ? frames - 1 - index : index) / frames;
        phase += (2 * Math.PI * (100 + Math.min(6000, rate * 0.4) * position)) / rate;
        out[index] = amplitude * Math.sin(phase);
    }
    return out;
}

/** Signal-to-noise ratio in dB of `candidate` (from `offset`) against `reference`. */
export function snrDb(reference, candidate, offset = 0) {
    let signal = 0;
    let noise = 0;
    for (let index = 0; index < reference.length; index++) {
        signal += reference[index] ** 2;
        noise += (reference[index] - candidate[index + offset]) ** 2;
    }
    return 10 * Math.log10(signal / Math.max(noise, 1e-30));
}

/**
 * The delay of `decoded` behind `reference` (by cross-correlation, up to 2048 samples), then the
 * SNR in dB, the level ratio and the peak over the aligned middle.
 */
export function analyze(reference, decoded) {
    let delay = 0;
    let best = -Infinity;
    for (let lag = 0; lag <= 2048; lag++) {
        let sum = 0;
        for (let index = 2048; index < 2048 + 8192; index++)
            sum += reference[index] * (decoded[index + lag] ?? 0);
        if (sum > best) [best, delay] = [sum, lag];
    }
    let noise = 0;
    let signal = 0;
    let energy = 0;
    let peak = 0;
    for (let index = 4096; index < reference.length - 4096; index++) {
        const value = decoded[index + delay] ?? 0;
        noise += (reference[index] - value) ** 2;
        signal += reference[index] ** 2;
        energy += value * value;
        peak = Math.max(peak, Math.abs(value));
    }
    return { delay, snr: 10 * Math.log10(signal / noise), level: Math.sqrt(energy / signal), peak };
}

/** Relative power of `frequency` in `plane` (Goertzel), as a share of the plane's power. */
export function toneShare(plane, frequency, rate = 48000) {
    const coefficient = 2 * Math.cos((2 * Math.PI * frequency) / rate);
    let previous = 0;
    let before = 0;
    let energy = 0;
    for (const value of plane) {
        const next = value + coefficient * previous - before;
        before = previous;
        previous = next;
        energy += value * value;
    }
    const power = previous * previous + before * before - coefficient * previous * before;
    return (2 * power) / (plane.length * energy || 1);
}
