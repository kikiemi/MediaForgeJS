// The local server of the browser tests: the test page with its import map, the list of test
// files, and the files of dist/, test/ and packages/ (read-only, with byte ranges), nothing else.
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { readdir } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';

const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json',
    '.wasm': 'application/wasm',
    '.css': 'text/css',
};

/** The import map of the page: node:test and node:assert, and every package entry. */
async function importMap(root) {
    const imports = {
        'node:test': '/test/browser/node-test.mjs',
        'node:assert': '/test/browser/assert.mjs',
        'node:assert/strict': '/test/browser/assert.mjs',
    };
    const add = async (dir, prefix) => {
        const manifest = JSON.parse(await readFile(join(root, dir, 'package.json'), 'utf8'));
        for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
            const file = typeof target === 'string' ? target : (target.import ?? target.default);
            if (!file?.endsWith('.js') || subpath.includes('*')) continue;
            const name = subpath === '.' ? manifest.name : `${manifest.name}${subpath.slice(1)}`;
            imports[name] = `${prefix}${file.replace(/^\.\//, '')}`;
        }
    };
    await add('', '/');
    for (const name of await packageDirs(root))
        await add(join('packages', name), `/packages/${name}/`);
    return { imports };
}

async function packageDirs(root) {
    try {
        return (await readdir(join(root, 'packages'), { withFileTypes: true }))
            .filter(entry => entry.isDirectory())
            .map(entry => entry.name);
    } catch {
        return [];
    }
}

/** Starts the server on 127.0.0.1 for `files`, paths relative to `root`: { url, close }. */
export async function startServer(root, files) {
    const page =
        '<!doctype html>\n<meta charset="utf-8">\n<title>MediaForgeJS tests</title>\n' +
        `<script type="importmap">${JSON.stringify(await importMap(root))}</script>\n` +
        '<script type="module" src="/test/browser/page.mjs"></script>\n';
    const served = ['dist', 'test', 'packages'].map(dir => resolve(root, dir) + sep);
    const server = createServer(async (request, response) => {
        const path = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
        const headers = { 'Cache-Control': 'no-store' };
        if (request.method !== 'GET' && request.method !== 'HEAD') {
            response.writeHead(405, { Allow: 'GET, HEAD' }).end();
            return;
        }
        if (path === '/' || path === '/__files.json') {
            const body = path === '/' ? page : JSON.stringify(files);
            const type = path === '/' ? TYPES['.html'] : TYPES['.json'];
            response.writeHead(200, { ...headers, 'Content-Type': type }).end(body);
            return;
        }
        const file = resolve(root, `.${path}`);
        let bytes;
        try {
            if (
                !served.some(dir => file.startsWith(dir)) ||
                file.includes(`${sep}node_modules${sep}`)
            )
                throw new Error('not served');
            if (!(await stat(file)).isFile()) throw new Error('not a file');
            bytes = await readFile(file);
        } catch {
            response.writeHead(404, headers).end();
            return;
        }
        headers['Content-Type'] = TYPES[extname(file)] ?? 'application/octet-stream';
        headers['Accept-Ranges'] = 'bytes';
        let [start, end] = [0, bytes.length - 1];
        const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '');
        if (range) {
            start = Number(range[1]);
            end = range[2] ? Math.min(Number(range[2]), end) : end;
            if (start > end) {
                response.writeHead(416, { 'Content-Range': `bytes */${bytes.length}` }).end();
                return;
            }
            headers['Content-Range'] = `bytes ${start}-${end}/${bytes.length}`;
        }
        headers['Content-Length'] = end - start + 1;
        response.writeHead(range ? 206 : 200, headers);
        response.end(request.method === 'HEAD' ? undefined : bytes.subarray(start, end + 1));
    });
    await new Promise((resolveListen, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolveListen);
    });
    return {
        url: `http://127.0.0.1:${server.address().port}/`,
        close: () => {
            server.closeAllConnections();
            return new Promise(resolveClose => server.close(() => resolveClose()));
        },
    };
}
