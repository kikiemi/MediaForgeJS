/**
 * The script-tag build (dist/MediaForgeJS.js): the API with every plugin as the global
 * MediaForgeJS, and the package's other entries as its namespaces. The lite build (browser-lite.ts)
 * leaves the plugins out.
 */
export * from './index';
export * as plugins from './plugins';
export * as io from './io';
export * as streaming from './streaming';
export * as formats from './formats';
export * as codecs from './codecs';
