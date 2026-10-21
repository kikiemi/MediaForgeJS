import type { Source } from '../../core/model/types';
import type { DemuxResult } from '../../core/model/track';
import { readSampleBytes, sampleAt, sampleCount } from '../../core/model/sample-index';
import { awaitWithAbort } from '../../core/io/abort';
import { assertSourceBytes } from '../../core/io/sources/source-read';
import { MediaForgeError, throwIfAborted } from '../../core/errors/errors';
import { isDtsCodec } from '../../core/model/codec-strings';
import { sameBytes } from '../../core/bytes/bytes';

/**
 * Containers name DTS and TrueHD only loosely (Matroska A_DTS, AVI/WAV tag 0x2001, the esds DTS
 * indications), so the first access unit decides the codec string (dtsc/dtsh/dtsl/dtse), the rate
 * and channels, and supplies a DTSSpecificBox when the container carried none. AC-3, E-AC-3 and
 * TrueHD tracks without an MP4 configuration box (Matroska, MPEG-TS, raw streams) get
 * dac3/dec3/dmlp from their first frame so they can be copied into MP4. The frame parsers load with
 * the first such track.
 */
export async function describeSyncAudioTracks(
    result: DemuxResult,
    source: Source,
    maxPacketBytes: number,
    signal?: AbortSignal,
): Promise<void> {
    const tracks = result.audioTracks.filter(
        track =>
            isDtsCodec(track.codec) ||
            ((track.codec === 'ac-3' || track.codec === 'ec-3') && !track.codecConfig?.length) ||
            track.codec === 'mlpa',
    );
    if (!tracks.length) return;
    const { describeSyncAudioTrack } = await import('./sync-audio-config');
    for (const track of tracks) await describeSyncAudioTrack(track, source, maxPacketBytes, signal);
}

type AacSyntax = typeof import('../../core/codec-config/audio/aac-syntax');
type AacShape = ReturnType<AacSyntax['aacOutputShape']>;

/** The AAC syntax, loaded with the first AAC track (opening other media does not carry it). */
let aacSyntax: Promise<AacSyntax> | undefined;

/**
 * The shapes of the latest configurations and first frames, newest first: opening an input again
 * does not decode its first frame again.
 */
const shapes: { config: Uint8Array; frame?: Uint8Array; shape: AacShape }[] = [];

async function aacShape(config: Uint8Array, frame: Uint8Array | undefined): Promise<AacShape> {
    const known = shapes.find(
        item => sameBytes(item.config, config) && sameBytes(item.frame, frame),
    );
    if (known) return known.shape;
    const syntax = (aacSyntax ??= import('../../core/codec-config/audio/aac-syntax').catch(
        error => {
            aacSyntax = undefined;
            throw error;
        },
    ));
    const shape = (await syntax).aacOutputShape(config, frame);
    if (shapes.unshift({ config: config.slice(), frame: frame?.slice(), shape }) > 8) shapes.pop();
    return shape;
}

/**
 * AAC decodes to a shape its AudioSpecificConfig alone may not state: implicit SBR doubles the rate
 * and implicit parametric stereo makes mono stereo once the first frame carries them, and a first
 * frame with a channel pair in a mono configuration (or single channels in a stereo one) changes
 * the channels. The first access unit of each configuration settles the rate and channels reported
 * for the track; a libfaac first frame marks 1024 samples of encoder delay, which decoders discard
 * when the track states no priming or edit of its own.
 */
export async function describeAacTracks(
    result: DemuxResult,
    source: Source,
    maxPacketBytes: number,
    signal?: AbortSignal,
): Promise<void> {
    for (const track of result.audioTracks) {
        if (!/^mp4a\.40\.|^aac$/i.test(track.codec)) continue;
        const configurations = track.codecConfigurations?.length ? track.codecConfigurations : null;
        const count = sampleCount(track);

        const firstOf = async (configuration: number): Promise<Uint8Array | undefined> => {
            for (let index = 0; index < count; index++) {
                const sample = sampleAt(track, index)!;
                if ((sample.codecConfigIndex ?? 0) !== configuration) continue;
                throwIfAborted(signal);
                if (sample.size > maxPacketBytes) return undefined;
                // Packetized samples (MPEG-TS) are gathered from their transport packets.
                const bytes = await awaitWithAbort(
                    readSampleBytes(track, sample, source, signal),
                    signal,
                );
                assertSourceBytes(bytes, sample.size, 'AAC configuration scan');
                return bytes;
            }
            return undefined;
        };

        const shapeOf = async (config: Uint8Array | undefined, configuration: number) => {
            if (!config) return null;
            try {
                // The decoder loads with the first decode.
                return await aacShape(config, await firstOf(configuration));
            } catch (error) {
                if (
                    error instanceof MediaForgeError &&
                    error.code !== 'ABORT' &&
                    error.code !== 'IO'
                )
                    return null;
                throw error;
            }
        };

        if (configurations) {
            for (let index = 0; index < configurations.length; index++) {
                const configuration = configurations[index]!;
                const shape = await shapeOf(configuration.codecConfig, index);
                if (!shape) continue;
                configuration.sampleRate = shape.sampleRate;
                configuration.channelCount = shape.channels;
                configuration.samplesPerAccessUnit = shape.frameLength;
                if (index === 0) {
                    rescaleTrims(track, shape.sampleRate);
                    track.sampleRate = shape.sampleRate;
                    track.channelCount = shape.channels;
                    if (
                        shape.leadingSkip &&
                        !track.audioPrimingSamples &&
                        !(track.editMediaTimeSeconds ?? 0)
                    )
                        track.decoderDelaySamples = shape.leadingSkip;
                }
            }
            continue;
        }

        const shape = await shapeOf(track.codecConfig, 0);
        if (!shape) continue;
        rescaleTrims(track, shape.sampleRate);
        track.sampleRate = shape.sampleRate;
        track.channelCount = shape.channels;
        if (shape.leadingSkip && !track.audioPrimingSamples && !(track.editMediaTimeSeconds ?? 0))
            track.decoderDelaySamples = shape.leadingSkip;
    }
}

/**
 * Priming and padding counted at the track rate follow it to the rate the first frame settles
 * (implicit SBR).
 */
export function rescaleTrims(track: DemuxResult['audioTracks'][number], rate: number): void {
    if (!track.sampleRate || track.sampleRate === rate) return;
    const scale = rate / track.sampleRate;
    if (track.audioPrimingSamples !== undefined)
        track.audioPrimingSamples = Math.round(track.audioPrimingSamples * scale);
    if (track.audioTrailingPaddingSamples !== undefined)
        track.audioTrailingPaddingSamples = Math.round(track.audioTrailingPaddingSamples * scale);
}
