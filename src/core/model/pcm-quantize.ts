/**
 * The library's one rule for writing a float sample as a signed integer of `bits` bits: the value
 * scaled by 2^(bits−1), rounded half up and clamped to the integer's range, so ±1 become its ends
 * and an integer read as integer / 2^(bits−1) is written back as itself. A sample that is not a
 * number is written as silence.
 */
export function quantizeSample(value: number, bits: number): number {
    const scale = 2 ** (bits - 1);
    const sample = Math.floor(value * scale + 0.5);
    if (sample >= scale) return scale - 1;
    if (sample < -scale) return -scale;
    return sample === sample ? sample : 0;
}
