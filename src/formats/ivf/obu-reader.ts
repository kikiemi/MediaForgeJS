import type { Reader } from '../../core/contracts/reader';
import { HANDS_OVER, readerDiagnostics } from '../shared/contract';
import type { Source } from '../../core/model/types';
import type { DemuxResult, Sample, TrackInfo } from '../../core/model/track';
import { ChunkReader } from '../../core/io/sources/chunk-reader';
import { DiagnosticContext } from '../../core/errors/diagnostics';
import { throwIfAborted } from '../../core/errors/errors';
import { demuxAssert } from '../../core/errors/demux-guard';
import { PacketDemuxer } from '../shared/demux-budget';
import { yieldEventLoop } from '../../core/io/event-loop';
import {
    AV1_OBU_TEMPORAL_DELIMITER,
    av1AnnexBToLowOverhead,
    av1CodecString,
    av1FrameDuration,
    Av1StreamState,
    isAv1AnnexB,
    leb128,
} from '../../core/codec-config/video/av1-config';

const WINDOW_BYTES = 1 << 20;

/**
 * Raw AV1 bitstreams: the low-overhead format (sized OBUs, temporal units starting at temporal
 * delimiters) and the Annex B length-delimited format, which is converted to low-overhead temporal
 * units. Raw streams carry no timestamps; frames are timed from the sequence header timing_info or
 * at 25 frames per second.
 */
export class ObuDemuxer extends PacketDemuxer {
    async demux(
        source: Source,
        diagnostics = new DiagnosticContext({}, 'compatible'),
    ): Promise<DemuxResult> {
        const reader = new ChunkReader(source);
        const size = reader.size;
        demuxAssert(size >= 3, 'AV1 stream is too short');
        const head = await reader.bytes(0, Math.min(size, 64));
        const annexB = isAv1AnnexB(head);
        const state = new Av1StreamState();

        const samples: Sample[] = [];
        let incomplete = false;

        const truncated = (offset: number, message: string): void => {
            diagnostics.note('recover', 'obu', 'AV1_TRUNCATED', message, { offset });
            incomplete = true;
        };

        const adopt = (data: Uint8Array, offset: number, length: number, inline: boolean): void => {
            this.checkPacket(length, 'AV1 temporal unit');

            const info = state.inspect(data);

            this.budget.reserveSamples(1, inline ? 256 + length : 256, 'AV1 sample index');
            samples.push({
                offset,
                size: length,
                timestamp: 0,
                duration: 0,
                isKeyframe: info.keyframe,
                ...(inline ? { data } : {}),
            });
        };

        let units = 0;
        if (annexB) {
            let pos = 0;
            while (pos < size) {
                if ((units++ & 255) === 0) {
                    throwIfAborted(this.signal);
                    await yieldEventLoop();
                }

                const prefix = await reader.bytes(pos, Math.min(8, size - pos));
                const unitSize = leb128(prefix, 0, prefix.length);
                if (!unitSize || unitSize.value === 0) {
                    truncated(
                        pos,
                        `Dropped AV1 from a malformed temporal unit size at byte ${pos}`,
                    );
                    break;
                }

                const start = pos + unitSize.length;
                if (unitSize.value > size - start) {
                    truncated(
                        pos,
                        `AV1 Annex B temporal unit at byte ${pos} is cut by the end of the input`,
                    );
                    break;
                }

                const unit = av1AnnexBToLowOverhead(await reader.bytes(start, unitSize.value));
                if (!unit) {
                    truncated(
                        pos,
                        `AV1 Annex B temporal unit at byte ${pos} has inconsistent OBU lengths; ` +
                            `dropped`,
                    );
                    pos = start + unitSize.value;
                    continue;
                }

                adopt(unit, start, unit.length, true);
                pos = start + unitSize.value;
            }
        } else {
            let unitStart = -1;
            let pos = 0;
            let windowStart = 0;
            let window: Uint8Array = new Uint8Array(0);

            const finish = async (end: number): Promise<void> => {
                if (unitStart < 0) return;
                const data = await reader.bytes(unitStart, end - unitStart);
                adopt(data, unitStart, end - unitStart, false);
                unitStart = -1;
            };

            while (pos < size) {
                if ((units++ & 255) === 0) {
                    throwIfAborted(this.signal);
                    await yieldEventLoop();
                }

                if (pos < windowStart || pos + 16 > windowStart + window.length) {
                    windowStart = pos;
                    window = await reader.bytes(pos, Math.min(WINDOW_BYTES, size - pos));
                }

                const at = pos - windowStart;
                const header = window[at]!;
                const type = (header >> 3) & 15;
                const extension = (header >> 2) & 1;
                if (header & 0x80 || !((header >> 1) & 1)) {
                    truncated(pos, `Dropped AV1 from an unsized OBU at byte ${pos}`);
                    break;
                }

                const sizeField = leb128(window, at + 1 + extension, window.length);
                if (!sizeField) {
                    truncated(pos, `AV1 OBU size at byte ${pos} is malformed; the rest is dropped`);
                    break;
                }

                const obuEnd = pos + 1 + extension + sizeField.length + sizeField.value;
                if (obuEnd > size) {
                    truncated(pos, `Dropped an AV1 temporal unit cut by the end of the input`);
                    unitStart = -1;
                    break;
                }

                if (type === AV1_OBU_TEMPORAL_DELIMITER) {
                    await finish(pos);
                    unitStart = pos;
                } else if (unitStart < 0) unitStart = pos;
                pos = obuEnd;
            }
            await finish(pos);
        }

        demuxAssert(samples.length > 0, 'AV1 stream holds no temporal units');
        const { codecConfig, colour } = state.configuration(
            diagnostics,
            'obu',
            'AV1 stream carries no sequence header; it cannot be configured for decoding',
        );

        const duration = av1FrameDuration(state.sequenceHeader) ?? 1 / 25;
        samples.forEach((sample, index) => {
            sample.timestamp = index * duration;
            sample.duration = duration;
        });

        const sequence = state.sequenceHeader;
        const track: TrackInfo = {
            id: 1,
            codec: (codecConfig && av1CodecString(codecConfig)) ?? 'av01',
            width: sequence?.width ?? 0,
            height: sequence?.height ?? 0,
            colour,
            sampleRate: 0,
            channelCount: 0,
            duration: samples.length * duration,
            samples,
            codecConfig,
            ...(incomplete ? { incomplete: true } : {}),
        };
        return { videoTracks: [track], audioTracks: [] };
    }
}

/** The ivf plugin's 'obu' reader, which its index loads on first use. */
export const obuReader: Reader = {
    read: (source, options) => new ObuDemuxer(options).demux(source, readerDiagnostics(options)),
    capabilities: HANDS_OVER,
};
