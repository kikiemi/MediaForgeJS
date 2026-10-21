import type { Reader } from '../../core/contracts/reader';
import { HANDS_OVER, readerDiagnostics } from '../shared/contract';
import type { Source } from '../../core/model/types';
import type { DemuxResult, Sample, TrackInfo } from '../../core/model/track';
import { ChunkReader } from '../../core/io/sources/chunk-reader';
import { DiagnosticContext } from '../../core/errors/diagnostics';
import { DemuxError, throwIfAborted } from '../../core/errors/errors';
import { demuxAssert } from '../../core/errors/demux-guard';
import { PacketDemuxer } from '../shared/demux-budget';
import { yieldEventLoop } from '../../core/io/event-loop';
import {
    av1CodecString,
    av1FrameDuration,
    Av1StreamState,
    splitAv1Obus,
} from '../../core/codec-config/video/av1-config';
import { isVp8Keyframe, isVp9Keyframe } from '../../core/codec-config/video/vpx-frame';
import { dataView } from '../../core/bytes/byte-fields';

export const IVF_HEADER_BYTES = 32;
const IVF_FRAME_HEADER_BYTES = 12;

/** Enough of a temporal unit to reach its first frame header past any metadata OBUs. */
const AV1_INSPECT_BYTES = 4096;

/**
 * Whether one temporal unit starts random access, inspecting every OBU header and reading at most
 * AV1_INSPECT_BYTES at each OBU: the reference slots that later show_existing_frame headers point
 * at depend on the refresh flags of every frame, not only the first.
 */
async function av1Keyframe(
    reader: ChunkReader,
    state: Av1StreamState,
    offset: number,
    size: number,
): Promise<boolean> {
    let keyframe = false;
    for (let at = 0; at < size;) {
        const piece = await reader.bytes(offset + at, Math.min(size - at, AV1_INSPECT_BYTES));
        const obus = splitAv1Obus(piece, 0, piece.length, true);
        if (!obus?.length) break;
        keyframe = state.inspect(piece, obus).keyframe || keyframe;
        const last = obus[obus.length - 1]!;
        if (last.declaredEnd === undefined) break;
        at += last.declaredEnd;
    }
    return keyframe;
}

const FOURCC_CODECS: Readonly<Record<string, string>> = { AV01: 'av01', VP80: 'vp8', VP90: 'vp9' };

/**
 * IVF (DKIF) demuxer for AV1, VP8 and VP9 frames; AV1 key frames and the av1C record come from the
 * OBUs.
 */
export class IvfDemuxer extends PacketDemuxer {
    async demux(
        source: Source,
        diagnostics = new DiagnosticContext({}, 'compatible'),
    ): Promise<DemuxResult> {
        const reader = new ChunkReader(source);
        const size = reader.size;
        demuxAssert(size >= IVF_HEADER_BYTES, 'IVF file is shorter than its 32-byte header');
        const head = await reader.bytes(0, IVF_HEADER_BYTES);
        const view = dataView(head);
        demuxAssert(
            String.fromCharCode(head[0]!, head[1]!, head[2]!, head[3]!) === 'DKIF',
            'Not an IVF file',
        );
        const headerLength = view.getUint16(6, true);
        demuxAssert(
            headerLength >= IVF_HEADER_BYTES && headerLength <= size,
            'IVF header length is invalid',
        );
        const fourcc = String.fromCharCode(head[8]!, head[9]!, head[10]!, head[11]!);
        const codec = FOURCC_CODECS[fourcc.toUpperCase()];
        if (!codec)
            throw new DemuxError(
                `IVF codec '${fourcc}' is not supported (AV01, VP80 and VP90 are)`,
            );

        let width = view.getUint16(12, true);
        let height = view.getUint16(14, true);
        const timebaseDen = view.getUint32(16, true);
        const timebaseNum = view.getUint32(20, true);
        const declaredFrames = view.getUint32(24, true);

        const tick = timebaseDen > 0 && timebaseNum > 0 ? timebaseNum / timebaseDen : 0;
        if (!tick) {
            diagnostics.note(
                'recover',
                'ivf',
                'IVF_TIMEBASE_INVALID',
                `IVF time base ${timebaseNum}/${timebaseDen} is invalid; frames are ` +
                    `timed from their order`,
            );
        }

        const samples: Sample[] = [];
        const state = new Av1StreamState();
        let incomplete = false;
        let pos = headerLength;
        let previousPts = -Infinity;
        for (let frames = 0; pos < size; frames++) {
            if ((frames & 1023) === 0) {
                throwIfAborted(this.signal);
                await yieldEventLoop();
            }

            if (size - pos < IVF_FRAME_HEADER_BYTES) {
                diagnostics.recover(
                    {
                        code: 'IVF_TRUNCATED',
                        format: 'ivf',
                        offset: pos,
                        message:
                            `Ignored ${size - pos} trailing bytes that do not hold an IVF ` +
                            `frame header`,
                    },
                    'IVF frame header is truncated',
                );
                incomplete = true;
                break;
            }

            const frameHead = await reader.bytes(pos, IVF_FRAME_HEADER_BYTES);
            const frameView = dataView(frameHead);
            const frameSize = frameView.getUint32(0, true);
            const pts = Number(frameView.getBigUint64(4, true));
            demuxAssert(
                Number.isSafeInteger(pts),
                'IVF frame timestamp exceeds the exact integer range',
            );
            const dataOffset = pos + IVF_FRAME_HEADER_BYTES;
            if (frameSize > size - dataOffset) {
                diagnostics.recover(
                    {
                        code: 'IVF_TRUNCATED',
                        format: 'ivf',
                        offset: pos,
                        message:
                            `Dropped the IVF frame at byte ${pos}, cut by the end of the ` +
                            `input`,
                    },
                    'IVF frame payload is cut by the end of the input',
                );
                incomplete = true;
                break;
            }

            this.checkPacket(frameSize, 'IVF frame');
            pos = dataOffset + frameSize;
            if (frameSize === 0) continue;

            let isKeyframe: boolean;
            if (codec === 'av01') {
                isKeyframe = await av1Keyframe(reader, state, dataOffset, frameSize);
            } else {
                const prefix = await reader.bytes(dataOffset, Math.min(frameSize, 16));
                isKeyframe = codec === 'vp8' ? isVp8Keyframe(prefix) : isVp9Keyframe(prefix);
            }

            const timestamp = tick
                ? pts * tick
                : samples.length * (av1FrameDuration(state.sequenceHeader) ?? 1 / 25);
            if (timestamp < previousPts) {
                diagnostics.note(
                    'recover',
                    'ivf',
                    'IVF_TIMESTAMP_ORDER',
                    `IVF frame timestamp ${pts} regresses; the frame keeps its order`,
                    { offset: pos },
                );
            }
            previousPts = Math.max(previousPts, timestamp);

            this.budget.reserveSamples(1, 256, 'IVF sample index');
            samples.push({
                offset: dataOffset,
                size: frameSize,
                timestamp,
                duration: 0,
                isKeyframe,
            });
        }

        demuxAssert(samples.length > 0, 'IVF file holds no frames');
        if (declaredFrames && declaredFrames !== samples.length && !incomplete) {
            diagnostics.note(
                'warn',
                'ivf',
                'IVF_FRAME_COUNT',
                `IVF header declares ${declaredFrames} frames but ${samples.length} ` +
                    `were found`,
            );
        }

        const nominal = av1FrameDuration(state.sequenceHeader) ?? (tick || 1 / 25);
        const steps: number[] = [];
        for (let index = 1; index < samples.length; index++) {
            const step = samples[index]!.timestamp - samples[index - 1]!.timestamp;
            if (step > 0) steps.push(step);
        }

        steps.sort((a, b) => a - b);
        const typical = steps[steps.length >> 1] ?? nominal;
        for (let index = 0; index < samples.length; index++) {
            const step =
                index + 1 < samples.length
                    ? samples[index + 1]!.timestamp - samples[index]!.timestamp
                    : 0;
            samples[index]!.duration = step > 0 ? step : typical;
        }

        const { codecConfig, colour } =
            codec === 'av01'
                ? state.configuration(
                      diagnostics,
                      'ivf',
                      'IVF AV1 frames carry no sequence header, so they cannot be decoded',
                  )
                : {};
        const first = state.first;
        if (first && (!width || !height)) {
            width = first.width;
            height = first.height;
        }
        if (codec === 'av01' && !samples.some(sample => sample.isKeyframe)) {
            diagnostics.note(
                'recover',
                'ivf',
                'AV1_KEYFRAME_MISSING',
                'IVF AV1 stream has no shown key frame',
            );
        }

        const last = samples[samples.length - 1]!;
        const track: TrackInfo = {
            id: 1,
            codec:
                codec === 'av01' ? ((codecConfig && av1CodecString(codecConfig)) ?? 'av01') : codec,
            width,
            height,
            colour,
            sampleRate: 0,
            channelCount: 0,
            duration: last.timestamp + last.duration,
            samples,
            codecConfig,
            ...(incomplete ? { incomplete: true } : {}),
        };
        return { videoTracks: [track], audioTracks: [] };
    }
}

/** The ivf plugin's 'ivf' reader, which its index loads on first use. */
export const ivfReader: Reader = {
    read: (source, options) => new IvfDemuxer(options).demux(source, readerDiagnostics(options)),
    capabilities: HANDS_OVER,
};
