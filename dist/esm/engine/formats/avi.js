import { AVIDemuxer } from '../../demux/avi-demuxer.js';
import { AVIMuxer } from '../../mux/avi-muxer.js';
import { builtinDemuxer } from '../demux-ownership.js';
import { DiagnosticContext } from '../../core/diagnostics.js';
const formats = Object.freeze(['avi']);
export const avi = Object.freeze({
    demuxers: Object.freeze([
        builtinDemuxer({
            formats,
            demux: (source, options) => new AVIDemuxer(options).demux(source, options.signal, new DiagnosticContext(options, 'compatible')),
        }),
    ]),
    muxers: Object.freeze([{ formats, create: (config, sink) => new AVIMuxer(config, sink) }]),
});
