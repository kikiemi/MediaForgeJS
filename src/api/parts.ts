import { MediaForgeError } from '../core/errors/errors';
import type { MediaDiagnostic } from '../core/errors/diagnostics';
import type { Sink } from '../core/model/types';
import type { Engine } from '../pipeline/engine';
import { MediaForge } from './forge';
import type { MediaForgeOptions } from './types';
import { mediaFileState } from '../pipeline/read/file-state';
import { createAudioTrackDecoder } from '../pipeline/codecs/audio-track-decoder';
import type { AudioTrackDecoder } from '../pipeline/types';
import { trackPcm } from '../pipeline/transcode/track-pcm';
import type { PartOptions, PcmSource } from '../pipeline/parts';
import type {
    Muxer,
    MuxerOptions,
    VideoDecoderOptions,
    VideoDecoderPart,
    VideoEncoderOptions,
    VideoEncoderPart,
} from '../pipeline/codecs/part-options';
import type { CodecPreference } from '../pipeline/api-types';
import { allPlugins } from '../plugins/index';
import type { Media } from './media';
import { handles, mediaContext, mediaReading } from './handles';

/** MediaForge with every plugin of the library, which createParts() starts from. */
class PartsForge extends MediaForge {
    static override readonly defaultPlugins = allPlugins;
}

/**
 * The audio decoders of each engine: the core's and its plugins', which decodeAudio() uses without
 * the conversion code.
 */
const audioDecoders = new WeakMap<Engine, AudioTrackDecoder>();

function audioDecoderOf(engine: Engine): AudioTrackDecoder {
    let decoder = audioDecoders.get(engine);
    if (!decoder)
        audioDecoders.set(
            engine,
            (decoder = createAudioTrackDecoder(
                engine.audioDecoders,
                engine.formats.writers.missing,
            )),
        );
    return decoder;
}

/** The track `trackId` of `media` of `type`; another or a missing one fails with INPUT. */
function trackOf(media: Media, trackId: number, type: 'video' | 'audio') {
    const { engine, file } = mediaContext(media);
    const track = mediaFileState(file).tracks.find(
        candidate => candidate.description.id === trackId,
    );
    if (!track || track.type !== type)
        throw new MediaForgeError(
            `Track ${trackId} is not a ${type} track of this input`,
            'INPUT',
            {
                hint: `Choose an id from media.tracks whose type is '${type}'.`,
            },
        );
    return { engine, file, track };
}

/**
 * Opens a decoder for a video track of an opened input: the host VideoDecoder where it decodes the
 * track (unless `codecPreference` is 'builtin'), else the library's decoders. Feed it the track's
 * packets from `media.packets()`.
 */
export async function createVideoDecoder(
    media: Media,
    trackId: number,
    options: VideoDecoderOptions = {},
): Promise<VideoDecoderPart> {
    const { engine, track } = trackOf(media, trackId, 'video');
    const { openVideoDecoderPart } = await import('../pipeline/codecs/part-codecs');
    return openVideoDecoderPart(
        track.info,
        {
            decoders: engine.videoDecoders,
            preference: engine.codecPreference,
            missing: engine.formats.writers.missing,
            providers: engine.videoCodecs,
        },
        options,
    );
}

export interface AudioDecodeOptions extends PartOptions {
    /**
     * 'webcodecs' (default) tries the host AudioDecoder first, 'builtin' the library's decoders.
     */
    readonly codecPreference?: CodecPreference;
    /** Damaged packets fail the decode instead of being skipped with a warning. */
    readonly strict?: boolean;
}

/**
 * The sound of an audio track of an opened input as PCM, from its first presented sample: planar
 * float blocks at the track's rate. The source can be read more than once. A Media opened from a
 * probe (a large MPEG-TS, Matroska, Ogg, MP3 or FLAC input) reads its index first, once.
 */
export async function decodeAudio(
    media: Media,
    trackId: number,
    options: AudioDecodeOptions = {},
): Promise<PcmSource> {
    trackOf(media, trackId, 'audio');
    const { indexed } = await import('./media-reads');
    const { engine, file } = await indexed(mediaReading(media));
    const track = mediaFileState(file).tracks.find(
        candidate => candidate.description.id === trackId,
    )!;
    const listener = options.onWarning;
    const source = trackPcm(file, track, {
        decoder: audioDecoderOf(engine),
        codecPreference: options.codecPreference ?? engine.codecPreference,
        validation: options.strict ? 'strict' : 'compatible',
        onWarning: listener
            ? warning =>
                  listener(Object.freeze({ ...warning, severity: 'warning' }) as MediaDiagnostic)
            : undefined,
    });
    // The frames the track presents, the length a conversion declares for it too: a muxer
    // declares it before it writes (PcmSource.frames).
    const frames = source.estimatedFrames;
    return Number.isSafeInteger(frames) && frames > 0 ? { ...source, frames } : source;
}

/**
 * How createParts() reads inputs and which codecs and containers its parts use: the options of a
 * MediaForge, whose `plugins` start from every plugin of the library.
 */
export type PartsOptions = MediaForgeOptions;

/** The parts of a pipeline, bound to the plugins and options of createParts(). */
export interface Parts {
    /** Reads an input into tracks and packets, as open() of mediaforgejs does. */
    readonly open: MediaForge['open'];
    /** See createVideoDecoder(): it decodes with the codecs of the input's own MediaForge. */
    readonly createVideoDecoder: typeof createVideoDecoder;
    /** See decodeAudio(). */
    readonly decodeAudio: typeof decodeAudio;
    /**
     * Opens a video encoder: the host VideoEncoder with the first profile and level it accepts for
     * the size (a full codec string such as 'avc1.42001f' is kept as given), or a plugin's codec
     * that encodes it.
     */
    createVideoEncoder(options: VideoEncoderOptions): Promise<VideoEncoderPart>;
    /**
     * Opens a muxer that writes a container file of `format` ('mp4', 'webm', 'mkv', 'mov', 'ts' and
     * the others the plugins in use write) into `sink`, with the declared video and audio tracks.
     * finish() closes the sink.
     */
    createMuxer(format: string, sink: Sink, options: MuxerOptions): Promise<Muxer>;
}

/**
 * The parts of a pipeline with the plugins of `options` (every plugin of the library by default;
 * `plugins: { exclude: [...] }` or an array as for MediaForge): inputs opened with its open() and
 * the encoders and muxers it opens use those plugins only.
 */
export function createParts(options: PartsOptions = {}): Parts {
    const forge = new PartsForge(options);
    return Object.freeze({
        open: forge.open.bind(forge) as MediaForge['open'],
        createVideoDecoder,
        decodeAudio,
        async createVideoEncoder(encoder: VideoEncoderOptions): Promise<VideoEncoderPart> {
            const [{ openVideoEncoderPart }, engine] = await Promise.all([
                import('../pipeline/codecs/part-codecs'),
                handles.engineOf(forge),
            ]);
            return openVideoEncoderPart(encoder, engine.videoCodecs);
        },
        async createMuxer(format: string, sink: Sink, muxer: MuxerOptions): Promise<Muxer> {
            if (typeof format !== 'string' || !format.trim())
                throw new MediaForgeError('Expected a container format', 'INPUT');
            const engine = await handles.engineOf(forge);
            const [{ openMuxer }] = await Promise.all([
                import('../pipeline/codecs/part-codecs'),
                engine.prepare(),
            ]);
            return openMuxer(engine.formats.writers, format, sink, muxer, engine.containerAudio);
        },
    });
}
