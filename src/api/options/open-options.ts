import type { OpenOptions } from '../../core/contracts/reader';
import type { MediaDiagnostic } from '../../core/errors/diagnostics';
import { MediaForgeError } from '../../core/errors/errors';
import { COMMON_KEYS, readOptions, warningOf } from './options';
import {
    OptionNormalizer,
    resolveOptionPolicy,
    type OptionFinding,
    type OptionPolicy,
} from '../../core/errors/option-policy';

interface ResolvedOpenOptions {
    readonly snapshot: OpenOptions;
    /**
     * strict validation also rejects unusable options; compatible repairs them with these findings.
     */
    readonly policy: OptionPolicy;
    readonly findings: readonly OptionFinding[];
}

const OPEN_OPTION_KEYS: readonly (keyof OpenOptions)[] = [
    'format',
    'signal',
    'recovery',
    'maxPacketBytes',
    'maxSamples',
    'maxIndexBytes',
    'cacheBytes',
    'readPageBytes',
    'validation',
    'metadataPolicy',
    'onWarning',
    'maxWarnings',
];

/**
 * Reads every open option once, then resolves it under the policy its own validation value implies.
 * Unknown keys are reported (case-folded spellings are read as the known option), so a misspelled
 * option never passes silently.
 */
export function resolveOpenOptions(options: OpenOptions = {}): ResolvedOpenOptions {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
        throw new MediaForgeError('Expected open options', 'INPUT');
    }

    const scan = new OptionNormalizer('lenient', 'open options');
    const {
        format,
        signal,
        recovery,
        maxPacketBytes,
        maxSamples,
        maxIndexBytes,
        cacheBytes,
        readPageBytes,
        validation,
        metadataPolicy,
        onWarning,
        maxWarnings,
    } = scan.keys(options, OPEN_OPTION_KEYS) as OpenOptions;

    const normalizer = new OptionNormalizer(resolveOptionPolicy(validation), 'open options');
    normalizer.adopt(scan.findings);
    const snapshot: OpenOptions = {
        format: normalizer.string('format', format, 32),
        signal: normalizer.signal('signal', signal),
        recovery: normalizer.choice('recovery', recovery, ['complete-packets'], {
            optional: true,
        }),
        maxPacketBytes: normalizer.number('maxPacketBytes', maxPacketBytes, {
            integer: true,
            positive: true,
        }),
        maxSamples: normalizer.number('maxSamples', maxSamples, { integer: true, positive: true }),
        maxIndexBytes: normalizer.number('maxIndexBytes', maxIndexBytes, {
            integer: true,
            positive: true,
        }),
        cacheBytes: normalizer.number('cacheBytes', cacheBytes, { integer: true, min: 0 }),
        readPageBytes: normalizer.number('readPageBytes', readPageBytes, {
            integer: true,
            positive: true,
        }),
        validation: normalizer.choice('validation', validation, ['strict', 'compatible'], {
            optional: true,
            aliases: { lenient: 'compatible', loose: 'compatible', tolerant: 'compatible' },
        }),
        metadataPolicy: normalizer.choice('metadataPolicy', metadataPolicy, ['warn', 'error'], {
            optional: true,
        }),
        onWarning: normalizer.callback<NonNullable<OpenOptions['onWarning']>>(
            'onWarning',
            onWarning,
        ),
        maxWarnings: normalizer.number('maxWarnings', maxWarnings, {
            integer: true,
            min: 0,
            max: 10000,
        }),
    };

    return { snapshot, policy: normalizer.policy, findings: normalizer.findings };
}

/**
 * The settings of a call's `options` under `keys`, each read once, and the warnings of its unknown
 * keys, reported as every call reports them: INPUT under the strict policy. Calls that start at
 * once (inspect(), play()) read them here, once their work loads.
 */
export function readCallOptions(
    options: unknown,
    keys: readonly string[],
    scope: string,
    policy: OptionPolicy,
): { settings: Record<string, unknown>; warnings: MediaDiagnostic[] } {
    const normalizer = new OptionNormalizer(policy, scope);
    const settings = normalizer.keys(readOptions(options, keys, COMMON_KEYS, scope), keys);
    return { settings, warnings: normalizer.findings.map(warningOf) };
}

/**
 * The settings of play() and a player's load(), read as readCallOptions() reads them, with the
 * rendition choices of `audio` and `subtitles` (false turns subtitles off) read the same way: an
 * unusable choice is dropped with a warning, or fails with INPUT under the strict policy.
 */
export function readPlayOptions(
    options: unknown,
    keys: readonly string[],
    policy: OptionPolicy,
): ReturnType<typeof readCallOptions> {
    const read = readCallOptions(options, keys, 'play options', policy);
    const normalizer = new OptionNormalizer(policy, 'play options');
    const { settings } = read;
    for (const key of ['audio', 'subtitles']) {
        const value = settings[key];
        if (value === undefined || (key === 'subtitles' && typeof value === 'boolean')) continue;
        delete settings[key];
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            normalizer.ignore(key, value, 'must be an object of name and language');
            continue;
        }
        const { name, language } = normalizer.keys(value, ['name', 'language']);
        const languages = typeof language === 'string' ? [language] : language;
        const choice: { name?: string; language?: string[] } = {};
        if (typeof name === 'string' && name) choice.name = name;
        else normalizer.ignore(`${key}.name`, name, 'must be a non-empty string');
        if (Array.isArray(languages) && languages.every(item => typeof item === 'string' && item))
            choice.language = [...languages];
        else normalizer.ignore(`${key}.language`, language, 'must be language tags');
        settings[key] = choice;
    }
    return { settings, warnings: [...read.warnings, ...normalizer.findings.map(warningOf)] };
}

/** The settings of inspect(), read as readCallOptions() reads them: `sampleCounts` is a boolean. */
export function readInspectOptions(
    options: unknown,
    policy: OptionPolicy,
): ReturnType<typeof readCallOptions> {
    const read = readCallOptions(options, ['signal', 'sampleCounts'], 'inspect options', policy);
    if (typeof (read.settings.sampleCounts ?? false) !== 'boolean')
        throw new MediaForgeError('sampleCounts must be a boolean', 'INPUT');
    return read;
}
