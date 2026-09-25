import { FLVDemuxer } from '../../demux/flv-demuxer.js';
import { FLVMuxer } from '../../mux/flv-muxer.js';
import { builtinDemuxer } from '../demux-ownership.js';
const formats = Object.freeze(['flv']);
export const flv = Object.freeze({
    demuxers: Object.freeze([
        builtinDemuxer({ formats, demux: (source, options) => new FLVDemuxer(options).demux(source, options.signal) }),
    ]),
    muxers: Object.freeze([{ formats, create: (config, sink) => new FLVMuxer(config, sink) }]),
});
