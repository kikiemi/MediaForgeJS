import { DEFAULT_CHANNEL_MASKS, VORBIS_ORDER } from '../../core/model/channel-layout';
import { MediaForgeError } from '../../core/errors/errors';
import type { TrackInfo } from '../../core/model/track';
import type { BuiltinAudioCodec, PacketDecoder } from '../../core/contracts/decoder';
import { OPUS_MAX_FRAME_SAMPLES, OpusMultistreamDecoder } from './decoder';
import { parseOpusHead } from '../../core/codec-config/audio/opus-head';

export type { OpusHeadInfo } from '../../core/codec-config/audio/opus-head';

/**
 * Built-in Opus decoding of demuxed packets (Ogg, Matroska or MP4 tracks) into 48 kHz planes in
 * WAVE order.
 */
export function opusAudioCodec(track: TrackInfo): BuiltinAudioCodec {
    const head = parseOpusHead(track.codecConfig, track.channelCount);
    const { channels, layout } = head;
    if (channels !== track.channelCount)
        throw new MediaForgeError(
            `Opus header has ${channels} channels, but the track has ${track.channelCount}`,
            'FORMAT',
        );
    if (track.sampleRate !== 48000)
        throw new MediaForgeError(
            `Opus tracks must be 48000 Hz, not ${track.sampleRate}`,
            'FORMAT',
        );
    const order = head.mappingFamily === 1 ? VORBIS_ORDER[channels - 1]! : null;
    const gain = head.outputGain === 0 ? 1 : 10 ** (head.outputGain / (20 * 256));
    return {
        ...(order ? { channelMask: DEFAULT_CHANNEL_MASKS[channels - 1] } : {}),
        preRoll: head.preSkip,
        create: (): PacketDecoder => {
            const decoder = new OpusMultistreamDecoder(layout);
            const ordered: Float32Array[] = new Array<Float32Array>(channels);
            let lastFrames = 960;
            const planes = (frames: number): Float32Array[] => {
                const out = Array.from({ length: channels }, () => new Float32Array(frames));
                for (let c = 0; c < channels; c++) ordered[c] = out[order ? order[c]! : c]!;
                return out;
            };

            const finish = (out: Float32Array[]): readonly Float32Array[] => {
                if (gain !== 1)
                    for (const plane of out)
                        for (let i = 0; i < plane.length; i++) plane[i]! *= gain;
                return out;
            };

            const conceal = (frames: number): readonly Float32Array[] => {
                const out = planes(frames);
                let done = 0;
                while (frames - done >= 120) {
                    const chunk = Math.min(
                        frames - done - ((frames - done) % 120),
                        OPUS_MAX_FRAME_SAMPLES,
                    );
                    decoder.conceal(ordered, chunk, done);
                    done += chunk;
                }

                return finish(out);
            };

            return {
                decode(packet) {
                    if (packet.length === 0) return [conceal(lastFrames)];
                    const frames = decoder.packetSamples(packet);
                    const out = planes(frames);
                    decoder.decode(packet, ordered);
                    lastFrames = frames;
                    return [finish(out)];
                },
                conceal: frames => [conceal(frames)],
                reset: () => decoder.reset(),
            };
        },
    };
}
