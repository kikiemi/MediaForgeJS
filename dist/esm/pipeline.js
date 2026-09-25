import { Pipeline as PipelineCore } from './pipeline-core.js';
import { defaultPipelineOptions } from './conversion/pipeline-defaults.js';
export { toInputBlob } from './pipeline-core.js';
export class Pipeline extends PipelineCore {
    constructor(config) {
        super(config, defaultPipelineOptions);
    }
}
