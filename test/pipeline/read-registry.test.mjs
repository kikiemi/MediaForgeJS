import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { encodeAacLc, wrapAdts } from 'mediaforgejs/codecs';
import { coreParts, engineOf } from '../helpers/engine.mjs';

// The format registry behind open(): it reads and writes with the parts it was given and names
// what it lacks.

/** An M4A of AAC, written by an engine of the MP4 parts. */
async function m4a() {
    const encoded = await encodeAacLc([new Float32Array(4096)], { sampleRate: 48000, bitrate: 64 });
    const engine = await engineOf(coreParts(['mp4', 'mpeg-audio']));
    const adts = await engine.open(wrapAdts(encoded));
    try {
        return { frames: encoded.frames.length, blob: await adts.toBlob({ format: 'm4a' }) };
    } finally {
        adts.close();
    }
}

describe('pipeline/read: the format registry', () => {
    test('an engine of the MP4 and Matroska parts copies between them, no further', async () => {
        const { frames, blob } = await m4a();
        const engine = await engineOf(coreParts(['mp4', 'matroska']));
        const file = await engine.open(blob);
        try {
            assert.equal(file.checkRemux({ format: 'mkv' }).supported, true);
            const copy = await engine.open(await file.toBlob({ format: 'mkv' }));
            assert.equal(copy.tracks[0].sampleCount, frames);
            copy.close();
            assert.equal(file.checkRemux({ format: 'ts' }).supported, false);
            await assert.rejects(file.toBlob({ format: 'ts' }), /No writer for 'ts'/);
        } finally {
            file.close();
        }
    });

    test('an engine without readers names the reader it lacks', async () => {
        const { blob } = await m4a();
        await assert.rejects((await engineOf({})).open(blob), /No reader/);
    });

    test('without the fragmented MP4 writer, fMP4 is refused', async () => {
        const { blob } = await m4a();
        const engine = await engineOf(coreParts(['mp4'], { segments: false }));
        const file = await engine.open(blob);
        try {
            assert.equal(file.checkRemux({ format: 'fmp4' }).supported, false);
            await assert.rejects(file.toBlob({ format: 'fmp4' }), /registered/);
        } finally {
            file.close();
        }
    });
});
