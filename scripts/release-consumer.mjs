export const runtimeConsumer = rawFixture => `import assert from 'node:assert/strict';
assert.equal(globalThis.__mediaforgeOfflineNetworkBlocked, true, 'runtime network guard must be ' +
    'active');
import * as main from 'mediaforgejs';
import * as lite from 'mediaforgejs/lite';
import { allPlugins, h264 } from 'mediaforgejs/plugins';
import { encodeAacLc, wrapAdts } from 'mediaforgejs/codecs';
import { MemorySink } from 'mediaforgejs/io';
import { Mp4Muxer } from 'mediaforgejs/formats';
import { EmeController, HlsClient, player } from 'mediaforgejs-player';
import { FFmpegBackend } from 'mediaforgejs/runtime/ffmpeg';
import { createProResDecoder, createProResEncoder, prores } from 'mediaforgejs-prores';
import { decodeProResRaw } from 'mediaforgejs-prores-raw';
assert.deepEqual((await main.capabilities()).plugins, allPlugins.map(plugin => plugin.name));
assert.deepEqual((await lite.capabilities()).plugins, []);
const withoutH264 = new main.MediaForge({ plugins: { exclude: ['h264'], add: [prores] } });
assert.deepEqual(withoutH264.plugins.includes('h264'), false);
const liteWithPlugins = new lite.MediaForge({ plugins: { add: [h264, prores, player] } });
assert.deepEqual(liteWithPlugins.plugins, ['h264', 'prores', 'player']);
assert.equal(typeof (await player.players[0].load()), 'function');
assert.equal(typeof HlsClient, 'function');
assert.equal(typeof EmeController, 'function');
assert.equal(typeof FFmpegBackend, 'function');
const silence = [new Float32Array(4096)];
const adts = new Blob([wrapAdts(await encodeAacLc(silence, { sampleRate: 48000, bitrate: 64 }))]);
const { blob } = await main.convert(adts, 'm4a');
assert(blob.size > 0);
const media = await main.open(blob);
try {
    const target = { to: 'wav', audio: { sampleRate: 24000 } };
    assert.equal((await media.check(target)).supported, true);
    const pcm = await media.convert(target);
    assert(pcm.blob.size > 44);
    const reencoded = await main.convert(pcm.blob, { to: 'm4a', audio: { codec: 'aac' } });
    const info = await main.inspect(reencoded.blob);
    assert.equal(info.tracks[0].sampleRate, 24000);
    assert.equal(info.tracks[0].codec, 'mp4a.40.2');
} finally {
    media.close();
}
const tsSink = new MemorySink();
await main.convert(blob, 'ts', { sink: tsSink, maxBytes: 1024 * 1024, open: { cacheBytes: 0 } });
const tsTracks = (await main.inspect(tsSink.toBlob())).tracks;
assert.equal(tsTracks.filter(track => track.type === 'audio').length, 1);
assert.equal((await main.check(blob, 'ts', { maxBytes: 1 })).code, 'OOM');
await assert.rejects(
    main.convert(blob, 'ts', { sink: new MemorySink(), maxBytes: 1 }),
    error => error.code === 'OOM',
);
const proresEncoder = await createProResEncoder({codec:'apch',width:16,height:16});
const rgba = new Uint8Array(16*16*4);
for(let i=0;i<rgba.length;i+=4) rgba.set([96,128,160,255],i);
let proresPacket;
try {
    proresPacket = await proresEncoder.encode({
        data: rgba, format: 'RGBA', width: 16, height: 16, timestamp: 0, duration: 0.04,
    });
} finally {
    await proresEncoder.close();
}
const proresSink = new MemorySink();
const proresMuxer = new Mp4Muxer({format:'mov',mode:'standard',autoSync:false,maxFragmentDuration:2,
    video:{id:1,type:'video',codec:'apch',width:16,height:16,framerate:25}},proresSink);
proresMuxer.addVideoChunk(proresPacket); await proresMuxer.finalize();
const proresForge = new main.MediaForge({ plugins: { add: [prores] } });
const proresTarget = { to: 'mov', video: { codec: 'ap4h' }, allowPrecisionLoss: true };
assert.equal((await proresForge.check(proresSink.toBlob(), proresTarget)).supported, true);
const proresOutput = await proresForge.convert(proresSink.toBlob(), proresTarget);
const proresFile = await main.open(proresOutput.blob);
const proresDecoder = await createProResDecoder({codec:'ap4h'});
try {
    const packet = await proresFile.packetAt(proresFile.tracks[0].id, 0);
    const frame = await proresDecoder.decode(packet);
    try { assert.equal(frame.visibleWidth,16); assert.equal(frame.bitDepth,12); }
    finally { frame.close(); }
} finally { await proresDecoder.close(); proresFile.close(); }
const rawFrame=decodeProResRaw(Uint8Array.from(${JSON.stringify([...rawFixture])}));
assert.equal(rawFrame.format,'bayer-rggb16');assert.equal(rawFrame.data.length,32*24);
console.log(
    'installed entries and plugins, AAC/PCM/M4A, Media check/convert, TS sink and output limits, ' +
        'real ProRes encode/decode through the plugin and RAW decode passed',
);`;

export const typedConsumer = `import {
    MediaForge,
    convert,
    check,
    type ConvertOptions,
    type MediaResult,
} from 'mediaforgejs';
import { MediaForge as LiteForge } from 'mediaforgejs/lite';
import { allPlugins, type MediaForgePlugin, type VideoCodecProvider } from 'mediaforgejs/plugins';
import { MemorySink } from 'mediaforgejs/io';
import { EmeController, HlsClient, player } from 'mediaforgejs-player';
import { FFmpegBackend } from 'mediaforgejs/runtime/ffmpeg';
import {
    proResVideoCodec,
    prores,
    createProResDecoder,
    createProResEncoder,
} from 'mediaforgejs-prores';
import { decodeProResRawAsync, type ProResRawFrame } from 'mediaforgejs-prores-raw';
export const provider: VideoCodecProvider = proResVideoCodec;
export const plugin: MediaForgePlugin = prores;
export const forges = [
    new MediaForge({ plugins: { exclude: ['h264'], add: [prores, player] } }),
    new LiteForge({ plugins: [...allPlugins] }),
];
export const codecFactories = [createProResDecoder, createProResEncoder];
export async function raw(data: Uint8Array): Promise<ProResRawFrame> {
    return decodeProResRawAsync(data, { codec: 'aprn' });
}
export async function validate(input: Blob) {
    const options: ConvertOptions = {
        maxBytes: 1024 * 1024,
        onProgress: ({ fraction }) => fraction,
        open: { metadataPolicy: 'error' },
    };
    return check(input, 'mkv', options);
}
export async function write(input: Blob): Promise<MediaResult> {
    const limits = { maxBytes: 1024 * 1024, open: { cacheBytes: 0 } };
    await convert(input, 'ts', { sink: new MemorySink(), ...limits });
    return convert(input, {
        to: 'mov',
        video: { codec: 'ap4h' },
        allowPrecisionLoss: true,
        plugins: { add: [prores] },
    });
}
export const constructors = [HlsClient, EmeController, FFmpegBackend];\n`;
