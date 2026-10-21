import { LOSSLESS_AUDIO_FORMATS, PCM_AUDIO_FORMATS, audioFormatCodec } from '../plan/format-policy';
import { audioEncoderOrder } from '../codecs/router';
import { NO_PLUGINS, type MissingParts } from '../plugins/missing-parts';
import { AAC_SAMPLE_RATES } from '../../core/codec-config/audio/aac-sample-rates';
import {
    createStreamingAudioOutput,
    pcmSampleCodec,
    type StreamingAudioCodecs,
} from '../codecs/streaming-audio-output-core';
import { PCM_SAMPLE_BYTES } from '../../codecs/pcm/encoder';
import type { ReplayablePcmSource } from '../../codecs/pcm/pcm-source';
import { streamHostAudio } from '../codecs/host-audio-stream';
import { hostSupports } from '../../codecs/webcodecs/support';
import { defaultChannelMask, layoutMask } from '../../core/model/channel-layout';
import { MediaForgeError } from '../../core/errors/errors';
import { mpegBitrates } from '../../core/codec-config/audio/mpeg-audio-header';
import {
    createG711Header,
    createPcmCopyHeader,
    describePcmTrack,
} from '../../core/codec-config/audio/pcm-format';
import { AdtsMuxer } from '../../formats/audio-files/adts-writer';
import { FlacMuxer } from '../../formats/audio-files/flac-writer';
import type { Sink } from '../../core/model/types';
import type { AudioFileWriter, AudioFileConfig, AudioFileFormat, PcmCoding } from '../types';

export const MPEG_SAMPLE_RATES: readonly number[] = Object.freeze([32000, 44100, 48000]);
export { AAC_SAMPLE_RATES };

/** FLAC's implied layouts; 5 and 6 channels name back or surround (side) speakers. */
const FLAC_SIDE_MASKS: readonly number[] = [0x607, 0x60f];

/** Most channels the output carries: WAV, CAF and FLAC up to 8, the other formats 2. */
export function audioChannelLimit(format: AudioFileFormat): number {
    return format === 'wav' || format === 'caf' || format === 'flac' ? 8 : 2;
}

/**
 * Whether the output keeps the channels and speaker layout as they are: G.711 WAV and CAF only in
 * the default layout for the channel count, FLAC in its implied layouts.
 */
export function carriesChannelLayout(
    format: AudioFileFormat,
    codec: PcmCoding | undefined,
    channels: number,
    mask: number | undefined,
): boolean {
    if (channels > audioChannelLimit(format)) return false;
    const layout = layoutMask(channels, mask);
    if (layout === defaultChannelMask(channels)) return true;
    if (format === 'flac') return FLAC_SIDE_MASKS.includes(layout!);
    return (format === 'wav' || format === 'caf') && (codec === undefined || codec === 'pcm');
}

export function createAudioFileWriter(
    codecs: StreamingAudioCodecs = {},
    missing: MissingParts = NO_PLUGINS,
): AudioFileWriter {
    const output = createStreamingAudioOutput(codecs, missing);
    const formats: AudioFileFormat[] = ['wav', 'aiff', 'au', 'caf'];
    for (const format of ['flac', 'aac', 'mp2', 'mp3'] as const)
        if (codecs[format]) formats.push(format);
    const check = (config: AudioFileConfig): void => {
        const {
            format,
            sampleRate,
            channels,
            estimatedFrames,
            bitrateKbps,
            vbr,
            codec,
            sampleFormat = 's16',
        } = config;
        const invalid = (message: string): never => {
            throw new MediaForgeError(message, 'FORMAT');
        };

        if (!formats.includes(format))
            throw missing.audioEncoder(format, `No audio encoder for '${format}' is installed`);
        const limit = audioChannelLimit(format);
        if (
            !Number.isInteger(sampleRate) ||
            sampleRate < 1 ||
            sampleRate > 768000 ||
            !Number.isInteger(channels) ||
            channels < 1 ||
            channels > limit ||
            !Number.isSafeInteger(estimatedFrames) ||
            estimatedFrames < 1
        )
            invalid(`${format} audio has an invalid channel count, rate or length`);
        if (bitrateKbps !== undefined && (!Number.isInteger(bitrateKbps) || bitrateKbps < 1))
            invalid('bitrateKbps must be a positive integer');
        if (vbr !== undefined && (typeof vbr !== 'boolean' || format !== 'mp3'))
            invalid('vbr requires MP3 output');
        if (LOSSLESS_AUDIO_FORMATS.has(format) && bitrateKbps !== undefined)
            invalid('PCM and FLAC outputs do not take bitrateKbps');
        if (
            codec !== undefined &&
            codec !== 'pcm' &&
            !(PCM_AUDIO_FORMATS as ReadonlySet<string>).has(format)
        )
            invalid(`${codec} sample coding requires wav, aiff, au or caf output`);

        if (format === 'mp2' || format === 'mp3') {
            if (!MPEG_SAMPLE_RATES.includes(sampleRate))
                invalid(`${format} requires sampleRate 32000, 44100 or 48000`);
            if (bitrateKbps !== undefined && !mpegBitrates(format, channels).includes(bitrateKbps))
                invalid(`Unsupported ${format} bitrateKbps for ${channels} channels`);
        }
        if (format === 'aac') {
            if (!AAC_SAMPLE_RATES.includes(sampleRate)) invalid('Unsupported AAC sampleRate');
            if (
                bitrateKbps !== undefined &&
                (bitrateKbps < 16 * channels || bitrateKbps > 320 * channels)
            )
                invalid('AAC bitrateKbps is outside the encoder range');
        }
        if (format === 'flac' && (sampleRate > 655350 || estimatedFrames > 0xfffffffff))
            invalid('FLAC sample rate or sample count exceeds its native output range');
        if (format === 'wav' || format === 'aiff' || format === 'au' || format === 'caf') {
            if (codec === 'ulaw' || codec === 'alaw')
                createG711Header(format, codec, sampleRate, channels, estimatedFrames * channels);
            else if (format !== 'wav')
                createPcmCopyHeader(
                    format,
                    describePcmTrack({
                        codec: pcmSampleCodec(sampleFormat),
                        sampleRate,
                        channelCount: channels,
                    }),
                    estimatedFrames * channels * PCM_SAMPLE_BYTES[sampleFormat],
                );
            else if (
                !Number.isSafeInteger(estimatedFrames * channels * PCM_SAMPLE_BYTES[sampleFormat])
            )
                invalid('WAV output exceeds exact byte sizes');
        }
    };

    /**
     * AAC (ADTS) and FLAC through a supporting host AudioEncoder; false when the built-in encoder
     * must write.
     */
    async function encodeWithHost(
        source: ReplayablePcmSource,
        sink: Sink,
        config: AudioFileConfig,
    ): Promise<boolean> {
        const { format, signal } = config;
        const codec = audioFormatCodec(format) ?? format;
        const order = audioEncoderOrder(codec, true, config.codecPreference, config.sampleFormat);
        if (order[0] !== 'webcodecs') return false;
        const bitrate = format === 'aac' ? (config.bitrateKbps ?? 128) * 1000 : undefined;
        const encoderConfig: AudioEncoderConfig = {
            codec,
            sampleRate: config.sampleRate,
            numberOfChannels: config.channels,
            ...(bitrate ? { bitrate } : {}),
        };
        if (!(await hostSupports('AudioEncoder', encoderConfig, signal))) return false;

        const muxer =
            format === 'aac'
                ? new AdtsMuxer(sink, config.sampleRate, config.channels)
                : new FlacMuxer(
                      sink,
                      config.sampleRate,
                      config.channels,
                      16,
                      undefined,
                      config.tags,
                  );
        const expected = Math.max(1, source.estimatedFrames);
        const encoded = await streamHostAudio(
            {
                config: encoderConfig,
                muxer,
                startOffset: 0,
                expectedFrames: expected,
                signal,
                fallback: true,
                warn: (code, message) => config.onWarning?.({ code, message }),
            },
            async consume => {
                let frames = 0;
                let reported = 0;
                for await (const planes of source.chunks(signal)) {
                    await consume(planes);
                    frames += planes[0]?.length ?? 0;
                    if (frames - reported >= 65536) {
                        reported = frames;
                        config.onProgress?.({
                            fraction: Math.min(1, frames / expected),
                            message: `Encoding ${format} ${frames}/${expected}`,
                        });
                    }
                }
                return frames;
            },
        );

        if (encoded) await muxer.finalize();
        return encoded;
    }

    return Object.freeze({
        formats: Object.freeze(formats),
        check,
        async encode(source, sink, config) {
            check(config);
            if (await encodeWithHost(source, sink, config)) return;
            await output.encodeReplayablePcmToSink(source, config.format, sink, config);
        },
    } satisfies AudioFileWriter);
}
