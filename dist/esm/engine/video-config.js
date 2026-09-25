import { sampleAt, sampleCount } from '../demux/sample-index.js';
import { awaitWithAbort } from '../core/abort.js';
import { isAnnexB, splitAnnexBNals, buildAvcCFromAnnexB, buildHevcCFromAnnexB } from '../core/annexb.js';
import { assertSourceBytes } from '../io/source-read.js';
import { MediaForgeError } from '../core/errors.js';
export async function recoverVideoConfigurations(result, source, diagnostics, maxPacketBytes, signal) {
    for (const track of result.videoTracks) {
        const hevc = track.codec.startsWith('hev1') || track.codec.startsWith('hvc1');
        if (track.codecConfig?.length || (!hevc && !track.codec.startsWith('avc')))
            continue;
        const parameters = [];
        let parameterBytes = 0;
        let inspectedBytes = 0;
        for (let index = 0, length = Math.min(64, sampleCount(track)); index < length; index++) {
            const sample = sampleAt(track, index);
            if (signal?.aborted)
                throw new MediaForgeError('Aborted', 'ABORT');
            if (sample.size > maxPacketBytes || sample.size > 8 * 1024 * 1024 - inspectedBytes)
                break;
            inspectedBytes += sample.size;
            const bytes = sample.data ?? (await awaitWithAbort(source.read(sample.offset, sample.size), signal));
            assertSourceBytes(bytes, sample.size, 'Video configuration scan');
            if (!isAnnexB(bytes))
                continue;
            let changed = false;
            for (const nal of splitAnnexBNals(bytes)) {
                const type = hevc ? (nal[0] >>> 1) & 63 : nal[0] & 31;
                if (!(hevc ? type >= 32 && type <= 34 : type === 7 || type === 8))
                    continue;
                if (nal.length > 65535 || parameterBytes + nal.length + 4 > 1024 * 1024)
                    break;
                if (parameters.some(previous => previous.length === nal.length && previous.every((byte, i) => byte === nal[i])))
                    continue;
                parameters.push(nal.slice());
                parameterBytes += nal.length + 4;
                changed = true;
            }
            if (!changed)
                continue;
            const data = new Uint8Array(parameterBytes);
            let offset = 0;
            for (const nal of parameters) {
                data.set([0, 0, 0, 1], offset);
                data.set(nal, offset + 4);
                offset += nal.length + 4;
            }
            const config = (hevc ? buildHevcCFromAnnexB : buildAvcCFromAnnexB)(data);
            if (!config)
                continue;
            track.codecConfig = config;
            diagnostics.warn({
                code: 'VIDEO_CONFIG_DERIVED',
                trackId: track.id,
                message: `Derived ${hevc ? 'hvcC' : 'avcC'} from in-band video parameter sets`,
            });
            break;
        }
    }
}
