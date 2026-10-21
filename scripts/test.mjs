// Runs the tests with `node --test`: every test file, the tests of named features, or the tests of
// the features a change may break.
//
//   npm test                                every test file
//   npm test -- formats/mp4 codecs          the tests of these features (`codecs`: all of codecs/)
//   npm run test:affected                   the tests of what changed since the merge base with
//                                           origin/main, the working tree included
//   npm run test:affected -- --base <ref>   ... since <ref>
//
// Other options go to `node --test` (`--test-name-pattern=<regexp>`, `--test-concurrency=<n>`).
// The tests run against dist/, so the runner stops when src/ changed after the last build.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dependents, featureMap, featureOf, featureOfTest } from './features.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ALL = ['test/**/*.test.mjs', 'packages/*/test/**/*.test.mjs'];
/** Changes that can break any test: the tooling, the shared test helpers, the package setup. */
const EVERYTHING = /^(?:scripts\/|test\/helpers\/|package(?:-lock)?\.json$|tsconfig\.json$)/;

const args = process.argv.slice(2);
const options = [];
const named = [];
let affected = false;
let base;
for (let i = 0; i < args.length; i++) {
    if (args[i] === '--affected') affected = true;
    else if (args[i] === '--base') base = args[++i];
    else if (args[i].startsWith('--base=')) base = args[i].slice('--base='.length);
    else if (args[i].startsWith('-')) options.push(args[i]);
    else named.push(args[i]);
}
if (base !== undefined) affected = true;

/** The newest file under `dir` (path and modification time), skipping nothing. */
async function newest(dir, found = { path: undefined, time: 0 }) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await newest(path, found);
        else {
            const time = (await stat(path)).mtimeMs;
            if (time > found.time) Object.assign(found, { path, time });
        }
    }
    return found;
}

async function assertBuilt() {
    let built;
    try {
        built = (await stat(join(root, 'dist/esm/api/entries/index.js'))).mtimeMs;
    } catch {
        fail('dist/ is missing: run npm run build first.');
    }
    const source = await newest(join(root, 'src'));
    if (source.time > built)
        fail(`dist/ is older than ${source.path.slice(root.length + 1)}: run npm run build first.`);
}

function fail(message) {
    console.error(message);
    process.exit(1);
}

function git(...gitArgs) {
    return execFileSync('git', gitArgs, { cwd: root, encoding: 'utf8' })
        .split('\n')
        .filter(Boolean);
}

/** The files changed since `ref` (default: the merge base with origin/main), untracked included. */
function changedFiles(ref) {
    let from = ref;
    if (from === undefined) {
        try {
            [from] = git('merge-base', 'HEAD', 'origin/main');
        } catch {
            fail('there is no origin/main to compare with: name a base with --base <ref>.');
        }
    }
    return [
        ...new Set([
            ...git('diff', '--name-only', from),
            ...git('ls-files', '--others', '--exclude-standard'),
        ]),
    ].sort();
}

/** The test files to run for `changed` files, and the features that may break. */
function affectedTests(map, changed) {
    const ids = [...map.features.keys()];
    const features = new Set();
    const files = new Set();
    let everything = false;
    let code = false;
    for (const path of changed) {
        if (EVERYTHING.test(path)) everything = true;
        else if (path.startsWith('src/')) {
            code = true;
            const feature = featureOf(path.slice(4).replace(/\.ts$/, ''), map.plugins);
            if (map.features.has(feature)) features.add(feature);
            else everything = true;
        } else if (path.endsWith('.test.mjs')) {
            if (existsSync(join(root, path))) files.add(path);
        } else if (path.startsWith('test/fixtures/')) {
            const feature = featureOfTest(`test/${path.slice('test/fixtures/'.length)}`, ids);
            if (feature) features.add(feature);
            else everything = true;
        } else if (path.startsWith('packages/')) {
            code = true;
            features.add(path.split('/', 2).join('/'));
        }
    }
    if (everything) return { everything, changed: [...features], breaking: ids };
    const breaking = dependents(map, [...features]);
    for (const feature of breaking)
        for (const test of map.features.get(feature).tests) files.add(test);
    // The checks of the tooling (feature map, API report, bundle sizes) read all of the code.
    if (code) for (const test of map.tools) files.add(test);
    return { everything, changed: [...features].sort(), breaking, files: [...files].sort() };
}

const map = await featureMap(root);
let files = ALL;
if (affected) {
    const plan = affectedTests(map, changedFiles(base));
    if (plan.everything)
        console.log('A change to the tooling or the test helpers: every test runs.');
    else {
        console.log(`Changed features: ${plan.changed.join(', ') || 'none'}`);
        console.log(`Features that may break: ${plan.breaking.join(', ') || 'none'}`);
        if (!plan.files.length) {
            console.log('No test file covers these changes.');
            process.exit(0);
        }
        files = plan.files;
    }
} else if (named.length) {
    files = [];
    for (const name of named) {
        if (name.endsWith('.test.mjs')) {
            files.push(name);
            continue;
        }
        const matching = [...map.features.keys()].filter(
            id => id === name || id.startsWith(`${name}/`),
        );
        if (!matching.length) fail(`${name} is no feature; node scripts/features.mjs lists them.`);
        for (const id of matching) files.push(...map.features.get(id).tests);
    }
    if (!files.length) fail(`no test file belongs to ${named.join(', ')}.`);
}
await assertBuilt();
if (files !== ALL) console.log(`Running ${files.length} test files.`);
// The spec reporter unless the options name their own.
const reporter = options.some(option => option.startsWith('--test-reporter'))
    ? []
    : ['--test-reporter=spec'];
const run = spawnSync(process.execPath, ['--test', ...reporter, ...options, ...files], {
    cwd: root,
    stdio: 'inherit',
});
process.exit(run.status ?? 1);
