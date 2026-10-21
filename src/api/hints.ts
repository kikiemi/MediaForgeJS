import { MediaForgeError, type ErrorCode } from '../core/errors/errors';
import { hostCodecAvailable } from '../codecs/webcodecs/support';

/** What the failed operation was asked to do, so a hint can name an alternative that fits. */
export interface HintContext {
    /** Canonical output format. */
    readonly format?: string;
    /** remux, convert, audio, image or package. */
    readonly kind?: string;
    readonly audioCodec?: string;
    /** The result is collected into a Blob, whose size is capped by maxBytes. */
    readonly blob?: boolean;
}

const HOST_ONLY_AUDIO = new Set(['opus', 'vorbis']);

/**
 * One short sentence on what to do about a failure with `code` and `message`, or undefined when
 * there is nothing better than the message. Hints depend on the host: where a WebCodecs class is
 * missing they name another way.
 */
export function hintFor(
    code: ErrorCode,
    message: string,
    context: HintContext = {},
): string | undefined {
    const text = message.toLowerCase();
    if (code === 'ABORT') return undefined;
    if (code === 'OOM' && text.includes('maxtotalbytes'))
        return 'Pass onFile to store each file as it arrives, or raise maxBytes.';
    if (code === 'OOM' && (text.includes('maxbytes') || text.includes('could not allocate output')))
        return context.blob
            ? 'Write to a sink such as StreamSink.fromPicker() or FileSink instead.'
            : 'Raise maxBytes.';
    if (code === 'OOM' && (text.includes('maxsamples') || text.includes('maxindexbytes')))
        return 'Raise open.maxSamples or open.maxIndexBytes if memory allows.';

    if (code === 'ENCODE' || code === 'FORMAT' || code === 'DECODE') {
        if (text.includes('imagebitmap'))
            return 'Run in a browser, or take the pictures from a video.';
        if (text.includes('offscreencanvas') || text.includes('canvas'))
            return context.kind === 'image' || text.includes('jpeg') || text.includes('webp')
                ? "Ask for 'png', which needs no OffscreenCanvas."
                : 'Run in a browser, or leave the picture size and angle unchanged.';
        if (text.includes('video') && text.includes('encod') && !hostCodecAvailable('VideoEncoder'))
            return "Copy instead: drop the video settings and choose a container like 'mkv'.";
        if (text.includes('videoencoder does not support') || text.includes('10-bit encoder'))
            return "Use video: { codec: 'auto' }, or a smaller width.";
        if (text.includes('audio') && text.includes('encod')) {
            const codec = context.audioCodec ?? '';
            if (HOST_ONLY_AUDIO.has(codec) || !hostCodecAvailable('AudioEncoder'))
                return "Use audio: { codec: 'auto' } or 'aac', which needs no AudioEncoder.";
        }
        if (text.includes('video') && text.includes('decod') && !hostCodecAvailable('VideoDecoder'))
            return 'Run in a browser, or copy the track without video settings.';
        if (text.includes('audio') && text.includes('decod') && !hostCodecAvailable('AudioDecoder'))
            return 'Run in a browser, or copy the track into a container.';
        if (text.includes('cannot mux') || /cannot copy .*re-encode/.test(text))
            return "Choose a container that carries these codecs, such as 'mkv'.";
        if (
            text.includes('at most one video and one audio track') ||
            text.includes('select trackids')
        )
            return 'Pick one video and one audio track with trackIds from inspect().';
    }

    if (code === 'FORMAT' && text.includes('one audio track'))
        return 'Name one audio track with trackIds: [id], using an id from inspect().';
    if (code === 'FORMAT' && text.includes('allowprecisionloss'))
        return "Leave allowPrecisionLoss unset to accept it, or copy into 'mkv'.";
    if (code === 'FORMAT' && text.includes('no video track'))
        return "Choose an audio format such as 'mp3'.";
    if (code === 'FORMAT' && text.includes('no audio track'))
        return 'Choose a video format instead.';
    if (code === 'DEMUX' || (code === 'FORMAT' && text.includes('unrecognized')))
        return 'Check that the file is intact and in a supported format.';
    return undefined;
}

/** Adds the hint for its context to a MediaForgeError that has none; other values pass through. */
export function withHint<T>(error: T, context: HintContext): T {
    if (error instanceof MediaForgeError && !error.hint) {
        const hint = hintFor(error.code, error.message, context);
        if (hint) error.hint = hint;
    }
    return error;
}
