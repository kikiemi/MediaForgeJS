import { MediaForgeError } from './errors';
import { bitsPerSecond } from './bitrate';

/** lenient repairs or drops an unusable value and reports it; strict rejects it with code INPUT. */
export type OptionPolicy = 'lenient' | 'strict';

type OptionFindingCode = 'OPTION_NORMALIZED' | 'OPTION_IGNORED' | 'OPTION_UNKNOWN';

export interface OptionFinding {
    readonly code: OptionFindingCode;
    readonly option: string;
    readonly message: string;
}

interface NumberSpec {
    readonly min?: number;
    readonly max?: number;
    readonly integer?: boolean;
    /** Used when the value is unusable; omitted means the option is dropped. */
    readonly fallback?: number;
    /** Values at or below zero are unusable rather than clamped. */
    readonly positive?: boolean;
}

interface ChoiceSpec<T extends string> {
    readonly fallback?: T;
    readonly aliases?: Readonly<Record<string, T>>;
    /** An unsupported value is dropped instead of rejected when no fallback exists. */
    readonly optional?: boolean;
}

export function resolveOptionPolicy(value: unknown): OptionPolicy {
    return value === 'strict' ? 'strict' : 'lenient';
}

/** The candidate within two edits of `value` (case-insensitive), for "did you mean" messages. */
export function closestName(value: string, candidates: Iterable<string>): string | undefined {
    const wanted = value.trim().toLowerCase();
    let best: string | undefined;
    let bestDistance = 3;
    for (const candidate of candidates) {
        const name = candidate.toLowerCase();
        if (Math.abs(name.length - wanted.length) >= bestDistance) continue;
        let previous = Array.from({ length: name.length + 1 }, (_, index) => index);
        for (let row = 1; row <= wanted.length; row++) {
            const current = [row];
            for (let column = 1; column <= name.length; column++)
                current[column] = Math.min(
                    previous[column]! + 1,
                    current[column - 1]! + 1,
                    previous[column - 1]! + (wanted[row - 1] === name[column - 1] ? 0 : 1),
                );
            previous = current;
        }

        const distance = previous[name.length]!;
        if (distance < bestDistance && distance < Math.max(2, name.length)) {
            best = candidate;
            bestDistance = distance;
        }
    }
    return best;
}

function describe(value: unknown): string {
    if (typeof value === 'string') return JSON.stringify(value);
    if (typeof value === 'bigint') return `${value}n`;
    if (typeof value === 'symbol' || typeof value === 'function') return typeof value;
    if (value !== null && typeof value === 'object')
        return Array.isArray(value) ? 'array' : 'object';
    return String(value);
}

/**
 * Applies one option policy to a request: every repair, dropped value and unknown key is recorded
 * as a finding that the caller reports as a warning, or thrown as INPUT under the strict policy.
 */
export class OptionNormalizer {
    readonly findings: OptionFinding[] = [];

    constructor(
        readonly policy: OptionPolicy = 'lenient',
        private readonly scope = 'options',
    ) {}

    note(code: OptionFindingCode, option: string, message: string): void {
        const text = `${this.scope}: ${message}`;
        if (this.policy === 'strict') throw new MediaForgeError(text, 'INPUT');
        this.findings.push(Object.freeze({ code, option, message: text }));
    }

    /** Re-applies findings that were gathered before the policy itself was known. */
    adopt(findings: readonly OptionFinding[]): void {
        for (const finding of findings) {
            if (this.policy === 'strict') throw new MediaForgeError(finding.message, 'INPUT');
            this.findings.push(finding);
        }
    }

    number(option: string, value: unknown, spec: NumberSpec = {}): number | undefined {
        if (value === undefined || value === null) return spec.fallback;
        let result: number;
        if (typeof value === 'number') result = value;
        else if (typeof value === 'bigint') result = Number(value);
        else if (
            typeof value === 'string' &&
            value.trim() !== '' &&
            Number.isFinite(Number(value))
        ) {
            result = Number(value);
            this.note(
                'OPTION_NORMALIZED',
                option,
                `${option} read the string ${describe(value)} as ${result}`,
            );
        } else if (typeof value === 'boolean') {
            result = value ? 1 : 0;
            this.note('OPTION_NORMALIZED', option, `${option} read ${value} as ${result}`);
        } else {
            return this.unusable(option, value, spec.fallback);
        }

        if (!Number.isFinite(result)) return this.unusable(option, value, spec.fallback);
        if (spec.positive && result <= 0) return this.unusable(option, value, spec.fallback);
        if (spec.integer && !Number.isInteger(result)) {
            const rounded = Math.round(result);
            this.note('OPTION_NORMALIZED', option, `${option} ${result} was rounded to ${rounded}`);
            result = rounded;
        }
        if (spec.integer && !Number.isSafeInteger(result))
            return this.unusable(option, value, spec.fallback);
        if (spec.min !== undefined && result < spec.min) {
            this.note(
                'OPTION_NORMALIZED',
                option,
                `${option} ${result} was raised to the minimum ${spec.min}`,
            );
            result = spec.min;
        }
        if (spec.max !== undefined && result > spec.max) {
            this.note(
                'OPTION_NORMALIZED',
                option,
                `${option} ${result} was lowered to the maximum ${spec.max}`,
            );
            result = spec.max;
        }
        return result;
    }

    private unusable(
        option: string,
        value: unknown,
        fallback: number | undefined,
    ): number | undefined {
        this.note(
            fallback === undefined ? 'OPTION_IGNORED' : 'OPTION_NORMALIZED',
            option,
            fallback === undefined
                ? `${option} ${describe(value)} is not a usable number and was ignored`
                : `${option} ${describe(value)} is not a usable number; using ${fallback}`,
        );
        return fallback;
    }

    /** A bitrate in bits per second, read as bitsPerSecond() reads it; its readings are noted. */
    bitrate(option: string, value: unknown, kind: 'audio' | 'video'): number | undefined {
        if (value === undefined || value === null) return undefined;
        const input =
            typeof value === 'string' ? value : this.number(option, value, { positive: true });
        if (input === undefined) return undefined;
        const note = (message: string) =>
            this.note('OPTION_NORMALIZED', option, `${option} ${message}`);
        return bitsPerSecond(input, kind, note) ?? this.unusable(option, value, undefined);
    }

    boolean(option: string, value: unknown, fallback?: boolean): boolean | undefined {
        if (value === undefined || value === null) return fallback;
        if (typeof value === 'boolean') return value;
        const text = typeof value === 'string' ? value.trim().toLowerCase() : value;
        if (text === 'true' || text === 1 || text === '1' || text === 'yes' || text === 'on') {
            this.note('OPTION_NORMALIZED', option, `${option} read ${describe(value)} as true`);
            return true;
        }
        if (
            text === 'false' ||
            text === 0 ||
            text === '0' ||
            text === 'no' ||
            text === 'off' ||
            text === ''
        ) {
            this.note('OPTION_NORMALIZED', option, `${option} read ${describe(value)} as false`);
            return false;
        }
        this.note(
            'OPTION_IGNORED',
            option,
            `${option} ${describe(value)} is not a boolean and was ignored`,
        );
        return fallback;
    }

    choice<T extends string>(
        option: string,
        value: unknown,
        allowed: readonly T[],
        spec: ChoiceSpec<T> = {},
    ): T | undefined {
        if (value === undefined || value === null) return spec.fallback;
        if (typeof value === 'string') {
            if ((allowed as readonly string[]).includes(value)) return value as T;
            const folded = value.trim().toLowerCase();
            const direct = allowed.find(candidate => candidate.toLowerCase() === folded);
            const alias = direct ?? spec.aliases?.[folded];
            if (alias !== undefined) {
                this.note(
                    'OPTION_NORMALIZED',
                    option,
                    `${option} ${describe(value)} was read as ${describe(alias)}`,
                );
                return alias;
            }
        }

        if (spec.fallback === undefined) {
            if (!spec.optional) {
                throw new MediaForgeError(
                    `${this.scope}: ${option} ${describe(value)} is not one of ` +
                        `${allowed.join(', ')}`,
                    'INPUT',
                );
            }
            this.note(
                'OPTION_IGNORED',
                option,
                `${option} ${describe(value)} is not one of ${allowed.join(', ')} and was ignored`,
            );
            return undefined;
        }
        this.note(
            'OPTION_NORMALIZED',
            option,
            `${option} ${describe(value)} is not supported; using ${describe(spec.fallback)}`,
        );
        return spec.fallback;
    }

    string(option: string, value: unknown, maxLength = 256): string | undefined {
        if (value === undefined || value === null) return undefined;
        if (typeof value === 'string') {
            const trimmed = value.trim();
            if (trimmed === '') {
                this.note('OPTION_IGNORED', option, `${option} is empty and was ignored`);
                return undefined;
            }
            if (trimmed.length > maxLength) {
                this.note(
                    'OPTION_IGNORED',
                    option,
                    `${option} is longer than ${maxLength} characters and was ignored`,
                );
                return undefined;
            }
            if (trimmed !== value) this.note('OPTION_NORMALIZED', option, `${option} was trimmed`);
            return trimmed;
        }
        this.note(
            'OPTION_IGNORED',
            option,
            `${option} ${describe(value)} is not a string and was ignored`,
        );
        return undefined;
    }

    callback<T extends (...args: never[]) => unknown>(
        option: string,
        value: unknown,
    ): T | undefined {
        if (value === undefined || value === null) return undefined;
        if (typeof value === 'function') return value as T;
        this.note(
            'OPTION_IGNORED',
            option,
            `${option} ${describe(value)} is not a function and was ignored`,
        );
        return undefined;
    }

    signal(option: string, value: unknown): AbortSignal | undefined {
        if (value === undefined || value === null) return undefined;
        const candidate = value as AbortSignal;
        if (
            typeof candidate === 'object' &&
            typeof candidate.aborted === 'boolean' &&
            typeof candidate.addEventListener === 'function' &&
            typeof candidate.removeEventListener === 'function'
        )
            return candidate;
        this.note('OPTION_IGNORED', option, `${option} is not an AbortSignal and was ignored`);
        return undefined;
    }

    /**
     * Unique positive integer ids; unusable entries are dropped and an empty result means every
     * track.
     */
    ids(option: string, value: unknown): number[] | undefined {
        if (value === undefined || value === null) return undefined;
        const list = Array.isArray(value) ? value : typeof value === 'number' ? [value] : undefined;
        if (!list) {
            this.note(
                'OPTION_IGNORED',
                option,
                `${option} ${describe(value)} is not a list and was ignored`,
            );
            return undefined;
        }

        const result: number[] = [];
        for (const entry of list) {
            const id = this.number(`${option} entry`, entry, { integer: true, positive: true });
            if (id === undefined) continue;
            if (result.includes(id)) {
                this.note(
                    'OPTION_NORMALIZED',
                    option,
                    `${option} listed track ${id} more than once`,
                );
                continue;
            }
            result.push(id);
        }

        if (result.length === 0) {
            this.note(
                'OPTION_IGNORED',
                option,
                list.length
                    ? `${option} kept no usable track ids and was ignored`
                    : `${option} is empty and was ignored; every track is used`,
            );
            return undefined;
        }
        return result;
    }

    /** Drops a value that the request cannot use. */
    ignore(option: string, value: unknown, reason: string): void {
        if (value === undefined || value === null) return;
        this.note('OPTION_IGNORED', option, `${option} ${reason} and was ignored`);
    }

    /** Copies known keys, maps aliases onto their canonical key and reports the rest. */
    keys(
        input: object,
        known: Iterable<string>,
        aliases: Readonly<Record<string, string>> = {},
    ): Record<string, unknown> {
        const allowed = new Set(known);
        const result: Record<string, unknown> = {};
        const source = input as Record<string, unknown>;
        for (const key of Object.keys(source)) {
            if (allowed.has(key)) {
                result[key] = source[key];
                continue;
            }

            const canonical =
                aliases[key] ??
                [...allowed].find(candidate => candidate.toLowerCase() === key.toLowerCase());
            if (canonical !== undefined) {
                this.note('OPTION_NORMALIZED', key, `${key} was read as ${canonical}`);
                if (!(canonical in result) && source[canonical] === undefined)
                    result[canonical] = source[key];
                continue;
            }

            const suggestion = closestName(key, allowed);
            this.note(
                'OPTION_UNKNOWN',
                key,
                `${key} is not a known option and was ` +
                    `ignored${suggestion ? `; did you mean ${suggestion}?` : ''}`,
            );
        }

        for (const key of allowed) {
            if (!(key in result) && key in source) result[key] = source[key];
        }
        return result;
    }
}
