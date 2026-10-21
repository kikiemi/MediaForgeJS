import { DemuxError } from './errors';

export function demuxAssert(condition: unknown, message: string): asserts condition {
    if (!condition) malformedInput(message);
}

/**
 * Fails a parse on malformed input. Checks that run per element or per block call it behind their
 * condition rather than passing demuxAssert a message built on every call.
 */
export function malformedInput(message: string): never {
    throw new DemuxError(`Malformed input: ${message}`);
}

/**
 * A parser's failure as the caller sees it: a RangeError, a read past a view's end or structures
 * nested past the call stack, is malformed input.
 */
export function demuxFailure(error: unknown): unknown {
    if (!(error instanceof RangeError)) return error;
    const nested = /call stack/i.test(error.message);
    const what = nested ? 'structures nest too deep' : 'a structure reads past the data';
    return new DemuxError(`Malformed input: ${what}`, { cause: error });
}
