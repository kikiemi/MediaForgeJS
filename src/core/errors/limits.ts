import { MediaForgeError, type ErrorCode } from './errors';

/** A count or byte limit: `value`, or `fallback` when unset, as a positive safe integer. */
export function positiveLimit(
    value: number | undefined,
    fallback: number,
    name: string,
    code: ErrorCode = 'INPUT',
): number {
    const result = value ?? fallback;
    if (!Number.isSafeInteger(result) || result < 1)
        throw new MediaForgeError(`${name} must be a positive safe integer`, code);
    return result;
}
