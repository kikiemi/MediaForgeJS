import { getCompactSampleIndex, sampleAt, sampleCount } from '../demux/sample-index.js';
import { MediaForgeError } from './errors.js';
import { isProResCodec } from './prores.js';
import { isProResRawCodec } from './prores-raw.js';
const MP4_FAMILY = new Set(['mp4', 'mov', '3gp', 'm4v', 'm4a']);
function sourcePresentationStart(track) {
    if (!track)
        return undefined;
    if (track.editLeadTimeSeconds !== undefined) {
        return Math.max(0, track.editLeadTimeSeconds);
    }
    const compact = getCompactSampleIndex(track);
    if (compact)
        return Math.max(0, compact.firstPresentation);
    let first = Number.POSITIVE_INFINITY;
    for (let index = 0, count = sampleCount(track); index < count; index++)
        first = Math.min(first, sampleAt(track, index).timestamp);
    return Number.isFinite(first) ? Math.max(0, first) : 0;
}
function sourcePresentationDuration(track) {
    if (!track)
        return undefined;
    const duration = track.editPresentationDurationSeconds ?? track.duration;
    return Number.isFinite(duration) && duration > 0 ? duration : undefined;
}
export class PipelineMuxerFactory {
    cfg;
    host;
    writers;
    constructor(cfg, host, writers) {
        this.cfg = cfg;
        this.host = host;
        this.writers = writers;
    }
    makeMuxer(fmt, sink, srcV, srcA, vCodec, aCodec, forceV = false, forceA = false, overW = 0, overH = 0, overSR = 0, overCh = 0, videoCopy = false, audioCopy = false, subtitleTracks = [], extraVideoTracks = undefined, extraAudioTracks = undefined) {
        const hasV = !!srcV || forceV;
        const hasA = !!srcA || forceA;
        const preserveDisplayMetadata = videoCopy && !overW && !overH && !this.cfg.width && !this.cfg.height;
        const copySampleRate = srcA ? (aCodec === 'opus' ? 48000 : srcA.sampleRate || 48000) : 48000;
        const copyChannels = srcA ? srcA.channelCount || 2 : 2;
        const firstVideo = srcV ? sampleAt(srcV, 0) : undefined;
        const videoSamples = srcV ? sampleCount(srcV) : 0;
        const durationStep = Math.max(1, Math.ceil(videoSamples / 4096));
        const durationProbes = srcV
            ? Array.from({ length: Math.ceil(videoSamples / durationStep) }, (_, index) => sampleAt(srcV, index * durationStep))
            : undefined;
        const timestampProbes = srcV
            ? Array.from({ length: Math.min(121, videoSamples) }, (_, index) => sampleAt(srcV, index))
            : undefined;
        const cfg = {
            title: this.host.title(),
            videoColour: this.host.videoColour(),
            audioLanguage: this.host.audioLanguage(),
            videoLanguage: this.host.videoLanguage(),
            moovUserData: this.cfg.moovUserData,
            extraVideoTracks: extraVideoTracks && extraVideoTracks.length > 0 ? extraVideoTracks : undefined,
            extraAudioTracks: extraAudioTracks && extraAudioTracks.length > 0 ? extraAudioTracks : undefined,
            format: fmt,
            mode: ((MP4_FAMILY.has(fmt) || fmt === 'webm' || fmt === 'mkv') && !this.host.hasExternalSink()) ||
                (MP4_FAMILY.has(fmt) &&
                    ((extraVideoTracks?.length ?? 0) > 0 ||
                        (extraAudioTracks?.length ?? 0) > 0 ||
                        (videoCopy && (isProResCodec(srcV?.codec ?? '') || isProResRawCodec(srcV?.codec ?? ''))))) ||
                fmt === 'avi'
                ? 'standard'
                : 'fragmented',
            maxFragmentDuration: 2.0,
            autoSync: true,
            ...(fmt === 'flv'
                ? {
                    timestampOffsetSeconds: Math.max(0, -(firstVideo?.decodeTimestamp ?? firstVideo?.timestamp ?? 0)),
                }
                : {}),
            video: hasV
                ? {
                    id: 1,
                    type: 'video',
                    codec: videoCopy ? (srcV?.codec ?? vCodec) : vCodec,
                    matroskaTrackUid: srcV?.matroskaTrackUid,
                    default: srcV?.default,
                    forced: srcV?.forced,
                    alphaMode: srcV?.alphaMode,
                    name: srcV?.name,
                    title: srcV?.title,
                    commentary: srcV?.commentary,
                    width: overW || this.cfg.width || srcV?.width || 0,
                    height: overH || this.cfg.height || srcV?.height || 0,
                    rotation: MP4_FAMILY.has(fmt) || fmt === 'mkv' || fmt === 'webm' ? srcV?.rotation : undefined,
                    displayWidth: preserveDisplayMetadata ? srcV?.displayWidth : undefined,
                    displayHeight: preserveDisplayMetadata ? srcV?.displayHeight : undefined,
                    pixelAspectRatioNum: preserveDisplayMetadata ? srcV?.pixelAspectRatioNum : undefined,
                    pixelAspectRatioDen: preserveDisplayMetadata ? srcV?.pixelAspectRatioDen : undefined,
                    framerate: this.cfg.fps ||
                        this.host.estimateFpsFromDurations(durationProbes) ||
                        Math.round(this.host.estimateFps(timestampProbes)) ||
                        30,
                    codecConfig: videoCopy ? srcV?.codecConfig : undefined,
                    presentationStartSeconds: sourcePresentationStart(srcV),
                    presentationDurationSeconds: sourcePresentationDuration(srcV),
                }
                : undefined,
            audio: hasA
                ? {
                    id: hasV ? 2 : 1,
                    type: 'audio',
                    codec: audioCopy ? (srcA?.codec ?? aCodec) : aCodec,
                    matroskaTrackUid: srcA?.matroskaTrackUid,
                    default: srcA?.default,
                    forced: srcA?.forced,
                    name: srcA?.name,
                    title: srcA?.title,
                    commentary: srcA?.commentary,
                    sampleRate: audioCopy ? copySampleRate : overSR || copySampleRate,
                    channelCount: audioCopy ? copyChannels : overCh || copyChannels,
                    codecConfig: audioCopy ? srcA?.codecConfig : undefined,
                    presentationStartSeconds: sourcePresentationStart(srcA),
                    presentationDurationSeconds: sourcePresentationDuration(srcA),
                }
                : undefined,
            ...(subtitleTracks.length > 0
                ? {
                    subtitleTracks: subtitleTracks.map(st => ({
                        codec: st.codec,
                        codecConfig: st.codecConfig,
                        language: st.language,
                        matroskaTrackUid: st.matroskaTrackUid,
                        default: st.default,
                        forced: st.forced,
                        name: st.name,
                        title: st.title,
                        commentary: st.commentary,
                    })),
                }
                : {}),
        };
        const create = this.writers.container.get(fmt);
        if (!create)
            throw new MediaForgeError(`No container muxer registered for '${fmt}'`, 'FORMAT');
        return create(cfg, sink, { deferCodecConfig: true });
    }
}
