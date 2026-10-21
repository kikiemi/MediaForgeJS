import type { CodecPreference } from '../../pipeline/api-types';
import type { OptionNormalizer } from '../../core/errors/option-policy';
import { MediaForgeError } from '../../core/errors/errors';
import type { MediaDiagnostic } from '../../core/errors/diagnostics';
import type { CommonOptions } from '../types';

/** The options every call accepts besides its own settings. */
export const COMMON_KEYS: readonly (keyof CommonOptions)[] = Object.freeze([
    'plugins',
    'onWarning',
    'optionPolicy',
    'codecPreference',
    'open',
]);

/** The input-reading options of open(). */
export const OPEN_KEYS: readonly string[] = Object.freeze([
    'format',
    'signal',
    'validation',
    'metadataPolicy',
    'onWarning',
    'maxWarnings',
    'recovery',
    'maxPacketBytes',
    'cacheBytes',
    'readPageBytes',
    'maxSamples',
    'maxIndexBytes',
]);

/** The settings of a target: its format, tracks, range, codec settings, output and callbacks. */
export const TARGET_KEYS: readonly string[] = [
    'to',
    'trackIds',
    'start',
    'end',
    'video',
    'audio',
    'image',
    'copy',
    'allowPrecisionLoss',
    'container',
    'targetDuration',
    'encryption',
    'programDateTime',
    'maxBytes',
    'sink',
    'codecPreference',
    'signal',
    'onProgress',
    'onPlan',
    'onFile',
];

/** A frozen warning from an option finding. */
export function warningOf(finding: {
    readonly code: string;
    readonly message: string;
    readonly trackId?: number;
    readonly format?: string;
}): MediaDiagnostic {
    const { code, message, trackId, format } = finding;
    return Object.freeze({
        code,
        message,
        ...(trackId !== undefined ? { trackId } : {}),
        ...(format !== undefined ? { format } : {}),
        severity: 'warning',
    });
}

function assertObject(options: unknown, scope: string): asserts options is Record<string, unknown> {
    if (!options || typeof options !== 'object' || Array.isArray(options))
        throw new MediaForgeError(`Expected ${scope} as an object`, 'INPUT');
}

/**
 * A plain copy of `options`: its own enumerable keys and the `known` keys it inherits or defines as
 * non-enumerable, each read once from `options`; `skip` keys are left out and not read. Unknown own
 * keys stay for the caller's normalizer to report.
 */
export function readOptions(
    options: unknown,
    known: readonly string[],
    skip: readonly string[] = [],
    scope = 'options',
): Record<string, unknown> {
    if (options === undefined) return {};
    assertObject(options, scope);
    const copy: Record<string, unknown> = {};
    for (const key of Object.keys(options)) if (!skip.includes(key)) copy[key] = options[key];
    for (const key of known)
        if (!(key in copy) && !skip.includes(key) && key in options) copy[key] = options[key];
    return copy;
}

/**
 * The common options of a call, each read once; absent and undefined keys stay absent, so they keep
 * the instance's defaults.
 */
export function readCommon(options: unknown): CommonOptions {
    if (options === undefined) return {};
    assertObject(options, 'options');
    const common: Record<string, unknown> = {};
    for (const key of COMMON_KEYS) {
        if (!(key in options)) continue;
        const value = options[key];
        if (value !== undefined) common[key] = value;
    }
    return common as CommonOptions;
}

const CODEC_PREFERENCES = ['webcodecs', 'builtin'] as const;

/**
 * Reads a codecPreference; an unusable value is dropped with a finding, so the 'webcodecs' default
 * applies.
 */
export function codecPreferenceOf(
    normalizer: OptionNormalizer,
    value: unknown,
): CodecPreference | undefined {
    return normalizer.choice('codecPreference', value, CODEC_PREFERENCES, {
        optional: true,
        aliases: {
            host: 'webcodecs',
            browser: 'webcodecs',
            'built-in': 'builtin',
            library: 'builtin',
            software: 'builtin',
        },
    });
}
