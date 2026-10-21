import {
    declarePcmStarts,
    pcmSourceFrom,
    type ReplayablePcmSource,
} from '../../codecs/pcm/pcm-source';
import { codecFamily } from '../../core/model/codec-strings';
import { MediaForgeError } from '../../core/errors/errors';
import type { ValidationMode, Warn } from '../../core/errors/diagnostics';
import type { MediaFile } from '../read/media-file';
import { mediaFileState } from '../read/file-state';
import type { RemuxTrack } from '../media-types';
import { pcmTrackSource, type TrackPacketRead } from './pcm-source';
import { readsLinearPcm } from '../codecs/router';
import type { AudioTrackDecoder } from '../types';
import type { CodecPreference } from '../api-types';

/** How sound is decoded for a timeline. */
export interface PcmSettings {
    readonly decoder?: AudioTrackDecoder;
    readonly codecPreference?: CodecPreference;
    readonly validation?: ValidationMode;
    readonly onWarning?: Warn;
}

/**
 * Whether every sample of `planes` is finite: a NaN or an infinity makes the sum of the samples
 * times zero NaN, which a loop without branches finds.
 */
function finitePlanes(planes: readonly Float32Array[]): boolean {
    let probe = 0;
    for (const plane of planes)
        for (let frame = 0; frame < plane.length; frame++) probe += plane[frame]! * 0;
    return probe === 0;
}

/** A decoder's source, checked to keep its declared shape and finite samples. */
function checkedSource(source: ReplayablePcmSource): ReplayablePcmSource {
    if (
        !source ||
        !Number.isInteger(source.sampleRate) ||
        source.sampleRate < 1 ||
        source.sampleRate > 768000 ||
        !Number.isInteger(source.channels) ||
        source.channels < 1 ||
        source.channels > 8 ||
        !Number.isSafeInteger(source.estimatedFrames) ||
        source.estimatedFrames < 1 ||
        typeof source.chunks !== 'function'
    )
        throw new MediaForgeError('Audio decoder returned an invalid PCM source', 'DECODE');
    const checked: ReplayablePcmSource = {
        sampleRate: source.sampleRate,
        channels: source.channels,
        estimatedFrames: source.estimatedFrames,
        ...(source.channelMask !== undefined ? { channelMask: source.channelMask } : {}),
        async *chunks(signal) {
            for await (const planes of source.chunks(signal)) {
                if (
                    !Array.isArray(planes) ||
                    planes.length !== source.channels ||
                    planes.some(
                        plane =>
                            !(plane instanceof Float32Array) || plane.length !== planes[0]!.length,
                    )
                )
                    throw new MediaForgeError(
                        'Audio decoder returned invalid PCM planes',
                        'DECODE',
                    );
                if (!finitePlanes(planes))
                    throw new MediaForgeError(
                        'Audio decoder returned nonfinite PCM samples',
                        'DECODE',
                    );
                yield planes;
            }
        },
    };
    return declarePcmStarts(checked, frame => {
        const near = pcmSourceFrom(source, frame);
        return near && { from: near.from, source: checkedSource(near.source) };
    });
}

/**
 * Presentation PCM of one track: linear PCM is read directly (readsLinearPcm), everything else runs
 * through the decoder. The first sample is the track's first presented sample. Packets come through
 * `read`: a conversion reads them from its read of the input (ClipRead), decodeAudio() by index.
 */
export function trackPcm(
    file: MediaFile,
    track: RemuxTrack,
    settings: PcmSettings,
    read: TrackPacketRead = (index, signal) => file.readPacket(track.description.id, index, signal),
): ReplayablePcmSource {
    if (readsLinearPcm(track.info.codec)) return pcmTrackSource(track.info, read);
    const { decoder } = settings;
    if (
        !decoder ||
        !decoder.codecs.some(codec => codecFamily(codec) === codecFamily(track.info.codec))
    )
        throw mediaFileState(file).missing.audioDecoder(
            track.info.codec,
            `No audio decoder for '${track.info.codec}'`,
        );
    return checkedSource(
        decoder.createSource(
            track.info,
            async (index, signal) => (await read(index, signal)).data,
            {
                codecPreference: settings.codecPreference,
                validation: settings.validation,
                onWarning: settings.onWarning,
            },
        ),
    );
}
