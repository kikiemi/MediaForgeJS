/** The modified Bessel function of the first kind and order zero, I0(x), by its power series. */
export function besselI0(x: number): number {
    let sum = 1;
    let term = 1;
    for (let k = 1; k < 40; k++) {
        term *= (x * x) / (4 * k * k);
        sum += term;
        if (term < 1e-18 * sum) break;
    }
    return sum;
}

/** Rising half (n taps) of a Kaiser-Bessel-derived window of length 2n, as AAC and AC-3 use it. */
export function kbdWindow(n: number, alpha: number): Float64Array {
    const kernel = new Float64Array(n + 1);
    for (let i = 0; i <= n; i++) {
        const t = (2 * i) / n - 1;
        kernel[i] = besselI0(Math.PI * alpha * Math.sqrt(Math.max(0, 1 - t * t)));
    }
    let total = 0;
    for (let i = 0; i <= n; i++) total += kernel[i]!;
    const window = new Float64Array(n);
    let sum = 0;
    for (let i = 0; i < n; i++) {
        sum += kernel[i]!;
        window[i] = Math.sqrt(sum / total);
    }
    return window;
}
