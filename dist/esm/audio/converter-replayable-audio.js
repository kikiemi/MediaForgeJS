import { demuxCompatible } from '../demux/compatible-demux.js';
import { MediaForgeError, rethrowIfAbort } from '../core/errors.js';
import { injectFlacMetaBlocks, readFlacMetaBlocks, readId3v2Prefix } from '../core/audio-metadata.js';
import { logger } from '../core/logger.js';
import { DiagnosticContext } from '../core/diagnostics.js';
import { readOggCommentPayload } from '../core/ogg-meta.js';
import { readMp4Udta } from '../core/mp4-meta.js';
import { mp4aAudioObjectType } from '../core/codec-strings.js';
import { PCM_AUDIO_FORMATS } from '../core/format-plans.js';
import { demuxStandaloneAudio } from '../demux/standalone-audio-demuxer.js';
import { createPcmTrackSource } from './pcm-track-source.js';
import { MP4Demuxer } from '../demux/mp4-demuxer.js';
import { WebMDemuxer } from '../demux/webm-demuxer.js';
import { FLVDemuxer } from '../demux/flv-demuxer.js';
import { TSDemuxer } from '../demux/ts-demuxer.js';
import { AVIDemuxer } from '../demux/avi-demuxer.js';
import { BlobSource } from '../io/sources.js';
import { MemorySink } from '../io/sinks.js';
import { MP4Muxer } from '../mux/mp4-muxer.js';
import { AAC_SAMPLE_RATES } from './aac-tables.js';
import { buildAacAsc } from './adts.js';
import { createConfiguredAacTrackPcmSource } from './aac-track-decoder.js';
import { createWavPcmSource, readWavLayout } from './streaming-wav.js';
import { normalizePcmSource } from './pcm-source.js';
import { resolveMpegAudioBitrate } from './mpeg-audio-encoder.js';
import { createWebCodecsTrackPcmSource } from './webcodecs-pcm-source.js';
import { createAdtsPcmSource, createRawMpegPcmSource } from './raw-audio-pcm-sources.js';
import { createRawFlacPcmSource } from './raw-flac-pcm-source.js';
import { createRawOggOpusPcmSource } from './raw-ogg-opus-pcm-source.js';
import { createRawOggVorbisPcmSource } from './raw-ogg-vorbis-pcm-source.js';
import { encodeReplayableOpusToSink } from './streaming-opus-output.js';
import { encodeReplayableM4AToSink } from './streaming-m4a-output.js';
import { encodeReplayablePcm, encodeReplayablePcmToSink, streamReplayableAac, } from './streaming-audio-output.js';
function nativeDemuxerFor(format, metadataPolicy) {
    if (['m4a', 'mp4', 'mov', '3gp', 'm4v'].includes(format))
        return new MP4Demuxer();
    if (format === 'webm' || format === 'mkv')
        return {
            demux: (input, signal) => new WebMDemuxer().demux(input, signal, new DiagnosticContext({ metadataPolicy, onWarning: warning => logger.warn(warning.message) })),
        };
    if (format === 'flv')
        return new FLVDemuxer();
    if (format === 'ts')
        return new TSDemuxer();
    if (format === 'avi')
        return new AVIDemuxer();
    return null;
}
function flacMetadataSink(sink, blocks) {
    const metadataBytes = blocks.reduce((sum, block) => sum + block.length, 0);
    let headerWritten = false;
    return {
        signal: sink.signal,
        write: data => {
            if (!headerWritten) {
                const placeholder = data.length === 42 && data.every(byte => byte === 0);
                const header = data.length === 42 && data[0] === 0x66 && data[1] === 0x4c && data[2] === 0x61 && data[3] === 0x43;
                if (!placeholder && !header) {
                    throw new MediaForgeError('FLAC sink encoder did not emit its STREAMINFO header first', 'ENCODE');
                }
                headerWritten = true;
                const first = data.slice();
                if (header)
                    first[4] = first[4] & 0x7f;
                sink.write(first);
                for (let index = 0; index < blocks.length; index++) {
                    const block = blocks[index].slice();
                    block[0] = (block[0] & 0x7f) | (index === blocks.length - 1 ? 0x80 : 0);
                    sink.write(block);
                }
                return;
            }
            sink.write(data);
        },
        close: () => sink.close(),
        ...(sink.patchAt
            ? {
                patchAt: (offset, data) => {
                    const patch = offset === 0 && data.length >= 5 ? data.slice() : data;
                    if (offset === 0 &&
                        patch[0] === 0x66 &&
                        patch[1] === 0x4c &&
                        patch[2] === 0x61 &&
                        patch[3] === 0x43) {
                        patch[4] = patch[4] & 0x7f;
                    }
                    sink.patchAt(offset < 42 ? offset : offset + metadataBytes, patch);
                },
            }
            : {}),
        ...(sink.abort ? { abort: (reason) => sink.abort(reason) } : {}),
        ...(sink.drain ? { drain: () => sink.drain() } : {}),
    };
}
export class ConverterReplayableAudio {
    config;
    host;
    constructor(config, host) {
        this.config = config;
        this.host = host;
    }
    async tryEncode(file, fmt, inputFmt) {
        if (!['mp3', 'mp2', 'aac', 'flac', 'm4a', ...PCM_AUDIO_FORMATS, 'ogg'].includes(fmt))
            return null;
        const resolved = await this.resolveSource(file, inputFmt);
        if (!resolved)
            return null;
        const { source, label } = resolved;
        const target = this.resolveTarget(fmt, source.sampleRate, source.channels);
        if (!target)
            return null;
        const normalized = normalizePcmSource(source, target.sampleRate, target.channels);
        const encoded = await this.encodeSource(normalized, fmt, target, label);
        if (inputFmt === 'mp3' && fmt === 'mp3') {
            const tag = await readId3v2Prefix(file, this.config.signal);
            if (tag)
                return new Blob([tag, encoded], { type: 'audio/mpeg' });
        }
        if (inputFmt === 'flac' && fmt === 'flac') {
            const blocks = await readFlacMetaBlocks(file, this.config.signal);
            if (blocks.length > 0)
                return injectFlacMetaBlocks(encoded, blocks, this.config.signal);
        }
        return encoded;
    }
    async resolveSource(file, inputFmt, requireExplicitTrackSelection = false) {
        if (inputFmt &&
            [...PCM_AUDIO_FORMATS, 'aac', 'mp1', 'mp2', 'mp3', 'flac'].includes(inputFmt) &&
            this.config.audioTrackIndex !== undefined &&
            this.config.audioTrackIndex !== 0) {
            throw new MediaForgeError(`audioTrackIndex ${this.config.audioTrackIndex} is out of range (input has 1 audio track)`, 'FORMAT');
        }
        let source = null;
        let label = '';
        if (inputFmt === 'wav') {
            const layout = await readWavLayout(file, this.config.signal);
            if (!layout)
                return null;
            source = createWavPcmSource(file, layout);
            label = 'WAV';
        }
        else if (inputFmt === 'aiff' || inputFmt === 'au' || inputFmt === 'caf') {
            const input = new BlobSource(file);
            const result = await demuxStandaloneAudio(input, { format: inputFmt, signal: this.config.signal });
            source = createPcmTrackSource(result.audioTracks[0], sample => input.read(sample.offset, sample.size), this.config.signal);
            label = inputFmt.toUpperCase();
        }
        else if (inputFmt === 'aac') {
            source = await createAdtsPcmSource(file, this.config.signal);
            if (!source)
                return null;
            label = 'ADTS AAC-LC';
        }
        else if (inputFmt === 'mp1' || inputFmt === 'mp2' || inputFmt === 'mp3') {
            source = await createRawMpegPcmSource(file, inputFmt, this.config.signal);
            if (!source)
                return null;
            label = inputFmt.toUpperCase();
        }
        else if (inputFmt === 'flac') {
            source = await createRawFlacPcmSource(file, this.config.signal);
            if (!source)
                return null;
            label = 'raw FLAC';
        }
        else if (inputFmt === 'ogg') {
            const opus = await createRawOggOpusPcmSource(file, this.config.signal);
            if (opus) {
                source = opus;
                label = 'Ogg Opus';
            }
            else {
                source = await createRawOggVorbisPcmSource(file, this.config.signal);
                if (!source)
                    return null;
                label = 'Ogg Vorbis';
            }
        }
        else if (inputFmt && nativeDemuxerFor(inputFmt, this.config.metadataPolicy)) {
            try {
                const result = this.host.getDemuxed?.(file) ??
                    (await demuxCompatible(nativeDemuxerFor(inputFmt, this.config.metadataPolicy), file, this.config.signal));
                const index = this.config.audioTrackIndex ?? 0;
                if (requireExplicitTrackSelection &&
                    result.audioTracks.length > 1 &&
                    this.config.audioTrackIndex === undefined) {
                    throw new MediaForgeError(`input has ${result.audioTracks.length} audio tracks; convertToSink() requires ` +
                        'audioTrackIndex because a single-track audio stream cannot preserve the others', 'FORMAT');
                }
                if (this.config.audioTrackIndex !== undefined &&
                    (!Number.isInteger(index) || index < 0 || index >= result.audioTracks.length)) {
                    throw new MediaForgeError(`audioTrackIndex ${index} is out of range (input has ${result.audioTracks.length} audio track(s))`, 'FORMAT');
                }
                const track = result.audioTracks[index];
                if (!track || track.samples.length === 0)
                    return null;
                const blobSource = new BlobSource(file);
                const readSample = async (sample) => sample.data ?? blobSource.read(sample.offset, sample.size);
                if (inputFmt === 'avi' && (track.codec === 'pcm' || track.codec.startsWith('pcm-'))) {
                    source = createPcmTrackSource(track, readSample, this.config.signal);
                }
                else if (track.codec.startsWith('mp4a') || track.codec === 'aac') {
                    source = createConfiguredAacTrackPcmSource(track, readSample, {
                        signal: this.config.signal,
                    });
                }
                else {
                    source = await createWebCodecsTrackPcmSource(track, readSample, this.config.signal);
                }
                if (!source)
                    return null;
                label = `${inputFmt.toUpperCase()} ${track.codec}`;
            }
            catch (error) {
                rethrowIfAbort(error, this.config.signal);
                if (error instanceof MediaForgeError && (error.code === 'FORMAT' || error.code === 'DEMUX'))
                    throw error;
                logger.info(`[Converter] replayable ${inputFmt} audio route unavailable:`, error);
                return null;
            }
        }
        else {
            return null;
        }
        return { source, label };
    }
    async tryEncodeToSink(file, sink, fmt, inputFmt) {
        if (!['mp3', 'mp2', 'aac', 'flac', ...PCM_AUDIO_FORMATS, 'ogg', 'm4a'].includes(fmt))
            return false;
        const resolved = await this.resolveSource(file, inputFmt, true);
        if (!resolved)
            return false;
        const target = this.resolveTarget(fmt, resolved.source.sampleRate, resolved.source.channels);
        if (!target)
            return false;
        const source = normalizePcmSource(resolved.source, target.sampleRate, target.channels);
        let outputSink = sink;
        if (inputFmt === 'mp3' && fmt === 'mp3') {
            const tag = await readId3v2Prefix(file, this.config.signal);
            if (tag) {
                sink.write(tag);
                const base = tag.length;
                outputSink = {
                    signal: sink.signal,
                    write: data => sink.write(data),
                    close: () => sink.close(),
                    ...(sink.patchAt
                        ? { patchAt: (offset, data) => sink.patchAt(base + offset, data) }
                        : {}),
                    ...(sink.abort ? { abort: (reason) => sink.abort(reason) } : {}),
                    ...(sink.drain ? { drain: () => sink.drain() } : {}),
                };
            }
        }
        if (inputFmt === 'flac' && fmt === 'flac') {
            const blocks = await readFlacMetaBlocks(file, this.config.signal);
            if (blocks.length > 0)
                outputSink = flacMetadataSink(sink, blocks);
        }
        if (fmt === 'm4a') {
            const mp4Family = inputFmt !== undefined && ['m4a', 'mp4', 'mov', '3gp', 'm4v'].includes(inputFmt);
            const diagnostics = await encodeReplayableM4AToSink(source, outputSink, {
                bitrateKbps: target.bitrateKbps,
                audioLanguage: this.host.getCarried().audioLanguage,
                title: this.host.getCarried().title,
                audioTrack: this.host.getCarried().audioTrack,
                moovUserData: mp4Family ? ((await readMp4Udta(file, this.config.signal)) ?? undefined) : undefined,
                signal: this.config.signal,
                onProgress: (fraction, message) => this.config.onProgress?.(12 + Math.round(fraction * 88), message),
            });
            logger.info(`[Converter] sink ${resolved.label}->M4A: ${diagnostics.passes} pass(es), ` +
                `peak PCM ${diagnostics.peakPcmFrames} frames, ` +
                `sample table ${diagnostics.planningBytes} bytes`);
            return true;
        }
        if (fmt === 'ogg') {
            const commentPayload = inputFmt === 'ogg'
                ? ((await readOggCommentPayload(file, this.config.signal)) ?? undefined)
                : (this.host.getCarried().oggComments ?? undefined);
            const diagnostics = await encodeReplayableOpusToSink(source, outputSink, {
                bitrateBps: this.host.audioBitrateBps() || 128000,
                commentPayload,
                signal: this.config.signal,
                onProgress: (fraction, message) => this.config.onProgress?.(12 + Math.round(fraction * 88), message),
            });
            logger.info(`[Converter] sink ${resolved.label}->OGG: 1 pass, ` +
                `peak PCM ${diagnostics.peakPcmFrames} frames, ${diagnostics.packets} packets`);
            return true;
        }
        const diagnostics = await encodeReplayablePcmToSink(source, target.format, outputSink, {
            bitrateKbps: target.bitrateKbps,
            vbr: this.config.audioVbr === true,
            signal: this.config.signal,
            onProgress: (fraction, message) => this.config.onProgress?.(12 + Math.round(fraction * 88), message),
        });
        logger.info(`[Converter] sink ${resolved.label}->${fmt.toUpperCase()}: ${diagnostics.passes} pass(es), ` +
            `peak PCM ${diagnostics.peakPcmFrames} frames, planning ${diagnostics.planningBytes} bytes`);
        return true;
    }
    resolveTarget(fmt, sourceRate, sourceChannels) {
        let sampleRate = this.config.audioSampleRate || sourceRate;
        let channels = this.config.audioChannels || sourceChannels;
        let format;
        if (fmt === 'mp3' || fmt === 'mp2') {
            const legalRates = [32000, 44100, 48000];
            if (this.config.audioSampleRate &&
                !legalRates.includes(this.config.audioSampleRate)) {
                throw new MediaForgeError(`MP3/MP2 encoder supports ${legalRates.join('/')} Hz; requested ${this.config.audioSampleRate}` +
                    ' (MPEG-2 half rates are not implemented)', 'ENCODE');
            }
            if (!this.config.audioSampleRate) {
                sampleRate = legalRates.reduce((best, rate) => (Math.abs(rate - sourceRate) < Math.abs(best - sourceRate) ? rate : best), 44100);
            }
            if (this.config.audioChannels && (this.config.audioChannels < 1 || this.config.audioChannels > 2)) {
                throw new MediaForgeError(`MP3/MP2 carry 1-2 channels; requested ${this.config.audioChannels}`, 'ENCODE');
            }
            channels = Math.max(1, Math.min(2, channels));
            format = fmt;
        }
        else if (fmt === 'flac') {
            if (sampleRate < 1 || sampleRate > 655350) {
                throw new MediaForgeError(`FLAC cannot encode at ${sampleRate} Hz`, 'ENCODE');
            }
            if (this.config.audioChannels && (this.config.audioChannels < 1 || this.config.audioChannels > 8)) {
                throw new MediaForgeError(`flac output supports 1-8 channels; requested ${this.config.audioChannels}`, 'FORMAT');
            }
            channels = Math.max(1, Math.min(8, channels));
            format = 'flac';
        }
        else if (fmt === 'ogg') {
            if (this.config.audioSampleRate && this.config.audioSampleRate !== 48000) {
                throw new MediaForgeError(`Opus encodes at 48000 Hz only; requested ${this.config.audioSampleRate}`, 'FORMAT');
            }
            sampleRate = 48000;
            if (this.config.audioChannels && (this.config.audioChannels < 1 || this.config.audioChannels > 2)) {
                throw new MediaForgeError(`ogg Opus output supports 1-2 channels; requested ${this.config.audioChannels}`, 'FORMAT');
            }
            channels = Math.max(1, Math.min(2, channels));
            format = 'ogg';
        }
        else if (fmt === 'aiff' || fmt === 'au' || fmt === 'caf') {
            if (sampleRate < 1 || sampleRate > 768000)
                throw new MediaForgeError(`${fmt.toUpperCase()} cannot encode at ${sampleRate} Hz`, 'ENCODE');
            if (channels > 2)
                throw new MediaForgeError(`${fmt} decoded output supports mono/stereo; select audioChannels explicitly to downmix`, 'FORMAT');
            format = fmt;
        }
        else if (fmt === 'wav') {
            if (sampleRate < 1 || sampleRate > 0xffffffff) {
                throw new MediaForgeError(`WAV cannot encode at ${sampleRate} Hz`, 'ENCODE');
            }
            if (this.config.audioChannels && (this.config.audioChannels < 1 || this.config.audioChannels > 8)) {
                throw new MediaForgeError(`wav output supports 1-8 channels; requested ${this.config.audioChannels}`, 'FORMAT');
            }
            channels = Math.max(1, Math.min(8, channels));
            format = 'wav';
        }
        else {
            const objectType = mp4aAudioObjectType(this.host.requestedAacCodec());
            if ((objectType !== null && objectType !== 2) || channels > 2)
                return null;
            if (!AAC_SAMPLE_RATES.includes(sampleRate)) {
                if (this.config.audioSampleRate) {
                    throw new MediaForgeError(`AAC cannot encode at ${sampleRate} Hz (legal AAC rates: ${AAC_SAMPLE_RATES.join('/')})`, 'FORMAT');
                }
                sampleRate = 48000;
            }
            channels = Math.max(1, Math.min(2, channels));
            format = 'aac';
        }
        return {
            format,
            sampleRate,
            channels,
            bitrateKbps: PCM_AUDIO_FORMATS.has(fmt)
                ? 0
                : fmt === 'mp3' || fmt === 'mp2'
                    ? resolveMpegAudioBitrate(fmt, this.config.audioBitrate, channels)
                    : Math.round((this.host.audioBitrateBps() || 128000) / 1000),
        };
    }
    async encodeSource(source, fmt, target, label) {
        this.config.onProgress?.(12, `Streaming ${label} to ${fmt.toUpperCase()}...`);
        const progress = (fraction, message) => {
            this.config.onProgress?.(12 + Math.round(fraction * 86), message);
        };
        if (fmt === 'm4a') {
            const carried = this.host.getCarried();
            const sink = new MemorySink();
            if (carried.extraAudio.length === 0) {
                const diagnostics = await encodeReplayableM4AToSink(source, sink, {
                    bitrateKbps: target.bitrateKbps,
                    audioLanguage: carried.audioLanguage,
                    title: carried.title,
                    audioTrack: carried.audioTrack,
                    moovUserData: carried.udta ?? undefined,
                    signal: this.config.signal,
                    onProgress: progress,
                });
                logger.info(`[Converter] bounded ${label}->M4A: peak PCM ${diagnostics.peakPcmFrames} frames, ` +
                    `${diagnostics.passes} pass(es), sample table ${diagnostics.planningBytes} bytes`);
                this.config.onProgress?.(100, 'Done');
                return sink.toBlob('audio/mp4');
            }
            const codec = this.host.requestedAacCodec();
            const muxer = new MP4Muxer({
                title: carried.title,
                moovUserData: carried.udta ?? undefined,
                audioLanguage: carried.audioLanguage,
                extraAudioTracks: carried.extraAudio.length > 0 ? carried.extraAudio.map(track => track.config) : undefined,
                format: 'm4a',
                mode: 'standard',
                maxFragmentDuration: 2,
                autoSync: true,
                audio: {
                    ...carried.audioTrack,
                    id: 1,
                    type: 'audio',
                    codec,
                    sampleRate: source.sampleRate,
                    channelCount: source.channels,
                },
            }, sink);
            muxer.setAudioCodecConfig(buildAacAsc(source.sampleRate, source.channels));
            for (let trackIndex = 0; trackIndex < carried.extraAudio.length; trackIndex++) {
                const track = carried.extraAudio[trackIndex];
                for (const chunk of track.chunks) {
                    muxer.addExtraAudioChunk(trackIndex, chunk, track.config.codecConfig);
                }
            }
            carried.extraAudio = [];
            const frameSeconds = 1024 / source.sampleRate;
            const result = await streamReplayableAac(source, (frame, index) => {
                muxer.addAudioChunk({
                    data: frame,
                    timestamp: index * frameSeconds,
                    duration: frameSeconds,
                    isKeyframe: true,
                    trackType: 'audio',
                });
            }, {
                bitrateKbps: target.bitrateKbps,
                signal: this.config.signal,
                onProgress: progress,
            });
            muxer.setAudioPriming(1024, result.inputFrames);
            this.config.onProgress?.(100, 'Finalizing output...');
            await muxer.finalize();
            logger.info(`[Converter] bounded ${label}->M4A: peak PCM ${result.peakPcmFrames} frames, 1 pass`);
            return sink.toBlob('audio/mp4');
        }
        if (fmt === 'ogg') {
            const sink = new MemorySink();
            const diagnostics = await encodeReplayableOpusToSink(source, sink, {
                bitrateBps: this.host.audioBitrateBps() || 128000,
                commentPayload: this.host.getCarried().oggComments ?? undefined,
                signal: this.config.signal,
                onProgress: progress,
            });
            logger.info(`[Converter] bounded ${label}->OGG: peak PCM ${diagnostics.peakPcmFrames} frames, ` +
                `${diagnostics.packets} packets`);
            this.config.onProgress?.(100, 'Done');
            if (this.config.signal?.aborted)
                throw new MediaForgeError('Aborted', 'ABORT');
            return sink.toBlob('audio/ogg');
        }
        const result = await encodeReplayablePcm(source, target.format, {
            bitrateKbps: target.bitrateKbps,
            vbr: this.config.audioVbr === true,
            signal: this.config.signal,
            onProgress: progress,
        });
        logger.info(`[Converter] bounded ${label}->${fmt.toUpperCase()}: ${result.diagnostics.passes} pass(es), ` +
            `peak PCM ${result.diagnostics.peakPcmFrames} frames, ` +
            `planning ${result.diagnostics.planningBytes} bytes`);
        this.config.onProgress?.(100, 'Done');
        return result.blob;
    }
}
