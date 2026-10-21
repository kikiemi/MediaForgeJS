import { distUrl } from './dist-paths.mjs';

// The plugin descriptors, for tests that choose plugins; the default entry already uses every one.
export const plugins = await import(distUrl('esm/plugins/index.js'));
export const { allPlugins } = plugins;
