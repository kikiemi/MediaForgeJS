import { NO_PLUGINS, type MissingParts } from '../plugins/missing-parts';
import {
    createG711Header,
    createPcmCopyHeader,
    describePcmTrack,
} from '../../core/codec-config/audio/pcm-format';
import { PCM_AUDIO_FORMATS } from '../../core/model/pcm-files';
import { encoderLoader } from '../../codecs/shared/lazy-audio-encoder';
import { EncodeError, throwIfAborted } from '../../core/errors/errors';
import { runReplayableAudio } from './replayable-audio-lifetime';
import { MemorySink } from '../../core/io/sinks/sinks';
import { drainSink } from '../../core/io/sinks/sink-backpressure';
import type { Sink } from '../../core/model/types';
import { AdtsMuxer } from '../../formats/audio-files/adts-writer';
import type { ReplayablePcmSource } from '../../codecs/pcm/pcm-source';
import { defaultChannelMask, layoutMask } from '../../core/model/channel-layout';
import { encodeG711 } from '../../codecs/pcm/g711';
import { yieldEventLoop } from '../../core/io/event-loop';
import type { StreamingAacLcEncoder } from '../../codecs/aac/encoder';
import type { StreamingFlacEncoder } from '../../codecs/flac/encoder';
import type { StreamingMp2Encoder } from '../../codecs/mpeg-audio/mp2-encoder';
import type { StreamingMp3Encoder } from '../../codecs/mpeg-audio/mp3-encoder';
import { sameBytes } from '../../core/bytes/bytes';
import { mimeTypeOf } from '../../formats/shared/mime-types';
import type {
    StreamingAacResult,
    StreamingAudioDiagnostics,
    StreamingAudioEncodeOptions,
    StreamingSelfHostedAudioFormat,
} from './audio-output-types';
import { PCM_SAMPLE_BYTES, encodePcm, type PcmSampleFormat } from '../../codecs/pcm/encoder';
import { flacHeaderWithTags, riffWithInfo } from '../../formats/audio-files/tags';
import { riffInfoChunk } from '../../formats/metadata/riff-info';
import { id3TagFromMediaTags } from '../../formats/metadata/id3';

/** The PCM codec string of a linear coding in little-endian order. */
export function pcmSampleCodec(
    sampleFormat: PcmSampleFormat,
): 'pcm-s16le' | 'pcm-s24le' | 'pcm-f32le' {
    return sampleFormat === 'f32'
        ? 'pcm-f32le'
        : sampleFormat === 's24'
          ? 'pcm-s24le'
          : 'pcm-s16le';
}

/** The options inside the output: the public ones and a wait between PCM chunks. */
interface OutputOptions extends StreamingAudioEncodeOptions {
    /** Awaited after each PCM chunk, as for the backpressure of the sink a packet writer fills. */
    readonly afterPcmChunk?: () => Promise<void>;
}

export interface StreamingAudioCodecs {
    readonly aac?: typeof StreamingAacLcEncoder;
    readonly flac?: typeof StreamingFlacEncoder;
    readonly mp2?: typeof StreamingMp2Encoder;
    readonly mp3?: typeof StreamingMp3Encoder;
}

type EncoderName = 'aac' | 'flac' | 'mp2' | 'mp3';

/** The encoders of one output: the given ones, with lazily installed ones loaded before use. */
class AudioEncoders {
    private readonly ready: { -readonly [K in EncoderName]?: StreamingAudioCodecs[K] };

    constructor(
        codecs: StreamingAudioCodecs,
        private readonly missing: MissingParts,
    ) {
        this.ready = { ...codecs };
    }

    /** Loads a lazily installed encoder; undefined when there is nothing to wait for. */
    load(name: string): Promise<void> | undefined {
        return encoderLoader(this.ready[name as EncoderName])?.().then(encoder => {
            this.ready[name as EncoderName] = encoder;
        });
    }

    /** The encoder `name`, which must be installed. */
    get<K extends EncoderName>(name: K): NonNullable<StreamingAudioCodecs[K]> {
        const codec = this.ready[name];
        if (!codec)
            throw this.missing.audioEncoder(name, `Audio encoder '${name}' is not installed`);
        return codec as NonNullable<StreamingAudioCodecs[K]>;
    }
}

interface PcmVisitResult {
    readonly frames: number;
    readonly peakChunkFrames: number;
}

function assertChunk(source: ReplayablePcmSource, chunk: readonly Float32Array[]): number {
    if (chunk.length !== source.channels) {
        throw new EncodeError('PCM replay changed its channel count');
    }
    const frames = chunk[0]?.length ?? 0;
    for (let channel = 1; channel < chunk.length; channel++) {
        if (chunk[channel]!.length !== frames) {
            throw new EncodeError('PCM replay produced channel planes with different lengths');
        }
    }
    return frames;
}

async function visitPcm(
    source: ReplayablePcmSource,
    signal: AbortSignal | undefined,
    consume: (chunk: readonly Float32Array[]) => void | Promise<void>,
    progress?: (frames: number) => void,
): Promise<PcmVisitResult> {
    let frames = 0;
    let peakChunkFrames = 0;
    let framesSinceYield = 0;
    let lastProgressFrame = 0;
    for await (const chunk of source.chunks(signal)) {
        throwIfAborted(signal);
        const chunkFrames = assertChunk(source, chunk);
        if (chunkFrames === 0) continue;
        await consume(chunk);
        frames += chunkFrames;
        framesSinceYield += chunkFrames;
        peakChunkFrames = Math.max(peakChunkFrames, chunkFrames);
        if (frames - lastProgressFrame >= 65536 || frames >= source.estimatedFrames) {
            progress?.(frames);
            lastProgressFrame = frames;
        }

        if (framesSinceYield >= 16384) {
            await yieldEventLoop();
            framesSinceYield = 0;
        }
    }
    throwIfAborted(signal);
    return { frames, peakChunkFrames };
}

/** Feeds each PCM chunk to `encoder`, then waits until the sink takes what the encoder wrote. */
function feeding(
    encoder: { pushPlanar(planes: readonly Float32Array[]): void },
    sink: Sink,
    signal: AbortSignal | undefined,
): (chunk: readonly Float32Array[]) => Promise<void> {
    return async chunk => {
        encoder.pushPlanar(chunk);
        await drainSink(sink, signal);
    };
}

/** Drains and closes the sink of a finished encoding, with the last progress report. */
async function closeOutput(sink: Sink, options: StreamingAudioEncodeOptions): Promise<void> {
    await drainSink(sink, options.signal);
    options.onProgress?.({ fraction: 1, message: 'Finalizing output...' });
    await sink.close();
}

function expectedRatio(done: number, expected: number): number {
    return Math.max(0, Math.min(1, done / Math.max(1, expected)));
}

/** Streams the AAC frames of a replayable source to `onFrame`, guarded for replays. */
async function streamReplayableAac(
    encoders: AudioEncoders,
    source: ReplayablePcmSource,
    onFrame: (frame: Uint8Array, frameIndex: number) => void,
    options: OutputOptions = {},
): Promise<StreamingAacResult> {
    return runReplayableAudio(source, undefined, options, (input, _sink, guarded, perform) =>
        streamAac(encoders, input, (frame, index) => perform(() => onFrame(frame, index)), guarded),
    );
}

async function streamAac(
    encoders: AudioEncoders,
    source: ReplayablePcmSource,
    onFrame: (frame: Uint8Array, frameIndex: number) => void,
    options: OutputOptions = {},
): Promise<StreamingAacResult> {
    if (source.channels > 2) {
        throw new EncodeError('Built-in streaming AAC-LC encoder supports 1-2 channels');
    }

    const loading = encoders.load('aac');
    if (loading) await loading;
    const encoder = new (encoders.get('aac'))(
        source.sampleRate,
        source.channels,
        options.bitrateKbps ?? 128,
        {
            expectedInputFrames: source.estimatedFrames,
            collectFrames: false,
            onFrame,
            onProgress: (done, total) => {
                if ((done & 15) === 0 || done === total) {
                    options.onProgress?.({
                        fraction: expectedRatio(done, total),
                        message: `Encoding AAC ${done}/${total}`,
                    });
                }
            },
        },
    );

    const visit = await visitPcm(source, options.signal, async chunk => {
        encoder.pushPlanar(chunk);
        await options.afterPcmChunk?.();
    });

    const result = encoder.finish();
    return {
        audioSpecificConfig: result.audioSpecificConfig,
        inputFrames: encoder.framesReceived,
        encodedFrames: encoder.framesProduced,
        peakPcmFrames: Math.max(visit.peakChunkFrames, encoder.peakBufferedFrames),
    };
}

function setAscii(bytes: Uint8Array, offset: number, text: string): void {
    for (let index = 0; index < text.length; index++) {
        bytes[offset + index] = text.charCodeAt(index);
    }
}

function setUint64LE(view: DataView, offset: number, value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new EncodeError('WAV size exceeds the safe integer range');
    }
    view.setUint32(offset, value >>> 0, true);
    view.setUint32(offset + 4, Math.floor(value / 0x100000000), true);
}

/**
 * Seek-free WAVE prefix: a JUNK chunk reserved for RF64, then WAVE_FORMAT_PCM for 16-bit mono or
 * stereo, or WAVE_FORMAT_EXTENSIBLE with the speaker mask for other layouts, 24-bit and float
 * samples.
 */
function streamingWavHeader(
    sampleRate: number,
    channels: number,
    frames: number,
    channelMask: number | undefined,
    sampleFormat: PcmSampleFormat,
): Uint8Array {
    if (!Number.isInteger(sampleRate) || sampleRate < 1 || sampleRate > 0xffffffff) {
        throw new EncodeError(`WAV sample rate ${sampleRate} is invalid`);
    }
    if (!Number.isInteger(channels) || channels < 1 || channels > 0x7fff) {
        throw new EncodeError(`WAV channel count ${channels} is invalid`);
    }

    const width = PCM_SAMPLE_BYTES[sampleFormat];
    const blockAlign = channels * width;
    const byteRate = sampleRate * blockAlign;
    if (blockAlign > 0xffff || byteRate > 0xffffffff) {
        throw new EncodeError('WAV sample rate or channel count is too large');
    }

    const dataBytes = frames * blockAlign;
    if (!Number.isSafeInteger(dataBytes)) {
        throw new EncodeError('WAV size exceeds the safe integer range');
    }

    const mask = layoutMask(channels, channelMask);
    const extensible =
        channels > 2 ||
        (mask !== undefined && mask !== defaultChannelMask(channels)) ||
        sampleFormat !== 's16';
    const fmtBytes = extensible ? 40 : 16;
    const headerBytes = 64 + fmtBytes;
    const riffSize = headerBytes + dataBytes - 8;
    const rf64 = riffSize > 0xffffffff;

    const header = new Uint8Array(headerBytes);
    const view = new DataView(header.buffer);
    setAscii(header, 0, rf64 ? 'RF64' : 'RIFF');
    view.setUint32(4, rf64 ? 0xffffffff : riffSize, true);
    setAscii(header, 8, 'WAVE');
    setAscii(header, 12, rf64 ? 'ds64' : 'JUNK');
    view.setUint32(16, 28, true);
    if (rf64) {
        setUint64LE(view, 20, riffSize);
        setUint64LE(view, 28, dataBytes);
        setUint64LE(view, 36, frames);
        view.setUint32(44, 0, true);
    }

    setAscii(header, 48, 'fmt ');
    view.setUint32(52, fmtBytes, true);
    view.setUint16(56, extensible ? 0xfffe : 1, true);
    view.setUint16(58, channels, true);
    view.setUint32(60, sampleRate, true);
    view.setUint32(64, byteRate, true);
    view.setUint16(68, blockAlign, true);
    view.setUint16(70, width * 8, true);
    if (extensible) {
        view.setUint16(72, 22, true);
        view.setUint16(74, width * 8, true);
        view.setUint32(76, mask ?? 0, true);
        view.setUint32(80, sampleFormat === 'f32' ? 3 : 1, true);
        view.setUint32(84, 0x00100000, true);
        view.setUint32(88, 0xaa000080, true);
        view.setUint32(92, 0x719b3800, true);
    }

    setAscii(header, 56 + fmtBytes, 'data');
    view.setUint32(60 + fmtBytes, rf64 ? 0xffffffff : dataBytes, true);
    return header;
}

function assertFormat(format: StreamingSelfHostedAudioFormat): void {
    if (!['aac', 'flac', 'mp2', 'mp3', ...PCM_AUDIO_FORMATS].includes(format)) {
        throw new EncodeError(`Streaming audio format ${format} is not supported`);
    }
}

/** One encoding of a replayable source into a sink, as each format's writer takes it. */
interface SinkEncoding {
    readonly encoders: AudioEncoders;
    readonly source: ReplayablePcmSource;
    readonly format: StreamingSelfHostedAudioFormat;
    readonly sink: Sink;
    readonly options: OutputOptions;
    /** The bitrate of the lossy formats, in kbps. */
    readonly bitrate: number;
}

/** WAV, AIFF, AU and CAF: linear PCM or G.711 after a header that states the length. */
async function writePcm(
    { source, sink, options }: SinkEncoding,
    format: 'wav' | 'aiff' | 'au' | 'caf',
): Promise<StreamingAudioDiagnostics> {
    const g711 = options.codec === 'ulaw' || options.codec === 'alaw' ? options.codec : undefined;
    const sampleFormat = options.sampleFormat ?? 's16';
    const pcm =
        format === 'wav' || g711
            ? undefined
            : {
                  ...describePcmTrack({
                      codec: pcmSampleCodec(sampleFormat),
                      sampleRate: source.sampleRate,
                      channelCount: source.channels,
                  }),
                  channelMask: source.channelMask,
              };
    const info = format === 'wav' ? riffInfoChunk(options.tags) : undefined;
    const header = (frames: number): Uint8Array =>
        riffWithInfo(
            g711
                ? createG711Header(
                      format,
                      g711,
                      source.sampleRate,
                      source.channels,
                      frames * source.channels,
                  ).header
                : pcm
                  ? createPcmCopyHeader(format, pcm, frames * pcm.blockAlign).header
                  : streamingWavHeader(
                        source.sampleRate,
                        source.channels,
                        frames,
                        source.channelMask,
                        sampleFormat,
                    ),
            info,
        );
    const initialHeader = header(0);
    const littleEndian = format === 'wav' || format === 'caf';
    const padding = (frames: number): number =>
        g711 && (format === 'wav' || format === 'aiff') ? (frames * source.channels) & 1 : 0;

    // A sink that copies what it is given lets every chunk reuse one buffer.
    let reused = new Uint8Array(0);
    const allocate =
        sink.copiesWrites === true
            ? (size: number): Uint8Array =>
                  size <= reused.length ? reused.subarray(0, size) : (reused = new Uint8Array(size))
            : (size: number): Uint8Array => new Uint8Array(size);
    let counted: PcmVisitResult | null = null;
    if (sink.patchAt) {
        // The header of an empty stream until the length is known, so a reader can parse the
        // format at once.
        sink.write(initialHeader);
        await drainSink(sink, options.signal);
    } else {
        counted = await visitPcm(
            source,
            options.signal,
            () => drainSink(sink, options.signal),
            done =>
                options.onProgress?.({
                    fraction: expectedRatio(done, source.estimatedFrames) * 0.25,
                    message:
                        `Counting ${format.toUpperCase()} samples ` +
                        `${done}/${source.estimatedFrames}`,
                }),
        );
        sink.write(header(counted.frames));
        await drainSink(sink, options.signal);
    }
    const written = await visitPcm(
        source,
        options.signal,
        async chunk => {
            sink.write(
                g711
                    ? encodeG711(chunk, { codec: g711 })
                    : encodePcm(chunk, sampleFormat, littleEndian, allocate),
            );
            await drainSink(sink, options.signal);
        },
        done =>
            options.onProgress?.({
                fraction:
                    (counted ? 0.25 : 0) +
                    expectedRatio(done, source.estimatedFrames) * (counted ? 0.75 : 1),
                message:
                    `Writing ${format.toUpperCase()} samples ` +
                    `${done}/${source.estimatedFrames}`,
            }),
    );
    if (counted && counted.frames !== written.frames) {
        throw new EncodeError('PCM replay changed its length');
    }
    if (padding(written.frames)) sink.write(new Uint8Array(1));
    if (sink.patchAt) {
        sink.patchAt(0, header(written.frames));
    }
    await closeOutput(sink, options);
    return {
        format,
        passes: counted ? 2 : 1,
        inputFrames: written.frames,
        encodedFrames: written.frames,
        peakPcmFrames: Math.max(written.peakChunkFrames, counted?.peakChunkFrames ?? 0),
        planningBytes: 0,
    };
}

/** AAC in ADTS frames. */
async function writeAdts({
    encoders,
    source,
    format,
    sink,
    options,
    bitrate,
}: SinkEncoding): Promise<StreamingAudioDiagnostics> {
    const muxer = new AdtsMuxer(sink, source.sampleRate, source.channels);
    const frameSeconds = 1024 / source.sampleRate;
    const result = await streamReplayableAac(
        encoders,
        source,
        (frame, index) =>
            muxer.addAudioChunk({
                data: frame,
                timestamp: index * frameSeconds,
                duration: frameSeconds,
                isKeyframe: true,
                trackType: 'audio',
            }),
        {
            ...options,
            bitrateKbps: bitrate,
            afterPcmChunk: () => drainSink(sink, options.signal),
        },
    );
    options.onProgress?.({ fraction: 1, message: 'Finalizing output...' });
    await muxer.finalize();
    return {
        format,
        passes: 1,
        inputFrames: result.inputFrames,
        encodedFrames: result.encodedFrames,
        peakPcmFrames: result.peakPcmFrames,
        planningBytes: 0,
    };
}

/** FLAC: its STREAMINFO patched in after one pass, or taken from a first pass that writes none. */
async function writeFlac({
    encoders,
    source,
    format,
    sink,
    options,
}: SinkEncoding): Promise<StreamingAudioDiagnostics> {
    const run = async (
        onFrame: (frame: Uint8Array) => void,
    ): Promise<{
        header: Uint8Array;
        visit: PcmVisitResult;
        encoder: StreamingFlacEncoder;
    }> => {
        const encoder = new (encoders.get('flac'))(source.sampleRate, source.channels, {
            signal: options.signal,
            bitsPerSample: options.sampleFormat === 's24' ? 24 : 16,
            expectedInputFrames: source.estimatedFrames,
            collectFrames: false,
            onFrame,
            onProgress: (done, total) =>
                options.onProgress?.({
                    fraction: expectedRatio(done, total),
                    message: `Encoding FLAC ${done}/${total}`,
                }),
        });
        const visit = await visitPcm(
            source,
            options.signal,
            feeding(encoder, sink, options.signal),
        );
        const header = encoder.finishHeader();
        return { header, visit, encoder };
    };

    let passes = 1;
    let final: Awaited<ReturnType<typeof run>>;
    const tagged = (header: Uint8Array): Uint8Array => flacHeaderWithTags(header, options.tags);
    if (sink.patchAt) {
        const reserved = tagged(
            Uint8Array.of(0x66, 0x4c, 0x61, 0x43, 0x80, 0, 0, 34, ...new Uint8Array(34)),
        );
        sink.write(new Uint8Array(reserved.length));
        await drainSink(sink, options.signal);
        final = await run(frame => sink.write(frame));
        if (final.header.length !== 42)
            throw new EncodeError('FLAC header size changed unexpectedly');
        sink.patchAt(0, tagged(final.header));
    } else {
        const dry = await run(() => undefined);
        sink.write(tagged(dry.header));
        await drainSink(sink, options.signal);
        final = await run(frame => sink.write(frame));
        if (!sameBytes(dry.header, final.header)) {
            throw new EncodeError('PCM replay changed FLAC stream statistics');
        }
        passes = 2;
    }
    await closeOutput(sink, options);
    return {
        format,
        passes,
        inputFrames: final.encoder.framesReceived,
        encodedFrames: final.encoder.framesProduced,
        peakPcmFrames: Math.max(final.visit.peakChunkFrames, final.encoder.peakBufferedFrames),
        planningBytes: 0,
    };
}

/** The ID3v2 tag of the input tags, written first; undefined when there are none. */
async function leadingId3(
    sink: Sink,
    options: StreamingAudioEncodeOptions,
): Promise<Uint8Array | undefined> {
    // MPEG audio files carry their tags, chapters and cover art in a leading ID3v2 tag.
    const id3 = id3TagFromMediaTags(options.tags);
    if (id3) {
        sink.write(id3);
        await drainSink(sink, options.signal);
    }
    return id3;
}

// MP2 and MP3 code the source at its own level in one pass: values beyond full scale stay in the
// bitstream for the decoder, as the source would have played them.

/** MP2 after the ID3 tag. */
async function writeMp2({
    encoders,
    source,
    format,
    sink,
    options,
    bitrate,
}: SinkEncoding): Promise<StreamingAudioDiagnostics> {
    await leadingId3(sink, options);
    const encoder = new (encoders.get('mp2'))(source.sampleRate, source.channels, bitrate, {
        signal: options.signal,
        expectedInputFrames: Math.max(0, source.estimatedFrames),
        collectOutput: false,
        onFrame: frame => sink.write(frame),
        onProgress: (done, total) =>
            options.onProgress?.({
                fraction: expectedRatio(done, total),
                message: `Encoding MP2 ${done}/${total}`,
            }),
    });
    const visit = await visitPcm(source, options.signal, feeding(encoder, sink, options.signal));
    encoder.finish();
    await closeOutput(sink, options);
    return {
        format,
        passes: 1,
        inputFrames: encoder.framesReceived,
        encodedFrames: encoder.framesProduced,
        peakPcmFrames: Math.max(visit.peakChunkFrames, encoder.peakBufferedFrames),
        planningBytes: 0,
    };
}

/** MP3 after the ID3 tag and a gapless Info frame. */
async function writeMp3({
    encoders,
    source,
    format,
    sink,
    options,
    bitrate,
}: SinkEncoding): Promise<StreamingAudioDiagnostics> {
    const id3 = await leadingId3(sink, options);
    const runMp3 = async (
        onFrame: (frame: Uint8Array) => void,
    ): Promise<{
        infoFrame: Uint8Array;
        visit: PcmVisitResult;
        encoder: StreamingMp3Encoder;
    }> => {
        const encoder = new (encoders.get('mp3'))(source.sampleRate, source.channels, bitrate, {
            signal: options.signal,
            vbr: options.vbr === true,
            collectFrames: false,
            expectedInputFrames: Math.max(0, source.estimatedFrames),
            onFrame,
            onProgress: (done, total) =>
                options.onProgress?.({
                    fraction: expectedRatio(done, total),
                    message: `Encoding MP3 ${done}/${total}`,
                }),
        });
        const visit = await visitPcm(
            source,
            options.signal,
            feeding(encoder, sink, options.signal),
        );
        const output = encoder.finishOutput();
        return { infoFrame: output.infoFrame, visit, encoder };
    };

    // The Info frame leads the stream and depends on all of it: a sink that patches takes a
    // placeholder, any other sink gets it from a first encode that writes nothing.
    let passes = 1;
    let final: Awaited<ReturnType<typeof runMp3>>;
    if (sink.patchAt) {
        const headerSize = encoders
            .get('mp3')
            .infoFrameSize(source.sampleRate, source.channels, bitrate);
        sink.write(new Uint8Array(headerSize));
        await drainSink(sink, options.signal);
        final = await runMp3(frame => sink.write(frame));
        if (final.infoFrame.length !== headerSize) {
            throw new EncodeError('MP3 Info frame changed its size');
        }
        sink.patchAt(id3?.length ?? 0, final.infoFrame);
    } else {
        const dry = await runMp3(() => undefined);
        sink.write(dry.infoFrame);
        await drainSink(sink, options.signal);
        final = await runMp3(frame => sink.write(frame));
        if (!sameBytes(dry.infoFrame, final.infoFrame) || dry.visit.frames !== final.visit.frames)
            throw new EncodeError('PCM replay changed MP3 gapless metadata');
        passes = 2;
    }
    await closeOutput(sink, options);
    return {
        format,
        passes,
        inputFrames: final.encoder.framesReceived,
        encodedFrames: final.encoder.framesProduced,
        peakPcmFrames: Math.max(final.visit.peakChunkFrames, final.encoder.peakBufferedFrames),
        planningBytes: 0,
    };
}

/** What streamFrames resolves with: the frames taken and FLAC's stream header, final at the end. */
export interface StreamedFrames {
    readonly inputFrames: number;
    readonly header?: Uint8Array;
}

/**
 * The FLAC, MP2 or MP3 frames of a replayable source, handed to `onFrame` as the encoder codes
 * them, as the audio file holds them after its headers and tags (which this leaves out).
 */
async function streamFrames(
    encoders: AudioEncoders,
    source: ReplayablePcmSource,
    format: 'flac' | 'mp2' | 'mp3',
    onFrame: (frame: Uint8Array) => void,
    options: OutputOptions,
): Promise<StreamedFrames> {
    const loading = encoders.load(format);
    if (loading) await loading;
    const bitrate = lossyBitrate(format, source.channels, options.bitrateKbps);
    const expectedInputFrames = Math.max(0, source.estimatedFrames);
    const { sampleRate, channels } = source;
    const { signal } = options;
    const encoder =
        format === 'flac'
            ? new (encoders.get('flac'))(sampleRate, channels, {
                  signal,
                  bitsPerSample: options.sampleFormat === 's24' ? 24 : 16,
                  expectedInputFrames,
                  collectFrames: false,
                  onFrame,
              })
            : format === 'mp2'
              ? new (encoders.get('mp2'))(sampleRate, channels, bitrate, {
                    signal,
                    expectedInputFrames,
                    collectOutput: false,
                    onFrame,
                })
              : new (encoders.get('mp3'))(sampleRate, channels, bitrate, {
                    signal,
                    vbr: options.vbr === true,
                    collectFrames: false,
                    expectedInputFrames,
                    onFrame,
                });
    await visitPcm(source, signal, async chunk => {
        encoder.pushPlanar(chunk);
        await options.afterPcmChunk?.();
    });
    const inputFrames = encoder.framesReceived;
    if ('finishHeader' in encoder) return { inputFrames, header: encoder.finishHeader() };
    if ('finishOutput' in encoder) encoder.finishOutput();
    else encoder.finish();
    return { inputFrames };
}

/** The bitrate in kbps of a lossy format: `requested`, else its default for the channels. */
function lossyBitrate(format: string, channels: number, requested: number | undefined): number {
    return (
        requested ??
        (format === 'mp2' ? (channels === 1 ? 192 : 256) : format === 'mp3' ? 256 : 128)
    );
}

/** The writers of the encoded formats. */
const ENCODED_WRITERS: Readonly<
    Record<EncoderName, (encoding: SinkEncoding) => Promise<StreamingAudioDiagnostics>>
> = { aac: writeAdts, flac: writeFlac, mp2: writeMp2, mp3: writeMp3 };

async function encodeToSink(
    encoders: AudioEncoders,
    source: ReplayablePcmSource,
    format: StreamingSelfHostedAudioFormat,
    sink: Sink,
    options: OutputOptions = {},
): Promise<StreamingAudioDiagnostics> {
    const loading = encoders.load(format);
    if (loading) await loading;
    const bitrate = lossyBitrate(format, source.channels, options.bitrateKbps);
    const encoding = { encoders, source, format, sink, options, bitrate };
    return format === 'wav' || format === 'aiff' || format === 'au' || format === 'caf'
        ? writePcm(encoding, format)
        : ENCODED_WRITERS[format](encoding);
}

/** Builds replayable encoding operations without importing unselected codec implementations. */
export function createStreamingAudioOutput(
    codecs: StreamingAudioCodecs = {},
    missing: MissingParts = NO_PLUGINS,
) {
    const encoders = new AudioEncoders(codecs, missing);

    async function encodeReplayablePcmToSink(
        source: ReplayablePcmSource,
        format: StreamingSelfHostedAudioFormat,
        sink: Sink,
        options: StreamingAudioEncodeOptions = {},
    ): Promise<StreamingAudioDiagnostics> {
        assertFormat(format);
        return runReplayableAudio(source, sink, options, (input, output, guarded) =>
            encodeToSink(encoders, input, format, output!, guarded),
        );
    }

    return {
        streamReplayableAac: (
            source: ReplayablePcmSource,
            onFrame: (frame: Uint8Array, frameIndex: number) => void,
            options: StreamingAudioEncodeOptions = {},
        ): Promise<StreamingAacResult> => streamReplayableAac(encoders, source, onFrame, options),

        /** The FLAC, MP2 or MP3 frames of a replayable source to `onFrame`, replays guarded. */
        streamReplayableFrames: (
            source: ReplayablePcmSource,
            format: 'flac' | 'mp2' | 'mp3',
            onFrame: (frame: Uint8Array) => void,
            options: OutputOptions = {},
        ): Promise<StreamedFrames> =>
            runReplayableAudio(source, undefined, options, (input, _sink, guarded, perform) =>
                streamFrames(
                    encoders,
                    input,
                    format,
                    frame => perform(() => onFrame(frame)),
                    guarded,
                ),
            ),

        /**
         * Encodes into a Blob: the sink encoding into memory, whose placeholder headers are
         * patched in place.
         */
        async encodeReplayablePcm(
            source: ReplayablePcmSource,
            format: StreamingSelfHostedAudioFormat,
            options: StreamingAudioEncodeOptions = {},
        ): Promise<{ blob: Blob; diagnostics: StreamingAudioDiagnostics }> {
            assertFormat(format);
            const sink = new MemorySink();
            const diagnostics = await encodeReplayablePcmToSink(source, format, sink, options);
            return { blob: sink.toBlob(mimeTypeOf(format)), diagnostics };
        },
        encodeReplayablePcmToSink,
    };
}
