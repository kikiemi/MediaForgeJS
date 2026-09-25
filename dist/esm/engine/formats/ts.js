import { TSDemuxer } from '../../demux/ts-demuxer.js';
import { TSMuxer } from '../../mux/ts-muxer.js';
import { DiagnosticContext } from '../../core/diagnostics.js';
import { builtinDemuxer } from '../demux-ownership.js';
const formats = Object.freeze(['ts']);
export const ts = Object.freeze({
    demuxers: Object.freeze([
        builtinDemuxer({
            formats,
            demux: (source, options) => new TSDemuxer(options).demux(source, options.signal, new DiagnosticContext(options, 'compatible')),
        }),
    ]),
    muxers: Object.freeze([{ formats, create: (config, sink) => new TSMuxer(config, sink) }]),
});
