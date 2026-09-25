import { createStreamingAudioOutput } from '../audio/streaming-audio-output-core.js';
import { MediaForgeError } from '../core/errors.js';
import { createPcmCopyHeader, describePcmTrack } from '../core/pcm-format.js';
export function createWorkflowAudio(codecs = {}) {
    const output = createStreamingAudioOutput(codecs);
    const formats = ['wav', 'aiff', 'au', 'caf'];
    for (const format of ['flac', 'aac', 'mp2', 'mp3'])
        if (codecs[format])
            formats.push(format);
    const check = (config) => {
        const { format, sampleRate, channels, estimatedFrames, bitrateKbps, vbr } = config;
        const invalid = (message) => {
            throw new MediaForgeError(message, 'FORMAT');
        };
        if (!formats.includes(format))
            invalid(`Native audio encoder '${format}' is not installed`);
        if (!Number.isInteger(sampleRate) ||
            sampleRate < 1 ||
            sampleRate > 768000 ||
            !Number.isInteger(channels) ||
            channels < 1 ||
            channels > 2 ||
            !Number.isSafeInteger(estimatedFrames) ||
            estimatedFrames < 1)
            invalid('Native audio requires 1-2 channels, a rate in 1..768000 and a positive safe frame count');
        if (bitrateKbps !== undefined && (!Number.isInteger(bitrateKbps) || bitrateKbps < 1))
            invalid('bitrateKbps must be a positive integer');
        if (vbr !== undefined && (typeof vbr !== 'boolean' || format !== 'mp3'))
            invalid('vbr requires MP3 output');
        if (['wav', 'aiff', 'au', 'caf', 'flac'].includes(format) && bitrateKbps !== undefined)
            invalid('PCM and FLAC outputs do not take bitrateKbps');
        if (format === 'mp2' || format === 'mp3') {
            if (![32000, 44100, 48000].includes(sampleRate))
                invalid(`${format} requires sampleRate 32000, 44100 or 48000`);
            const legal = format === 'mp3'
                ? [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
                : channels === 1
                    ? [32, 48, 56, 64, 80, 96, 112, 128, 160, 192]
                    : [64, 96, 112, 128, 160, 192, 224, 256, 320, 384];
            if (bitrateKbps !== undefined && !legal.includes(bitrateKbps))
                invalid(`Unsupported ${format} bitrateKbps for ${channels} channels`);
        }
        if (format === 'aac') {
            if (![96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350].includes(sampleRate))
                invalid('Unsupported AAC sampleRate');
            if (bitrateKbps !== undefined && (bitrateKbps < 16 * channels || bitrateKbps > 320 * channels))
                invalid('AAC bitrateKbps is outside the encoder range');
        }
        if (format === 'flac' && (sampleRate > 655350 || estimatedFrames > 0xfffffffff))
            invalid('FLAC sample rate or sample count exceeds its native output range');
        if (format === 'wav' || format === 'aiff' || format === 'au' || format === 'caf') {
            const pcm = describePcmTrack({ codec: 'pcm-s16le', sampleRate, channelCount: channels });
            if (format !== 'wav')
                createPcmCopyHeader(format, pcm, estimatedFrames * channels * 2);
            else if (!Number.isSafeInteger(estimatedFrames * channels * 2))
                invalid('WAV output exceeds exact byte sizes');
        }
    };
    return Object.freeze({
        formats: Object.freeze(formats),
        check,
        async encode(source, sink, config) {
            check(config);
            await output.encodeReplayablePcmToSink(source, config.format, sink, config);
        },
    });
}
