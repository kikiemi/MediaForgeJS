import { Pipeline as PipelineCore } from './pipeline-core.js';
import type { PipelineConfig } from './core/pipeline-config.js';
export type { PipelineConfig } from './core/pipeline-config.js';
export { toInputBlob } from './pipeline-core.js';
/** Complete built-in composition; use pipeline-core to select individual components. */
export declare class Pipeline extends PipelineCore {
    constructor(config: PipelineConfig);
}
