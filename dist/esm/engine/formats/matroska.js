import { WebMDemuxer } from '../../demux/webm-demuxer.js';
import { WebMMuxer, validateMatroskaCodecConfigs } from '../../mux/webm-muxer.js';
import { builtinDemuxer } from '../demux-ownership.js';
import { DiagnosticContext } from '../../core/diagnostics.js';
const formats = Object.freeze(['mkv', 'webm']);
export const matroska = Object.freeze({
    demuxers: Object.freeze([
        builtinDemuxer({
            formats,
            demux: (source, options) => new WebMDemuxer(options).demux(source, options.signal, new DiagnosticContext(options, 'compatible')),
        }),
    ]),
    muxers: Object.freeze([
        {
            formats,
            create: (config, sink, options) => {
                if (!options?.deferCodecConfig)
                    validateMatroskaCodecConfigs(config);
                return new WebMMuxer(config, sink);
            },
        },
    ]),
});
