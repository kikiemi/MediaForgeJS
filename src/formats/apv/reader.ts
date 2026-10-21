import type { Reader } from '../../core/contracts/reader';
import { HANDS_OVER, readerDiagnostics } from '../shared/contract';
import type { Source } from '../../core/model/types';
import type { DemuxResult, Sample, TrackInfo } from '../../core/model/track';
import { ChunkReader } from '../../core/io/sources/chunk-reader';
import { dataView } from '../../core/bytes/byte-fields';
import { DiagnosticContext } from '../../core/errors/diagnostics';
import { throwIfAborted } from '../../core/errors/errors';
import { demuxAssert } from '../../core/errors/demux-guard';
import { PacketDemuxer } from '../shared/demux-budget';
import { yieldEventLoop } from '../../core/io/event-loop';
import { apvCodecString } from '../../core/codec-config/video/apv';
import { apvConfigRecord, apvFrameInfo } from './access-unit';

/** Raw APV states no timing; its frames are read at FFmpeg's default of 30 per second. */
const FRAME_RATE = 30;

/**
 * Raw APV (draft-lim-apv, annex B): access units, each after its 32-bit size. Each access unit,
 * from its 'aPv1' signature on, is one packet and a keyframe, as MP4 stores it; the first one's
 * primary frame gives the size, the codec string and the 'apvC' record.
 */
export class ApvDemuxer extends PacketDemuxer {
    async demux(
        source: Source,
        diagnostics = new DiagnosticContext({}, 'compatible'),
    ): Promise<DemuxResult> {
        const reader = new ChunkReader(source);
        const size = reader.size;
        const samples: Sample[] = [];
        let incomplete = false;
        for (let pos = 0; pos + 4 <= size;) {
            if ((samples.length & 1023) === 0) {
                throwIfAborted(this.signal);
                await yieldEventLoop();
            }
            const length = dataView(await reader.bytes(pos, 4)).getUint32(0);
            if (length < 12 || length > size - pos - 4) {
                const message = 'Dropped a malformed or cut APV access unit';
                diagnostics.note('recover', 'apv', 'APV_TRUNCATED', message, { offset: pos });
                incomplete = true;
                break;
            }
            this.checkPacket(length, 'APV access unit');
            this.budget.reserveSamples(1, 256, 'APV sample index');
            samples.push({
                offset: pos + 4,
                size: length,
                timestamp: samples.length / FRAME_RATE,
                duration: 1 / FRAME_RATE,
                isKeyframe: true,
            });
            pos += 4 + length;
        }

        demuxAssert(samples.length > 0, 'APV stream holds no access units');
        const first = samples[0]!;
        const info = apvFrameInfo(await reader.bytes(first.offset, first.size));
        demuxAssert(info, 'APV access unit has no primary frame');
        const track: TrackInfo = {
            id: 1,
            codec: apvCodecString(info),
            width: info.width,
            height: info.height,
            sampleRate: 0,
            channelCount: 0,
            duration: samples.length / FRAME_RATE,
            samples,
            codecConfig: apvConfigRecord(info),
            ...(incomplete ? { incomplete: true } : {}),
        };
        return { videoTracks: [track], audioTracks: [] };
    }
}

/** The apv plugin's 'apv' reader, which its index loads on first use. */
export const apvReader: Reader = {
    read: (source, options) => new ApvDemuxer(options).demux(source, readerDiagnostics(options)),
    capabilities: HANDS_OVER,
};
