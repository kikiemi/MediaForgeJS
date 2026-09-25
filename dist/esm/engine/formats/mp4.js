import { MP4Demuxer } from '../../demux/mp4-demuxer.js';
import { enableCompactMP4Index, usesCompactMP4Index } from '../../demux/sample-index.js';
import { MP4Muxer } from '../../mux/mp4-muxer.js';
import { CmafWriter } from '../../streaming/cmaf.js';
import { DiagnosticContext } from '../../core/diagnostics.js';
import { compatibleMp4Source } from '../compatible-source.js';
import { builtinDemuxer } from '../demux-ownership.js';
const formats = Object.freeze(['mp4', 'mov', 'm4a', 'm4v', '3gp']);
export const mp4 = Object.freeze({
    demuxers: Object.freeze([
        builtinDemuxer({
            formats,
            async demux(source, options) {
                const diagnostics = new DiagnosticContext(options, 'compatible');
                source = await compatibleMp4Source(source, diagnostics, options.signal);
                const demuxer = new MP4Demuxer({
                    allowEmptyTracks: true,
                    maxSamples: options.maxSamples,
                    maxIndexBytes: options.maxIndexBytes,
                });
                if (usesCompactMP4Index(options))
                    enableCompactMP4Index(demuxer);
                return demuxer.demux(source, options.signal, diagnostics);
            },
        }),
    ]),
    muxers: Object.freeze([{ formats, create: (config, sink) => new MP4Muxer(config, sink) }]),
    createSegmentWriter: options => new CmafWriter(options),
});
