import { libraryAudioCodecs } from '../pipeline/codecs/router';
import { awaitWithAbort } from '../core/io/abort';
import { canonicalAudioCodec, codecDisplayName } from '../core/model/codec-names';
import { IMAGE_FORMATS, PACKAGE_FORMATS } from '../pipeline/plan/format-policy';
import {
    HOST_DECODED_FORMATS,
    HOST_ONLY_IMAGE_FORMATS,
    probedHostImageFormats,
} from '../codecs/image/host-formats';
import { canonicalFormat, formatAudioCodec } from '../formats/shared/names';
import { muxCodecTables } from '../formats/shared/capabilities';
import { CORE_FORMATS } from '../formats/core-formats';
import type { PluginSet } from '../pipeline/plugins/plugin';
import { BUILTIN_AUDIO_DECODER_FAMILIES } from '../pipeline/codecs/audio-track-decoder';
import { coreVideoDecoders } from '../pipeline/codecs/core-codecs';
import { hostSupports } from '../codecs/webcodecs/support';
import {
    autoAudioCodecs,
    autoVideoFamilies,
    canEncodeAudioCodec,
    hostVideoCodecs,
    hostVideoEncoderCodec,
} from '../pipeline/plan/codec-choice';
import type { CapabilityOptions, MediaCapabilities } from './capability-types';

/** Xiph-laced Vorbis identification, comment and setup-header prefix for 48 kHz stereo. */
const VORBIS_PROBE_HEADERS = new Uint8Array([
    2, 30, 16, 1, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73, 0, 0, 0, 0, 2, 0x80, 0xbb, 0, 0, 0, 0, 0, 0,
    0, 0xf4, 1, 0, 0, 0, 0, 0, 0xb8, 1, 3, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73, 0, 0, 0, 0, 0, 0, 0,
    0, 1, 5, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73, 0,
]);

/** fLaC and a 48 kHz stereo 16-bit STREAMINFO with 4096-sample blocks. */
const FLAC_PROBE_HEADER = new Uint8Array([
    0x66, 0x4c, 0x61, 0x43, 0x80, 0, 0, 34, 0x10, 0, 0x10, 0, 0, 0, 0, 0, 0, 0, 0x0b, 0xb8, 0x02,
    0xf0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
]);

/**
 * Host decoder probes as codec name and WebCodecs configuration; none for linear PCM, which the
 * library always reads itself (readsLinearPcm()).
 */
export const HOST_AUDIO_DECODE_PROBES: readonly (readonly [string, AudioDecoderConfig])[] = [
    [
        'aac',
        {
            codec: 'mp4a.40.2',
            sampleRate: 48000,
            numberOfChannels: 2,
            description: new Uint8Array([0x11, 0x90]),
        },
    ],
    ['mp3', { codec: 'mp3', sampleRate: 48000, numberOfChannels: 2 }],
    ['opus', { codec: 'opus', sampleRate: 48000, numberOfChannels: 2 }],
    [
        'flac',
        { codec: 'flac', sampleRate: 48000, numberOfChannels: 2, description: FLAC_PROBE_HEADER },
    ],
    [
        'vorbis',
        {
            codec: 'vorbis',
            sampleRate: 48000,
            numberOfChannels: 2,
            description: VORBIS_PROBE_HEADERS,
        },
    ],
    ['ac-3', { codec: 'ac-3', sampleRate: 48000, numberOfChannels: 2 }],
    ['ec-3', { codec: 'ec-3', sampleRate: 48000, numberOfChannels: 2 }],
    ['ulaw', { codec: 'ulaw', sampleRate: 8000, numberOfChannels: 1 }],
    ['alaw', { codec: 'alaw', sampleRate: 8000, numberOfChannels: 1 }],
];

/** The video codecs asked about without a target: the host's decoders and encoders of these. */
export const ALL_VIDEO = ['avc1', 'hvc1', 'vp8', 'vp09', 'av01'];
/** The audio codecs whose encoding, by the host or the library, is asked about without a target. */
export const ALL_AUDIO = ['mp4a.40.2', 'opus', 'mp3', 'flac', 'vorbis', 'mp2', 'pcm'];
const COPY_ONLY = {
    video: [
        'wmv1',
        'wmv2',
        'wmv3',
        'vc1',
        'theora',
        'vvc1',
        'vvi1',
        'dvh1',
        'dvhe',
        'dnxhd',
        'jpeg2000',
    ],
    audio: ['wmav1', 'wmav2', 'wmapro', 'wmalossless', 'wmavoice', 'speex'],
};

function hasGlobal(name: string): boolean {
    return typeof (globalThis as Record<string, unknown>)[name] === 'function';
}

/** The image formats, less those of `hostOnly` that this host (`hosted`) lacks; sorted. */
function hostOrLibrary(hostOnly: readonly string[], hosted: readonly string[]): string[] {
    return [...IMAGE_FORMATS]
        .filter(format => !hostOnly.includes(format) || hosted.includes(format))
        .sort();
}

/**
 * A small picture of `format` the host's decoder is tried on: BMP and ICO by the library's
 * encoders, AVIF, HEIF and JPEG XL from ./image-samples; none of JPEG, which only a canvas makes.
 * The icon is 16 pixels a side, the smallest common icon: Safari decodes none of 1 or 2.
 */
async function imageSample(format: string): Promise<Uint8Array<ArrayBuffer> | undefined> {
    if (format === 'bmp' || format === 'ico') {
        const { encodeBmp, encodeIco } = await import('../codecs/image/encoders');
        const side = format === 'bmp' ? 1 : 16;
        const data = new Uint8Array(side * side * 4).fill(255);
        const picture = { data, width: side, height: side };
        return format === 'bmp' ? encodeBmp(picture) : encodeIco(picture);
    }
    const samples = await import('./image-samples');
    return samples.hasImageSample(format) ? samples.imageSample(format) : undefined;
}

/**
 * The capabilities of a composition with `plugins` in this host. Host codecs are asked with
 * isConfigSupported once per configuration; encode lists answer for the size, rate and container of
 * `options`.
 */
export async function probeCapabilities(
    plugins: PluginSet,
    options: CapabilityOptions = {},
): Promise<MediaCapabilities> {
    const { signal } = options;
    const read = new Set<string>();
    const write = new Set<string>();
    for (const reader of [...plugins.readers, ...CORE_FORMATS.readers])
        for (const format of reader.formats) read.add(format);
    for (const writer of [...plugins.writers, ...CORE_FORMATS.writers])
        for (const format of writer.formats) write.add(format);

    const format = options.to === undefined ? undefined : canonicalFormat(options.to);
    const videoCandidates = format
        ? autoVideoFamilies(format).map(family => (family === 'avc' ? 'avc1' : family))
        : ALL_VIDEO;
    // An 'opus' target holds Opus only; the others list their container's order.
    const required = formatAudioCodec(options.to);
    const audioCandidates = required ? [required] : format ? autoAudioCodecs(format) : ALL_AUDIO;
    const libraryCodecs = libraryAudioCodecs(plugins.audioEncoders);
    const libraryDecode = [
        ...BUILTIN_AUDIO_DECODER_FAMILIES,
        ...plugins.audioDecoders.flatMap(decoder => decoder.codecs),
    ].map(codec => (codec === 'mp4a' ? 'aac' : codec));

    const [hostDecode, host, video, audio, hostImages] = await awaitWithAbort(
        Promise.all([
            Promise.all(
                HOST_AUDIO_DECODE_PROBES.map(([, config]) =>
                    hostSupports('AudioDecoder', config, signal),
                ),
            ),
            hostVideoCodecs(signal),
            Promise.all(
                videoCandidates.map(codec =>
                    hostVideoEncoderCodec(
                        codec,
                        {
                            width: options.width ?? 1280,
                            height: options.height ?? 720,
                            framerate: options.framerate,
                            bitrate: options.bitrate,
                            hardwareAcceleration: options.hardwareAcceleration,
                            latencyMode: options.latencyMode,
                            bitrateMode: options.bitrateMode,
                        },
                        signal,
                    ).then(accepted => accepted !== undefined),
                ),
            ),
            Promise.all(
                audioCandidates.map(codec =>
                    canEncodeAudioCodec(
                        canonicalAudioCodec(codec),
                        libraryCodecs,
                        {
                            sampleRate: options.sampleRate,
                            channels: options.channels,
                            bitrate: options.bitrate,
                        },
                        signal,
                    ),
                ),
            ),
            probedHostImageFormats(imageSample),
        ]),
        signal,
    );

    const tables = muxCodecTables();
    return {
        plugins: plugins.names,
        containers: { read: [...read].sort(), write: [...write].sort() },
        audio: {
            decode: [
                ...new Set([
                    ...libraryDecode,
                    ...HOST_AUDIO_DECODE_PROBES.filter((_, index) => hostDecode[index]).map(
                        ([name]) => name,
                    ),
                ]),
            ],
            encode: audioCandidates.filter((_, index) => audio[index]).map(codecDisplayName),
        },
        video: {
            decoders: [...coreVideoDecoders, ...plugins.videoDecoders].map(codec => codec.id),
            decode: host.decode,
            encode: videoCandidates.filter((_, index) => video[index]).map(codecDisplayName),
            transforms: ['crop', 'resize', 'rotate', 'flip'],
        },
        videoCopy: tables.video,
        audioCopy: tables.audio,
        copyOnly: COPY_ONLY,
        // A format the library writes or decodes itself is always listed; one only the host does,
        // where this host does it.
        images: hostOrLibrary(HOST_ONLY_IMAGE_FORMATS, hostImages.encode),
        imageRead: hostOrLibrary(HOST_DECODED_FORMATS, hostImages.decode),
        packaging: [...PACKAGE_FORMATS],
        host: {
            videoDecoder: hasGlobal('VideoDecoder'),
            videoEncoder: hasGlobal('VideoEncoder'),
            audioDecoder: hasGlobal('AudioDecoder'),
            audioEncoder: hasGlobal('AudioEncoder'),
            canvas: hasGlobal('OffscreenCanvas') || hasGlobal('HTMLCanvasElement'),
            mediaSource: hasGlobal('MediaSource'),
        },
    };
}
