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
import { leb128 } from '../../core/codec-config/video/av1-config';
import {
    IAMF_SEQUENCE_HEADER,
    IAMF_TEMPORAL_DELIMITER,
    iamfDescription,
    iamfObuAt,
    type IamfObu,
} from '../../core/codec-config/audio/iamf';

const WINDOW_BYTES = 1 << 20;

/** Descriptor OBUs: codec configs, audio elements, mix presentations and sequence headers. */
const isDescriptor = (type: number): boolean => type < 3 || type === IAMF_SEQUENCE_HEADER;

/** The temporal unit being gathered: its byte range and the substreams it has a frame of. */
interface PendingUnit {
    readonly start: number;
    end: number;
    readonly key: boolean;
    readonly substreams: Set<number>;
}

/**
 * A raw IA sequence (IAMF § 5): its descriptors, then temporal units of parameter blocks and one
 * audio frame per substream, with or without temporal delimiters. Each temporal unit (without its
 * delimiter) is one packet, as MP4 stores it, timed by the frame length of the codec config; the
 * descriptors are the track's configuration. Descriptors repeated later are redundant copies and
 * are skipped.
 */
export class IamfDemuxer extends PacketDemuxer {
    async demux(
        source: Source,
        diagnostics = new DiagnosticContext({}, 'compatible'),
    ): Promise<DemuxResult> {
        const reader = new ChunkReader(source);
        const size = reader.size;
        let windowStart = 0;
        let window: Uint8Array = new Uint8Array(0);

        // The OBU at `pos`, from a window of the input that holds it whole.
        const obuAt = async (pos: number): Promise<IamfObu | undefined> => {
            let at = pos - windowStart;
            const length = at >= 0 ? leb128(window, at + 1, window.length) : undefined;
            const needed = length ? 1 + length.length + length.value : 16;
            if (at < 0 || at + needed > window.length) {
                this.checkPacket(needed, 'IAMF OBU');
                windowStart = pos;
                window = await reader.bytes(
                    pos,
                    Math.min(size - pos, Math.max(WINDOW_BYTES, needed)),
                );
                at = 0;
            }
            const obu = iamfObuAt(window, at);
            return (
                obu && { ...obu, payload: obu.payload + windowStart, end: obu.end + windowStart }
            );
        };

        const samples: Sample[] = [];
        let unit: PendingUnit | undefined;
        let nextKey = true;
        let descriptorsEnd = -1;
        let incomplete = false;
        const close = (): void => {
            if (unit?.substreams.size) {
                this.budget.reserveSamples(1, 256, 'IAMF sample index');
                samples.push({
                    offset: unit.start,
                    size: unit.end - unit.start,
                    timestamp: 0,
                    duration: 0,
                    isKeyframe: unit.key,
                });
            }
            unit = undefined;
        };

        for (let pos = 0, count = 0; pos < size; count++) {
            if ((count & 1023) === 0) {
                throwIfAborted(this.signal);
                await yieldEventLoop();
            }
            const obu = await obuAt(pos);
            if (!obu) {
                diagnostics.note(
                    'recover',
                    'iamf',
                    'IAMF_TRUNCATED',
                    `Dropped IAMF from a malformed or cut OBU at byte ${pos}`,
                    { offset: pos },
                );
                incomplete = true;
                break;
            }
            const { type } = obu;
            if (descriptorsEnd < 0 && (isDescriptor(type) || type > 23)) {
                pos = obu.end;
                continue;
            }
            if (descriptorsEnd < 0) descriptorsEnd = pos;

            // Descriptors after the first temporal unit are redundant copies; new ones would start
            // another IA sequence, which is not read.
            if (isDescriptor(type)) {
                close();
                if (!obu.redundant) {
                    diagnostics.note(
                        'recover',
                        'iamf',
                        'IAMF_SEQUENCE_CHANGE',
                        `Stopped at a new IA sequence at byte ${pos}`,
                        { offset: pos },
                    );
                    break;
                }
            } else if (type === IAMF_TEMPORAL_DELIMITER) {
                close();
                nextKey = !obu.notKey;
            } else {
                // Without delimiters a unit ends where a parameter block follows its audio frames
                // or a substream has a second frame.
                const frame = obu.substream;
                const parameter = type === 3;
                if (unit && ((parameter && unit.substreams.size) || unit.substreams.has(frame!)))
                    close();
                unit ??= { start: pos, end: pos, key: nextKey, substreams: new Set() };
                nextKey = true;
                if (frame !== undefined) unit.substreams.add(frame);
                unit.end = obu.end;
            }
            pos = obu.end;
        }
        close();

        const descriptors = await reader.bytes(0, descriptorsEnd < 0 ? size : descriptorsEnd);
        const description = iamfDescription(descriptors);
        demuxAssert(description, 'IAMF stream has no sequence header or codec config');
        const { codec, sampleRate, channelCount, frameSamples } = description;
        demuxAssert(sampleRate > 0 && frameSamples > 0, 'IAMF codec config states no frame length');
        demuxAssert(samples.length > 0, 'IAMF stream holds no temporal units');
        samples.forEach((sample, index) => {
            sample.timestamp = (index * frameSamples) / sampleRate;
            sample.duration = frameSamples / sampleRate;
        });

        const track: TrackInfo = {
            id: 1,
            codec,
            width: 0,
            height: 0,
            sampleRate,
            channelCount,
            duration: (samples.length * frameSamples) / sampleRate,
            samples,
            codecConfig: descriptors,
            ...(incomplete ? { incomplete: true } : {}),
        };
        return { videoTracks: [], audioTracks: [track] };
    }
}

/** The iamf plugin's 'iamf' reader, which its index loads on first use. */
export const iamfReader: Reader = {
    read: (source, options) => new IamfDemuxer(options).demux(source, readerDiagnostics(options)),
    capabilities: HANDS_OVER,
};
