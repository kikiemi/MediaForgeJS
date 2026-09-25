import { builtinFormats } from '../engine/builtin-formats.js';
import { createNativeVideoTransform } from './transcode-core.js';
export { createNativeVideoTransform } from './transcode-core.js';
export const nativeVideoTransform = createNativeVideoTransform({ formats: builtinFormats });
