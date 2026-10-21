import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const imports = {
    'mediaforgejs-prores': '/node_modules/mediaforgejs-prores/index.js',
    turbores: '/node_modules/turbores/dist/turbores.js',
    'prores-wasm-encoder': '/node_modules/prores-wasm-encoder/dist/prores-encoder.mjs',
};
const page = `<!doctype html><html lang="en"><meta charset="utf-8">
<title>MediaForgeJS local ProRes check</title>
<h1>Local ProRes encode/decode</h1>
<pre id="result">Running. This is an actual browser test only after a result appears.</pre>
<script type="importmap">${JSON.stringify({ imports })}</script>
<script type="module">
const result = {
    status: 'running',
    browserExecuted: true,
    origin: location.origin,
    userAgent: navigator.userAgent,
    crossOriginIsolated,
    profiles: [],
};
const check = (condition, message) => { if (!condition) throw new Error(message); };
try {
    const {createProResEncoder, createProResDecoder} = await import('mediaforgejs-prores');
    for (const codec of ['apch','ap4h']) {
        const encoder = await createProResEncoder({codec,width:16,height:16});
        let decoder;
        let frame;
        try {
            const rgba = new Uint8Array(16*16*4);
            for(let i=0;i<rgba.length;i+=4) rgba.set([96,128,160,255],i);
            const picture = {data:rgba,format:'RGBA',width:16,height:16,timestamp:0,duration:0.04};
            const packet = await encoder.encode(picture);
            check(packet.data.length>0,'Encoder returned no packet');
            decoder = await createProResDecoder({codec,concurrency:0,useSharedMemory:false});
            frame = await decoder.decode(packet);
            check(frame.visibleWidth===16 && frame.visibleHeight===16,'Decoded dimensions differ');
            const decoded = await frame.toRgba({allowPrecisionLoss:true});
            check(decoded.data.length===rgba.length,'Decoded RGBA size differs');
            let maxError=0;
            for(let i=0;i<rgba.length;i++)
                maxError=Math.max(maxError,Math.abs(rgba[i]-decoded.data[i]));
            check(maxError<=8,'RGBA roundtrip exceeded tolerance: '+maxError);
            const packetBytes=packet.data.length;
            result.profiles.push({codec,packetBytes,bitDepth:frame.bitDepth,maxError});
        } finally {frame?.close();await decoder?.close();await encoder.close();}
    }
    result.resources = performance.getEntriesByType('resource').map(entry=>entry.name);
    check(result.resources.every(url=>new URL(url).origin===location.origin),'Nonlocal asset was ' +
        'loaded');
    result.status='passed';
} catch(error) {result.status='failed';result.error={name:error.name,message:error.message};}
window.__mediaforgeOfflineBrowser=result;
document.querySelector('#result').textContent=JSON.stringify(result,null,2);
const headers={'Content-Type':'application/json'};
await fetch('/report',{method:'POST',headers,body:JSON.stringify(result)});
</script></html>`;

export async function startOfflineBrowserServer(consumer, port = 0) {
    const directory = await realpath(resolve(consumer));
    for (const path of Object.values(imports))
        assert(
            (await stat(join(directory, path))).isFile(),
            `Missing local browser asset: ${path}`,
        );
    const server = createServer(async (request, response) => {
        const headers = {
            'Content-Security-Policy':
                "default-src 'none'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; " +
                "connect-src 'self'; worker-src 'self' blob:; base-uri 'none'; form-action 'none'",
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Embedder-Policy': 'require-corp',
            'Cross-Origin-Resource-Policy': 'same-origin',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
        };
        try {
            const url = new URL(request.url, 'http://localhost');
            if (request.method === 'POST' && url.pathname === '/report') {
                let body = '';
                for await (const chunk of request) {
                    body += chunk;
                    assert(body.length < 64 * 1024, 'Browser report too large');
                }
                const report = JSON.parse(body);
                assert(
                    ['passed', 'failed'].includes(report.status) && report.browserExecuted === true,
                    'Invalid browser report',
                );
                await writeFile(
                    join(directory, 'offline-browser-report.json'),
                    JSON.stringify(report, null, 2) + '\n',
                );
                response.writeHead(200, { ...headers, 'Content-Type': 'application/json' });
                response.end('{"saved":true}');
                return;
            }
            assert.equal(request.method, 'GET');
            if (url.pathname === '/') {
                response.writeHead(200, { ...headers, 'Content-Type': 'text/html; charset=utf-8' });
                response.end(page);
                return;
            }
            assert(url.pathname.startsWith('/node_modules/'));
            const path = await realpath(join(directory, decodeURIComponent(url.pathname)));
            assert(
                relative(join(directory, 'node_modules'), path) &&
                    !relative(join(directory, 'node_modules'), path).startsWith('..'),
            );
            const data = await readFile(path);
            response.writeHead(200, {
                ...headers,
                'Content-Type':
                    {
                        '.js': 'text/javascript',
                        '.mjs': 'text/javascript',
                        '.wasm': 'application/wasm',
                        '.json': 'application/json',
                    }[extname(path)] ?? 'application/octet-stream',
            });
            response.end(data);
        } catch {
            response.writeHead(404, { ...headers, 'Content-Type': 'text/plain' });
            response.end('Not found');
        }
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
    });
    return {
        url: `http://127.0.0.1:${server.address().port}/`,
        close: () =>
            new Promise((resolve, reject) =>
                server.close(error => (error ? reject(error) : resolve())),
            ),
    };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    assert(process.argv[2], 'Usage: node release/offline/browser.mjs CONSUMER_DIRECTORY');
    const server = await startOfflineBrowserServer(process.argv[2]);
    console.log(`Open ${server.url} in a browser. No browser test has run yet.`);
    console.log(
        'The browser writes offline-browser-report.json in the consumer directory. Stop this ' +
            'server with Ctrl+C.',
    );
}
