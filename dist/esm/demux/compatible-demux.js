import { MP4Demuxer } from './mp4-demuxer.js';
import { TSDemuxer } from './ts-demuxer.js';
import { BlobSource } from '../io/sources.js';
import { DiagnosticContext } from '../core/diagnostics.js';
import { logger } from '../core/logger.js';
import { compatibleMp4Source } from '../engine/compatible-source.js';
import { recoverConversionDemux } from './conversion-recovery.js';
export async function demuxCompatible(demuxer, input, signal) {
    const diagnostics = new DiagnosticContext({
        validation: 'compatible',
        onWarning: warning => logger.warn(warning.message),
    });
    const source = input instanceof Blob ? new BlobSource(input) : input;
    const result = demuxer instanceof MP4Demuxer
        ? await demuxer.demux(await compatibleMp4Source(source, diagnostics, signal), signal, diagnostics)
        : demuxer instanceof TSDemuxer
            ? await demuxer.demux(source, signal, diagnostics)
            : await demuxer.demux(input, signal);
    await recoverConversionDemux(result, source, diagnostics, signal);
    return result;
}
