import { sampleAt, sampleCount } from '../demux/sample-index.js';
import { parseAacAudioSpecificConfig } from '../audio/adts.js';
import { MediaForgeError } from './errors.js';
function audioTimingRate(track) {
    return track.codec.startsWith('opus') ? 48000 : Math.max(1, track.sampleRate || 48000);
}
export function encodedAudioSampleCount(track, targetRate) {
    const sourceRate = audioTimingRate(track);
    let sourceSamples = 0;
    if (track.codec.startsWith('mp4a') || track.codec === 'aac') {
        const parsedAac = track.codecConfig ? parseAacAudioSpecificConfig(track.codecConfig) : null;
        const samplesPerAccessUnit = parsedAac?.samplesPerAccessUnit ?? 1024;
        sourceSamples = sampleCount(track) * samplesPerAccessUnit;
        const explicitSbr = parsedAac?.audioObjectType === 5 ||
            parsedAac?.audioObjectType === 29 ||
            track.codec === 'mp4a.40.5' ||
            track.codec === 'mp4a.40.29';
        if (explicitSbr && track.editPresentationDurationSeconds !== undefined) {
            let durationSamples = 0;
            for (let index = 0, length = sampleCount(track); index < length; index++) {
                const sample = sampleAt(track, index);
                if (!Number.isFinite(sample.duration) || sample.duration < 0) {
                    throw new MediaForgeError(`Audio track '${track.codec}' has an invalid encoded packet duration`, 'FORMAT');
                }
                durationSamples += Math.max(0, Math.round(sample.duration * sourceRate));
                if (!Number.isSafeInteger(durationSamples)) {
                    throw new MediaForgeError(`Audio track '${track.codec}' encoded sample count exceeds the safe range`, 'FORMAT');
                }
            }
            sourceSamples = Math.max(sourceSamples, durationSamples);
        }
    }
    else {
        for (let index = 0, length = sampleCount(track); index < length; index++) {
            const sample = sampleAt(track, index);
            if (!Number.isFinite(sample.duration) || sample.duration < 0) {
                throw new MediaForgeError(`Audio track '${track.codec}' has an invalid encoded packet duration`, 'FORMAT');
            }
            sourceSamples += Math.max(0, Math.round(sample.duration * sourceRate));
            if (!Number.isSafeInteger(sourceSamples)) {
                throw new MediaForgeError(`Audio track '${track.codec}' encoded sample count exceeds the safe range`, 'FORMAT');
            }
        }
    }
    const scaled = Math.round((sourceSamples * Math.max(1, targetRate)) / sourceRate);
    if (!Number.isSafeInteger(scaled) || scaled < 0) {
        throw new MediaForgeError(`Audio track '${track.codec}' encoded sample count is invalid`, 'FORMAT');
    }
    return scaled;
}
function requirePossibleWindow(track, encoded, head, valid) {
    if (!Number.isSafeInteger(head) ||
        head < 0 ||
        !Number.isSafeInteger(valid) ||
        valid < 1 ||
        !Number.isSafeInteger(head + valid) ||
        encoded + 1 < head + valid) {
        throw new MediaForgeError(`Audio track '${track.codec}' presentation window ${head}+${valid} exceeds ${encoded} encoded samples`, 'FORMAT');
    }
}
export function copiedVideoTrackConfig(track) {
    return {
        id: 0,
        matroskaTrackUid: track.matroskaTrackUid,
        type: 'video',
        alphaMode: track.alphaMode,
        codec: track.codec,
        width: track.width,
        height: track.height,
        rotation: track.rotation,
        displayWidth: track.displayWidth,
        displayHeight: track.displayHeight,
        pixelAspectRatioNum: track.pixelAspectRatioNum,
        pixelAspectRatioDen: track.pixelAspectRatioDen,
        language: track.language,
        default: track.default,
        forced: track.forced,
        name: track.name,
        title: track.title,
        commentary: track.commentary,
        colour: track.colour,
        framerate: sampleCount(track) > 1 && track.duration > 0 ? sampleCount(track) / track.duration : 30,
        codecConfig: track.codecConfig,
    };
}
export function copiedAudioTrackConfig(track, outputFormat) {
    const rate = track.sampleRate || 48000;
    const first = sampleAt(track, 0)?.timestamp ?? 0;
    const last = sampleAt(track, sampleCount(track) - 1);
    const end = last ? last.timestamp + last.duration : first;
    const codecDelaySeconds = Math.max(0, track.matroskaCodecDelaySeconds ?? 0);
    const explicitDiscardSeconds = Math.max(0, (track.codec === 'vorbis' && track.audioPrimingSamples !== undefined
        ? track.audioPrimingSamples / rate
        : track.editMediaTimeSeconds) ?? (codecDelaySeconds > 0 ? 0 : Math.max(0, -first)));
    const codecDelaySamples = Math.max(0, Math.round(codecDelaySeconds * rate));
    const primingSamples = Math.max(0, Math.round((track.codec.startsWith('opus') ? codecDelaySeconds + explicitDiscardSeconds : explicitDiscardSeconds) *
        rate));
    const trailingSamples = Math.max(0, Math.round(Math.max(track.audioTrailingPaddingSamples ?? 0, track.opusTrailingPaddingSamples ?? 0)));
    const hasWindow = primingSamples > 0 ||
        codecDelaySamples > 0 ||
        trailingSamples > 0 ||
        track.editPresentationDurationSeconds !== undefined;
    const isMatroska = outputFormat === 'mkv' || outputFormat === 'webm';
    const codedSamples = encodedAudioSampleCount(track, rate);
    const validSamples = Math.round(isMatroska && track.editPresentationDurationSeconds === undefined
        ? codedSamples - primingSamples - trailingSamples
        : track.editPresentationDurationSeconds !== undefined
            ? Math.round(track.editPresentationDurationSeconds * rate)
            : track.codec.startsWith('mp4a') ||
                track.codec === 'aac' ||
                track.codec.startsWith('opus') ||
                (track.codec === 'vorbis' && track.audioPrimingSamples !== undefined)
                ? codedSamples - primingSamples - trailingSamples
                : Math.round((end - Math.max(0, first)) * rate) -
                    (track.presentationTimestampsIncludeEdits === true
                        ? 0
                        : Math.round(Math.max(0, track.editMediaTimeSeconds ?? 0) * rate)) -
                    trailingSamples);
    if (hasWindow)
        requirePossibleWindow(track, codedSamples, primingSamples, validSamples);
    return {
        id: 0,
        matroskaTrackUid: track.matroskaTrackUid,
        type: 'audio',
        codec: track.codec === 'aac' ? 'mp4a.40.2' : track.codec,
        sampleRate: track.sampleRate || 48000,
        channelCount: track.channelCount || 2,
        codecConfig: track.codecConfig,
        language: track.language,
        default: track.default,
        forced: track.forced,
        name: track.name,
        title: track.title,
        commentary: track.commentary,
        ...(hasWindow
            ? {
                primingSamples,
                validSamples,
                presentationTimestamps: track.presentationTimestampsIncludeEdits === true,
                discardLeadingSamples: explicitDiscardSeconds > 0,
                ...(outputFormat === undefined || outputFormat === 'mkv' || outputFormat === 'webm'
                    ? { codecDelaySamples }
                    : {}),
            }
            : {}),
    };
}
export function sourceAudioWindow(src, rate) {
    const sourceRate = src.codec.startsWith('opus') ? 48000 : src.sampleRate || rate || 48000;
    const first = sampleAt(src, 0)?.timestamp ?? 0;
    const last = sampleAt(src, sampleCount(src) - 1);
    const end = last ? last.timestamp + last.duration : 0;
    const codecDelay = Math.max(0, src.matroskaCodecDelaySeconds ?? 0);
    const explicitDiscard = Math.max(0, (src.codec === 'vorbis' && src.audioPrimingSamples !== undefined
        ? src.audioPrimingSamples / sourceRate
        : src.editMediaTimeSeconds) ?? (codecDelay > 0 ? 0 : Math.max(0, -first)));
    const totalSkip = src.codec.startsWith('opus') ? codecDelay + explicitDiscard : explicitDiscard;
    const head = Math.max(0, Math.round(totalSkip * rate));
    const startOffset = Math.max(0, first);
    const sourceTail = Math.max(src.audioTrailingPaddingSamples ?? 0, src.opusTrailingPaddingSamples ?? 0);
    const tail = Math.max(0, Math.round((sourceTail * rate) / sourceRate));
    const codedSamples = encodedAudioSampleCount(src, rate);
    const hasCodedWindow = src.editPresentationDurationSeconds !== undefined || codecDelay > 0 || totalSkip > 0 || tail > 0;
    const valid = Math.max(1, src.editPresentationDurationSeconds !== undefined
        ? Math.round(src.editPresentationDurationSeconds * rate)
        : hasCodedWindow
            ? codedSamples - head - tail
            : Math.round((end - startOffset) * rate) -
                (src.presentationTimestampsIncludeEdits === true
                    ? 0
                    : Math.round(Math.max(0, src.editMediaTimeSeconds ?? 0) * rate)) -
                tail);
    return { head, valid, startOffset };
}
export function hasSourceAudioPriming(src) {
    if (src.codec === 'vorbis' && (src.audioPrimingSamples ?? 0) > 0)
        return true;
    if ((src.editMediaTimeSeconds ?? 0) > 0)
        return true;
    if ((src.matroskaCodecDelaySeconds ?? 0) > 0)
        return false;
    return (sampleAt(src, 0)?.timestamp ?? 0) < 0;
}
export function sourceAudioRemuxWindow(src, rate, fmt) {
    const window = sourceAudioWindow(src, rate);
    if (fmt !== 'mkv' && fmt !== 'webm')
        return window;
    const sourceRate = audioTimingRate(src);
    const tailAtSourceRate = Math.max(src.audioTrailingPaddingSamples ?? 0, src.opusTrailingPaddingSamples ?? 0);
    const tail = Math.max(0, Math.round((tailAtSourceRate * rate) / sourceRate));
    const encoded = encodedAudioSampleCount(src, rate);
    const valid = src.editPresentationDurationSeconds !== undefined
        ? Math.round(src.editPresentationDurationSeconds * rate)
        : encoded - window.head - tail;
    requirePossibleWindow(src, encoded, window.head, valid);
    return { ...window, valid };
}
export function matroskaAudioWindowFitsFinalPacket(track) {
    const rate = audioTimingRate(track);
    const window = sourceAudioRemuxWindow(track, rate, 'mkv');
    const encoded = encodedAudioSampleCount(track, rate);
    const trailing = Math.max(0, encoded - window.head - window.valid);
    if (trailing === 0)
        return true;
    const last = sampleAt(track, sampleCount(track) - 1);
    if (!last)
        return false;
    const parsedAac = track.codecConfig ? parseAacAudioSpecificConfig(track.codecConfig) : null;
    const finalPacketSamples = track.codec.startsWith('mp4a') || track.codec === 'aac'
        ? (parsedAac?.samplesPerAccessUnit ?? 1024)
        : Math.max(0, Math.round(last.duration * rate));
    return trailing <= finalPacketSamples;
}
