// node:assert/strict for the browser test page: the functions the test files use, with the strict
// comparisons of Node. The page's import map points 'node:assert/strict' here.

export class AssertionError extends Error {
    constructor({ message, actual, expected, operator }) {
        super(message);
        this.name = 'AssertionError';
        this.code = 'ERR_ASSERTION';
        this.actual = actual;
        this.expected = expected;
        this.operator = operator;
    }
}

const show = value => {
    try {
        if (typeof value === 'string') return JSON.stringify(value);
        if (typeof value === 'bigint') return `${value}n`;
        if (ArrayBuffer.isView(value))
            return `${value.constructor.name}(${value.length ?? value.byteLength}) [${Array.from(
                value.length === undefined ? new Uint8Array(value.buffer) : value,
            )
                .slice(0, 16)
                .join(', ')}${(value.length ?? value.byteLength) > 16 ? ', …' : ''}]`;
        return JSON.stringify(value, (_, item) => (typeof item === 'bigint' ? `${item}n` : item));
    } catch {
        return String(value);
    }
};

function raise(message, actual, expected, operator, fallback) {
    if (message instanceof Error) throw message;
    throw new AssertionError({ message: message ?? fallback, actual, expected, operator });
}

/** Node's strict deep equality: same prototypes, own enumerable keys, values and entries. */
function equalDeep(a, b, seen = new Map()) {
    if (Object.is(a, b)) return true;
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
    if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
    if (seen.get(a) === b) return true;
    seen.set(a, b);
    if (a instanceof Date) return a.getTime() === b.getTime();
    if (a instanceof RegExp) return String(a) === String(b);
    if (a instanceof Error && (a.message !== b.message || a.name !== b.name)) return false;
    if (ArrayBuffer.isView(a) || a instanceof ArrayBuffer) {
        const x = new Uint8Array(ArrayBuffer.isView(a) ? a.buffer : a, a.byteOffset, a.byteLength);
        const y = new Uint8Array(ArrayBuffer.isView(b) ? b.buffer : b, b.byteOffset, b.byteLength);
        if (x.length !== y.length) return false;
        for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
    }
    if (a instanceof Map) {
        if (a.size !== b.size) return false;
        for (const [key, value] of a)
            if (!b.has(key) || !equalDeep(value, b.get(key), seen)) return false;
    }
    if (a instanceof Set) {
        if (a.size !== b.size) return false;
        for (const value of a)
            if (!b.has(value) && ![...b].some(other => equalDeep(value, other, seen))) return false;
    }
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every(key => Object.hasOwn(b, key) && equalDeep(a[key], b[key], seen));
}

/** Whether `error` satisfies the `expected` of throws() and rejects(). */
function matches(error, expected) {
    if (expected === undefined) return true;
    if (typeof expected === 'function') {
        if (expected.prototype !== undefined && error instanceof expected) return true;
        if (Error.isPrototypeOf(expected) || expected === Error) return false;
        return expected(error) === true;
    }
    if (expected instanceof RegExp) return expected.test(String(error?.message ?? error));
    return Object.entries(expected).every(([key, value]) =>
        value instanceof RegExp && typeof error?.[key] === 'string'
            ? value.test(error[key])
            : equalDeep(error?.[key], value),
    );
}

export default function assert(value, message) {
    if (!value) raise(message, value, true, '==', 'The expression evaluated to a falsy value');
}

export const ok = assert;
assert.ok = assert;

assert.equal = assert.strictEqual = (actual, expected, message) => {
    if (!Object.is(actual, expected))
        raise(message, actual, expected, 'strictEqual', `${show(actual)} !== ${show(expected)}`);
};
assert.notEqual = assert.notStrictEqual = (actual, expected, message) => {
    if (Object.is(actual, expected))
        raise(message, actual, expected, 'notStrictEqual', `${show(actual)} is ${show(expected)}`);
};
assert.deepEqual = assert.deepStrictEqual = (actual, expected, message) => {
    if (!equalDeep(actual, expected))
        raise(
            message,
            actual,
            expected,
            'deepStrictEqual',
            `${show(actual)} differs from ${show(expected)}`,
        );
};
assert.notDeepEqual = assert.notDeepStrictEqual = (actual, expected, message) => {
    if (equalDeep(actual, expected))
        raise(
            message,
            actual,
            expected,
            'notDeepStrictEqual',
            `${show(actual)} equals ${show(expected)}`,
        );
};
assert.match = (text, pattern, message) => {
    if (typeof text !== 'string' || !pattern.test(text))
        raise(message, text, pattern, 'match', `${show(text)} does not match ${pattern}`);
};
assert.doesNotMatch = (text, pattern, message) => {
    if (typeof text === 'string' && pattern.test(text))
        raise(message, text, pattern, 'doesNotMatch', `${show(text)} matches ${pattern}`);
};
assert.fail = message => raise(message, undefined, undefined, 'fail', 'Failed');
assert.throws = (run, expected, message) => {
    if (typeof expected === 'string') [message, expected] = [expected, undefined];
    try {
        run();
    } catch (error) {
        if (!matches(error, expected)) throw error;
        return;
    }
    raise(message, undefined, expected, 'throws', 'Missing expected exception');
};
assert.rejects = async (promise, expected, message) => {
    if (typeof expected === 'string') [message, expected] = [expected, undefined];
    try {
        await (typeof promise === 'function' ? promise() : promise);
    } catch (error) {
        if (!matches(error, expected)) throw error;
        return;
    }
    raise(message, undefined, expected, 'rejects', 'Missing expected rejection');
};
assert.doesNotThrow = run => run();
assert.doesNotReject = async promise => {
    await (typeof promise === 'function' ? promise() : promise);
};
assert.strict = assert;
assert.AssertionError = AssertionError;

export const {
    equal,
    strictEqual,
    notEqual,
    notStrictEqual,
    deepEqual,
    deepStrictEqual,
    notDeepEqual,
    notDeepStrictEqual,
    match,
    doesNotMatch,
    fail,
    throws,
    rejects,
    doesNotThrow,
    doesNotReject,
    strict,
} = assert;
