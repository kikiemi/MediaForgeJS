// Runs the browser test files (`*-browser.test.mjs`) in a real browser through its WebDriver:
// what Node cannot test, such as WebCodecs, Media Source Extensions and the script bundles. The
// files use node:test and node:assert as in Node; the page maps those, and the package names, to
// the browser's modules and dist/.
//
//   npm run test:browser                          every browser test file in Chrome
//   npm run test:browser -- --browser firefox     ... in Firefox (also safari, on macOS)
//   npm run test:browser -- codecs/webcodecs      the browser tests of a feature, or a file
//
// The driver: CHROMEDRIVER, GECKODRIVER or /usr/bin/safaridriver; the browser: CHROME_BINARY or
// FIREFOX_BINARY when it is not where the platform installs it. --headed shows the window.
import { spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { featureMap } from './features.mjs';
import { startServer } from '../test/browser/server.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RUN_TIMEOUT_MS = 15 * 60 * 1000;
const isRoot = () => typeof process.getuid === 'function' && process.getuid() === 0;
const delay = ms => new Promise(done => setTimeout(done, ms));

const args = process.argv.slice(2);
let browser = 'chrome';
let headed = false;
const named = [];
for (let i = 0; i < args.length; i++) {
    if (args[i] === '--browser') browser = args[++i];
    else if (args[i].startsWith('--browser=')) browser = args[i].slice('--browser='.length);
    else if (args[i] === '--headed') headed = true;
    else named.push(args[i]);
}

/** The driver command, its arguments for `port`, and the session capabilities of `name`. */
function driverOf(name, port) {
    const mac = process.platform === 'darwin';
    if (name === 'chrome')
        return {
            command:
                process.env.CHROMEDRIVER ??
                (process.env.CHROMEWEBDRIVER
                    ? join(process.env.CHROMEWEBDRIVER, 'chromedriver')
                    : 'chromedriver'),
            args: [`--port=${port}`, '--allowed-ips=127.0.0.1'],
            capabilities: {
                browserName: 'chrome',
                'goog:chromeOptions': {
                    ...(process.env.CHROME_BINARY && { binary: process.env.CHROME_BINARY }),
                    args: [
                        ...(headed ? [] : ['--headless=new']),
                        ...(isRoot() ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
                        '--autoplay-policy=no-user-gesture-required',
                        // Heap bounds measure what the work holds: gc() and exact heap sizes.
                        '--js-flags=--expose-gc',
                        '--enable-precise-memory-info',
                    ],
                },
            },
        };
    if (name === 'firefox')
        return {
            command:
                process.env.GECKODRIVER ??
                (process.env.GECKOWEBDRIVER
                    ? join(process.env.GECKOWEBDRIVER, 'geckodriver')
                    : 'geckodriver'),
            args: ['--port', String(port), '--host', '127.0.0.1'],
            capabilities: {
                browserName: 'firefox',
                'moz:firefoxOptions': {
                    ...(process.env.FIREFOX_BINARY && { binary: process.env.FIREFOX_BINARY }),
                    args: headed ? [] : ['-headless'],
                    prefs: { 'media.autoplay.default': 0 },
                },
            },
        };
    if (name === 'safari' && mac)
        return {
            command: '/usr/bin/safaridriver',
            args: ['--port', String(port)],
            capabilities: { browserName: 'safari' },
        };
    throw new Error(`no ${name} to run: use --browser chrome, firefox or safari (macOS)`);
}

async function freePort() {
    const server = createNetServer();
    await new Promise((done, fail) => server.once('error', fail).listen(0, '127.0.0.1', done));
    const { port } = server.address();
    await new Promise(done => server.close(done));
    return port;
}

/** A WebDriver session: the driver process and the commands this runner needs. */
async function openSession(name) {
    const port = await freePort();
    const driver = driverOf(name, port);
    const child = spawn(driver.command, driver.args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let log = '';
    child.stderr.on('data', chunk => (log = (log + chunk).slice(-4000)));
    let exit;
    child.once('error', error => (exit = error));
    child.once('exit', code => (exit ??= new Error(`${driver.command} exited with ${code}`)));
    const base = `http://127.0.0.1:${port}`;
    const call = async (method, path, body) => {
        const response = await fetch(`${base}${path}`, {
            method,
            headers: body && { 'Content-Type': 'application/json' },
            body: body && JSON.stringify(body),
            signal: AbortSignal.timeout(60000),
        });
        const { value } = await response.json();
        if (!response.ok || value?.error)
            throw new Error(`WebDriver ${method} ${path}: ${value?.error}: ${value?.message}`);
        return value;
    };
    const quit = async () => {
        child.kill();
        await delay(100);
    };
    try {
        for (let tries = 0; ; tries++) {
            if (exit) throw new Error(`${exit.message}\n${log}`);
            if (tries > 150) throw new Error(`${driver.command} did not start\n${log}`);
            try {
                if ((await fetch(`${base}/status`)).ok) break;
            } catch {}
            await delay(100);
        }
        const { sessionId } = await call('POST', '/session', {
            capabilities: { alwaysMatch: driver.capabilities },
        });
        const session = `/session/${sessionId}`;
        return {
            navigate: url => call('POST', `${session}/url`, { url }),
            evaluate: script => call('POST', `${session}/execute/sync`, { script, args: [] }),
            close: async () => {
                await call('DELETE', session).catch(() => {});
                await quit();
            },
        };
    } catch (error) {
        await quit();
        throw error;
    }
}

const map = await featureMap(root);
const browserFiles = [...map.features.values()]
    .flatMap(feature => feature.tests)
    .concat(map.tools)
    .filter(file => file.endsWith('-browser.test.mjs'))
    .sort();
const files = named.length
    ? browserFiles.filter(file =>
          named.some(
              name =>
                  file === name ||
                  map.features.get(name)?.tests.includes(file) ||
                  [...map.features.keys()].some(
                      id => id.startsWith(`${name}/`) && map.features.get(id).tests.includes(file),
                  ),
          ),
      )
    : browserFiles;
if (!files.length) {
    console.error(
        `No browser test file (*-browser.test.mjs) matches ${named.join(' ') || 'the map'}.`,
    );
    process.exit(1);
}

const server = await startServer(root, files);
let session;
let report;
try {
    session = await openSession(browser);
    await session.navigate(server.url);
    const end = Date.now() + RUN_TIMEOUT_MS;
    for (;;) {
        report = JSON.parse(
            await session.evaluate('return JSON.stringify(window.__testReport ?? null)'),
        );
        if (report?.done) break;
        if (Date.now() > end)
            throw new Error(
                `the browser tests did not finish; running: ${report?.current ?? 'none'}`,
            );
        await delay(500);
    }
} finally {
    await session?.close();
    await server.close();
}

const counts = { pass: 0, fail: 0, skip: 0, todo: 0 };
const marks = { pass: '✔', fail: '✖', skip: '﹣', todo: '﹣' };
console.log(`${browser}: ${report.userAgent}`);
for (const { file, results } of report.files) {
    console.log(`▶ ${file}`);
    for (const result of results) {
        counts[result.status]++;
        const note = result.reason ? ` # ${result.status} ${result.reason}` : '';
        const time = result.ms === undefined ? '' : ` (${result.ms} ms)`;
        console.log(`  ${marks[result.status]} ${result.name}${time}${note}`);
        if (result.error) console.log(result.error.replace(/^/gm, '    '));
    }
}
for (const error of report.pageErrors) console.log(`✖ page error: ${error}`);
console.log(
    `ℹ files ${report.files.length}, tests ${Object.values(counts).reduce((a, b) => a + b)}, ` +
        `pass ${counts.pass}, fail ${counts.fail}, skipped ${counts.skip}, todo ${counts.todo}`,
);
if (counts.fail || report.pageErrors.length) process.exitCode = 1;
