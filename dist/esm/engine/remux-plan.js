import { MediaForgeError } from '../core/errors.js';
import { assertMuxCodec } from '../core/mux-codecs.js';
import { assertAlphaCopy, trackDispositionLoss, matroskaMetadataLoss, matroskaOutputMetadata, } from '../core/track-metadata.js';
import { copyEngineVideoTrack, copyEngineAudioTrack } from './mp4-copy.js';
import { sampleCount, sampleAt } from '../demux/sample-index.js';
import { decodeTime } from './packet-index.js';
import { cmafTrackConfig } from './cmaf-adapter.js';
import { isProResCodec } from '../core/prores.js';
import { isProResRawCodec } from '../core/prores-raw.js';
const MP4_FORMATS = new Set(['mp4', 'mov', 'm4a', 'm4v', '3gp']);
export class RemuxPlanner {
    format;
    writers;
    matroskaPassThrough;
    matroskaUnsupportedTags;
    title;
    constructor(format, writers, matroskaPassThrough, matroskaUnsupportedTags = false, title) {
        this.format = format;
        this.writers = writers;
        this.matroskaPassThrough = matroskaPassThrough;
        this.matroskaUnsupportedTags = matroskaUnsupportedTags;
        this.title = title;
    }
    checkTrackMetadata(tracks, format, diagnostics) {
        const metadataLoss = matroskaMetadataLoss(this.matroskaPassThrough, this.matroskaUnsupportedTags, format, tracks.map(track => track.info));
        if (metadataLoss)
            diagnostics.metadata(metadataLoss);
        if (this.title !== undefined &&
            this.matroskaPassThrough?.title === undefined &&
            !['mkv', 'webm', 'mp4', 'mov', 'm4a', 'm4v', '3gp', 'fmp4'].includes(format))
            diagnostics.metadata({
                code: 'CONTAINER_METADATA_LOSS',
                message: `${format} writing cannot preserve the container title`,
                format,
            });
        for (const track of tracks) {
            assertAlphaCopy(track.info, format);
            const loss = trackDispositionLoss(track.info, format);
            if (loss)
                diagnostics.metadata(loss);
        }
    }
    checkCopy(tracks) {
        for (const track of tracks) {
            if ((track.info.codecConfigurations?.length ?? 0) > 1) {
                throw new MediaForgeError('Remux with changing codec configuration requires separate initialization segments', 'FORMAT');
            }
        }
    }
    prepareSegments(tracks, options, diagnostics) {
        this.checkCopy(tracks);
        this.checkTrackMetadata(tracks, 'fmp4', diagnostics);
        for (const track of tracks) {
            if ((track.info.editMediaTimeSeconds ?? 0) > 0 ||
                (track.info.matroskaCodecDelaySeconds ?? 0) > 0 ||
                (track.info.audioTrailingPaddingSamples ?? 0) > 0 ||
                (track.info.opusTrailingPaddingSamples ?? 0) > 0) {
                diagnostics.recover({
                    code: 'FMP4_PRESENTATION_WINDOW',
                    message: "Fragment output preserves coded packets but cannot preserve this track's gapless presentation trim",
                    trackId: track.description.id,
                    format: 'fmp4',
                });
            }
        }
        const configs = tracks.map(track => cmafTrackConfig({
            ...track.description,
            timescale: track.info.timescale ?? (track.type === 'audio' ? track.info.sampleRate : 90000),
        }));
        const byteLimit = options.maxBufferedBytes ?? 16 * 1024 * 1024;
        const sampleLimit = options.maxBufferedSamples ?? 100_000;
        const factory = this.writers.segments;
        if (!factory)
            throw new MediaForgeError('No fragmented MP4 writer registered', 'FORMAT');
        const writer = factory({
            tracks: configs,
            maxBufferedBytes: byteLimit,
            maxBufferedSamples: sampleLimit,
            title: this.title,
        });
        return { writer, configs, byteLimit, sampleLimit };
    }
    prepareContainer(tracks, sink, options, diagnostics) {
        if (options.format === 'fmp4')
            throw new MediaForgeError('Fragmented MP4 requires the segment writer', 'FORMAT');
        const video = tracks.filter(track => track.type === 'video');
        const audio = tracks.filter(track => track.type === 'audio');
        const subtitles = tracks.filter(track => track.type === 'subtitle');
        const mp4 = MP4_FORMATS.has(options.format);
        for (const track of tracks)
            assertMuxCodec(options.format, track.type, track.info.codec);
        for (const track of tracks) {
            if (sampleCount(track.info) === 0)
                throw new MediaForgeError('Container copy requires samples in every selected track', 'FORMAT');
            if (mp4 &&
                !isProResCodec(track.info.codec) &&
                !isProResRawCodec(track.info.codec) &&
                !track.info.codecConfig?.length) {
                throw new MediaForgeError(`MP4 ${track.type} codec '${track.info.codec}' requires decoder configuration before copying`, 'FORMAT');
            }
        }
        const matroska = options.format === 'mkv' || options.format === 'webm';
        if ((video.length > 1 && !mp4 && !matroska) ||
            (audio.length > 1 && !mp4 && !matroska && options.format !== 'ts') ||
            (subtitles.length && !matroska) ||
            (options.format === 'm4a' && video.length)) {
            throw new MediaForgeError('Selected tracks are not supported by this output; use fmp4 or select compatible tracks', 'FORMAT');
        }
        if (mp4 || options.format === 'ts')
            for (const track of tracks) {
                if (track.info.language && !/^[a-z]{3}$/i.test(track.info.language)) {
                    diagnostics.metadata({
                        code: mp4 ? 'MP4_LANGUAGE_LOSS' : 'TS_LANGUAGE_LOSS',
                        message: `${options.format} writing cannot preserve this language tag; use a three-letter ISO-639 code`,
                        trackId: track.description.id,
                        format: options.format,
                    });
                }
            }
        const cfg = {
            title: this.title,
            format: options.format,
            mode: mp4 ||
                options.format === 'avi' ||
                (matroska && (video.length > 1 || audio.length > 1 || subtitles.length > 0))
                ? 'standard'
                : 'fragmented',
            maxFragmentDuration: options.targetDuration ?? 2,
            autoSync: true,
            videoColour: video[0]?.info.colour,
            videoLanguage: video[0]?.info.language,
            audioLanguage: audio[0]?.info.language,
            video: video[0]
                ? { ...copyEngineVideoTrack(video[0].info, this.format, options.format), id: video[0].description.id }
                : undefined,
            audio: audio[0]
                ? { ...copyEngineAudioTrack(audio[0].info, this.format, options.format), id: audio[0].description.id }
                : undefined,
            extraVideoTracks: video.slice(1).map(track => ({
                ...copyEngineVideoTrack(track.info, this.format, options.format),
                id: track.description.id,
            })),
            extraAudioTracks: audio.slice(1).map(track => ({
                ...copyEngineAudioTrack(track.info, this.format, options.format),
                id: track.description.id,
            })),
            subtitleTracks: subtitles.map(track => ({
                id: track.description.id,
                codec: track.info.codec,
                matroskaTrackUid: track.info.matroskaTrackUid,
                codecConfig: track.info.codecConfig,
                language: track.info.language,
                default: track.info.default,
                forced: track.info.forced,
                name: track.info.name,
                title: track.info.title,
                commentary: track.info.commentary,
            })),
            ...(options.format === 'flv'
                ? {
                    timestampOffsetSeconds: Math.max(0, -Math.min(0, ...tracks.map(track => decodeTime(sampleAt(track.info, track.order?.[0] ?? 0) ?? { timestamp: 0 })))),
                }
                : {}),
        };
        const factory = this.writers.container.get(options.format);
        if (!factory)
            throw new MediaForgeError(`No muxer registered for '${options.format}'`, 'FORMAT');
        const muxer = factory(cfg, sink);
        if (matroska && this.matroskaPassThrough)
            muxer.setMatroskaPassThrough?.(matroskaOutputMetadata(this.matroskaPassThrough, options.format, tracks.map(track => track.info)));
        if (cfg.audio?.validSamples !== undefined)
            muxer.setAudioPriming?.(cfg.audio.primingSamples ?? 0, cfg.audio.validSamples, cfg.audio.presentationTimestamps, cfg.audio.discardLeadingSamples, cfg.audio.codecDelaySamples);
        const routes = new Map();
        video.forEach((track, i) => routes.set(track.description.id, packet => i === 0
            ? muxer.addVideoChunk(packet, packet.codecConfig)
            : muxer.addExtraVideoChunk(i - 1, packet, packet.codecConfig)));
        audio.forEach((track, i) => routes.set(track.description.id, packet => i === 0
            ? muxer.addAudioChunk(packet, packet.codecConfig)
            : muxer.addExtraAudioChunk(i - 1, packet, packet.codecConfig)));
        subtitles.forEach((track, i) => routes.set(track.description.id, packet => muxer.addSubtitleChunk(packet, i)));
        return { muxer, routes, layout: cfg.mode };
    }
    resolveRemuxFormat(tracks, options) {
        if (options.format === 'm4a' && tracks.some(track => track.type !== 'audio')) {
            throw new MediaForgeError('M4A requires audio-only tracks', 'FORMAT');
        }
        if (!['mp4', 'm4a', 'm4v'].includes(options.format) || options.mp4Mode === 'standard')
            return options.format;
        if (options.mp4Mode === 'fragmented')
            return 'fmp4';
        try {
            for (const track of tracks)
                assertMuxCodec(options.format, track.type, track.info.codec);
            return options.format;
        }
        catch (error) {
            if (!(error instanceof MediaForgeError) || error.code !== 'FORMAT')
                throw error;
            return 'fmp4';
        }
    }
}
