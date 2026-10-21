import { MediaForgeError, throwIfAborted } from '../../core/errors/errors';
import { assertAbortSignal } from '../../core/io/abort';
import type { PackageOptions, PackagedFile, ResolvedPackageOptions } from './types';

export const PACKAGE_MAX_SEGMENTS = 1_000_000;
const DEFAULT_MAX_SEGMENTS = 100_000;

/**
 * Byte budget of a package collected into memory; files taken one by one have none unless
 * requested.
 */
export const COLLECTED_PACKAGE_BYTES = 1024 * 1024 * 1024;
const DEFAULT_BUFFERED_BYTES = 128 * 1024 * 1024;
const DEFAULT_BUFFERED_SAMPLES = 100_000;
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;

export function packageError(message: string, code: MediaForgeError['code'] = 'INPUT'): never {
    throw new MediaForgeError(`Packaging: ${message}`, code);
}

function integerOption(
    value: number | undefined,
    fallback: number,
    label: string,
    maximum: number,
): number {
    const result = value ?? fallback;
    if (!Number.isSafeInteger(result) || result < 1 || result > maximum)
        packageError(`${label} must be an integer between 1 and ${maximum}`);
    return result;
}

/** Validates the options shared by every packager and fixes the values used for the whole run. */
export function snapshotPackageOptions(options: PackageOptions): ResolvedPackageOptions {
    if (!options || typeof options !== 'object' || Array.isArray(options))
        packageError('expected package options');
    const {
        trackIds,
        targetDuration,
        maxSegments,
        maxTotalBytes,
        maxBufferedBytes,
        maxBufferedSamples,
        signal,
        onProgress,
    } = options;

    assertAbortSignal(signal);
    throwIfAborted(signal);
    if (onProgress !== undefined && typeof onProgress !== 'function')
        packageError('onProgress must be a function');

    const target = targetDuration ?? 6;
    if (typeof target !== 'number' || !Number.isFinite(target) || target < 0.1 || target > 3600)
        packageError('targetDuration must be between 0.1 and 3600 seconds');
    if (
        trackIds !== undefined &&
        (!Array.isArray(trackIds) ||
            !trackIds.length ||
            new Set(trackIds).size !== trackIds.length ||
            trackIds.some(id => !Number.isSafeInteger(id) || id < 1))
    )
        packageError('trackIds must be a nonempty list of unique positive integers');

    return {
        trackIds: trackIds?.slice(),
        targetDuration: target,
        maxSegments: integerOption(
            maxSegments,
            DEFAULT_MAX_SEGMENTS,
            'maxSegments',
            PACKAGE_MAX_SEGMENTS,
        ),
        maxTotalBytes: integerOption(
            maxTotalBytes,
            Number.MAX_SAFE_INTEGER,
            'maxTotalBytes',
            Number.MAX_SAFE_INTEGER,
        ),
        maxBufferedBytes: integerOption(
            maxBufferedBytes,
            DEFAULT_BUFFERED_BYTES,
            'maxBufferedBytes',
            0x7f000000,
        ),
        maxBufferedSamples: integerOption(
            maxBufferedSamples,
            DEFAULT_BUFFERED_SAMPLES,
            'maxBufferedSamples',
            1_000_000,
        ),
        signal,
        onProgress,
    };
}

/** Accepts one segment file name pattern holding a single %d or zero-padded %0Nd placeholder. */
export function segmentNamePattern(pattern: string, label: string): (number: number) => string {
    const match =
        typeof pattern === 'string'
            ? /^([A-Za-z0-9._-]*)%(0[1-9])?d([A-Za-z0-9._-]*)$/.exec(pattern)
            : null;
    if (!match || !NAME_PATTERN.test(`${match[1]}0${match[3]}`))
        packageError(`${label} must be a file name containing one %d or %0Nd placeholder`);
    const width = match[2] ? Number(match[2].slice(1)) : 0;
    return number => `${match[1]}${String(number).padStart(width, '0')}${match[3]}`;
}

export function assertPackageName(name: string): string {
    if (typeof name !== 'string' || !NAME_PATTERN.test(name))
        packageError(`invalid package file name ${JSON.stringify(String(name))}`, 'IO');
    return name;
}

/**
 * The request with the 1 GiB collection budget where it sets no maxTotalBytes; other settings are
 * inherited as given.
 */
export function collectedPackageRequest<T extends { readonly maxTotalBytes?: number }>(
    request: T,
): T {
    if (!request || typeof request !== 'object') return request;
    const maxTotalBytes = request.maxTotalBytes;
    return Object.create(request, {
        maxTotalBytes: { value: maxTotalBytes ?? COLLECTED_PACKAGE_BYTES, enumerable: true },
    }) as T;
}

/** Collects a package into a name-keyed map; duplicate names fail with code IO. */
export async function collectPackage(
    files: AsyncIterable<PackagedFile>,
): Promise<Map<string, PackagedFile>> {
    const result = new Map<string, PackagedFile>();
    for await (const file of files) {
        if (result.has(file.name)) packageError(`duplicate package file ${file.name}`, 'IO');
        result.set(file.name, file);
    }
    return result;
}
