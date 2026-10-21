import { MediaForgeError } from '../errors/errors';

/** Greatest common divisor of two finite numbers rounded to integers; 1 when both are zero. */
export function gcd(a: number, b: number): number {
    if (!Number.isFinite(a) || !Number.isFinite(b))
        throw new MediaForgeError('a ratio must be finite', 'INPUT');
    a = Math.abs(Math.round(a));
    b = Math.abs(Math.round(b));
    while (b !== 0) [a, b] = [b, a % b];
    return Math.max(1, a);
}

/** Greatest common divisor of two non-negative bigints; 0 when both are zero. */
export function bigGcd(a: bigint, b: bigint): bigint {
    while (b !== 0n) [a, b] = [b, a % b];
    return a;
}
