import { copiedAudioTrackConfig, hasSourceAudioPriming, matroskaAudioWindowFitsFinalPacket, sourceAudioRemuxWindow, } from './pipeline-track-config.js';
import { sampleAt, sampleCount } from '../demux/sample-index.js';
import { MediaForgeError } from './errors.js';
import { codecFamily } from './codec-strings.js';
import { canMuxCodec } from './mux-codecs.js';
import { logger } from './logger.js';
const MP4_FAMILY = new Set(['mp4', 'mov', '3gp', 'm4v', 'm4a']);
export class PipelineRemuxPlanner {
    cfg;
    constructor(cfg) {
        this.cfg = cfg;
    }
    hasDynamicCodecConfiguration(track) {
        return (track.codecConfigurations?.length ?? 0) > 1;
    }
    canDirectRemuxVideo(inputFmt, outputFmt, track, outputCodec) {
        if (!canMuxCodec(outputFmt, 'video', track.codec))
            return false;
        if (this.cfg.videoCodecUserSet &&
            !this.codecSatisfiesRequest(track.codec, this.cfg.videoCodecRequested ?? outputCodec))
            return false;
        if (this.cfg.fps || this.cfg.videoBitrate)
            return false;
        if ((this.cfg.width && track.width && this.cfg.width !== track.width) ||
            (this.cfg.height && track.height && this.cfg.height !== track.height)) {
            return false;
        }
        if (outputFmt === 'ts') {
            return inputFmt === 'ts' || !!track.codecConfig;
        }
        if (inputFmt === 'avi' && (!track.codec.startsWith('avc') || !track.codecConfig?.length))
            return false;
        if (inputFmt === 'ts' && !track.codecConfig)
            return false;
        return true;
    }
    canDirectRemuxAudio(inputFmt, outputFmt, track, outputCodec) {
        if (this.hasDynamicCodecConfiguration(track))
            return false;
        if (!canMuxCodec(outputFmt, 'audio', track.codec))
            return false;
        if (this.cfg.audioCodecUserSet &&
            !this.codecSatisfiesRequest(track.codec, this.cfg.audioCodecRequested ?? outputCodec))
            return false;
        if (this.cfg.audioBitrate)
            return false;
        if (this.cfg.audioChannels && track.channelCount && this.cfg.audioChannels !== track.channelCount) {
            return false;
        }
        if ((this.cfg.audioCodecUserSet && outputCodec === 'opus') || track.codec === 'opus') {
            if (track.sampleRate !== 48000)
                return false;
        }
        else if (this.cfg.audioSampleRate && track.sampleRate && this.cfg.audioSampleRate !== track.sampleRate) {
            return false;
        }
        if ((track.codec === 'ac-3' || track.codec === 'ec-3') && !track.codecConfig && MP4_FAMILY.has(outputFmt)) {
            return false;
        }
        if (inputFmt === 'avi' && !track.codec.startsWith('pcm'))
            return false;
        if ((outputFmt === 'mkv' || outputFmt === 'webm') && !matroskaAudioWindowFitsFinalPacket(track)) {
            logger.info('[Pipeline] Matroska tail edit crosses its final audio packet; transcoding is required');
            return false;
        }
        return true;
    }
    sameCodecFamily(sourceCodec, targetCodec) {
        return codecFamily(sourceCodec) === codecFamily(targetCodec);
    }
    directAudioStartIndex(src, fmt) {
        if (fmt !== 'flv' || !(src.codec.startsWith('mp4a') || src.codec === 'aac'))
            return 0;
        const tolerance = 0.5 / Math.max(1, src.sampleRate || 48000);
        let index = 0;
        const count = sampleCount(src);
        while (index < count) {
            const sample = sampleAt(src, index);
            if (sample.timestamp + sample.duration > tolerance)
                break;
            index++;
        }
        if (index >= count) {
            throw new MediaForgeError('FLV output has no AAC packet at or after timestamp zero', 'FORMAT');
        }
        if (sampleAt(src, index).timestamp < -tolerance) {
            throw new MediaForgeError('FLV cannot losslessly represent a partial AAC priming packet; transcode the audio or use MKV/MP4', 'FORMAT');
        }
        if (index > 0)
            logger.info(`[Pipeline] FLV remux omitted ${index} AAC priming packet(s)`);
        return index;
    }
    wireAudioPadding(src, muxer, fmt) {
        const isMatroska = fmt === 'mkv' || fmt === 'webm';
        const hasWindow = hasSourceAudioPriming(src) ||
            (src.matroskaCodecDelaySeconds ?? 0) > 0 ||
            src.editPresentationDurationSeconds !== undefined ||
            (src.audioTrailingPaddingSamples ?? 0) > 0 ||
            (src.opusTrailingPaddingSamples ?? 0) > 0;
        if (isMatroska && hasWindow && muxer.setAudioPriming) {
            const rate = src.codec.startsWith('opus') ? 48000 : src.sampleRate || 48000;
            const window = sourceAudioRemuxWindow(src, rate, fmt);
            muxer.setAudioPriming(window.head, window.valid, src.presentationTimestampsIncludeEdits === true, hasSourceAudioPriming(src), Math.max(0, Math.round((src.matroskaCodecDelaySeconds ?? 0) * rate)));
            return;
        }
        if (MP4_FAMILY.has(fmt) && hasWindow && muxer.setAudioPriming) {
            const rate = src.codec.startsWith('opus') ? 48000 : src.sampleRate || 48000;
            const window = sourceAudioRemuxWindow(src, rate, fmt);
            muxer.setAudioPriming(window.head, window.valid, src.presentationTimestampsIncludeEdits === true, hasSourceAudioPriming(src), Math.max(0, Math.round((src.matroskaCodecDelaySeconds ?? 0) * rate)));
            return;
        }
        if (!src.codec.startsWith('opus'))
            return;
        const window = copiedAudioTrackConfig(src);
        if (window.validSamples !== undefined && muxer.setAudioPriming) {
            muxer.setAudioPriming(window.primingSamples ?? 0, window.validSamples, window.presentationTimestamps === true, window.discardLeadingSamples !== false, window.codecDelaySamples ?? 0);
            return;
        }
        if ((src.opusTrailingPaddingSamples ?? 0) > 0 && muxer.setValidSamples) {
            let encoded = 0;
            for (let index = 0, count = sampleCount(src); index < count; index++)
                encoded += Math.max(0, Math.round(sampleAt(src, index).duration * 48000));
            const valid = Math.max(1, encoded - (src.opusTrailingPaddingSamples ?? 0));
            muxer.setValidSamples(valid);
        }
    }
    codecSatisfiesRequest(sourceCodec, requested) {
        const src = sourceCodec.toLowerCase();
        const req = requested.toLowerCase();
        if (src === req)
            return true;
        if (src.replace(/^avc3/, 'avc1') === req.replace(/^avc3/, 'avc1'))
            return true;
        if (!req.includes('.'))
            return this.sameCodecFamily(sourceCodec, requested);
        return false;
    }
}
