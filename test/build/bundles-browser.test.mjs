import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

// The script-tag builds in a real browser (npm run test:browser): each sets its globals once and
// works from them, and the lite script takes plugin scripts.

const inBrowser = typeof document !== 'undefined';

/** A WAV file of 16-bit stereo PCM at 48 kHz: a tenth of a second of a 440 Hz tone. */
function waveFixture() {
    const frames = 4800;
    const bytes = new Uint8Array(44 + frames * 4);
    const view = new DataView(bytes.buffer);
    const text = (at, value) =>
        [...value].forEach((char, i) => (bytes[at + i] = char.charCodeAt(0)));
    text(0, 'RIFF');
    view.setUint32(4, bytes.length - 8, true);
    text(8, 'WAVEfmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 2, true);
    view.setUint32(24, 48000, true);
    view.setUint32(28, 48000 * 4, true);
    view.setUint16(32, 4, true);
    view.setUint16(34, 16, true);
    text(36, 'data');
    view.setUint32(40, frames * 4, true);
    for (let i = 0; i < frames; i++) {
        const sample = Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / 48000));
        view.setInt16(44 + i * 4, sample, true);
        view.setInt16(46 + i * 4, sample, true);
    }
    return bytes;
}

/** A same-origin frame that has run `scripts` in order, counting mediaforgejs:ready events. */
async function frameWith(...scripts) {
    const frame = document.createElement('iframe');
    document.body.append(frame);
    const window = frame.contentWindow;
    const events = [];
    window.document.addEventListener('mediaforgejs:ready', event => events.push(event.detail));
    for (const script of scripts)
        await new Promise((resolve, reject) => {
            const element = window.document.createElement('script');
            element.src = new URL(script, location.href).href;
            element.onload = resolve;
            element.onerror = () => reject(new Error(`${script} did not load`));
            window.document.head.append(element);
        });
    return { window, events, remove: () => frame.remove() };
}

describe(
    'script bundles',
    { skip: !inBrowser && 'runs in a browser (npm run test:browser)' },
    () => {
        test('MediaForgeJS.min.js sets its two globals and announces itself once', async () => {
            const { window, events, remove } = await frameWith('/dist/MediaForgeJS.min.js');
            try {
                const api = window.MediaForgeJS;
                assert.equal(typeof api.convert, 'function');
                assert.equal(await window.MediaForgeJSReady, api);
                assert.deepEqual(events, [api]);
                assert(!('define' in window) && !('require' in window), 'no AMD loader globals');
            } finally {
                remove();
            }
        });

        test('the full script converts a WAV file with its global API', async () => {
            const { window, remove } = await frameWith('/dist/MediaForgeJS.min.js');
            try {
                const result = await window.MediaForgeJS.convert(
                    new window.Blob([waveFixture()]),
                    'wav',
                );
                assert.equal(result.filename, 'output.wav');
                assert(result.blob.size > 44);
            } finally {
                remove();
            }
        });

        // Browsers have no FLAC encoder, so the library's comes from the flac plugin.
        test('the lite script encodes FLAC with the flac plugin script only', async () => {
            const { window, remove } = await frameWith(
                '/dist/MediaForgeJS.lite.min.js',
                '/dist/browser-plugins/flac.min.js',
            );
            try {
                const api = window.MediaForgeJS;
                const wave = new window.Blob([waveFixture()]);
                const forge = new api.MediaForge({ plugins: { add: [api.plugins.flac] } });
                assert.equal((await forge.convert(wave, 'flac')).filename, 'output.flac');
                await assert.rejects(api.convert(wave, 'flac'), { code: 'PLUGIN', plugin: 'flac' });
            } finally {
                remove();
            }
        });

        test('a plugin missing its script fails with PLUGIN naming the script to add', async () => {
            const { window, remove } = await frameWith('/dist/MediaForgeJS.lite.min.js');
            try {
                const [decoder] = window.MediaForgeJS.plugins.h264.decoders;
                await assert.rejects(decoder.load(), {
                    code: 'PLUGIN',
                    hint: /browser-plugins\/h264\.min\.js/,
                });
            } finally {
                remove();
            }
        });

        test('noConflict() restores the globals the page had before', async () => {
            const { window, remove } = await frameWith('/dist/MediaForgeJS.lite.min.js');
            try {
                const api = window.MediaForgeJS.noConflict();
                assert.equal(typeof api.inspect, 'function');
                assert(!('MediaForgeJS' in window) && !('MediaForgeJSReady' in window));
            } finally {
                remove();
            }
        });
    },
);
