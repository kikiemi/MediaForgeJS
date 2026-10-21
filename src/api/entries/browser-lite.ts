/**
 * The lite script-tag build (dist/MediaForgeJS.lite.js): browser.ts without plugins, whose formats
 * and codecs namespaces carry the core ones. Plugin scripts (dist/browser-plugins/<name>.js) add
 * their implementations; pass them with plugins: { add: [...] }.
 */
export * from './lite';
export * as plugins from './plugins';
export * as io from './io';
export * as streaming from './streaming';
export * as formats from '../surface-formats';
export * as codecs from '../surface-codecs';
