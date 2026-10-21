import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { publicEntries, readApi } from '../../scripts/api-report.mjs';

// The public API is the exports map of package.json and nothing else (docs/README.md, "Stability").
// api/*.api.d.ts holds the API of every entry; a change of the declarations must come with a change
// of those files, so it shows in review.

const root = fileURLToPath(new URL('../..', import.meta.url));
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const typed = Object.entries(manifest.exports).filter(
    ([, target]) => typeof target === 'object' && target.types,
);
const specifier = subpath => (subpath === '.' ? 'mediaforgejs' : `mediaforgejs${subpath.slice(1)}`);
const api = await readApi(root);
const entries = await publicEntries(root);

/** An application written against the declarations, as the guide shows the API. */
const APPLICATION = `
import { parseHlsPlaylist } from 'mediaforgejs/streaming';
import type { HlsParseOptions } from 'mediaforgejs/streaming';
import { createHttpLicenseCallback, player, playHls } from 'mediaforgejs-player';
import type { HlsPlaybackOptions, PlayDrmOptions } from 'mediaforgejs-player';
import { encodeReplayablePcmToSink, encodeAacLc } from 'mediaforgejs/codecs';
import { convert, inspect, open, thumbnail, frames, check, packageMedia, edit, capabilities,
    isMediaForgeError, MediaForge, encodeFrames, recordStream } from 'mediaforgejs';
import type { Media, MediaResult, PackageResult, TargetFormat, Bitrate, MediaPlan, ErrorCode, Frame,
    MediaForgePlugin } from 'mediaforgejs';
import * as lite from 'mediaforgejs/lite';
import { Mp4Demuxer, Mp4Muxer } from 'mediaforgejs/formats';
import { BufferSource, ReadableStreamSink } from 'mediaforgejs/io';
import { h264, mxf, mpegAudio, allPlugins } from 'mediaforgejs/plugins';
// @ts-expect-error the engine is internal
import type { Engine } from 'mediaforgejs/dist/pipeline/engine.js';
// @ts-expect-error the API modules behind the entries are internal
import { MediaForge as Internal } from 'mediaforgejs/dist/esm/api/forge.js';
export type Hidden = [Engine, typeof Internal];
const options: HlsPlaybackOptions = { bufferAhead: 5, operationTimeoutMs: 3000 };
const parse: HlsParseOptions = { baseUrl: 'https://example.com/' };
void [playHls, parseHlsPlaylist, parse, encodeReplayablePcmToSink, encodeAacLc, options,
    Mp4Demuxer, Mp4Muxer];
const custom: MediaForgePlugin = { name: 'noop', readers: [] };
const everything: readonly MediaForgePlugin[] = [...allPlugins, custom];
export const liteForge = new lite.MediaForge({ plugins: [h264, mxf, mpegAudio] });
export const withoutH264 = new MediaForge({ plugins: { exclude: ['h264', 'avi'], add: [custom] } });
export const everyPlugin: Promise<readonly string[]> = new lite.MediaForge({ plugins: everything })
    .capabilities()
    .then(c => c.plugins);
export function watch(video: HTMLVideoElement, licenses: string) {
    const drm: PlayDrmOptions = { keySystems: [{ keySystem: 'com.widevine.alpha',
        license: createHttpLicenseCallback({ url: licenses }) }] };
    const forge = new MediaForge({ plugins: { add: [player] } });
    return forge.play('https://example.com/master.m3u8', video, { drm, adaptive: true })
        .finished;
}
export async function app(file: File, music: Blob, canvas: OffscreenCanvas, stream: MediaStream) {
    const controller = new AbortController();
    const result: MediaResult = await convert(file, 'mp4', {
        video: { width: 1280, codec: 'auto', bitrate: '2.5M', quality: 'high',
            hardwareAcceleration: 'prefer-hardware' },
        audio: { bitrate: 128_000, codec: 'aac' },
        signal: controller.signal,
        onProgress: ({ fraction, stage, time, duration }) =>
            void [fraction.toFixed(2), stage === 'copy', time, duration],
        onPlan: (report: MediaPlan) =>
            void report.tracks.map(track => [track.action, track.codec, track.encoder]),
    });
    const url: string = URL.createObjectURL(result.blob);
    const name: string = result.filename + result.mimeType + result.plan.action +
        result.warnings.length;
    const future: TargetFormat = 'some-future-format';
    const bitrate: Bitrate = '192k';
    // @ts-expect-error bitrates are numbers or text with a unit
    const wrong: Bitrate = '192 potatoes';
    // @ts-expect-error quality is one of the named levels
    await convert(file, 'mp4', { video: { quality: 'ultra' } });
    const info = await inspect(file, { signal: controller.signal });
    const ids: number[] = info.tracks.map(track => track.id);
    await convert(file, 'mp3', { trackIds: [ids[0]!], audio: { bitrate: '192k' } });
    await convert(file, { start: 10, end: 20 });
    await convert(file, { audio: { mute: true } });
    await convert(file, 'mp4', { audio: { replace: music } });
    const readable = new ReadableStreamSink();
    const written = await convert(file, 'webm', { sink: readable });
    const media: Media = await open(new BufferSource(new Uint8Array(await file.arrayBuffer())));
    try {
        const first = await media.convert({ end: 60 });
        const second = await media.convert({ start: 60 });
        void [first.blob, second.blob, media.tracks, media.duration];
        const trackIds = [media.tracks[0]!.id];
        for await (const packet of media.packets({ trackIds })) void packet.data;
    } finally {
        media.close();
    }
    const poster = await thumbnail(file, { time: 3, width: 320 });
    const support = await check(file, 'webm');
    if (!support.supported) void [support.code, support.reason, support.hint];
    else void support.plan.action;
    for await (const frame of frames(file, { every: 1 })) {
        const rgba: Frame = frame;
        void rgba.data;
    }
    for await (const frame of frames(file, { format: 'videoframe' })) {
        const native: VideoFrame = frame;
        native.close();
    }
    const hls: PackageResult = await packageMedia(file, 'hls', { onFile: file => void file.name });
    const edited = await edit({ clips: [{ input: file, end: 5 }, { input: music }] }, 'mp4');
    const encoded = await encodeFrames([new VideoFrame(canvas, { timestamp: 0 })], {
        to: 'webm', video: { codec: 'vp9' } });
    const recording = recordStream(stream, { to: 'webm', maxDuration: 10 });
    const recorded: MediaResult = await recording.stop();
    const large = await capabilities({ to: 'mp4', width: 3840, height: 2160 });
    const hevc: boolean = large.video.encode.includes('hvc1');
    await convert(file, 'mp4', { plugins: { exclude: ['h264'] } });
    await lite.inspect(file, { plugins: [mxf] });
    void [url, name, future, bitrate, wrong, written.plan, readable.stream, poster.blob, hls.entry,
        edited.plan, encoded.plan, recorded.filename, hevc];
    try {
        await new MediaForge().convert(file, { to: 'mp4', video: { codec: 'h264' } });
    } catch (error) {
        if (isMediaForgeError(error, 'ABORT', 'ENCODE')) {
            const code: ErrorCode = error.code;
            const hint: string | undefined = error.hint;
            const plugin: string | undefined = error.plugin;
            void [code, hint, plugin];
        }
    }
}
`;

/** The errors of compiling `files` (name to text) as an application of the package. */
function compileErrors(files) {
    const options = {
        noEmit: true,
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        target: ts.ScriptTarget.ES2022,
        lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
        strict: true,
        types: [],
        // Every entry of the package and of packages/, as an application installs them.
        paths: Object.fromEntries(entries.map(entry => [entry.name, [entry.types]])),
    };
    const dir = join(root, 'test', 'application');
    const virtual = new Map(Object.entries(files).map(([name, text]) => [join(dir, name), text]));
    const host = ts.createCompilerHost(options);
    const { getSourceFile, fileExists, readFile: read } = host;
    host.fileExists = path => virtual.has(path) || fileExists.call(host, path);
    host.readFile = path => virtual.get(path) ?? read.call(host, path);
    host.getSourceFile = (path, language, ...rest) =>
        virtual.has(path)
            ? ts.createSourceFile(path, virtual.get(path), language, true)
            : getSourceFile.call(host, path, language, ...rest);
    const program = ts.createProgram([...virtual.keys()], options, host);
    return ts
        .getPreEmitDiagnostics(program)
        .map(diagnostic => ts.formatDiagnostic(diagnostic, host).trim());
}

describe('public API', () => {
    test('every entry of the exports map resolves to files in dist/api/entries', async () => {
        for (const [subpath, target] of typed)
            for (const condition of ['types', 'import', 'default']) {
                assert.match(
                    target[condition],
                    /^\.\/dist\/(esm\/)?api\/entries\/[a-z-]+\.(d\.ts|js)$/,
                    `${subpath} ${condition}`,
                );
                await stat(join(root, target[condition]));
            }
    });

    test('the reports in api/ match the built declarations (npm run api:report)', async () => {
        const committed = (await readdir(join(root, 'api'))).filter(name =>
            name.endsWith('.api.d.ts'),
        );
        assert.deepEqual(committed.sort(), [...api.reports.keys()].sort());
        for (const [name, text] of api.reports) {
            const before = await readFile(join(root, 'api', name), 'utf8');
            if (before === text) continue;
            const old = before.split('\n');
            const now = text.split('\n');
            const line = now.findIndex((value, index) => value !== old[index]);
            assert.fail(
                `The public API of api/${name} changed from line ${line + 1} ` +
                    `(${JSON.stringify(old[line] ?? '')} is now ` +
                    `${JSON.stringify(now[line] ?? '')}). ` +
                    'If the change is meant, run npm run api:report and commit the diff of api/.',
            );
        }
    });

    test('no entry reaches the engine or the tuning of the encoders behind it', () => {
        const internal = [
            'class Engine',
            'interface PluginSet',
            'class Streaming\\w+Encoder',
            'afterPcmChunk',
            'slotEnergyMean',
            'collectFrames',
            'expectedInputFrames',
            'onBufferedFrames',
        ];
        const pattern = new RegExp(`\\b(?:${internal.join('|')})\\b`);
        for (const [name, text] of api.reports) assert.doesNotMatch(text, pattern, `api/${name}`);
    });

    test('the JavaScript of an entry exports the values its declarations name', async () => {
        for (const [subpath] of typed) {
            const module = await import(specifier(subpath));
            assert.deepEqual(
                Object.keys(module).sort(),
                [...api.values.get(specifier(subpath))].sort(),
                specifier(subpath),
            );
        }
    });

    test('modules behind the entries cannot be imported through the package name', async () => {
        for (const internal of [
            'mediaforgejs/dist/esm/pipeline/engine.js',
            'mediaforgejs/dist/esm/api/forge.js',
            'mediaforgejs/pipeline/engine',
            'mediaforgejs/codecs/aac/decoder',
            'mediaforgejs/src/api/forge.ts',
        ])
            await assert.rejects(import(internal), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
    });

    test('declarations ship for the entries and what their types reach only', async () => {
        const dist = join(root, 'dist');
        const reached = new Set();
        const pending = typed.map(([, target]) => join(root, target.types));
        while (pending.length) {
            const file = pending.pop();
            if (reached.has(file)) continue;
            reached.add(file);
            const text = await readFile(file, 'utf8');
            for (const match of text.matchAll(/(?:from\s+|import\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g))
                pending.push(join(dirname(file), match[1].replace(/\.js$/, '.d.ts')));
        }
        const shipped = [];
        const walk = async dir => {
            for (const entry of await readdir(dir, { withFileTypes: true })) {
                const path = join(dir, entry.name);
                if (entry.isDirectory() && path !== join(dist, 'esm')) await walk(path);
                else if (entry.name.endsWith('.d.ts')) shipped.push(path);
            }
        };
        await walk(dist);
        assert.deepEqual(
            shipped.filter(file => !reached.has(file)).map(file => relative(dist, file)),
            [],
        );
        // Each of them declares the API or passes it on: a file of internals reached because a
        // file of the API exports one of them too would ship the internals' declarations.
        assert.deepEqual(
            shipped.filter(file => !api.files.has(file)).map(file => relative(dist, file)),
            [],
        );
    });

    test('an application compiles in strict mode', () => {
        assert.deepEqual(compileErrors({ 'application.mts': APPLICATION }), []);
    });
});
