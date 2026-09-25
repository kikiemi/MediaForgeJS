import { createPcmCopyHeader, describePcmTrack } from '../core/pcm-format.js';
import { PCM_AUDIO_FORMATS } from '../core/format-plans.js';
import { DemuxerRegistry } from '../demux/registry.js';
import { EncodeError, MediaForgeError } from '../core/errors.js';
import { runReplayableAudio } from './replayable-audio-lifetime.js';
import { MemorySink } from '../io/sinks.js';
import { drainSink } from '../io/sink-backpressure.js';
import { ADTSMuxer } from '../mux/adts-muxer.js';
import { yieldToEventLoop } from './audio-buffer-tools.js';
export function createStreamingAudioOutput(codecs = {}) {
    function requireCodec(codec, name) {
        if (!codec)
            throw new MediaForgeError(`Audio encoder '${name}' is not installed`, 'FORMAT');
        return codec;
    }
    function assertChunk(source, chunk) {
        if (chunk.length !== source.channels) {
            throw new EncodeError(`PCM replay changed channel count (${source.channels} -> ${chunk.length})`);
        }
        const frames = chunk[0]?.length ?? 0;
        for (let channel = 1; channel < chunk.length; channel++) {
            if (chunk[channel].length !== frames) {
                throw new EncodeError('PCM replay produced channel planes with different lengths');
            }
        }
        return frames;
    }
    async function visitPcm(source, signal, consume, progress) {
        let frames = 0;
        let peakChunkFrames = 0;
        let framesSinceYield = 0;
        let lastProgressFrame = 0;
        for await (const chunk of source.chunks(signal)) {
            signal?.throwIfAborted();
            const chunkFrames = assertChunk(source, chunk);
            if (chunkFrames === 0)
                continue;
            await consume(chunk);
            frames += chunkFrames;
            framesSinceYield += chunkFrames;
            peakChunkFrames = Math.max(peakChunkFrames, chunkFrames);
            if (frames - lastProgressFrame >= 65536 || frames >= source.estimatedFrames) {
                progress?.(frames);
                lastProgressFrame = frames;
            }
            if (framesSinceYield >= 16384) {
                await yieldToEventLoop();
                framesSinceYield = 0;
            }
        }
        signal?.throwIfAborted();
        return { frames, peakChunkFrames };
    }
    function expectedRatio(done, expected) {
        return Math.max(0, Math.min(1, done / Math.max(1, expected)));
    }
    async function streamReplayableAac(source, onFrame, options = {}) {
        return runReplayableAudio(source, undefined, options, (input, _sink, guarded, perform) => streamReplayableAacInternal(input, (frame, index) => perform(() => onFrame(frame, index)), guarded));
    }
    async function streamReplayableAacInternal(source, onFrame, options = {}) {
        if (source.channels > 2) {
            throw new EncodeError('Built-in streaming AAC-LC encoder supports 1-2 channels');
        }
        const encoder = new (requireCodec(codecs.aac, 'aac'))(source.sampleRate, source.channels, options.bitrateKbps ?? 128, {
            expectedInputFrames: source.estimatedFrames,
            collectFrames: false,
            onFrame,
            onProgress: (done, total) => {
                if ((done & 15) === 0 || done === total) {
                    options.onProgress?.(expectedRatio(done, total), `Encoding AAC ${done}/${total}`);
                }
            },
        });
        const visit = await visitPcm(source, options.signal, async (chunk) => {
            encoder.pushPlanar(chunk);
            await options.afterPcmChunk?.();
        });
        const result = encoder.finish();
        return {
            audioSpecificConfig: result.audioSpecificConfig,
            inputFrames: encoder.framesReceived,
            encodedFrames: encoder.framesProduced,
            peakPcmFrames: Math.max(visit.peakChunkFrames, encoder.peakBufferedFrames),
        };
    }
    function planningBytes(plan) {
        let bytes = 0;
        for (const channel of plan.mixedEpisodes)
            bytes += channel.bits.byteLength;
        return bytes;
    }
    async function encodeReplayablePcm(source, format, options = {}) {
        assertFormat(format);
        return runReplayableAudio(source, undefined, options, (input, _sink, guarded) => encodeReplayablePcmInternal(input, format, guarded));
    }
    async function encodeReplayablePcmInternal(source, format, options = {}) {
        if (PCM_AUDIO_FORMATS.has(format)) {
            const sink = new MemorySink();
            const diagnostics = await encodeReplayablePcmToSink(source, format, sink, options);
            return { blob: sink.toBlob(DemuxerRegistry.getMimeType(format)), diagnostics };
        }
        const expected = Math.max(1, source.estimatedFrames);
        const bitrate = options.bitrateKbps ??
            (format === 'mp2' ? (source.channels === 1 ? 192 : 256) : format === 'mp3' ? 256 : 128);
        if (format === 'aac') {
            const sink = new MemorySink();
            const muxer = new ADTSMuxer(sink, source.sampleRate, source.channels);
            const frameSeconds = 1024 / source.sampleRate;
            const result = await streamReplayableAac(source, (frame, index) => muxer.addAudioChunk({
                data: frame,
                timestamp: index * frameSeconds,
                duration: frameSeconds,
                isKeyframe: true,
                trackType: 'audio',
            }), { ...options, bitrateKbps: bitrate });
            await muxer.finalize();
            return {
                blob: sink.toBlob('audio/aac'),
                diagnostics: {
                    format,
                    passes: 1,
                    inputFrames: result.inputFrames,
                    encodedFrames: result.encodedFrames,
                    peakPcmFrames: result.peakPcmFrames,
                    planningBytes: 0,
                },
            };
        }
        if (format === 'flac') {
            const encoder = new (requireCodec(codecs.flac, 'flac'))(source.sampleRate, source.channels, {
                signal: options.signal,
                expectedInputFrames: source.estimatedFrames,
                onProgress: (done, total) => {
                    if ((done & 15) === 0 || done === total) {
                        options.onProgress?.(expectedRatio(done, total), `Encoding FLAC ${done}/${total}`);
                    }
                },
            });
            const visit = await visitPcm(source, options.signal, chunk => encoder.pushPlanar(chunk), done => options.onProgress?.(expectedRatio(done, expected), `Reading PCM ${done}/${expected}`));
            const blob = encoder.finishBlob();
            return {
                blob,
                diagnostics: {
                    format,
                    passes: 1,
                    inputFrames: encoder.framesReceived,
                    encodedFrames: encoder.framesProduced,
                    peakPcmFrames: Math.max(visit.peakChunkFrames, encoder.peakBufferedFrames),
                    planningBytes: 0,
                },
            };
        }
        if (format === 'mp2') {
            let peak = 0;
            const levelVisit = await visitPcm(source, options.signal, chunk => {
                for (const plane of chunk) {
                    for (let index = 0; index < plane.length; index++) {
                        peak = Math.max(peak, Math.abs(plane[index]));
                    }
                }
            }, done => options.onProgress?.(expectedRatio(done, expected) * 0.15, `Analysing MP2 level ${done}/${expected}`));
            const gain = peak > 1 && peak > 1e-9 ? 1 / peak : 1;
            const encoder = new (requireCodec(codecs.mp2, 'mp2'))(source.sampleRate, source.channels, bitrate, {
                signal: options.signal,
                expectedInputFrames: levelVisit.frames,
                onProgress: progress => {
                    if ((progress.completedFrames & 31) === 0 || progress.completedFrames === progress.totalFrames) {
                        options.onProgress?.(0.15 + expectedRatio(progress.completedFrames, progress.totalFrames) * 0.85, `Encoding MP2 ${progress.completedFrames}/${progress.totalFrames}`);
                    }
                },
            });
            const encodeVisit = await visitPcm(source, options.signal, chunk => {
                if (gain === 1) {
                    encoder.pushPlanar(chunk);
                    return;
                }
                encoder.pushPlanar(chunk.map(plane => Float32Array.from(plane, sample => sample * gain)));
            });
            if (encodeVisit.frames !== levelVisit.frames) {
                throw new EncodeError(`PCM replay length changed (${levelVisit.frames} -> ${encodeVisit.frames})`);
            }
            const blob = encoder.finish();
            return {
                blob,
                diagnostics: {
                    format,
                    passes: 2,
                    inputFrames: encoder.framesReceived,
                    encodedFrames: encoder.framesProduced,
                    peakPcmFrames: Math.max(levelVisit.peakChunkFrames, encodeVisit.peakChunkFrames, encoder.peakBufferedFrames),
                    planningBytes: 0,
                },
            };
        }
        const levels = new (requireCodec(codecs.mp3, 'mp3').Mp3LevelAnalyzer)(source.channels);
        const levelVisit = await visitPcm(source, options.signal, chunk => levels.pushPlanar(chunk), done => options.onProgress?.(expectedRatio(done, expected) * 0.08, `Analysing MP3 level ${done}/${expected}`));
        const summary = levels.finish();
        const gain = summary.peak > 1 && summary.peak > 1e-9 ? 1 / summary.peak : 1;
        const analyser = new (requireCodec(codecs.mp3, 'mp3').Mp3PlanAnalyzer)(source.sampleRate, source.channels, summary, gain);
        const planVisit = await visitPcm(source, options.signal, chunk => analyser.pushPlanar(chunk), done => options.onProgress?.(0.08 + expectedRatio(done, expected) * 0.12, `Planning MP3 blocks ${done}/${expected}`));
        const plan = analyser.finish();
        const encoder = new (requireCodec(codecs.mp3, 'mp3').StreamingMp3Encoder)(plan, bitrate, {
            signal: options.signal,
            vbr: options.vbr === true,
            onProgress: progress => {
                if ((progress.completedFrames & 31) === 0 || progress.completedFrames === progress.totalFrames) {
                    options.onProgress?.(0.2 + expectedRatio(progress.completedFrames, progress.totalFrames) * 0.8, `Encoding MP3 ${progress.completedFrames}/${progress.totalFrames}`);
                }
            },
        });
        const encodeVisit = await visitPcm(source, options.signal, chunk => encoder.pushPlanar(chunk));
        const blob = encoder.finish();
        return {
            blob,
            diagnostics: {
                format,
                passes: 3,
                inputFrames: encoder.framesReceived,
                encodedFrames: encoder.framesProduced,
                peakPcmFrames: Math.max(levelVisit.peakChunkFrames, planVisit.peakChunkFrames, encodeVisit.peakChunkFrames, analyser.peakBufferedFrames, encoder.peakBufferedFrames),
                planningBytes: planningBytes(plan),
            },
        };
    }
    function sameBytes(left, right) {
        if (left.length !== right.length)
            return false;
        for (let index = 0; index < left.length; index++) {
            if (left[index] !== right[index])
                return false;
        }
        return true;
    }
    const WAV_STREAM_HEADER_BYTES = 80;
    function setAscii(bytes, offset, text) {
        for (let index = 0; index < text.length; index++) {
            bytes[offset + index] = text.charCodeAt(index);
        }
    }
    function setUint64LE(view, offset, value) {
        if (!Number.isSafeInteger(value) || value < 0) {
            throw new EncodeError(`WAV size is outside JavaScript's exact integer range (${value})`);
        }
        view.setUint32(offset, value >>> 0, true);
        view.setUint32(offset + 4, Math.floor(value / 0x100000000), true);
    }
    function streamingWavHeader(sampleRate, channels, frames) {
        if (!Number.isInteger(sampleRate) || sampleRate < 1 || sampleRate > 0xffffffff) {
            throw new EncodeError(`WAV sample rate is invalid (${sampleRate})`);
        }
        if (!Number.isInteger(channels) || channels < 1 || channels > 0x7fff) {
            throw new EncodeError(`WAV channel count is invalid (${channels})`);
        }
        const blockAlign = channels * 2;
        const byteRate = sampleRate * blockAlign;
        if (blockAlign > 0xffff || byteRate > 0xffffffff) {
            throw new EncodeError(`WAV ${sampleRate}Hz/${channels}ch exceeds RIFF format-field limits`);
        }
        const dataBytes = frames * blockAlign;
        if (!Number.isSafeInteger(dataBytes)) {
            throw new EncodeError("WAV PCM byte count exceeds JavaScript's exact integer range");
        }
        const riffSize = WAV_STREAM_HEADER_BYTES + dataBytes - 8;
        const rf64 = riffSize > 0xffffffff;
        const header = new Uint8Array(WAV_STREAM_HEADER_BYTES);
        const view = new DataView(header.buffer);
        setAscii(header, 0, rf64 ? 'RF64' : 'RIFF');
        view.setUint32(4, rf64 ? 0xffffffff : riffSize, true);
        setAscii(header, 8, 'WAVE');
        setAscii(header, 12, rf64 ? 'ds64' : 'JUNK');
        view.setUint32(16, 28, true);
        if (rf64) {
            setUint64LE(view, 20, riffSize);
            setUint64LE(view, 28, dataBytes);
            setUint64LE(view, 36, frames);
            view.setUint32(44, 0, true);
        }
        setAscii(header, 48, 'fmt ');
        view.setUint32(52, 16, true);
        view.setUint16(56, 1, true);
        view.setUint16(58, channels, true);
        view.setUint32(60, sampleRate, true);
        view.setUint32(64, byteRate, true);
        view.setUint16(68, blockAlign, true);
        view.setUint16(70, 16, true);
        setAscii(header, 72, 'data');
        view.setUint32(76, rf64 ? 0xffffffff : dataBytes, true);
        return header;
    }
    function pcm16Bytes(planes, littleEndian = true) {
        const channels = planes.length;
        const frames = planes[0]?.length ?? 0;
        const bytes = new Uint8Array(frames * channels * 2);
        const stride = channels * 2;
        const low = littleEndian ? 0 : 1;
        const high = 1 - low;
        for (let channel = 0; channel < channels; channel++) {
            const plane = planes[channel];
            for (let frame = 0, at = channel * 2; frame < frames; frame++, at += stride) {
                const sample = plane[frame];
                const quantized = (sample < 0 ? Math.max(-1, sample) * 32768 : Math.min(1, sample) * 32767) | 0;
                bytes[at + low] = quantized;
                bytes[at + high] = quantized >> 8;
            }
        }
        return bytes;
    }
    function assertFormat(format) {
        if (!['aac', 'flac', 'mp2', 'mp3', ...PCM_AUDIO_FORMATS].includes(format)) {
            throw new EncodeError(`Unsupported streaming audio format (${format})`);
        }
    }
    async function encodeReplayablePcmToSink(source, format, sink, options = {}) {
        assertFormat(format);
        return runReplayableAudio(source, sink, options, (input, output, guarded) => encodeReplayablePcmToSinkInternal(input, format, output, guarded));
    }
    async function encodeReplayablePcmToSinkInternal(source, format, sink, options = {}) {
        if (format === 'wav' || format === 'aiff' || format === 'au' || format === 'caf') {
            const pcm = format === 'wav'
                ? undefined
                : describePcmTrack({
                    codec: 'pcm-s16le',
                    sampleRate: source.sampleRate,
                    channelCount: source.channels,
                });
            const header = (frames) => pcm
                ? createPcmCopyHeader(format, pcm, frames * pcm.blockAlign).header
                : streamingWavHeader(source.sampleRate, source.channels, frames);
            const initialHeader = header(0);
            const littleEndian = format === 'wav' || format === 'caf';
            let counted = null;
            if (sink.patchAt) {
                sink.write(new Uint8Array(initialHeader.length));
                await drainSink(sink, options.signal);
            }
            else {
                counted = await visitPcm(source, options.signal, () => drainSink(sink, options.signal), done => options.onProgress?.(expectedRatio(done, source.estimatedFrames) * 0.25, `Counting ${format.toUpperCase()} samples ${done}/${source.estimatedFrames}`));
                sink.write(header(counted.frames));
                await drainSink(sink, options.signal);
            }
            const written = await visitPcm(source, options.signal, async (chunk) => {
                sink.write(pcm16Bytes(chunk, littleEndian));
                await drainSink(sink, options.signal);
            }, done => options.onProgress?.((counted ? 0.25 : 0) + expectedRatio(done, source.estimatedFrames) * (counted ? 0.75 : 1), `Writing ${format.toUpperCase()} samples ${done}/${source.estimatedFrames}`));
            if (counted && counted.frames !== written.frames) {
                throw new EncodeError(`PCM replay length changed (${counted.frames} -> ${written.frames})`);
            }
            if (sink.patchAt) {
                sink.patchAt(0, header(written.frames));
            }
            await drainSink(sink, options.signal);
            options.onProgress?.(1, 'Finalizing output...');
            await sink.close();
            return {
                format,
                passes: counted ? 2 : 1,
                inputFrames: written.frames,
                encodedFrames: written.frames,
                peakPcmFrames: Math.max(written.peakChunkFrames, counted?.peakChunkFrames ?? 0),
                planningBytes: 0,
            };
        }
        const bitrate = options.bitrateKbps ??
            (format === 'mp2' ? (source.channels === 1 ? 192 : 256) : format === 'mp3' ? 256 : 128);
        if (format === 'aac') {
            const muxer = new ADTSMuxer(sink, source.sampleRate, source.channels);
            const frameSeconds = 1024 / source.sampleRate;
            const result = await streamReplayableAac(source, (frame, index) => muxer.addAudioChunk({
                data: frame,
                timestamp: index * frameSeconds,
                duration: frameSeconds,
                isKeyframe: true,
                trackType: 'audio',
            }), {
                ...options,
                bitrateKbps: bitrate,
                afterPcmChunk: () => drainSink(sink, options.signal),
            });
            options.onProgress?.(1, 'Finalizing output...');
            await muxer.finalize();
            return {
                format,
                passes: 1,
                inputFrames: result.inputFrames,
                encodedFrames: result.encodedFrames,
                peakPcmFrames: result.peakPcmFrames,
                planningBytes: 0,
            };
        }
        if (format === 'flac') {
            const run = async (onFrame) => {
                const encoder = new (requireCodec(codecs.flac, 'flac'))(source.sampleRate, source.channels, {
                    signal: options.signal,
                    expectedInputFrames: source.estimatedFrames,
                    collectFrames: false,
                    onFrame,
                    onProgress: (done, total) => options.onProgress?.(expectedRatio(done, total), `Encoding FLAC ${done}/${total}`),
                });
                const visit = await visitPcm(source, options.signal, async (chunk) => {
                    encoder.pushPlanar(chunk);
                    await drainSink(sink, options.signal);
                });
                const header = encoder.finishHeader();
                return { header, visit, encoder };
            };
            let passes = 1;
            let final;
            if (sink.patchAt) {
                sink.write(new Uint8Array(42));
                await drainSink(sink, options.signal);
                final = await run(frame => sink.write(frame));
                if (final.header.length !== 42)
                    throw new EncodeError('FLAC header size changed unexpectedly');
                sink.patchAt(0, final.header);
            }
            else {
                const dry = await run(() => undefined);
                sink.write(dry.header);
                await drainSink(sink, options.signal);
                final = await run(frame => sink.write(frame));
                if (!sameBytes(dry.header, final.header)) {
                    throw new EncodeError('PCM replay changed FLAC stream statistics');
                }
                passes = 2;
            }
            await drainSink(sink, options.signal);
            options.onProgress?.(1, 'Finalizing output...');
            await sink.close();
            return {
                format,
                passes,
                inputFrames: final.encoder.framesReceived,
                encodedFrames: final.encoder.framesProduced,
                peakPcmFrames: Math.max(final.visit.peakChunkFrames, final.encoder.peakBufferedFrames),
                planningBytes: 0,
            };
        }
        if (format === 'mp2') {
            let peak = 0;
            const levelVisit = await visitPcm(source, options.signal, async (chunk) => {
                for (const plane of chunk) {
                    for (let index = 0; index < plane.length; index++) {
                        peak = Math.max(peak, Math.abs(plane[index]));
                    }
                }
                await drainSink(sink, options.signal);
            });
            const gain = peak > 1 && peak > 1e-9 ? 1 / peak : 1;
            const encoder = new (requireCodec(codecs.mp2, 'mp2'))(source.sampleRate, source.channels, bitrate, {
                signal: options.signal,
                expectedInputFrames: levelVisit.frames,
                collectOutput: false,
                onFrame: frame => sink.write(frame),
                onProgress: progress => options.onProgress?.(expectedRatio(progress.completedFrames, progress.totalFrames), `Encoding MP2 ${progress.completedFrames}/${progress.totalFrames}`),
            });
            const encodeVisit = await visitPcm(source, options.signal, async (chunk) => {
                encoder.pushPlanar(gain === 1 ? chunk : chunk.map(plane => Float32Array.from(plane, sample => sample * gain)));
                await drainSink(sink, options.signal);
            });
            encoder.finish();
            if (encodeVisit.frames !== levelVisit.frames) {
                throw new EncodeError(`PCM replay length changed (${levelVisit.frames} -> ${encodeVisit.frames})`);
            }
            await drainSink(sink, options.signal);
            options.onProgress?.(1, 'Finalizing output...');
            await sink.close();
            return {
                format,
                passes: 2,
                inputFrames: encoder.framesReceived,
                encodedFrames: encoder.framesProduced,
                peakPcmFrames: Math.max(levelVisit.peakChunkFrames, encodeVisit.peakChunkFrames, encoder.peakBufferedFrames),
                planningBytes: 0,
            };
        }
        const levels = new (requireCodec(codecs.mp3, 'mp3').Mp3LevelAnalyzer)(source.channels);
        const levelVisit = await visitPcm(source, options.signal, async (chunk) => {
            levels.pushPlanar(chunk);
            await drainSink(sink, options.signal);
        });
        const summary = levels.finish();
        const gain = summary.peak > 1 && summary.peak > 1e-9 ? 1 / summary.peak : 1;
        const analyser = new (requireCodec(codecs.mp3, 'mp3').Mp3PlanAnalyzer)(source.sampleRate, source.channels, summary, gain);
        const planVisit = await visitPcm(source, options.signal, async (chunk) => {
            analyser.pushPlanar(chunk);
            await drainSink(sink, options.signal);
        });
        const plan = analyser.finish();
        const runMp3 = async (onFrame) => {
            const encoder = new (requireCodec(codecs.mp3, 'mp3').StreamingMp3Encoder)(plan, bitrate, {
                signal: options.signal,
                vbr: options.vbr === true,
                collectFrames: false,
                onFrame,
                onProgress: progress => options.onProgress?.(expectedRatio(progress.completedFrames, progress.totalFrames), `Encoding MP3 ${progress.completedFrames}/${progress.totalFrames}`),
            });
            const visit = await visitPcm(source, options.signal, async (chunk) => {
                encoder.pushPlanar(chunk);
                await drainSink(sink, options.signal);
            });
            const output = encoder.finishOutput();
            return { infoFrame: output.infoFrame, visit, encoder };
        };
        let passes = 3;
        let final;
        if (sink.patchAt) {
            const headerSize = requireCodec(codecs.mp3, 'mp3').mp3GaplessInfoFrameSize(source.sampleRate, source.channels, bitrate);
            sink.write(new Uint8Array(headerSize));
            await drainSink(sink, options.signal);
            final = await runMp3(frame => sink.write(frame));
            if (final.infoFrame.length !== headerSize) {
                throw new EncodeError(`MP3 Info frame size changed (${headerSize} -> ${final.infoFrame.length})`);
            }
            sink.patchAt(0, final.infoFrame);
        }
        else {
            const dry = await runMp3(() => undefined);
            sink.write(dry.infoFrame);
            await drainSink(sink, options.signal);
            final = await runMp3(frame => sink.write(frame));
            if (!sameBytes(dry.infoFrame, final.infoFrame)) {
                throw new EncodeError('PCM replay changed MP3 gapless metadata');
            }
            passes = 4;
        }
        if (final.visit.frames !== levelVisit.frames || planVisit.frames !== levelVisit.frames) {
            throw new EncodeError('PCM replay length changed during MP3 sink encode');
        }
        await drainSink(sink, options.signal);
        options.onProgress?.(1, 'Finalizing output...');
        await sink.close();
        return {
            format,
            passes,
            inputFrames: final.encoder.framesReceived,
            encodedFrames: final.encoder.framesProduced,
            peakPcmFrames: Math.max(levelVisit.peakChunkFrames, planVisit.peakChunkFrames, final.visit.peakChunkFrames, analyser.peakBufferedFrames, final.encoder.peakBufferedFrames),
            planningBytes: planningBytes(plan),
        };
    }
    return { streamReplayableAac, encodeReplayablePcm, encodeReplayablePcmToSink };
}
