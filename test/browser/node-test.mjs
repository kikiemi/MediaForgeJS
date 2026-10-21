// node:test for the browser test page: describe(), test() and it() with the skip and todo options,
// the hooks, and t.diagnostic() and t.skip(). A file registers its tests while it is imported;
// runFile() then runs them in order and returns one result per test. The page's import map points
// 'node:test' here.

let root;

const newSuite = (name, options = {}, parent = undefined) => ({
    name,
    options,
    parent,
    children: [],
    before: [],
    after: [],
    beforeEach: [],
    afterEach: [],
});

/** The suite that registrations go to: the innermost describe() being defined. */
let current;

function parse(name, options, fn) {
    if (typeof name === 'function') [name, options, fn] = [name.name || '<anonymous>', {}, name];
    if (typeof options === 'function') [options, fn] = [{}, options];
    return { name, options: options ?? {}, fn };
}

export function describe(...args) {
    const { name, options, fn } = parse(...args);
    const suite = newSuite(name, options, current);
    current.children.push({ suite });
    const outer = current;
    current = suite;
    try {
        fn?.();
    } finally {
        current = outer;
    }
}

export function test(...args) {
    const { name, options, fn } = parse(...args);
    current.children.push({ test: { name, options, fn } });
}

export const it = test;
export const suite = describe;
export const before = fn => current.before.push(fn);
export const after = fn => current.after.push(fn);
export const beforeEach = fn => current.beforeEach.push(fn);
export const afterEach = fn => current.afterEach.push(fn);

test.describe = describe;
test.it = it;
test.test = test;
test.suite = suite;
test.before = before;
test.after = after;
test.beforeEach = beforeEach;
test.afterEach = afterEach;
describe.skip = (name, fn) => describe(name, { skip: true }, fn);
describe.todo = (name, fn) => describe(name, { todo: true }, fn);
test.skip = (name, fn) => test(name, { skip: true }, fn);
test.todo = (name, fn) => test(name, { todo: true }, fn);

export default test;

/** Starts collecting the tests of the next file. */
export function startFile() {
    root = newSuite('');
    current = root;
}

const reason = value => (typeof value === 'string' ? value : '');

/** How long a test may run, unless its `timeout` option says otherwise. */
const TIMEOUT_MS = 120000;

/** `promise`, or a rejection after `ms`. */
function within(promise, ms) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`the test did not finish in ${ms} ms`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Runs the tests the file registered, telling `onTest` the name of each as it starts; each result
 * is { name, status, reason, error, ms, diagnostics }.
 */
export async function runFile(onTest = () => {}) {
    const results = [];
    const hooks = suite => {
        const chain = [];
        for (let at = suite; at; at = at.parent) chain.unshift(at);
        return chain;
    };
    const visit = async (suite, path, skipped) => {
        const skip =
            skipped ?? (suite.options.skip ? reason(suite.options.skip) || 'skipped' : undefined);
        const todo = suite.options.todo;
        if (!skip) for (const hook of suite.before) await hook();
        for (const child of suite.children) {
            if (child.suite) {
                await visit(child.suite, [...path, child.suite.name], skip);
                continue;
            }
            const { name, options, fn } = child.test;
            const full = [...path, name].join(' > ');
            if (skip || options.skip) {
                results.push({
                    name: full,
                    status: 'skip',
                    reason: skip ?? (reason(options.skip) || 'skipped'),
                });
                continue;
            }
            const isTodo = todo || options.todo;
            if (!fn) {
                results.push({
                    name: full,
                    status: isTodo ? 'todo' : 'pass',
                    reason: reason(isTodo),
                });
                continue;
            }
            const diagnostics = [];
            let skippedInside;
            const context = {
                name,
                diagnostic: message => diagnostics.push(String(message)),
                skip: message => {
                    skippedInside = message ?? 'skipped';
                },
                todo: message => {
                    skippedInside = message ?? 'todo';
                },
                signal: new AbortController().signal,
            };
            const started = performance.now();
            let error;
            onTest(full);
            try {
                for (const at of hooks(suite)) for (const hook of at.beforeEach) await hook();
                await within(Promise.resolve(fn(context)), options.timeout ?? TIMEOUT_MS);
                for (const at of hooks(suite).reverse())
                    for (const hook of at.afterEach) await hook();
            } catch (caught) {
                error = caught;
            }
            const ms = Math.round(performance.now() - started);
            const status =
                skippedInside !== undefined ? 'skip' : isTodo ? 'todo' : error ? 'fail' : 'pass';
            results.push({
                name: full,
                status,
                reason: skippedInside ?? reason(isTodo),
                ms,
                diagnostics,
                ...(error && status === 'fail' && { error: String(error?.stack ?? error) }),
            });
        }
        if (!skip) for (const hook of suite.after) await hook();
    };
    await visit(root, [], undefined);
    return results;
}
