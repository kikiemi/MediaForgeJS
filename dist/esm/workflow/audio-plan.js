import { mediaFileState } from '../engine/file-state.js';
import { normalizePcmSource } from '../audio/pcm-source.js';
import { codecFamily } from '../core/codec-strings.js';
import { MediaForgeError } from '../core/errors.js';
import { preparePcmSource } from './pcm-source.js';
function finiteSource(source) {
    if (!source ||
        !Number.isInteger(source.sampleRate) ||
        source.sampleRate < 1 ||
        source.sampleRate > 768000 ||
        !Number.isInteger(source.channels) ||
        source.channels < 1 ||
        source.channels > 2 ||
        !Number.isSafeInteger(source.estimatedFrames) ||
        source.estimatedFrames < 1 ||
        typeof source.chunks !== 'function')
        throw new MediaForgeError('Audio decoder returned an invalid PCM source', 'DECODE');
    return {
        sampleRate: source.sampleRate,
        channels: source.channels,
        estimatedFrames: source.estimatedFrames,
        async *chunks(signal) {
            for await (const planes of source.chunks(signal)) {
                if (!Array.isArray(planes) ||
                    planes.length !== source.channels ||
                    planes.some(plane => !(plane instanceof Float32Array) || plane.length !== planes[0].length))
                    throw new MediaForgeError('Audio decoder returned invalid PCM planes', 'DECODE');
                for (const plane of planes)
                    for (let frame = 0; frame < plane.length; frame++)
                        if (!Number.isFinite(plane[frame]))
                            throw new MediaForgeError('Audio decoder returned nonfinite PCM samples', 'DECODE');
                yield planes;
            }
        },
    };
}
export function audioPlan(file, request, diagnostics, audio, decoder) {
    const state = mediaFileState(file);
    if (!audio?.formats.includes(request.format))
        throw new MediaForgeError(`Native audio encoder '${request.format}' is not installed`, 'FORMAT');
    let tracks = state.tracks.filter(track => track.type === 'audio' && (request.trackId === undefined || track.description.id === request.trackId));
    if (tracks.length > 1 && request.trackId === undefined) {
        const defaults = tracks.filter(track => track.description.default === true);
        if (defaults.length === 1)
            tracks = defaults;
    }
    if (tracks.length !== 1)
        throw new MediaForgeError('Native audio requires one audio track; select an existing audio trackId', 'FORMAT');
    const track = tracks[0];
    let input;
    if (track.info.codec.startsWith('pcm'))
        input = preparePcmSource(file, track.info, request);
    else {
        if (!decoder?.codecs.some(codec => codecFamily(codec) === codecFamily(track.info.codec)))
            throw new MediaForgeError(`Native workflow decoding for '${track.info.codec}' is not installed`, 'FORMAT');
        input = decoder.createSource(track.info, async (index, signal) => (await file.readPacket(track.description.id, index, signal)).data);
        input = finiteSource(input);
    }
    const sampleRate = request.sampleRate ?? input.sampleRate;
    const channels = request.channels ?? input.channels;
    const head = Math.round((request.start ?? 0) * sampleRate);
    const total = Math.ceil((input.estimatedFrames * sampleRate) / input.sampleRate);
    const end = request.end === undefined ? total : Math.min(total, Math.round(request.end * sampleRate));
    if (end <= head)
        throw new MediaForgeError('Audio trim selects no presentation samples', 'FORMAT');
    const source = sampleRate === input.sampleRate && channels === input.channels && head === 0 && end === total
        ? input
        : normalizePcmSource(input, sampleRate, channels, { head, valid: end - head });
    const config = {
        format: request.format,
        sampleRate,
        channels,
        estimatedFrames: source.estimatedFrames,
        bitrateKbps: request.bitrateKbps,
        vbr: request.vbr,
        signal: request.signal,
        onProgress: undefined,
    };
    audio.check(config);
    state.planner.checkTrackMetadata([track], request.format, diagnostics);
    if (track.info.language)
        diagnostics.metadata({
            code: 'AUDIO_LANGUAGE_LOSS',
            message: `${request.format} native encoding cannot preserve track language`,
            trackId: track.description.id,
            format: request.format,
        });
    const support = {
        supported: true,
        operation: 'audio',
        outputFormat: request.format,
        trackId: track.description.id,
        sampleRate,
        channels,
        ...(['wav', 'aiff', 'au', 'caf', 'flac'].includes(request.format) ? { pcmBits: 16 } : {}),
        lossless: false,
        warnings: diagnostics.warnings,
    };
    return { source, config, support };
}
