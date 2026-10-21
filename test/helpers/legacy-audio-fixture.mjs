import { encodeAacLc, wrapAdts } from '../../dist/esm/api/entries/codecs.js';
import { openFile } from './engine.mjs';

// These are the original shared smoke inputs. Explicit factories avoid sharing
// MediaFile state between domain suites or relying on previous test execution.
export async function createAacFixture() {
    const encoded = await encodeAacLc([new Float32Array(4096)], { sampleRate: 48000, bitrate: 64 });
    return { encoded, aac: wrapAdts(encoded) };
}

export async function createAacMp4Fixture() {
    const { encoded, aac } = await createAacFixture();
    const input = await openFile(aac);
    try {
        return { encoded, aac, mp4: await input.toBlob({ format: 'm4a' }) };
    } finally {
        input.close();
    }
}
