import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { inspect } from 'mediaforgejs';
import { MemorySink } from 'mediaforgejs/io';
import { FFmpegBackend } from 'mediaforgejs/runtime/ffmpeg';
import { toneWav } from './helpers/api-fixtures.mjs';

// The FFmpeg backend of mediaforgejs/runtime/ffmpeg, which runs the ffmpeg and ffprobe found on
// PATH: these tests need them and are skipped where they are missing.

const present = ['ffmpeg', 'ffprobe'].every(
    name => spawnSync(name, ['-version'], { stdio: 'ignore' }).status === 0,
);

/** A temporary directory holding a one-second WAV, for `run`. */
async function withWave(run) {
    const directory = await mkdtemp(join(tmpdir(), 'mediaforge-ffmpeg-'));
    try {
        const wave = join(directory, 'in.wav');
        await writeFile(wave, toneWav(1));
        return await run(directory, wave);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

describe(
    'runtime: the FFmpeg backend',
    { skip: !present && 'ffmpeg and ffprobe are not on PATH' },
    () => {
        const ffmpeg = new FFmpegBackend();

        test('capabilities() reports the version, formats and codecs', async () => {
            const capabilities = await ffmpeg.capabilities();
            assert.match(capabilities.version, /^ffmpeg version/);
            assert.ok(capabilities.demuxers.includes('wav'));
            assert.ok(capabilities.encoders.includes('flac'));
        });

        test('probe() describes a file path and a Source alike', async () => {
            await withWave(async (_directory, wave) => {
                const { streams, format } = await ffmpeg.probe(wave);
                assert.deepEqual(
                    streams.map(stream => [
                        stream.codec_type,
                        stream.codec_name,
                        stream.sample_rate,
                    ]),
                    [['audio', 'pcm_s16le', '48000']],
                );
                assert.equal(format?.format_name, 'wav');
                const bytes = new Uint8Array(await readFile(wave));
                const source = {
                    size: bytes.length,
                    read: async (at, length) => bytes.slice(at, at + length),
                };
                assert.equal((await ffmpeg.probe(source)).streams.length, 1);
            });
        });

        test('convert() writes a file and replaces it only with overwrite', async () => {
            await withWave(async (directory, wave) => {
                const output = join(directory, 'out.flac');
                const options = { format: 'flac', audioCodec: 'flac' };
                assert.ok((await ffmpeg.convert(wave, output, options)).bytesWritten > 0);
                const written = await inspect(new Blob([await readFile(output)]));
                assert.deepEqual(
                    written.tracks.map(track => [track.codec, track.sampleRate]),
                    [['flac', 48000]],
                );
                await assert.rejects(
                    ffmpeg.convert(wave, output, options),
                    error => error.code === 'IO',
                );
                await ffmpeg.convert(wave, output, { ...options, overwrite: true });
            });
        });

        test('remux() writes into a sink', async () => {
            await withWave(async (_directory, wave) => {
                const sink = new MemorySink();
                await ffmpeg.remux(wave, sink, { format: 'matroska' });
                const written = await inspect(sink.toBlob('video/x-matroska'));
                assert.equal(written.format, 'mkv');
                assert.equal(written.tracks.length, 1);
            });
        });

        test('output over maxOutputBytes fails with IO; an aborted signal with ABORT', async () => {
            await withWave(async (directory, wave) => {
                await assert.rejects(
                    ffmpeg.convert(wave, join(directory, 'big.flac'), {
                        format: 'flac',
                        audioCodec: 'flac',
                        maxOutputBytes: 100,
                    }),
                    error => error.code === 'IO',
                );
                const controller = new AbortController();
                controller.abort();
                await assert.rejects(
                    ffmpeg.probe(wave, { signal: controller.signal }),
                    error => error.code === 'ABORT',
                );
            });
        });

        test('exportDirectory() writes HLS and lists its files', async () => {
            await withWave(async (directory, wave) => {
                const target = join(directory, 'hls');
                const result = await ffmpeg.exportDirectory(wave, target, {
                    format: 'hls',
                    audioCodec: 'aac',
                    segmentDuration: 0.5,
                });
                assert.equal(result.manifestPath, join(target, 'index.m3u8'));
                assert.deepEqual(
                    result.files.map(file => file.name).sort(),
                    (await readdir(target)).sort(),
                );
                assert.equal(
                    result.bytesWritten,
                    result.files.reduce((sum, file) => sum + file.bytes, 0),
                );
            });
        });
    },
);
