import { mediaFileState } from '../engine/file-state.js';
import { copyEngineAudioTrack, copyEngineVideoTrack } from '../engine/mp4-copy.js';
import { MediaForgeError } from '../core/errors.js';
import { assertMuxCodec, canMuxCodec } from '../core/mux-codecs.js';
import { CONTAINER_CODEC_PLANS } from '../core/format-plans.js';
import { sampleAt, sampleCount } from '../demux/sample-index.js';
export function providerVideoPlan(file, request, codecs, diagnostics) {
    const state = mediaFileState(file);
    const ids = request.trackIds;
    if (ids && (!ids.length || new Set(ids).size !== ids.length))
        throw new MediaForgeError('trackIds must contain unique existing track IDs', 'INPUT');
    const tracks = ids
        ? ids.map(id => {
            const track = state.tracks.find(track => track.description.id === id);
            if (!track)
                throw new MediaForgeError(`Unknown track ${id}`, 'INPUT');
            return track;
        })
        : [...state.tracks];
    const videos = tracks.filter(track => track.type === 'video');
    const video = videos[0];
    if (!video)
        return undefined;
    const targetCodec = request.videoCodec ??
        (canMuxCodec(request.format, 'video', video.info.codec)
            ? video.info.codec
            : (CONTAINER_CODEC_PLANS[request.format]?.defaultVideo ?? video.info.codec));
    const decode = codecs.find(codec => codec.supportsDecode(video.info.codec));
    const encode = codecs.find(codec => codec.supportsEncode(targetCodec));
    if (!decode && !encode)
        return undefined;
    const changed = targetCodec !== video.info.codec ||
        (!!request.width && request.width !== video.info.width) ||
        (!!request.height && request.height !== video.info.height) ||
        !!request.fps ||
        !!request.videoBitrate;
    if (!changed)
        return undefined;
    if (videos.length !== 1)
        throw new MediaForgeError('Provider video conversion requires one video track; select trackIds', 'FORMAT');
    if (!['mov', 'mp4', 'm4v', '3gp', 'mkv', 'webm'].includes(request.format))
        throw new MediaForgeError('Provider video conversion requires MOV, MP4, MKV or WebM output', 'FORMAT');
    if (request.fps)
        throw new MediaForgeError('Provider video conversion preserves frame timing; frame-rate changes are unsupported', 'FORMAT');
    const source = video.info;
    const width = request.width || source.width;
    const height = request.height || source.height;
    if (!Number.isSafeInteger(width) ||
        !Number.isSafeInteger(height) ||
        width <= 0 ||
        height <= 0 ||
        width * height > 8192 * 8192)
        throw new MediaForgeError('Provider video dimensions exceed the 8192 × 8192 pixel budget', 'OOM');
    if (width !== source.width || height !== source.height)
        throw new MediaForgeError('Provider video resizing is not installed; use source dimensions', 'FORMAT');
    if (source.rotation || source.alphaMode)
        throw new MediaForgeError('Provider video conversion cannot preserve rotation or separate alpha streams', 'FORMAT');
    if (source.colour &&
        (![0, 1, 2].includes(source.colour.primaries) || ![0, 1, 2, 6].includes(source.colour.transfer)))
        throw new MediaForgeError('Provider video conversion requires BT.709 SDR colour; HDR conversion is unsupported', 'FORMAT');
    if ((source.editMediaTimeSeconds ?? 0) > 0 || (source.editTimelineShiftSeconds ?? 0) < 0)
        throw new MediaForgeError('Provider video conversion does not support trimmed leading video edits', 'FORMAT');
    for (const config of source.codecConfigurations ?? []) {
        if ((config.width ?? source.width) !== source.width ||
            (config.height ?? source.height) !== source.height ||
            (decode && !decode.supportsDecode(config.codec)))
            throw new MediaForgeError('Provider video configuration changes must retain codec support and dimensions', 'FORMAT');
    }
    const audio = tracks.filter(track => track.type === 'audio');
    if (!audio.length &&
        [request.audioCodec, request.audioSampleRate, request.audioChannels, request.audioBitrate].some(value => value !== undefined))
        throw new MediaForgeError('Audio options require a selected audio track', 'FORMAT');
    for (const track of audio) {
        if ((request.audioCodec !== undefined && request.audioCodec !== track.info.codec) ||
            (!!request.audioSampleRate && request.audioSampleRate !== track.info.sampleRate) ||
            (!!request.audioChannels && request.audioChannels !== track.info.channelCount) ||
            !!request.audioBitrate)
            throw new MediaForgeError('Provider video conversion copies audio; requested audio conversion is unsupported', 'FORMAT');
    }
    const subtitles = tracks.filter(track => track.type === 'subtitle');
    for (const track of tracks) {
        assertMuxCodec(request.format, track.type, track === video ? targetCodec : track.info.codec);
        if (!sampleCount(track.info))
            throw new MediaForgeError('Every selected track must contain packets', 'FORMAT');
    }
    state.planner.checkCopy(tracks.filter(track => track !== video));
    state.planner.checkTrackMetadata(tracks, request.format, diagnostics);
    if (!decode && (typeof VideoDecoder !== 'function' || typeof EncodedVideoChunk !== 'function'))
        throw new MediaForgeError('Video WebCodecs decoder is unavailable; provide a matching codec instance', 'DECODE');
    if (!encode && (typeof VideoEncoder !== 'function' || typeof VideoFrame !== 'function'))
        throw new MediaForgeError('Video WebCodecs encoder is unavailable; provide a matching codec instance', 'ENCODE');
    const copied = copyEngineVideoTrack(source, file.format, request.format);
    const first = sampleAt(source, 0);
    const framerate = first.duration > 0 ? 1 / first.duration : 30;
    return {
        tracks,
        video,
        decode,
        encode,
        config: {
            title: state.title,
            format: request.format,
            mode: 'standard',
            maxFragmentDuration: 2,
            autoSync: true,
            video: {
                ...copied,
                id: video.description.id,
                codec: targetCodec,
                codecConfig: undefined,
                width,
                height,
                framerate,
                colour: { primaries: 1, transfer: 1, matrix: 1, fullRange: false },
                presentationMediaTimeSeconds: undefined,
                mediaTimescale: undefined,
            },
            audio: audio[0]
                ? { ...copyEngineAudioTrack(audio[0].info, file.format, request.format), id: audio[0].description.id }
                : undefined,
            extraAudioTracks: audio.slice(1).map(track => ({
                ...copyEngineAudioTrack(track.info, file.format, request.format),
                id: track.description.id,
            })),
            subtitleTracks: subtitles.map(track => ({
                id: track.description.id,
                codec: track.info.codec,
                codecConfig: track.info.codecConfig,
                matroskaTrackUid: track.info.matroskaTrackUid,
                language: track.info.language,
                default: track.info.default,
                forced: track.info.forced,
                name: track.info.name,
                title: track.info.title,
                commentary: track.info.commentary,
            })),
        },
    };
}
